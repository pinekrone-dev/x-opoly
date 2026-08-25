/**
 * Tenant isolation: the tests that try to read another team's data.
 *
 * Every one of these must come back 404 — not 403, which would confirm the
 * record exists. One missed route here is one customer reading another's
 * deal pipeline, so this file is deliberately paranoid.
 */

import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'

import { createServer } from '../server/index.js'
import { useTempData } from './helpers.js'

const temp = useTempData()
let app

/**
 * Self-serve signup opens only when billing AND email sending are configured;
 * exemption keeps the subscription gate open for these accounts.
 */
const ENV = {
  STRIPE_SECRET_KEY: 'sk_test_not_called_in_these_tests',
  RESEND_API_KEY: 're_test_stub',
  STRIPE_EXEMPT_EMAILS: 'alice@example.com,bob@example.com,carol@example.com',
}

/** Every email the app "sends" lands here instead of Resend. */
const sentEmails = []
const realFetch = globalThis.fetch

function client() {
  let cookie = null
  const call = async (path, init = {}) => {
    const response = await app.fetch(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          ...(cookie ? { cookie } : {}),
          ...(init.headers || {}),
        },
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

/**
 * Registers a self-serve account and walks the verification flow: the 201
 * carries no session, the emailed link does. Returns the register response.
 */
async function registerVerified(who, payload) {
  const joined = await who('/api/auth/register', asJson(payload))
  assert.equal(joined.status, 201, 'self-serve signup opens when billing and email are configured')
  assert.equal(joined.body.requiresVerification, true)
  assert.equal(who.cookie(), null, 'no session until the email is proven')

  const mail = sentEmails[sentEmails.length - 1]
  assert.equal(mail.to[0], payload.email, 'the link goes to the address that signed up')
  const token = new URL(mail.text.match(/https?:\/\/\S+/)[0]).searchParams.get('verify')
  const confirmed = await who('/api/auth/verify-email', asJson({ token }))
  assert.equal(confirmed.status, 200)
  assert.ok(who.cookie(), 'verification signs the browser in')
  return joined
}

let alice
let bob
let aliceSurvey
let aliceProperty
let aliceImage
let aliceZone

const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
)

before(async () => {
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.resend.com/')) {
      sentEmails.push(JSON.parse(init.body))
      return new Response(JSON.stringify({ id: `email_${sentEmails.length}` }), { status: 200 })
    }
    return realFetch(url, init)
  }

  app = await createServer({ DATA_DIR: temp.directory, DB_FILE: `${temp.directory}/test.db`, ...ENV })

  // The first account claims the deployment; no verification dance needed.
  alice = client()
  await alice('/api/auth/register', asJson({ name: 'Alice', email: 'alice@example.com', password: 'a long enough password' }))

  // Second account: self-serve, its own team, verified by email.
  bob = client()
  await registerVerified(bob, { name: 'Bob', email: 'bob@example.com', password: 'a long enough password' })

  // Alice builds a survey with everything attached.
  const { body: created } = await alice('/api/surveys', asJson({ name: 'Alice deal' }))
  aliceSurvey = created.survey
  const { body: prop } = await alice(`/api/surveys/${aliceSurvey.id}/properties`, asJson({ name: 'Site', lat: 30.1, lng: -97.1 }))
  aliceProperty = prop.property
  const image = await app.fetch(
    new Request(`http://localhost/api/properties/${aliceProperty.id}/images`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', cookie: alice.cookie() },
      body: PNG,
    }),
  )
  aliceImage = (await image.json()).image
  const { body: zone } = await alice(`/api/surveys/${aliceSurvey.id}/zones`, asJson({ label: 'NC', lat: 30.1, lng: -97.1, radiusMiles: 1 }))
  aliceZone = zone.zone
})

after(() => {
  globalThis.fetch = realFetch
  temp.cleanup()
})

