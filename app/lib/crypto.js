/**
 * Password hashing, token minting, and constant-time comparison.
 *
 * Everything here uses WebCrypto, which is global on both Node and Workers, so
 * there is no native dependency to compile and no bcrypt/argon2 WASM to ship.
 * PBKDF2 is the strongest KDF available in that set; it is memory-cheap and so
 * weaker against custom hardware than argon2 would be, which is why the
 * iteration count is high rather than nominal.
 */

/** OWASP's floor for PBKDF2-SHA256. Stored per hash so it can be raised. */
const ITERATIONS = 210_000

/**
 * The most iterations one WebCrypto call will accept on Cloudflare Workers.
 *
 * Asking for more does not run slowly — it throws, so signing up failed
 * outright on the deployed Worker while working locally on Node. Rather than
 * cut the work factor to fit, the derivation is chained in runs of this size
 * (see `pbkdf2`), which costs the same and keeps the same total.
 */
const MAX_ITERATIONS_PER_CALL = 100_000

/** Codes live minutes, not months, so they need less stretching than a password. */
const CODE_ITERATIONS = 50_000

const encoder = new TextEncoder()

function toBase64(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(value) {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

/** URL-safe, padding-free — these end up in cookies and links. */
export function randomToken(bytes = 32) {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  return toBase64(buffer).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * A numeric code of `digits` length, drawn from the CSPRNG.
 *
 * Rejection sampling rather than a modulo of a random integer: modulo makes the
 * lowest values fractionally more likely, and while that barely matters for six
 * digits, a biased security code is not worth the two lines it saves.
 */
export function randomCode(digits = 6) {
  const max = 10 ** digits
  const limit = Math.floor(0xffffffff / max) * max
  const buffer = new Uint32Array(1)
  let value
  do {
    crypto.getRandomValues(buffer)
    value = buffer[0]
  } while (value >= limit)
  return String(value % max).padStart(digits, '0')
}

async function deriveBits(material, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', material, 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256,
  )
  return new Uint8Array(bits)
}

/**
 * PBKDF2, in runs no larger than the platform will take.
 *
 * Each run's output becomes the next run's input, so 210,000 iterations is
 * three chained calls rather than one that Workers refuses. The total work is
 * unchanged and the chain is deterministic, so a hash written by one runtime
 * verifies on the other — the chunking is a function of the iteration count
 * recorded in the hash, not of where it was computed.
 */
async function pbkdf2(secret, salt, iterations) {
  let material = typeof secret === 'string' ? encoder.encode(secret) : secret
  let remaining = Math.max(1, Math.floor(iterations))

  while (remaining > 0) {
    const run = Math.min(remaining, MAX_ITERATIONS_PER_CALL)
    material = await deriveBits(material, salt, run)
    remaining -= run
  }

  return material
}

/** `pbkdf2$sha256$<iterations>$<salt>$<hash>` — self-describing, so the cost can change. */
export async function hashPassword(password, iterations = ITERATIONS) {
  const salt = new Uint8Array(16)
  crypto.getRandomValues(salt)
  const hash = await pbkdf2(password, salt, iterations)
  return `pbkdf2$sha256$${iterations}$${toBase64(salt)}$${toBase64(hash)}`
}

/**
 * Verifies a password against a stored hash.
 *
 * Returns false for anything malformed rather than throwing: a corrupt row
 * should fail the login, not crash the endpoint and leak a stack trace.
 */
export async function verifyPassword(password, stored) {
  try {
    const [scheme, algorithm, iterations, salt, hash] = String(stored ?? '').split('$')
    if (scheme !== 'pbkdf2' || algorithm !== 'sha256') return false

    const rounds = Number(iterations)
    if (!Number.isFinite(rounds) || rounds < 1000) return false

    const computed = await pbkdf2(password, fromBase64(salt), rounds)
    return timingSafeEqual(computed, fromBase64(hash))
  } catch {
    return false
  }
}

export async function hashCode(code, salt = null) {
  const bytes = salt ? fromBase64(salt) : crypto.getRandomValues(new Uint8Array(16))
  const hash = await pbkdf2(code, bytes, CODE_ITERATIONS)
  return { salt: toBase64(bytes), hash: toBase64(hash) }
}

export async function verifyCode(code, salt, expected) {
  try {
    const { hash } = await hashCode(code, salt)
    return timingSafeEqual(fromBase64(hash), fromBase64(expected))
  } catch {
    return false
  }
}

/**
 * A session token is stored as its SHA-256, never in the clear.
 *
 * A leaked database then yields no usable sessions. This is a plain digest
 * rather than a KDF on purpose: the token is 256 bits of CSPRNG output, so
 * there is no guessable input to slow an attacker down over.
 */
export async function hashToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token))
  return toBase64(new Uint8Array(digest))
}

/**
 * Compares without leaking where two values diverge.
 *
 * Length is compared first and returns early, which does leak length — for
 * fixed-width digests that is not a secret.
 */
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index += 1) {
    difference |= a[index] ^ b[index]
  }
  return difference === 0
}
