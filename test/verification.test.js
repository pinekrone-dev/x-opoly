/**
 * Email verification on self-serve signup, and the rate limiter behind it.
 *
 * The rules under test: a stranger's signup earns no session until the
 * emailed link is redeemed, the link works exactly once, resending never
 * reveals whether an address has an account, and signup stays closed unless
 * billing AND email sending are both configured.
 */

import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'

import { createServer } from '../server/index.js'
import { rateLimit, resetRateLimits } from '../app/lib/ratelimit.js'
import { useTempData } from './helpers.js'

const temp = useTempData()
let app

const ENV = {
  STRIPE_SECRET_KEY: 'sk_test_stub',
  RESEND_API_KEY: 're_test_stub',
  STRIPE_EXEMPT_EMAILS: 'owner@example.com,newcomer@example.com',
}

const sentEmails = []
let failSending = false
const realFetch = globalThis.fetch

function client() {
  let cookie = null
  const call = async (path, init = {}) => {
    const response = await app.fetch(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers || {}) },
      }),
    )
    const set = response.headers.get('set-cookie')
    if (set) cookie = set.split(';')[0]
    const text = await response.text()
    let body = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }
    return { status: response.status, body }
  }
  call.cookie = () => cookie
  return call
}

const asJson = (payload, method = 'POST') => ({ method, body: JSON.stringify(payload) })

const lastToken = () => {
  const mail = sentEmails[sentEmails.length - 1]
  return new URL(mail.text.match(/https?:\/\/\S+/)[0]).searchParams.get('verify')
}

before(async () => {
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.resend.com/')) {
      if (failSending) return new Response(JSON.stringify({ message: 'Sending is down.' }), { status: 500 })
      sentEmails.push(JSON.parse(init.body))
      return new Response(JSON.stringify({ id: `email_${sentEmails.length}` }), { status: 200 })
    }
    return realFetch(url, init)
  }

  app = await createServer({ DATA_DIR: temp.directory, DB_FILE: `${temp.directory}/test.db`, ...ENV })

  // The deployment's first account — created in the setup window, no email.
  const owner = client()
  await owner('/api/auth/register', asJson({ name: 'Owner', email: 'owner@example.com', password: 'a long enough password' }))
})

after(() => {
  globalThis.fetch = realFetch
  temp.cleanup()
})

describe('self-serve signup with verification', () => {
  const newcomer = client()
  const ACCOUNT = { name: 'New Broker', email: 'newcomer@example.com', password: 'a long enough password' }

  test('registering sends a link and withholds the session', async () => {
    const joined = await newcomer('/api/auth/register', asJson(ACCOUNT))
    assert.equal(joined.status, 201)
    assert.equal(joined.body.requiresVerification, true)
    assert.equal(newcomer.cookie(), null)
    assert.equal(sentEmails[sentEmails.length - 1].to[0], ACCOUNT.email)
  })

  test('the password alone cannot sign in before the link is used', async () => {
    const denied = await newcomer('/api/auth/login', asJson({ email: ACCOUNT.email, password: ACCOUNT.password }))
    assert.equal(denied.status, 403)
    assert.equal(denied.body.code, 'email_unverified')
  })

  test('a garbage token verifies nothing', async () => {
    assert.equal((await newcomer('/api/auth/verify-email', asJson({ token: 'nope' }))).status, 410)
  })

  test('resending replaces the old link with a fresh one', async () => {
    const stale = lastToken()
    const answer = await newcomer('/api/auth/resend-verification', asJson({ email: ACCOUNT.email }))
    assert.equal(answer.status, 200)
    assert.notEqual(lastToken(), stale)
    assert.equal((await newcomer('/api/auth/verify-email', asJson({ token: stale }))).status, 410, 'the replaced link is dead')
  })

  test('the emailed link verifies the account and signs the browser in', async () => {
    const token = lastToken()
    const confirmed = await newcomer('/api/auth/verify-email', asJson({ token }))
    assert.equal(confirmed.status, 200)
    assert.equal(confirmed.body.user.verified, true)
    assert.ok(newcomer.cookie())
    assert.equal((await newcomer('/api/surveys')).status, 200, 'a verified, exempt account reaches the app')
  })

  test('the link works exactly once', async () => {
    const again = await client()('/api/auth/verify-email', asJson({ token: lastToken() }))
    assert.equal(again.status, 410)
  })

  test('after verification, the password signs in normally', async () => {
    const fresh = client()
    const entered = await fresh('/api/auth/login', asJson({ email: ACCOUNT.email, password: ACCOUNT.password }))
    assert.equal(entered.status, 200)
    assert.ok(fresh.cookie())
  })

  test('resending for a verified or unknown address answers the same 200', async () => {
    const forVerified = await client()('/api/auth/resend-verification', asJson({ email: ACCOUNT.email }))
    const forStranger = await client()('/api/auth/resend-verification', asJson({ email: 'ghost@example.com' }))
    assert.equal(forVerified.status, 200)
    assert.deepEqual(forStranger.body, forVerified.body, 'no signal about which addresses exist')
  })

  test('a failed send is admitted, and resend recovers', async () => {
    failSending = true
    const broken = await client()('/api/auth/register', asJson({
      name: 'Unlucky',
      email: 'unlucky@example.com',
      password: 'a long enough password',
    }))
    failSending = false
    assert.equal(broken.status, 201)
    assert.equal(broken.body.emailFailed, true)

    const retry = client()
    await retry('/api/auth/resend-verification', asJson({ email: 'unlucky@example.com' }))
    const confirmed = await retry('/api/auth/verify-email', asJson({ token: lastToken() }))
    assert.equal(confirmed.status, 200)
  })
})

