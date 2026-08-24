/**
 * Authenticator-app codes.
 *
 * RFC 6238 publishes test vectors, so this is checked against the standard
 * itself rather than against my own idea of what the answer should be. That
 * matters more than usual here: a TOTP implementation that is subtly wrong
 * still produces six plausible digits, and the only way to notice is that
 * nobody's phone agrees with it.
 */

import assert from 'node:assert/strict'
import test, { describe } from 'node:test'

import {
  codeForCounter,
  counterFor,
  currentCode,
  fromBase32,
  generateSecret,
  otpauthUri,
  toBase32,
  verifyTotp,
} from '../app/lib/totp.js'

/** RFC 6238 Appendix B: the ASCII secret "12345678901234567890". */
const RFC_SECRET = toBase32(new TextEncoder().encode('12345678901234567890'))

describe('base32', () => {
  test('round-trips arbitrary bytes', () => {
    const bytes = Uint8Array.from([0, 1, 127, 128, 255, 42, 7])
    assert.deepEqual(Array.from(fromBase32(toBase32(bytes))), Array.from(bytes))
  })

  test('encodes the RFC secret as authenticator apps expect', () => {
    assert.equal(RFC_SECRET, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
  })

  test('tolerates the spaces and lower case people paste', () => {
    const secret = generateSecret()
    const messy = secret.toLowerCase().replace(/(.{4})/g, '$1 ')
    assert.deepEqual(Array.from(fromBase32(messy)), Array.from(fromBase32(secret)))
  })
})

describe('RFC 6238 test vectors', () => {
  // Time, then the eight-digit code the standard says SHA1 must produce.
  const VECTORS = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ]

  for (const [seconds, expected] of VECTORS) {
    test(`T=${seconds} produces ${expected}`, async () => {
      const code = await codeForCounter(RFC_SECRET, counterFor(seconds), 8)
      assert.equal(code, expected)
    })
  }

  test('the largest vector proves the counter is not truncated to 32 bits', async () => {
    // T=20000000000 puts the counter past 2^32 / 30. Building the counter with
    // a 32-bit shift instead of division silently produces the wrong code here
    // and the right one everywhere else.
    assert.equal(await codeForCounter(RFC_SECRET, counterFor(20000000000), 8), '65353130')
  })
})

describe('verifying a submitted code', () => {
  const NOW = 1700000000

  test('accepts the code for right now', async () => {
    const code = await currentCode(RFC_SECRET, { nowSeconds: NOW })
    assert.equal(await verifyTotp(RFC_SECRET, code, { nowSeconds: NOW }), true)
  })

  test('accepts one step of drift either way', async () => {
    // Phones and servers are never exactly aligned; rejecting a second of
    // skew makes the feature feel broken.
    const before = await codeForCounter(RFC_SECRET, counterFor(NOW) - 1)
    const after = await codeForCounter(RFC_SECRET, counterFor(NOW) + 1)

    assert.equal(await verifyTotp(RFC_SECRET, before, { nowSeconds: NOW }), true)
    assert.equal(await verifyTotp(RFC_SECRET, after, { nowSeconds: NOW }), true)
  })

  test('rejects a code two steps stale', async () => {
    const old = await codeForCounter(RFC_SECRET, counterFor(NOW) - 2)
    assert.equal(await verifyTotp(RFC_SECRET, old, { nowSeconds: NOW }), false)
  })

  test('rejects a code from a different secret', async () => {
    const other = generateSecret()
    const code = await currentCode(other, { nowSeconds: NOW })
    assert.equal(await verifyTotp(RFC_SECRET, code, { nowSeconds: NOW }), false)
  })

  test('rejects malformed input rather than throwing', async () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', null, undefined]) {
      assert.equal(await verifyTotp(RFC_SECRET, bad, { nowSeconds: NOW }), false, `for ${bad}`)
    }
  })

  test('tolerates the spaces people type between digit groups', async () => {
    const code = await currentCode(RFC_SECRET, { nowSeconds: NOW })
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`
    assert.equal(await verifyTotp(RFC_SECRET, spaced, { nowSeconds: NOW }), true)
  })
})

describe('enrolling a phone', () => {
  test('secrets are unique and long enough', () => {
    const seen = new Set()
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const secret = generateSecret()
      assert.equal(fromBase32(secret).length, 20, '160 bits, as RFC 4226 recommends')
      assert.equal(seen.has(secret), false)
      seen.add(secret)
    }
  })

  test('the otpauth URI carries what an authenticator needs', () => {
    const uri = otpauthUri('ABCDEFGH', { account: 'broker@example.com', issuer: 'SiteSurvey CRE' })
    assert.match(uri, /^otpauth:\/\/totp\//)
    assert.match(uri, /secret=ABCDEFGH/)
    assert.match(uri, /issuer=SiteSurvey\+CRE/)
    assert.match(uri, /period=30/)
    // The issuer appears in the label too, because apps disagree about which
    // one they read.
    assert.match(decodeURIComponent(uri), /SiteSurvey CRE:broker@example\.com/)
  })
})
