/**
 * Accounts, sessions, and the SMS second factor.
 *
 * The properties worth asserting here are mostly negative: that a wrong
 * password is indistinguishable from an unknown account, that a password alone
 * cannot produce a session when 2FA is on, that a code is good exactly once,
 * and that guessing runs out of road.
 */

import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'

import { createServer } from '../server/index.js'
import { useTempData } from './helpers.js'
import {
  hashPassword,
  randomCode,
  randomToken,
  timingSafeEqual,
  verifyPassword,
} from '../app/lib/crypto.js'
import { SmsUnavailable, sendSms, smsConfigured } from '../app/lib/sms.js'
import { normalizeEmail, normalizePhone } from '../app/lib/auth.js'

const temp = useTempData()
let app

const BASE = 'http://localhost'

before(async () => {
  app = await createServer({ DATA_DIR: temp.directory, DB_FILE: `${temp.directory}/test.db` })
})

after(() => temp.cleanup())

/** Keeps the session cookie between calls, the way a browser would. */
let cookie = null

async function call(path, init = {}) {
  const headers = { ...(init.headers || {}) }
  if (cookie) headers.cookie = cookie

  const response = await app.fetch(new Request(BASE + path, { ...init, headers }))
  const setCookie = response.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0]

  const text = await response.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: response.status, body, setCookie }
}

const asJson = (payload, method = 'POST') => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
})

const ACCOUNT = { email: 'Broker@Example.com', password: 'a-long-enough-secret', name: 'Broker' }

describe('password hashing', () => {
  test('a password verifies against its own hash and nothing else', async () => {
    const hash = await hashPassword('correct horse battery staple', 1000)
    assert.equal(await verifyPassword('correct horse battery staple', hash), true)
    assert.equal(await verifyPassword('correct horse battery stapl', hash), false)
    assert.equal(await verifyPassword('', hash), false)
  })

  test('the hash records its own cost, so it can be raised later', async () => {
    const hash = await hashPassword('secret value here', 2000)
    const [scheme, algorithm, iterations] = hash.split('$')
    assert.equal(scheme, 'pbkdf2')
    assert.equal(algorithm, 'sha256')
    assert.equal(iterations, '2000')
  })

  test('the same password hashes differently every time', async () => {
    // Equal hashes would mean a missing salt, and a rainbow table would work.
    const [a, b] = await Promise.all([hashPassword('same input', 1000), hashPassword('same input', 1000)])
    assert.notEqual(a, b)
  })

  test('no single derivation exceeds what Cloudflare Workers will accept', async () => {
    // Workers refuse a PBKDF2 call above 100,000 iterations outright — they do
    // not run it slowly, they throw. Signing up therefore failed on the
    // deployed Worker while passing every test here, because Node has no such
    // cap. The work factor is kept by chaining runs instead of cutting it.
    const real = crypto.subtle.deriveBits.bind(crypto.subtle)
    const asked = []
    crypto.subtle.deriveBits = (algorithm, key, length) => {
      asked.push(algorithm.iterations)
      return real(algorithm, key, length)
    }

    try {
      const hash = await hashPassword('a long enough password')
      assert.ok(asked.length > 0, 'the derivation ran')
      assert.ok(
        asked.every((count) => count <= 100_000),
        `Workers would reject ${asked.filter((count) => count > 100_000).join(', ')}`,
      )
      assert.equal(
        asked.reduce((total, count) => total + count, 0),
        Number(hash.split('$')[2]),
        'the chained runs add up to the cost the hash claims',
      )
      assert.equal(await verifyPassword('a long enough password', hash), true)
    } finally {
      crypto.subtle.deriveBits = real
    }
  })

  test('a corrupt stored hash fails the login instead of throwing', async () => {
    for (const bad of ['', 'nonsense', 'pbkdf2$sha256$notanumber$x$y', 'bcrypt$2b$12$abc', null]) {
      assert.equal(await verifyPassword('anything', bad), false, `should reject ${bad}`)
    }
  })

  test('a hash with a nonsensically low cost is refused', async () => {
    // Otherwise an attacker who can write the column sets iterations to 1.
    assert.equal(await verifyPassword('x', 'pbkdf2$sha256$1$AAAA$AAAA'), false)
  })
})

describe('random values', () => {
  test('codes are six digits, zero-padded', () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      assert.match(randomCode(6), /^\d{6}$/)
    }
  })

  test('tokens are URL-safe and do not repeat', () => {
    const seen = new Set()
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const token = randomToken(32)
      assert.match(token, /^[A-Za-z0-9_-]+$/)
      assert.equal(seen.has(token), false)
      seen.add(token)
    }
  })

  test('comparison rejects different lengths and different content', () => {
    assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true)
    assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false)
    assert.equal(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])), false)
  })
})