describe("the operator's email check", () => {
  const signedIn = async (email) => {
    const who = client()
    await who('/api/auth/login', asJson({ email, password: 'a long enough password' }))
    return who
  }

  test('sends the operator a test message and reports the provider that took it', async () => {
    const owner = await signedIn('owner@example.com')
    const before = sentEmails.length
    const answer = await owner('/api/auth/email-check', { method: 'POST' })
    assert.equal(answer.status, 200)
    assert.equal(answer.body.ok, true)
    assert.equal(answer.body.provider, 'resend')
    assert.equal(answer.body.to, 'owner@example.com')
    assert.equal(sentEmails.length, before + 1)
    assert.equal(sentEmails[sentEmails.length - 1].to[0], 'owner@example.com')
  })

  test("a refusal comes back as the provider's own words, not a silent 200", async () => {
    const owner = await signedIn('owner@example.com')
    failSending = true
    const answer = await owner('/api/auth/email-check', { method: 'POST' })
    failSending = false
    assert.equal(answer.status, 502)
    assert.equal(answer.body.ok, false)
    assert.match(answer.body.error, /Sending is down/)
  })

  test('anyone but the operator is refused', async () => {
    const newcomer = await signedIn('newcomer@example.com')
    assert.equal((await newcomer('/api/auth/email-check', { method: 'POST' })).status, 403)
    assert.equal((await client()('/api/auth/email-check', { method: 'POST' })).status, 401)
  })
})

describe('the signup door', () => {
  test('billing without email keeps registration closed', async () => {
    const half = await createServer({
      DATA_DIR: temp.directory,
      DB_FILE: `${temp.directory}/half.db`,
      STRIPE_SECRET_KEY: 'sk_test_stub',
    })
    // Claim the instance first, so the register below is not the setup window.
    await half.fetch(new Request('http://localhost/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'first@example.com', password: 'a long enough password' }),
    }))
    const closed = await half.fetch(new Request('http://localhost/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'second@example.com', password: 'a long enough password' }),
    }))
    assert.equal(closed.status, 403)

    const me = await (await half.fetch(new Request('http://localhost/api/auth/me'))).json()
    assert.equal(me.billing.selfServe, false, 'the frontend is told signup is closed')
  })
})

describe('the rate limiter', () => {
  test('allows up to the limit, then refuses with a retry hint', () => {
    resetRateLimits()
    const opts = { limit: 3, windowMs: 60_000, now: 1_000_000 }
    assert.equal(rateLimit('probe:1.2.3.4', opts).allowed, true)
    assert.equal(rateLimit('probe:1.2.3.4', opts).allowed, true)
    assert.equal(rateLimit('probe:1.2.3.4', opts).allowed, true)
    const refused = rateLimit('probe:1.2.3.4', opts)
    assert.equal(refused.allowed, false)
    assert.ok(refused.retryAfterSeconds >= 1)
  })

  test('the window slides: old hits stop counting', () => {
    resetRateLimits()
    const key = 'probe:5.6.7.8'
    assert.equal(rateLimit(key, { limit: 2, windowMs: 60_000, now: 1_000_000 }).allowed, true)
    assert.equal(rateLimit(key, { limit: 2, windowMs: 60_000, now: 1_010_000 }).allowed, true)
    assert.equal(rateLimit(key, { limit: 2, windowMs: 60_000, now: 1_020_000 }).allowed, false)
    assert.equal(rateLimit(key, { limit: 2, windowMs: 60_000, now: 1_070_000 }).allowed, true, 'the first hit aged out')
  })

  test('keys are independent: one abuser does not close the door', () => {
    resetRateLimits()
    const opts = { limit: 1, windowMs: 60_000, now: 1_000_000 }
    assert.equal(rateLimit('login:attacker', opts).allowed, true)
    assert.equal(rateLimit('login:attacker', opts).allowed, false)
    assert.equal(rateLimit('login:innocent', opts).allowed, true)
  })

  test('the API answers 429 once an endpoint is hammered', async () => {
    resetRateLimits()
    let refused = null
    for (let attempt = 0; attempt < 25 && !refused; attempt += 1) {
      const response = await client()('/api/auth/login', asJson({ email: 'ghost@example.com', password: 'wrong password here' }))
      if (response.status === 429 && response.body.code === 'rate_limited') refused = response
    }
    assert.ok(refused, 'hammering login should trip the limiter')
    resetRateLimits()
  })
})
