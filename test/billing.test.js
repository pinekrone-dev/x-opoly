/**
 * The Stripe layer, exercised against a stubbed fetch.
 *
 * Every call Stripe would receive is captured and inspected: the form
 * encoding it insists on, the checkout parameters that tie a session to a
 * team, the lazy revalidation that keeps the gate honest without webhooks,
 * and the webhook signature check that keeps forged events out.
 */

import assert from 'node:assert/strict'
import test, { before, describe } from 'node:test'

import { DatabaseSync } from 'node:sqlite'

import {
  applyWebhook,
  billingState,
  confirmCheckout,
  createCheckout,
  isExemptEmail,
  portalUrl,
  publishableKey,
  stripeConfigured,
  verifyWebhook,
  BillingError,
} from '../app/lib/billing.js'
import { nodeAdapter } from '../app/lib/sql.js'

const ENV = { STRIPE_SECRET_KEY: 'sk_test_stub', STRIPE_PUBLISHABLE_KEY: 'pk_test_stub' }

let db

before(async () => {
  db = nodeAdapter(new DatabaseSync(':memory:'))
  await db.migrate()
})

/** A fetch stub that records each request and answers from a queue. */
function stubFetch(...responses) {
  const calls = []
  const impl = async (url, init = {}) => {
    calls.push({ url, init })
    const next = responses.shift() ?? { status: 200, body: {} }
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200 })
  }
  impl.calls = calls
  return impl
}