describe('normalising input', () => {
  test('email case and padding never create a second account', () => {
    assert.equal(normalizeEmail('  Broker@Example.COM '), 'broker@example.com')
  })

  test('phone numbers become E.164', () => {
    assert.equal(normalizePhone('(214) 555-0100'), '+12145550100')
    assert.equal(normalizePhone('+44 20 7946 0958'), '+442079460958')
    assert.equal(normalizePhone(''), null)
    assert.equal(normalizePhone(null), null)
  })
})

describe('setting up the first account', () => {
  test('the API is open until an account exists, so the instance is claimable', async () => {
    const status = await call('/api/auth/me')
    assert.equal(status.body.setupRequired, true)

    // Otherwise a fresh deployment would be locked and unrecoverable.
    const surveys = await call('/api/surveys')
    assert.equal(surveys.status, 200)
  })

  test('a weak or malformed account is refused', async () => {
    const short = await call('/api/auth/register', asJson({ email: 'a@b.co', password: 'short' }))
    assert.equal(short.status, 400)

    const bad = await call('/api/auth/register', asJson({ email: 'not-an-email', password: 'a-long-enough-secret' }))
    assert.equal(bad.status, 400)
  })

  test('the first account is created, signed in, and adopts existing work', async () => {
    // A survey made before accounts existed must not become unreachable.
    const orphan = await call('/api/surveys', asJson({ name: 'Made before login existed' }))
    assert.equal(orphan.status, 201)

    const created = await call('/api/auth/register', asJson(ACCOUNT))
    assert.equal(created.status, 201)
    assert.equal(created.body.user.email, 'broker@example.com', 'stored lower-cased')
    assert.ok(created.body.adoptedSurveys >= 1, 'the earlier survey was adopted')
    assert.match(created.setCookie, /HttpOnly/, 'the session cookie is not readable by scripts')
    assert.match(created.setCookie, /SameSite=Lax/)
  })

  test('registration closes once an account exists', async () => {
    const second = await call(
      '/api/auth/register',
      asJson({ email: 'other@example.com', password: 'another-long-secret' }),
    )
    assert.equal(second.status, 403)
  })

  test('the session identifies the account', async () => {
    const me = await call('/api/auth/me')
    assert.equal(me.body.user.email, 'broker@example.com')
    assert.equal(me.body.setupRequired, false)
  })
})

describe('signing in', () => {
  test('a wrong password and an unknown account answer identically', async () => {
    cookie = null
    const wrong = await call('/api/auth/login', asJson({ email: ACCOUNT.email, password: 'wrong-password-here' }))
    const missing = await call('/api/auth/login', asJson({ email: 'nobody@example.com', password: 'wrong-password-here' }))

    // Different wording here would turn the login form into a customer list.
    assert.equal(wrong.status, 401)
    assert.equal(missing.status, 401)
    assert.equal(wrong.body.error, missing.body.error)
  })

  test('the right password signs in and sets a session', async () => {
    cookie = null
    const signedIn = await call('/api/auth/login', asJson({ email: ACCOUNT.email, password: ACCOUNT.password }))
    assert.equal(signedIn.status, 200)
    assert.equal(signedIn.body.twoFactor, false)
    assert.ok(signedIn.setCookie)

    const me = await call('/api/auth/me')
    assert.equal(me.body.user.email, 'broker@example.com')
  })

  test('signing out invalidates the session, not just the cookie', async () => {
    const held = cookie
    await call('/api/auth/logout', { method: 'POST' })

    // Replay the old cookie: a server-side delete means it is already dead.
    cookie = held
    const me = await call('/api/auth/me')
    assert.equal(me.body.user, null)
  })

  test('protected routes reject an anonymous caller once an account exists', async () => {
    cookie = null
    const surveys = await call('/api/surveys')
    assert.equal(surveys.status, 401)
  })

  test('client share links keep working without an account', async () => {
    cookie = null
    // Unknown token, but the point is the route is reachable rather than 401.
    const shared = await call('/api/share/does-not-exist')
    assert.notEqual(shared.status, 401)
  })

  test('repeated failures lock the account for a while', async () => {
    cookie = null
    let locked = null
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await call('/api/auth/login', asJson({ email: ACCOUNT.email, password: `bad-guess-${attempt}` }))
      if (response.status === 429) {
        locked = response
        break
      }
    }
    assert.ok(locked, 'credential stuffing should hit a lockout')
    assert.match(locked.body.error, /try again/i)
  })
})

