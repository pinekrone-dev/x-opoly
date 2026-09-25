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
  claimStartedMail,
  periodEndIso,
  sendTrialReminders,
  setRenewal,
  subscriptionTerms,
  trialDays,
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
import { cancellationEmail, trialReminderEmail, trialStartedEmail } from '../app/lib/email.js'

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
    assert.ok(body.includes('ui_mode=embedded_page'), "Stripe's current name for the embedded form")
    assert.ok(body.includes('return_url=https://survey.example.com/billing/return?session_id={CHECKOUT_SESSION_ID}'))
    assert.equal(fetchImpl.calls.length, 1, 'no fallback when the current name is accepted')
    assert.ok(body.includes('allow_promotion_codes=true'), 'dashboard promo codes work at checkout')
    assert.ok(body.includes('subscription_data[trial_period_days]=14'), 'a new team starts on a 14-day trial')
    assert.ok(body.includes('payment_method_collection=always'), 'the trial takes a card up front')
    assert.ok(
      body.includes('subscription_data[trial_settings][end_behavior][missing_payment_method]=cancel'),
      'a trial that reaches its end with no card is cancelled, not left unpaid',
    )
    assert.equal(result.trialDays, 14)
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
    assert.ok(decodeURIComponent(fetchImpl.calls[0].init.body).includes('ui_mode=embedded_page'))
  })

  test('an account pinned to an older API version gets the old ui_mode name on retry', async () => {
    const fetchImpl = stubFetch(
      { status: 400, body: { error: { message: "Invalid ui_mode: must be one of hosted or embedded" } } },
      { body: { client_secret: 'cs_old' } },
    )
    const result = await createCheckout(db, ENV, {
      teamId: 'team-1',
      email: 'buyer@example.com',
      origin: 'https://survey.example.com',
      fetchImpl,
    })
    assert.equal(result.clientSecret, 'cs_old')
    assert.equal(fetchImpl.calls.length, 2)
    const retry = decodeURIComponent(fetchImpl.calls[1].init.body)
    assert.ok(retry.includes('ui_mode=embedded') && !retry.includes('embedded_page'))
  })

  test('the ui_mode retry never happens for a hosted session or an unrelated refusal', async () => {
    const hostedRefusal = stubFetch({ status: 400, body: { error: { message: 'Invalid ui_mode' } } })
    await assert.rejects(
      createCheckout(db, ENV, { teamId: 'team-1', email: 'x@example.com', origin: 'https://a', hosted: true, fetchImpl: hostedRefusal }),
      BillingError,
    )
    assert.equal(hostedRefusal.calls.length, 1)

    const unrelated = stubFetch({ status: 400, body: { error: { message: 'No such customer: cus_gone' } } })
    await assert.rejects(
      createCheckout(db, ENV, { teamId: 'team-1', email: 'x@example.com', origin: 'https://a', fetchImpl: unrelated }),
      /No such customer/,
    )
    assert.equal(unrelated.calls.length, 1)
  })

  test('asking for hosted overrides the embedded form, so a blocked script is not a dead end', async () => {
    const fetchImpl = stubFetch({ body: { url: 'https://checkout.stripe.com/pay/cs_hosted' } })
    const result = await createCheckout(db, ENV, {
      teamId: 'team-1',
      email: 'buyer@example.com',
      origin: 'https://landquotient.com',
      hosted: true,
      fetchImpl,
    })

    assert.equal(result.embedded, false)
    assert.equal(result.url, 'https://checkout.stripe.com/pay/cs_hosted')

    const body = decodeURIComponent(fetchImpl.calls[0].init.body)
    assert.ok(!body.includes('ui_mode=embedded'), 'a redirect session, not an embedded one')
    assert.ok(body.includes('success_url=https://landquotient.com/billing/return?session_id={CHECKOUT_SESSION_ID}'))
    assert.ok(body.includes('cancel_url=https://landquotient.com/'))
    // The whole point of the fallback is that the promo code still works.
    assert.ok(body.includes('allow_promotion_codes=true'))
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

describe('minting a free code', () => {
  test('creates a 100%-off forever coupon and a single-use promotion code', async () => {
    const { mintFreeCode } = await import('../app/lib/billing.js')
    const fetchImpl = stubFetch({ body: { id: 'coupon_1' } }, { body: { id: 'promo_1', code: 'FREE-XYZ' } })
    const minted = await mintFreeCode({ STRIPE_SECRET_KEY: 'sk_test_stub' }, { fetchImpl })
    assert.equal(minted.code, 'FREE-XYZ')

    const couponBody = decodeURIComponent(fetchImpl.calls[0].init.body)
    assert.ok(fetchImpl.calls[0].url.endsWith('/coupons'))
    assert.ok(couponBody.includes('percent_off=100'))
    assert.ok(couponBody.includes('duration=forever'))

    const promoBody = decodeURIComponent(fetchImpl.calls[1].init.body)
    assert.ok(fetchImpl.calls[1].url.endsWith('/promotion_codes'))
    assert.ok(promoBody.includes('promotion[type]=coupon'), "Stripe's current shape goes first")
    assert.ok(promoBody.includes('promotion[coupon]=coupon_1'))
    assert.ok(promoBody.includes('max_redemptions=1'))
    assert.equal(fetchImpl.calls.length, 2, 'no fallback when the first shape is accepted')
  })

  test('falls back to the bare coupon field on an account pinned to an older API version', async () => {
    const { mintFreeCode } = await import('../app/lib/billing.js')
    const fetchImpl = stubFetch(
      { body: { id: 'coupon_2' } },
      { status: 400, body: { error: { message: 'Received unknown parameter: promotion' } } },
      { body: { id: 'promo_2', code: 'FREE-OLD' } },
    )
    const minted = await mintFreeCode({ STRIPE_SECRET_KEY: 'sk_test_stub' }, { fetchImpl })
    assert.equal(minted.code, 'FREE-OLD')
    assert.equal(fetchImpl.calls.length, 3)
    const retryBody = decodeURIComponent(fetchImpl.calls[2].init.body)
    assert.ok(retryBody.includes('coupon=coupon_2') && !retryBody.includes('promotion['))
  })

  test('any other Stripe refusal is surfaced, not retried', async () => {
    const { mintFreeCode } = await import('../app/lib/billing.js')
    const fetchImpl = stubFetch(
      { body: { id: 'coupon_3' } },
      { status: 402, body: { error: { message: 'Your account cannot currently make live charges.' } } },
    )
    await assert.rejects(() => mintFreeCode({ STRIPE_SECRET_KEY: 'sk_test_stub' }, { fetchImpl }), /live charges/)
    assert.equal(fetchImpl.calls.length, 2)
  })
})

describe('the free trial', () => {
  test('TRIAL_DAYS sets the length, 0 turns it off, and junk falls back to none', () => {
    assert.equal(trialDays({}), 14)
    assert.equal(trialDays({ TRIAL_DAYS: '7' }), 7)
    assert.equal(trialDays({ TRIAL_DAYS: '0' }), 0)
    assert.equal(trialDays({ TRIAL_DAYS: 'soon' }), 0)
  })

  test('a team that has had a subscription gets no second trial', async () => {
    await db.run(
      "INSERT INTO billing (team_id, customer_id, subscription_id, status, updated_at) VALUES ('team-had', 'cus_had', 'sub_had', 'canceled', 'x')",
    )
    const fetchImpl = stubFetch({ body: { client_secret: 'cs' } })
    const result = await createCheckout(db, ENV, { teamId: 'team-had', email: 'b@example.com', origin: 'https://x', fetchImpl })
    const body = decodeURIComponent(fetchImpl.calls[0].init.body)
    assert.ok(!body.includes('trial_period_days'))
    assert.ok(body.includes('customer=cus_had'))
    assert.equal(result.trialDays, 0)
  })

  test('an invite code is applied up front and asks for a card only if something is owed', async () => {
    const fetchImpl = stubFetch({ body: { data: [{ id: 'promo_1' }] } }, { body: { client_secret: 'cs' } })
    const result = await createCheckout(db, ENV, {
      teamId: 'team-invited',
      email: 'friend@example.com',
      origin: 'https://x',
      code: ' FRIEND100 ',
      fetchImpl,
    })
    assert.match(fetchImpl.calls[0].url, /\/promotion_codes\?active=true&limit=1&code=FRIEND100$/)
    assert.equal(fetchImpl.calls[0].init.method, 'GET')
    const body = decodeURIComponent(fetchImpl.calls[1].init.body)
    assert.ok(body.includes('discounts[0][promotion_code]=promo_1'))
    assert.ok(body.includes('payment_method_collection=if_required'))
    assert.ok(!body.includes('allow_promotion_codes'), 'Stripe refuses discounts and the promo field together')
    assert.ok(!body.includes('trial_period_days'))
    assert.equal(result.trialDays, 0)
  })

  test('an unknown code is refused in words the buyer can act on, and no session is made', async () => {
    const fetchImpl = stubFetch({ body: { data: [] } })
    await assert.rejects(
      createCheckout(db, ENV, { teamId: 'team-x', email: 'x@example.com', origin: 'https://x', code: 'NOPE', fetchImpl }),
      /code is not valid/,
    )
    assert.equal(fetchImpl.calls.length, 1)
  })

  test('a trialing subscription is active, and its trial end is stored', async () => {
    const trialEnd = 1790000000
    const fetchImpl = stubFetch({
      body: {
        status: 'complete',
        client_reference_id: 'team-trial',
        customer: 'cus_trial',
        subscription: { id: 'sub_trial', status: 'trialing', trial_end: trialEnd, items: { data: [{ current_period_end: trialEnd }] } },
      },
    })
    const result = await confirmCheckout(db, ENV, 'cs_trial', { fetchImpl })
    assert.equal(result.active, true)
    assert.equal(result.trialEnd, new Date(trialEnd * 1000).toISOString())
    const row = await db.get("SELECT * FROM billing WHERE team_id = 'team-trial'")
    assert.equal(row.status, 'trialing')
    assert.equal(row.trial_end, new Date(trialEnd * 1000).toISOString())
    assert.equal(row.current_period_end, new Date(trialEnd * 1000).toISOString())
  })

  test('the trial-started email is claimed exactly once', async () => {
    assert.equal(await claimStartedMail(db, 'team-trial'), true)
    assert.equal(await claimStartedMail(db, 'team-trial'), false)
  })
})

describe('the period end on current and older Stripe API versions', () => {
  test('read from the items when the subscription no longer carries it', () => {
    const at = 1790000000
    assert.equal(periodEndIso({ items: { data: [{ current_period_end: at }] } }), new Date(at * 1000).toISOString())
    assert.equal(periodEndIso({ current_period_end: at }), new Date(at * 1000).toISOString())
    assert.equal(periodEndIso({ status: 'trialing', trial_end: at }), new Date(at * 1000).toISOString())
    assert.equal(periodEndIso({ status: 'active' }), null)
  })

  test('a stored period end means a paying team costs no Stripe call and no write', async () => {
    const at = Math.floor(Date.now() / 1000) + 20 * 86400
    const refresh = stubFetch({ body: { id: 'sub_items', status: 'active', items: { data: [{ current_period_end: at }] } } })
    await db.run(
      "INSERT INTO billing (team_id, customer_id, subscription_id, status, updated_at) VALUES ('team-items', 'cus_i', 'sub_items', 'active', 'x')",
    )
    await billingState(db, ENV, 'team-items', { fetchImpl: refresh })
    assert.equal(refresh.calls.length, 1, 'a row with no period end is refreshed once')
    const quiet = stubFetch()
    const state = await billingState(db, ENV, 'team-items', { fetchImpl: quiet })
    assert.equal(state.active, true)
    assert.equal(quiet.calls.length, 0, 'and then answered from the row')
  })
})

describe('cancelling and resuming', () => {
  const end = Math.floor(Date.now() / 1000) + 10 * 86400

  test('cancelling stops the renewal at the period end, never at once', async () => {
    await db.run(
      "INSERT INTO billing (team_id, customer_id, subscription_id, status, updated_at) VALUES ('team-c', 'cus_c', 'sub_c', 'trialing', 'x')",
    )
    const fetchImpl = stubFetch({
      body: { id: 'sub_c', status: 'trialing', trial_end: end, cancel_at_period_end: true, cancel_at: end, items: { data: [{ current_period_end: end }] } },
    })
    const result = await setRenewal(db, ENV, 'team-c', false, { fetchImpl })
    const { url, init } = fetchImpl.calls[0]
    assert.equal(url, 'https://api.stripe.com/v1/subscriptions/sub_c')
    assert.equal(init.method, 'POST')
    assert.equal(init.body, 'cancel_at_period_end=true')
    assert.equal(result.cancelAt, new Date(end * 1000).toISOString())
    assert.equal(result.status, 'trialing')
    const row = await db.get("SELECT cancel_at FROM billing WHERE team_id = 'team-c'")
    assert.equal(row.cancel_at, new Date(end * 1000).toISOString())
  })

  test('a cancelled team keeps access until the date, and Stripe is asked the moment it passes', async () => {
    const before = stubFetch()
    const open = await billingState(db, ENV, 'team-c', { fetchImpl: before, now: end * 1000 - 1000 })
    assert.equal(open.active, true)
    assert.equal(open.cancelAt, new Date(end * 1000).toISOString())
    assert.equal(before.calls.length, 0)

    const after = stubFetch({ body: { id: 'sub_c', status: 'canceled', items: { data: [{ current_period_end: end }] } } })
    const closed = await billingState(db, ENV, 'team-c', { fetchImpl: after, now: end * 1000 + 1000 })
    assert.equal(after.calls.length, 1, 'no three days of grace after a cancellation')
    assert.equal(closed.active, false)
  })

  test('resuming clears the cancellation, including a fixed date set on Stripe\'s page', async () => {
    await db.run("UPDATE billing SET status = 'active', cancel_at = 'soon' WHERE team_id = 'team-c'")
    const fetchImpl = stubFetch(
      { body: { id: 'sub_c', status: 'active', cancel_at: end, items: { data: [{ current_period_end: end }] } } },
      { body: { id: 'sub_c', status: 'active', cancel_at: null, cancel_at_period_end: false, items: { data: [{ current_period_end: end }] } } },
    )
    const result = await setRenewal(db, ENV, 'team-c', true, { fetchImpl })
    assert.equal(fetchImpl.calls[0].init.body, 'cancel_at_period_end=false')
    assert.equal(fetchImpl.calls[1].init.body, 'cancel_at=')
    assert.equal(result.cancelAt, null)
    const row = await db.get("SELECT cancel_at FROM billing WHERE team_id = 'team-c'")
    assert.equal(row.cancel_at, null)
  })

  test('a team with no subscription has nothing to cancel', async () => {
    await assert.rejects(setRenewal(db, ENV, 'team-none', false, { fetchImpl: stubFetch() }), BillingError)
  })

  test('the terms read a period-end cancellation even without a fixed date', () => {
    const terms = subscriptionTerms({ status: 'active', cancel_at_period_end: true, items: { data: [{ current_period_end: end }] } })
    assert.equal(terms.cancelAt, new Date(end * 1000).toISOString())
    assert.equal(terms.trialEnd, null)
  })
})

describe('the billing emails', () => {
  const settingsUrl = 'https://landquotient.com/settings'

  test('the cancellation email says when access ends, that nothing more is charged, and how to undo it', () => {
    const mail = cancellationEmail({ name: 'Pat', endsAt: '2026-10-09T12:00:00.000Z', trial: true, settingsUrl })
    assert.match(mail.subject, /cancelled/)
    assert.match(mail.text, /until October 9, 2026/)
    assert.match(mail.text, /will not be charged/)
    assert.match(mail.text, /Resume subscription/)
    assert.ok(mail.html.includes(settingsUrl))
  })

  test('the trial email says when the card is first charged and where to cancel', () => {
    const mail = trialStartedEmail({ name: '', trialEnd: '2026-10-09T12:00:00.000Z', days: 14, settingsUrl })
    assert.match(mail.text, /14-day free trial/)
    assert.match(mail.text, /not be charged before October 9, 2026/)
    assert.match(mail.text, /Settings in the app and choose Cancel subscription/)
  })

  test('neither carries an em dash or a price figure', () => {
    for (const mail of [
      cancellationEmail({ name: 'Pat', endsAt: '2026-10-09T00:00:00Z', trial: false, settingsUrl }),
      trialStartedEmail({ name: 'Pat', trialEnd: '2026-10-09T00:00:00Z', days: 14, settingsUrl }),
    ]) {
      for (const part of [mail.subject, mail.text, mail.html]) {
        assert.ok(!part.includes('\u2014'), 'no em dash')
        assert.ok(!/\$\s?\d/.test(part), 'no price')
      }
    }
  })
})

describe('the reminder a week before a trial ends', () => {
  const now = Date.parse('2026-10-01T16:00:00Z')
  const inDays = (n) => new Date(now + n * 86400e3).toISOString()
  const trialing = (id, endIso, extra = {}) => ({
    id,
    status: 'trialing',
    trial_end: Date.parse(endIso) / 1000,
    items: { data: [{ current_period_end: Date.parse(endIso) / 1000 }] },
    cancel_at: null,
    cancel_at_period_end: false,
    ...extra,
  })

  before(async () => {
    const add = async (team, email, trialEnd, { started = inDays(-7), status = 'trialing' } = {}) => {
      await db.run('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)', [
        team, email, null, 'x', inDays(-7),
      ]).catch(async () => {
        // The users table's required columns vary by version; fall back to the minimum.
        await db.run('INSERT INTO users (id, email) VALUES (?, ?)', [team, email])
      })
      await db.run(
        `INSERT INTO billing (team_id, customer_id, subscription_id, status, trial_end, started_mail_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'x')`,
        [team, `cus_${team}`, `sub_${team}`, status, trialEnd, started],
      )
    }
    await add('r-due', 'due@example.com', inDays(6))
    await add('r-later', 'later@example.com', inDays(10))
    await add('r-past', 'past@example.com', inDays(-1))
    await add('r-new', 'new@example.com', inDays(5), { started: inDays(-1) })
    await add('r-gone', 'gone@example.com', inDays(3))
    await add('r-paid', 'paid@example.com', inDays(4), { status: 'active' })
  })

  test('mails only trials ending inside the week, once, and never one already set to end', async () => {
    const mailed = []
    const fetchImpl = async (url) => {
      const id = String(url).split('/subscriptions/')[1]
      const body = id === 'sub_r-gone' ? trialing(id, inDays(3), { cancel_at_period_end: true }) : trialing(id, inDays(6))
      return new Response(JSON.stringify(body), { status: 200 })
    }
    const tally = await sendTrialReminders(db, ENV, {
      now,
      fetchImpl,
      send: async (team, terms) => mailed.push({ email: team.email, trialEnd: terms.trialEnd }),
    })
    assert.deepEqual(mailed.map((m) => m.email), ['due@example.com'])
    assert.equal(tally.sent, 1)
    assert.equal(tally.skipped, 1, 'the one cancelled on Stripe\'s own page is read fresh and skipped')
    const again = await sendTrialReminders(db, ENV, { now, fetchImpl, send: async () => mailed.push('twice') })
    assert.equal(again.due, 0)
    assert.equal(mailed.length, 1, 'never twice')
  })

  test('a failed send is released for tomorrow rather than lost', async () => {
    await db.run("UPDATE billing SET reminder_mail_at = NULL WHERE team_id = 'r-due'")
    const fetchImpl = async () => new Response(JSON.stringify(trialing('sub_r-due', inDays(6))), { status: 200 })
    const failed = await sendTrialReminders(db, ENV, {
      now,
      fetchImpl,
      send: async () => {
        throw new Error('mail provider down')
      },
    })
    assert.equal(failed.failed, 1)
    const row = await db.get("SELECT reminder_mail_at FROM billing WHERE team_id = 'r-due'")
    assert.equal(row.reminder_mail_at, null)
  })

  test('with no Stripe key nothing is read at all', async () => {
    const tally = await sendTrialReminders(db, {}, { now, send: async () => assert.fail('no send') })
    assert.equal(tally.due, 0)
  })

  test('the reminder names the date and the way out, with no em dash or price', () => {
    const mail = trialReminderEmail({ name: 'Pat', trialEnd: '2026-10-09T12:00:00Z', settingsUrl: 'https://landquotient.com/settings' })
    assert.match(mail.subject, /ends on October 9, 2026/)
    assert.match(mail.text, /Cancel subscription before then/)
    for (const part of [mail.subject, mail.text, mail.html]) {
      assert.ok(!part.includes('\u2014'))
      assert.ok(!/\$\s?\d/.test(part))
    }
  })
})
