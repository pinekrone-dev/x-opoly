/**
 * Free with an account: FREE_ACCESS turns the subscription gate off and
 * keeps self-serve signup open, so the account is the price of entry, and
 * durable daily limits are what stop a scrape of the records.
 */
import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'

import { freeAccess } from '../app/lib/billing.js'
import { resetRateLimits } from '../app/lib/ratelimit.js'
import { createServer } from '../server/index.js'
import { useTempData } from './helpers.js'

const temp = useTempData()
let app

// Stripe still configured, as in production: free must win over it.
const ENV = {
  STRIPE_SECRET_KEY: 'sk_test_stub',
  RESEND_API_KEY: 're_test_stub',
  FREE_ACCESS: '1',
  SIGNUPS_PER_ADDRESS: '2',
  COUNTY_FILES_PER_ACCOUNT: '2',
}

const sentEmails = []
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
  return call
}

const asJson = (payload) => ({ method: 'POST', body: JSON.stringify(payload) })
const lastToken = () =>
  new URL(sentEmails[sentEmails.length - 1].text.match(/https?:\/\/\S+/)[0]).searchParams.get('verify')

before(async () => {
  resetRateLimits()
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.resend.com/')) {
      sentEmails.push(JSON.parse(init.body))
      return new Response(JSON.stringify({ id: `email_${sentEmails.length}` }), { status: 200 })
    }
    return realFetch(url, init)
  }
  app = await createServer({ DATA_DIR: temp.directory, DB_FILE: `${temp.directory}/test.db`, ...ENV })
  // The deployment's first account, in the setup window.
  await client()('/api/auth/register', asJson({ name: 'Owner', email: 'owner@example.com', password: 'a long enough password' }))
})

after(() => {
  globalThis.fetch = realFetch
  temp.cleanup()
})

describe('free with an account', () => {
  test('the switch reads the way an env var is written', () => {
    assert.equal(freeAccess({ FREE_ACCESS: '1' }), true)
    assert.equal(freeAccess({ FREE_ACCESS: 'true' }), true)
    assert.equal(freeAccess({ FREE_ACCESS: '0' }), false)
    assert.equal(freeAccess({}), false)
  })

  test('the public face says free: no paywall, signup open, no card key', async () => {
    const me = await client()('/api/auth/me')
    assert.equal(me.body.billing.configured, false)
    assert.equal(me.body.billing.free, true)
    assert.equal(me.body.billing.selfServe, true)
    assert.equal(me.body.billing.publishableKey, null)
  })

  const stranger = client()

  test('a stranger signs up, confirms the email, and is in without paying', async () => {
    const joined = await stranger('/api/auth/register', asJson({ name: 'Stranger', email: 'stranger@example.com', password: 'a long enough password' }))
    assert.equal(joined.status, 201)
    assert.equal(joined.body.requiresVerification, true)
    // An account is required: nothing before the email is confirmed.
    assert.equal((await stranger('/api/surveys')).status, 401)
    const confirmed = await stranger('/api/auth/verify-email', asJson({ token: lastToken() }))
    assert.equal(confirmed.status, 200)
    assert.equal((await stranger('/api/surveys')).status, 200, 'no subscription asked for')
    const checkout = await stranger('/api/billing/checkout', asJson({}))
    assert.equal(checkout.status, 400)
    assert.equal(checkout.body.code, 'free')
  })

  test('whole county files are counted per account per day, durably', async () => {
    const statuses = []
    for (let i = 0; i < 3; i += 1) statuses.push((await stranger('/catalog/austin-tx/index.json')).status)
    // The first two get past the limit (and find no bucket in tests); the third is refused.
    assert.notEqual(statuses[0], 429)
    assert.notEqual(statuses[1], 429)
    assert.equal(statuses[2], 429)
  })

  test('signed out, the records stay shut', async () => {
    const nobody = client()
    assert.equal((await nobody('/api/gis/parcels?market=austin-tx')).status, 401)
    assert.equal((await nobody('/catalog/austin-tx/index.json')).status, 401)
  })

  test('one address cannot open accounts faster than the daily cap', async () => {
    // One account from this address already today (the stranger); the cap is two.
    const second = await client()('/api/auth/register', asJson({ name: 'Two', email: 'two@example.com', password: 'a long enough password' }))
    assert.equal(second.status, 201)
    const third = await client()('/api/auth/register', asJson({ name: 'Three', email: 'three@example.com', password: 'a long enough password' }))
    assert.equal(third.status, 429)
    assert.equal(third.body.code, 'signup_limit')
  })
})