describe('texting the code', () => {
  test('an unconfigured server says so rather than failing obscurely', async () => {
    assert.equal(smsConfigured({}), false)
    await assert.rejects(
      () => sendSms('+12145550100', 'hello', { env: {} }),
      (error) => error instanceof SmsUnavailable && error.configured === false,
    )
  })

  test('a configured server posts the message to Twilio', async () => {
    let sent = null
    const fetchImpl = async (url, init) => {
      sent = { url, body: init.body, auth: init.headers.authorization }
      return { ok: true, status: 201, json: async () => ({ sid: 'SM1' }) }
    }

    await sendSms('+12145550100', 'Your code is 123456', {
      env: {
        TWILIO_ACCOUNT_SID: 'AC123',
        TWILIO_AUTH_TOKEN: 'token',
        TWILIO_FROM_NUMBER: '+15125550000',
      },
      fetchImpl,
    })

    assert.match(sent.url, /Accounts\/AC123\/Messages\.json$/)
    assert.match(sent.body, /To=%2B12145550100/)
    assert.match(sent.auth, /^Basic /)
  })

  test('rejected credentials are reported as a configuration problem', async () => {
    const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) })
    await assert.rejects(
      () =>
        sendSms('+12145550100', 'x', {
          env: { TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 'bad', TWILIO_FROM_NUMBER: '+1' },
          fetchImpl,
        }),
      (error) => error instanceof SmsUnavailable && error.configured === false,
    )
  })
})

