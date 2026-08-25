/**
 * Time-based one-time passwords (RFC 6238) — an authenticator app as the
 * second factor.
 *
 * This exists because SMS is the weakest of the common second factors and the
 * most expensive: it needs a carrier gateway, it costs per message, it fails
 * where there is no signal, and a SIM swap defeats it. TOTP needs none of
 * that. Nothing is sent anywhere; the phone and the server derive the same
 * six digits from a shared secret and the clock.
 *
 * Cloudflare has no SMS product, so on Workers the alternative to this is
 * always some third party's API. This has no third party at all.
 *
 * HMAC-SHA1 is not a lapse — RFC 6238 specifies it, and every authenticator
 * app implements it. The security rests on the secret, not the digest.
 */

const STEP_SECONDS = 30

/** How many steps either side are accepted, for clock drift. */
const DRIFT_STEPS = 1

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Base32 without padding, the form authenticator apps expect. */
export function toBase32(bytes) {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31]
  return output
}

export function fromBase32(text) {
  const clean = String(text ?? '').toUpperCase().replace(/[^A-Z2-7]/g, '')
  let bits = 0
  let value = 0
  const output = []
  for (const character of clean) {
    const index = BASE32.indexOf(character)
    if (index === -1) continue
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Uint8Array.from(output)
}

/** A fresh secret, as base32 for the user and bytes for the maths. */
export function generateSecret(bytes = 20) {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  return toBase32(buffer)
}

/**
 * The counter for a moment in time.
 * @param {number} seconds  unix time in seconds
 */
export function counterFor(seconds, step = STEP_SECONDS) {
  return Math.floor(seconds / step)
}

async function hmacSha1(keyBytes, messageBytes) {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, messageBytes))
}

/** The 8-byte big-endian counter RFC 4226 hashes. */
function counterBytes(counter) {
  const bytes = new Uint8Array(8)
  let remaining = counter
  for (let index = 7; index >= 0; index -= 1) {
    bytes[index] = remaining & 0xff
    // Divide rather than shift: >>> is 32-bit and would silently truncate a
    // counter past 2^32, which arrives in 2106 but is wrong today too.
    remaining = Math.floor(remaining / 256)
  }
  return bytes
}

/** The code for a given counter. */
export async function codeForCounter(secretBase32, counter, digits = 6) {
  const mac = await hmacSha1(fromBase32(secretBase32), counterBytes(counter))

  // Dynamic truncation, RFC 4226 §5.3.
  const offset = mac[mac.length - 1] & 0x0f
  const binary =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff)

  return String(binary % 10 ** digits).padStart(digits, '0')
}

/** The code right now. `nowSeconds` is injectable so tests are not timing-dependent. */
export async function currentCode(secretBase32, { nowSeconds = Date.now() / 1000, digits = 6 } = {}) {
  return codeForCounter(secretBase32, counterFor(nowSeconds), digits)
}

/**
 * Checks a submitted code.
 *
 * Accepts one step either side, because a phone's clock and a server's are
 * never exactly aligned and rejecting on a second of drift makes the feature
 * feel broken. Wider than that starts meaningfully extending the window an
 * intercepted code stays valid for.
 *
 * Comparison is constant-time — a code is a secret for thirty seconds, and
 * that is long enough to be worth not leaking character by character.
 */
export async function verifyTotp(
  secretBase32,
  submitted,
  { nowSeconds = Date.now() / 1000, digits = 6, drift = DRIFT_STEPS } = {},
) {
  const cleaned = String(submitted ?? '').replace(/\D/g, '')
  if (cleaned.length !== digits) return false

  const counter = counterFor(nowSeconds)
  let matched = false
  for (let offset = -drift; offset <= drift; offset += 1) {
    const expected = await codeForCounter(secretBase32, counter + offset, digits)
    // No early exit: checking every step keeps the work constant regardless of
    // which one matches.
    if (constantTimeEquals(expected, cleaned)) matched = true
  }
  return matched
}

function constantTimeEquals(a, b) {
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }
  return difference === 0
}

/**
 * The otpauth:// URI an authenticator app scans.
 *
 * The issuer appears twice by convention — in the label and as a parameter —
 * because apps disagree about which one they read.
 */
export function otpauthUri(secretBase32, { account, issuer = 'Land Quotient' } = {}) {
  const label = encodeURIComponent(`${issuer}:${account}`)
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: String(STEP_SECONDS),
  })
  return `otpauth://totp/${label}?${params.toString()}`
}