async function signWebhook(secret, payload, timestamp = 1700000000) {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${payload}`)))
  const v1 = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `t=${timestamp},v1=${v1}`
}

describe('configuration and exemptions', () => {
  test('the gate only exists once a secret key does', () => {
    assert.equal(stripeConfigured({}), false)
    assert.equal(stripeConfigured(ENV), true)
  })

  test('the names typed into the Cloudflare dashboard work as-is', () => {
    assert.equal(stripeConfigured({ STRIPE_KEY: 'sk_test_alias' }), true)
    assert.equal(publishableKey({ PUBLISHABLE_STRIPE: 'pk_test_alias' }), 'pk_test_alias')
    assert.equal(publishableKey({ STRIPE_PUBLISHABLE_KEY: 'pk_a', PUBLISHABLE_STRIPE: 'pk_b' }), 'pk_a')
  })

  test('exempt emails match case-insensitively and tolerate spacing', () => {
    const env = { STRIPE_EXEMPT_EMAILS: ' Kevin@Example.com , smoke@example.com ' }
    assert.equal(isExemptEmail(env, 'kevin@example.com'), true)
    assert.equal(isExemptEmail(env, 'SMOKE@EXAMPLE.COM'), true)
    assert.equal(isExemptEmail(env, 'stranger@example.com'), false)
    assert.equal(isExemptEmail({}, 'anyone@example.com'), false)
  })
})

describe('creating a checkout', () => {
  test('sends the $29/month inline price, the team id, and the embedded return url', async () => {
    const fetchImpl = stubFetch({ body: { client_secret: 'cs_secret', url: null } })
    const result = await createCheckout(db, ENV, {
      teamId: 'team-1',
      email: 'buyer@example.com',
      origin: 'https://survey.example.com',
      fetchImpl,
    })

    assert.equal(result.embedded, true)
    assert.equal(result.clientSecret, 'cs_secret')

    const { url, init } = fetchImpl.calls[0]
    assert.equal(url, 'https://api.stripe.com/v1/checkout/sessions')
    assert.equal(init.headers.authorization, 'Bearer sk_test_stub')

    const body = decodeURIComponent(init.body)
    assert.ok(body.includes('mode=subscription'))
    assert.ok(body.includes('line_items[0][price_data][unit_amount]=2900'))
    assert.ok(body.includes('line_items[0][price_data][recurring][interval]=month'))
    assert.ok(body.includes('client_reference_id=team-1'))
    assert.ok(body.includes('subscription_data[metadata][team_id]=team-1'))
    assert.ok(body.includes('customer_email=buyer@example.com'))
    assert.ok(body.includes('ui_mode=embedded'))
    assert.ok(body.includes('return_url=https://survey.example.com/billing/return?session_id={CHECKOUT_SESSION_ID}'))
    assert.ok(body.includes('allow_promotion_codes=true'), 'dashboard promo codes work at checkout')
    assert.ok(
      body.includes('payment_method_collection=if_required'),
      'a 100%-off code needs no card at all',
    )
  })

  test('a secret key under the alias name still reaches Stripe', async () => {
    const fetchImpl = stubFetch({ body: {} })
    await createCheckout(db, { STRIPE_KEY: 'sk_test_alias', PUBLISHABLE_STRIPE: 'pk_test_alias' }, {
      teamId: 'team-1',
      email: 'buyer@example.com',
      origin: 'https://survey.example.com',
      fetchImpl,
    })
    assert.equal(fetchImpl.calls[0].init.headers.authorization, 'Bearer sk_test_alias')
    assert.ok(decodeURIComponent(fetchImpl.calls[0].init.body).includes('ui_mode=embedded'))
  })

  test('a configured price id replaces the inline price', async () => {
    const fetchImpl = stubFetch({ body: {} })
    await createCheckout(db, { ...ENV, STRIPE_PRICE_ID: 'price_123' }, {
      teamId: 'team-1',
      email: 'buyer@example.com',
      origin: 'https://survey.example.com',
      fetchImpl,
    })
    const body = decodeURIComponent(fetchImpl.calls[0].init.body)
    assert.ok(body.includes('line_items[0][price]=price_123'))
    assert.ok(!body.includes('price_data'))
  })

  test('without a publishable key, checkout falls back to a hosted redirect', async () => {
    const fetchImpl = stubFetch({ body: { url: 'https://checkout.stripe.com/pay/cs_x' } })
    const result = await createCheckout(db, { STRIPE_SECRET_KEY: 'sk_test_stub' }, {
      teamId: 'team-1',
      email: 'buyer@example.com',
      origin: 'https://survey.example.com',
      fetchImpl,
    })
    assert.equal(result.embedded, false)
    assert.equal(result.url, 'https://checkout.stripe.com/pay/cs_x')
    const body = decodeURIComponent(fetchImpl.calls[0].init.body)
    assert.ok(body.includes('success_url='))
    assert.ok(body.includes('cancel_url=https://survey.example.com/'))
  })

  test('a Stripe error surfaces as a BillingError with Stripe wording', async () => {
    const fetchImpl = stubFetch({ status: 402, body: { error: { message: 'Your card was declined.' } } })
    await assert.rejects(
      createCheckout(db, ENV, { teamId: 'team-1', email: 'x@example.com', origin: 'https://a', fetchImpl }),
      (error) => error instanceof BillingError && error.message === 'Your card was declined.',
    )
  })
})

describe('confirming a checkout', () => {
  test('a complete session activates the team and stores the subscription', async () => {
    const periodEnd = Math.floor(Date.parse('2026-09-25T00:00:00Z') / 1000)
    const fetchImpl = stubFetch({
      body: {
        status: 'complete',
        client_reference_id: 'team-confirm',
        customer: 'cus_1',
        subscription: { id: 'sub_1', status: 'active', current_period_end: periodEnd },
      },
    })

    const result = await confirmCheckout(db, ENV, 'cs_test_1', { fetchImpl })
    assert.equal(result.active, true)
    assert.equal(result.teamId, 'team-confirm')
    assert.ok(fetchImpl.calls[0].url.includes('/checkout/sessions/cs_test_1'))
    assert.ok(fetchImpl.calls[0].url.includes('expand[]=subscription'))

    const row = await db.get('SELECT * FROM billing WHERE team_id = ?', ['team-confirm'])
    assert.equal(row.customer_id, 'cus_1')
    assert.equal(row.subscription_id, 'sub_1')
    assert.equal(row.status, 'active')
    assert.equal(row.current_period_end, '2026-09-25T00:00:00.000Z')
  })

  test('an open session activates nothing', async () => {
    const fetchImpl = stubFetch({ body: { status: 'open', client_reference_id: 'team-open' } })
    const result = await confirmCheckout(db, ENV, 'cs_test_2', { fetchImpl })
    assert.equal(result.active, false)
    assert.ok(!(await db.get('SELECT * FROM billing WHERE team_id = ?', ['team-open'])))
  })
})

describe('the billing state', () => {
  test('no Stripe key means no gate at all', async () => {
    const state = await billingState(db, {}, 'any-team')
    assert.equal(state.active, true)
    assert.equal(state.status, 'unmetered')
  })

  test('a team with no subscription is inactive without calling Stripe', async () => {
    const fetchImpl = stubFetch()
    const state = await billingState(db, ENV, 'team-nobody', { fetchImpl })
    assert.equal(state.active, false)
    assert.equal(fetchImpl.calls.length, 0)
  })

  test('inside the paid period the stored answer stands, no Stripe call', async () => {
    const periodEnd = Math.floor(Date.parse('2026-09-25T00:00:00Z') / 1000)
    await confirmCheckout(db, ENV, 'cs_paid', {
      fetchImpl: stubFetch({
        body: {
          status: 'complete',
          client_reference_id: 'team-paid',
          customer: 'cus_2',
          subscription: { id: 'sub_2', status: 'active', current_period_end: periodEnd },
        },
      }),
    })

    const fetchImpl = stubFetch()
    const state = await billingState(db, ENV, 'team-paid', {
      fetchImpl,
      now: Date.parse('2026-09-01T00:00:00Z'),
    })
    assert.equal(state.active, true)
    assert.equal(fetchImpl.calls.length, 0, 'the stored period answers without a Stripe round trip')
  })

  test('grace covers the days right after the period, then Stripe is asked', async () => {
    const inGrace = await billingState(db, ENV, 'team-paid', {
      fetchImpl: stubFetch(),
      now: Date.parse('2026-09-27T00:00:00Z'),
    })
    assert.equal(inGrace.active, true, 'two days past the period end is still inside grace')

    const renewed = Math.floor(Date.parse('2026-10-25T00:00:00Z') / 1000)
    const fetchImpl = stubFetch({ body: { id: 'sub_2', status: 'active', current_period_end: renewed } })
    const after = await billingState(db, ENV, 'team-paid', { fetchImpl, now: Date.parse('2026-09-29T00:00:00Z') })
    assert.equal(after.active, true)
    assert.equal(fetchImpl.calls.length, 1, 'past grace, the subscription is re-fetched')
    assert.ok(fetchImpl.calls[0].url.includes('/subscriptions/sub_2'))
  })

  test('a canceled answer from Stripe closes the gate', async () => {
    const fetchImpl = stubFetch({ body: { id: 'sub_2', status: 'canceled', current_period_end: null } })
    const state = await billingState(db, ENV, 'team-paid', { fetchImpl, now: Date.parse('2026-12-25T00:00:00Z') })
    assert.equal(state.active, false)
    assert.equal(state.status, 'canceled')
  })

  test('when Stripe is unreachable, the stored answer stands rather than locking anyone out', async () => {
    await confirmCheckout(db, ENV, 'cs_outage', {
      fetchImpl: stubFetch({
        body: {
          status: 'complete',
          client_reference_id: 'team-outage',
          customer: 'cus_3',
          subscription: {
            id: 'sub_3',
            status: 'active',
            current_period_end: Math.floor(Date.parse('2026-09-25T00:00:00Z') / 1000),
          },
        },
      }),
    })

    const failing = async () => {
      throw new Error('network down')
    }
    const state = await billingState(db, ENV, 'team-outage', { fetchImpl: failing, now: Date.parse('2026-12-01T00:00:00Z') })
    assert.equal(state.active, true, 'stale-active beats wrongly-locked-out during an outage')
  })
})

describe('the billing portal', () => {
  test('a subscribed team gets a portal url', async () => {
    const fetchImpl = stubFetch({ body: { url: 'https://billing.stripe.com/p/session_x' } })
    const url = await portalUrl(db, ENV, 'team-paid', 'https://survey.example.com/', { fetchImpl })
    assert.equal(url, 'https://billing.stripe.com/p/session_x')
    const body = decodeURIComponent(fetchImpl.calls[0].init.body)
    assert.ok(body.includes('customer=cus_2'))
  })

  test('a team that never subscribed cannot open the portal', async () => {
    await assert.rejects(portalUrl(db, ENV, 'team-nobody', 'https://a/', { fetchImpl: stubFetch() }), BillingError)
  })
})

describe('webhooks', () => {
  const SECRET = 'whsec_test'

  test('a correctly signed payload verifies and parses', async () => {
    const payload = JSON.stringify({ type: 'customer.subscription.updated', data: { object: { id: 'sub_9' } } })
    const header = await signWebhook(SECRET, payload)
    const event = await verifyWebhook({ STRIPE_WEBHOOK_SECRET: SECRET }, payload, header)
    assert.equal(event.type, 'customer.subscription.updated')
  })

  test('a tampered payload does not verify', async () => {
    const header = await signWebhook(SECRET, '{"type":"real"}')
    assert.equal(await verifyWebhook({ STRIPE_WEBHOOK_SECRET: SECRET }, '{"type":"forged"}', header), null)
  })

  test('the wrong secret, a missing header, and no configured secret all fail closed', async () => {
    const payload = '{"type":"x"}'
    const header = await signWebhook('whsec_other', payload)
    assert.equal(await verifyWebhook({ STRIPE_WEBHOOK_SECRET: SECRET }, payload, header), null)
    assert.equal(await verifyWebhook({ STRIPE_WEBHOOK_SECRET: SECRET }, payload, null), null)
    assert.equal(await verifyWebhook({}, payload, header), null)
  })

  test('subscription events land on the team via metadata, and deletion cancels', async () => {
    const applied = await applyWebhook(db, {
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_meta',
          customer: 'cus_meta',
          status: 'past_due',
          metadata: { team_id: 'team-hook' },
          current_period_end: Math.floor(Date.parse('2026-10-01T00:00:00Z') / 1000),
        },
      },
    })
    assert.equal(applied, true)
    assert.equal((await db.get('SELECT status FROM billing WHERE team_id = ?', ['team-hook'])).status, 'past_due')

    await applyWebhook(db, {
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_meta', customer: 'cus_meta', status: 'canceled', metadata: {} } },
    })
    assert.equal(
      (await db.get('SELECT status FROM billing WHERE team_id = ?', ['team-hook'])).status,
      'canceled',
      'without metadata the event still finds the team by subscription id',
    )
  })

  test('an unrelated event applies nothing', async () => {
    assert.equal(await applyWebhook(db, { type: 'invoice.finalized', data: { object: { id: 'in_1' } } }), false)
  })
})