describe('the second factor', () => {
  test('a password alone cannot produce a session once 2FA is on', async () => {
    // A separate instance, so the lockout above and the closed registration on
    // the shared one do not get in the way.
    const scratch = useTempData()
    const server = await createServer({
      DATA_DIR: scratch.directory,
      DB_FILE: `${scratch.directory}/twofactor.db`,
      TWILIO_ACCOUNT_SID: 'AC-test',
      TWILIO_AUTH_TOKEN: 'token',
      TWILIO_FROM_NUMBER: '+15125550000',
    })

    // Capture the outgoing text instead of sending one.
    const realFetch = globalThis.fetch
    let texted = null
    globalThis.fetch = async (url, init) => {
      texted = String(init?.body ?? '')
      return new Response(JSON.stringify({ sid: 'SM1' }), { status: 201 })
    }

    let jar = null
    const hit = async (path, init = {}) => {
      const headers = { ...(init.headers || {}) }
      if (jar) headers.cookie = jar
      const response = await server.fetch(new Request(BASE + path, { ...init, headers }))
      const setCookie = response.headers.get('set-cookie')
      if (setCookie) jar = setCookie.split(';')[0]
      const text = await response.text()
      return { status: response.status, body: text ? JSON.parse(text) : null, setCookie }
    }

    try {
      const registered = await hit(
        '/api/auth/register',
        asJson({ email: 'two@example.com', password: 'a-long-enough-secret', phone: '2145550199' }),
      )
      assert.equal(registered.status, 201)

      const enabled = await hit(
        '/api/auth/2fa',
        asJson({ enabled: true, password: 'a-long-enough-secret' }),
      )
      assert.equal(enabled.status, 200)
      assert.equal(enabled.body.user.sms2fa, true)
      assert.equal(enabled.body.user.phoneHint, '••• ••• 0199', 'only the last digits are exposed')

      jar = null
      const password = await hit(
        '/api/auth/login',
        asJson({ email: 'two@example.com', password: 'a-long-enough-secret' }),
      )
      assert.equal(password.status, 200)
      assert.equal(password.body.twoFactor, true)
      assert.ok(password.body.challengeId)
      assert.equal(password.setCookie, null, 'the password step must not set a session')

      const me = await hit('/api/auth/me')
      assert.equal(me.body.user, null, 'and no session exists yet')

      // The code went to the phone, not to the browser.
      assert.equal(JSON.stringify(password.body).includes('code'), false)
      // Form-encoded, so spaces arrive as "+"; URLSearchParams decodes that
      // correctly where decodeURIComponent does not.
      const body = new URLSearchParams(texted).get('Body') ?? ''
      const code = body.match(/(\d{6}) is your/)?.[1]
      assert.ok(code, `the code is texted (body was: ${body.slice(0, 80)})`)

      const verified = await hit(
        '/api/auth/verify',
        asJson({ challengeId: password.body.challengeId, code }),
      )
      assert.equal(verified.status, 200)
      assert.ok(verified.setCookie, 'the second step is what issues the session')
    } finally {
      globalThis.fetch = realFetch
      scratch.cleanup()
    }
  })

  test('enabling 2FA needs the current password, not just a live session', async () => {
    const scratch = useTempData()
    const server = await createServer({
      DATA_DIR: scratch.directory,
      DB_FILE: `${scratch.directory}/guard.db`,
      TWILIO_ACCOUNT_SID: 'AC-test',
      TWILIO_AUTH_TOKEN: 'token',
      TWILIO_FROM_NUMBER: '+15125550000',
    })

    let jar = null
    const hit = async (path, init = {}) => {
      const headers = { ...(init.headers || {}) }
      if (jar) headers.cookie = jar
      const response = await server.fetch(new Request(BASE + path, { ...init, headers }))
      const setCookie = response.headers.get('set-cookie')
      if (setCookie) jar = setCookie.split(';')[0]
      const text = await response.text()
      return { status: response.status, body: text ? JSON.parse(text) : null }
    }

    try {
      await hit(
        '/api/auth/register',
        asJson({ email: 'guard@example.com', password: 'a-long-enough-secret', phone: '2145550111' }),
      )

      // An unattended logged-in browser must not be able to point the second
      // factor at someone else's phone.
      const withoutPassword = await hit('/api/auth/2fa', asJson({ enabled: true }))
      assert.equal(withoutPassword.status, 403)

      const wrongPassword = await hit(
        '/api/auth/2fa',
        asJson({ enabled: true, password: 'not-the-password' }),
      )
      assert.equal(wrongPassword.status, 403)
    } finally {
      scratch.cleanup()
    }
  })

  test('an authenticator can be enrolled and then satisfies the login', async () => {
    const { currentCode } = await import('../app/lib/totp.js')

    // No Twilio anywhere in this flow — that is the point of TOTP.
    const scratch = useTempData()
    const server = await createServer({
      DATA_DIR: scratch.directory,
      DB_FILE: `${scratch.directory}/totp.db`,
    })

    let jar = null
    const hit = async (path, init = {}) => {
      const headers = { ...(init.headers || {}) }
      if (jar) headers.cookie = jar
      const response = await server.fetch(new Request(BASE + path, { ...init, headers }))
      const setCookie = response.headers.get('set-cookie')
      if (setCookie) jar = setCookie.split(';')[0]
      const text = await response.text()
      return { status: response.status, body: text ? JSON.parse(text) : null, setCookie }
    }

    try {
      await hit(
        '/api/auth/register',
        asJson({ email: 'totp@example.com', password: 'a-long-enough-secret' }),
      )

      const setup = await hit(
        '/api/auth/totp/setup',
        asJson({ password: 'a-long-enough-secret' }),
      )
      assert.equal(setup.status, 200)
      assert.match(setup.body.uri, /^otpauth:\/\/totp\//)
      assert.ok(setup.body.secret)

      // Not on yet: a secret nobody has proved they hold would be a lockout.
      const beforeConfirm = await hit('/api/auth/me')
      assert.equal(beforeConfirm.body.user.totp, false)

      const confirmed = await hit(
        '/api/auth/totp/confirm',
        asJson({ code: await currentCode(setup.body.secret) }),
      )
      assert.equal(confirmed.status, 200)
      assert.equal(confirmed.body.user.totp, true)
      assert.equal(confirmed.body.user.secondFactor, 'totp')

      jar = null
      const password = await hit(
        '/api/auth/login',
        asJson({ email: 'totp@example.com', password: 'a-long-enough-secret' }),
      )
      assert.equal(password.body.twoFactor, true)
      assert.equal(password.body.method, 'totp')
      assert.equal(password.setCookie, null, 'the password step must not set a session')

      const wrong = await hit(
        '/api/auth/verify',
        asJson({ challengeId: password.body.challengeId, code: '000000' }),
      )
      assert.equal(wrong.status, 401)

      const verified = await hit(
        '/api/auth/verify',
        asJson({
          challengeId: password.body.challengeId,
          code: await currentCode(setup.body.secret),
        }),
      )
      assert.equal(verified.status, 200)
      assert.ok(verified.setCookie, 'the authenticator code is what issues the session')
    } finally {
      scratch.cleanup()
    }
  })

  test('an authenticator is preferred over a text when both are on', async () => {
    const { currentCode } = await import('../app/lib/totp.js')

    const scratch = useTempData()
    const server = await createServer({
      DATA_DIR: scratch.directory,
      DB_FILE: `${scratch.directory}/both.db`,
      TWILIO_ACCOUNT_SID: 'AC-test',
      TWILIO_AUTH_TOKEN: 'token',
      TWILIO_FROM_NUMBER: '+15125550000',
    })

    const realFetch = globalThis.fetch
    let textsSent = 0
    globalThis.fetch = async () => {
      textsSent += 1
      return new Response(JSON.stringify({ sid: 'SM1' }), { status: 201 })
    }

    let jar = null
    const hit = async (path, init = {}) => {
      const headers = { ...(init.headers || {}) }
      if (jar) headers.cookie = jar
      const response = await server.fetch(new Request(BASE + path, { ...init, headers }))
      const setCookie = response.headers.get('set-cookie')
      if (setCookie) jar = setCookie.split(';')[0]
      const text = await response.text()
      return { status: response.status, body: text ? JSON.parse(text) : null }
    }

    try {
      await hit(
        '/api/auth/register',
        asJson({ email: 'both@example.com', password: 'a-long-enough-secret', phone: '2145550122' }),
      )
      await hit('/api/auth/2fa', asJson({ enabled: true, password: 'a-long-enough-secret' }))

      const setup = await hit('/api/auth/totp/setup', asJson({ password: 'a-long-enough-secret' }))
      await hit('/api/auth/totp/confirm', asJson({ code: await currentCode(setup.body.secret) }))

      jar = null
      const password = await hit(
        '/api/auth/login',
        asJson({ email: 'both@example.com', password: 'a-long-enough-secret' }),
      )

      // Nothing should have been sent: no carrier, no cost, no SIM to swap.
      assert.equal(password.body.method, 'totp')
      assert.equal(textsSent, 0, 'a text must not be sent when an authenticator is enrolled')
    } finally {
      globalThis.fetch = realFetch
      scratch.cleanup()
    }
  })

  test('a code is good once, and wrong codes run out', async () => {
    const { createChallenge, verifyChallenge } = await import('../app/lib/auth.js')
    const { nodeAdapter } = await import('../app/lib/sql.js')
    const { DatabaseSync } = await import('node:sqlite')

    const database = new DatabaseSync(':memory:')
    const db = nodeAdapter(database)
    await db.migrate()
    await db.run(
      "INSERT INTO users (id, email, password_hash, created_at) VALUES ('u1', 'a@b.co', 'x', '2026-01-01')",
    )

    const { challengeId, code } = await createChallenge(db, 'u1')

    const wrong = await verifyChallenge(db, challengeId, '000000')
    assert.ok(wrong.error, 'a wrong code is rejected')
    assert.equal(wrong.remaining, 4, 'and the attempts left are reported')

    const right = await verifyChallenge(db, challengeId, code)
    assert.equal(right.userId, 'u1')

    // Consumed: replaying the same code must not sign anyone in again.
    const replay = await verifyChallenge(db, challengeId, code)
    assert.ok(replay.error)
  })

  test('a challenge is destroyed after too many wrong codes', async () => {
    const { createChallenge, verifyChallenge } = await import('../app/lib/auth.js')
    const { nodeAdapter } = await import('../app/lib/sql.js')
    const { DatabaseSync } = await import('node:sqlite')

    const database = new DatabaseSync(':memory:')
    const db = nodeAdapter(database)
    await db.migrate()
    await db.run(
      "INSERT INTO users (id, email, password_hash, created_at) VALUES ('u1', 'a@b.co', 'x', '2026-01-01')",
    )

    const { challengeId, code } = await createChallenge(db, 'u1')
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await verifyChallenge(db, challengeId, '111111')
    }

    // Even the correct code must fail now: the challenge is gone.
    const afterwards = await verifyChallenge(db, challengeId, code)
    assert.ok(afterwards.error)
  })

  test('issuing a new challenge invalidates the previous one', async () => {
    const { createChallenge, verifyChallenge } = await import('../app/lib/auth.js')
    const { nodeAdapter } = await import('../app/lib/sql.js')
    const { DatabaseSync } = await import('node:sqlite')

    const database = new DatabaseSync(':memory:')
    const db = nodeAdapter(database)
    await db.migrate()
    await db.run(
      "INSERT INTO users (id, email, password_hash, created_at) VALUES ('u1', 'a@b.co', 'x', '2026-01-01')",
    )

    const first = await createChallenge(db, 'u1')
    await createChallenge(db, 'u1')

    const stale = await verifyChallenge(db, first.challengeId, first.code)
    assert.ok(stale.error, 'an older code must not still work')
  })
})