describe('tenant isolation', () => {
  test("bob's survey list does not contain alice's work", async () => {
    const { body } = await bob('/api/surveys')
    assert.deepEqual(body.surveys, [])
  })

  test("alice's survey answers 404 to bob, on every verb", async () => {
    assert.equal((await bob(`/api/surveys/${aliceSurvey.id}`)).status, 404)
    assert.equal((await bob(`/api/surveys/${aliceSurvey.id}`, asJson({ name: 'stolen' }, 'PATCH'))).status, 404)
    assert.equal((await bob(`/api/surveys/${aliceSurvey.id}`, { method: 'DELETE' })).status, 404)
    assert.equal((await bob(`/api/surveys/${aliceSurvey.id}/stages`)).status, 404)
    assert.equal((await bob(`/api/surveys/${aliceSurvey.id}/zones`)).status, 404)
    assert.equal((await bob(`/api/surveys/${aliceSurvey.id}/tour`, asJson({ propertyIds: [aliceProperty.id] }))).status, 404)
  })

  test("alice's property answers 404 to bob, on every verb", async () => {
    assert.equal((await bob(`/api/properties/${aliceProperty.id}`, asJson({ name: 'stolen' }, 'PATCH'))).status, 404)
    assert.equal((await bob(`/api/properties/${aliceProperty.id}`, { method: 'DELETE' })).status, 404)
    assert.equal((await bob(`/api/properties/${aliceProperty.id}/images`)).status, 404)
    assert.equal((await bob(`/api/properties/${aliceProperty.id}/extract`, asJson({}))).status, 404)
  })

  test("alice's image and zone answer 404 to bob", async () => {
    assert.equal((await bob(`/api/images/${aliceImage.id}`, asJson({ caption: 'x' }, 'PATCH'))).status, 404)
    assert.equal((await bob(`/api/images/${aliceImage.id}`, { method: 'DELETE' })).status, 404)
    assert.equal((await bob(`/api/zones/${aliceZone.id}`, { method: 'DELETE' })).status, 404)
  })

  test('and none of it was actually touched', async () => {
    const { body } = await alice(`/api/surveys/${aliceSurvey.id}`)
    assert.equal(body.survey.name, 'Alice deal')
    assert.equal(body.properties.length, 1)
    assert.equal(body.properties[0].images.length, 1)
    assert.equal(body.zones.length, 1)
  })

  test("bob's invite brings carol into bob's team, not alice's", async () => {
    const minted = await bob('/api/invites', asJson({ email: 'carol@example.com' }))
    const token = new URL(minted.body.url).searchParams.get('invite')

    const carol = client()
    await carol('/api/auth/register', asJson({
      name: 'Carol',
      email: 'carol@example.com',
      password: 'a long enough password',
      inviteToken: token,
    }))

    await bob('/api/surveys', asJson({ name: 'Bob deal' }))
    const theirs = await carol('/api/surveys')
    assert.deepEqual(theirs.body.surveys.map((survey) => survey.name), ['Bob deal'])
    assert.equal((await carol(`/api/surveys/${aliceSurvey.id}`)).status, 404, "carol cannot see alice's either")
  })

  test("alice's invites are not listed for bob", async () => {
    await alice('/api/invites', asJson({ email: 'friend-of-alice@example.com' }))
    const { body } = await bob('/api/invites')
    assert.ok(!body.invites.some((invite) => invite.email === 'friend-of-alice@example.com'))
  })
})

describe('the subscription gate', () => {
  test('an unexempt team gets 402 on the app, but can still reach auth and billing', async () => {
    const dave = client()
    await registerVerified(dave, { name: 'Dave', email: 'dave@example.com', password: 'a long enough password' })

    const gated = await dave('/api/surveys')
    assert.equal(gated.status, 402)
    assert.equal(gated.body.code, 'subscription_required')

    assert.equal((await dave('/api/auth/me')).status, 200, 'a lapsed subscriber can still sign in')
    const billing = await dave('/api/billing')
    assert.equal(billing.status, 200, 'and reach the payment page')
    assert.equal(billing.body.active, false)
  })

  test('exempt teams never see the gate', async () => {
    assert.equal((await alice('/api/surveys')).status, 200)
  })
})
