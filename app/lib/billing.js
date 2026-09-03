/**
 * Stripe subscriptions, one per team, at $29/month.
 *
 * Plain fetch against the Stripe API — no SDK — so it runs unchanged on
 * Cloudflare Workers. Two design choices carry the weight:
 *
 * Webhooks are an optimisation, not a dependency. Activation happens when the
 * buyer returns from checkout (the session is fetched and verified
 * server-side), and a lapsed period is lazily re-checked against Stripe the
 * next time the team calls the API. A deployment with no webhook configured
 * is slower to notice a cancellation, never wrong about one.
 *
 * The gate fails closed for strangers and open for the house: teams whose
 * owner is named in STRIPE_EXEMPT_EMAILS (the operator, the smoke-test
 * account) never pay; everyone else needs an active subscription once a
 * STRIPE_SECRET_KEY exists. No key, no gate — the app stays free-standing.
 */

import { nowIso } from './ids.js'
import { timingSafeEqual } from './crypto.js'

const API = 'https://api.stripe.com/v1'

/** Days past the paid-through date before the gate closes. Card retries take time. */
const GRACE_DAYS = 3

/**
 * The configured names are canonical, but the aliases match what was
 * actually typed into the Cloudflare dashboard — renaming a stored secret
 * is harder than accepting both spellings here.
 */
export function secretKey(env = {}) {
  return env.STRIPE_SECRET_KEY || env.STRIPE_KEY || null
}

export function publishableKey(env = {}) {
  return env.STRIPE_PUBLISHABLE_KEY || env.PUBLISHABLE_STRIPE || null
}

export function stripeConfigured(env = {}) {
  return Boolean(secretKey(env))
}

export class BillingError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BillingError'
  }
}

/** Flattens {a: {b: 1}, c: [x]} into Stripe's a[b]=1&c[0]=x form encoding. */
function formEncode(params, prefix = '') {
  const pairs = []
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue
    const name = prefix ? `${prefix}[${key}]` : key
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        if (entry != null && typeof entry === 'object') pairs.push(formEncode(entry, `${name}[${index}]`))
        else pairs.push(`${encodeURIComponent(`${name}[${index}]`)}=${encodeURIComponent(entry)}`)
      })
    } else if (typeof value === 'object') {
      pairs.push(formEncode(value, name))
    } else {
      pairs.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    }
  }
  return pairs.filter(Boolean).join('&')
}

async function stripe(env, path, { method = 'POST', params = null, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${secretKey(env)}`,
      ...(params ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(params ? { body: formEncode(params) } : {}),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    throw new BillingError(body?.error?.message ?? `Stripe returned HTTP ${response.status}.`)
  }
  return body
}

/** The subscription line: a configured price, or $29/month defined inline. */
function lineItem(env) {
  if (env.STRIPE_PRICE_ID) return { price: env.STRIPE_PRICE_ID, quantity: 1 }
  return {
    quantity: 1,
    price_data: {
      currency: 'usd',
      unit_amount: 2900,
      recurring: { interval: 'month' },
      product_data: { name: 'Land Quotient' },
    },
  }
}

/**
 * Starts a checkout for the team.
 *
 * Embedded when the frontend can mount it (publishable key set); hosted
 * redirect otherwise. Either way the return path carries the session id so
 * activation is verified server-side, not assumed from a redirect.
 */
export async function createCheckout(db, env, { teamId, email, origin, hosted = false, fetchImpl = fetch }) {
  const existing = await db.get('SELECT customer_id FROM billing WHERE team_id = ?', [teamId])
  // `hosted` is the client saying the embedded form could not mount — a
  // blocked script, an extension. Stripe gives an embedded session no URL to
  // fall back to, so the redirect version has to be asked for explicitly.
  const embedded = !hosted && Boolean(publishableKey(env))

  const params = (uiMode) => ({
    mode: 'subscription',
    line_items: [lineItem(env)],
    client_reference_id: teamId,
    subscription_data: { metadata: { team_id: teamId } },
    // Promotion codes minted in the Stripe dashboard work at checkout, and a
    // code that brings the total to zero skips card collection entirely —
    // which is how a free user is invited without ever touching env vars.
    allow_promotion_codes: 'true',
    payment_method_collection: 'if_required',
    ...(existing?.customer_id ? { customer: existing.customer_id } : { customer_email: email }),
    ...(embedded
      ? { ui_mode: uiMode, return_url: `${origin}/billing/return?session_id={CHECKOUT_SESSION_ID}` }
      : {
          success_url: `${origin}/billing/return?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${origin}/`,
        }),
  })

  // Stripe renamed the embedded form's ui_mode from `embedded` to
  // `embedded_page` in its recent API versions and refuses the old name
  // there; older pinned versions know only the old name. No version header
  // goes out, so the account's default decides — the current name is tried
  // first, and the old one only when Stripe says it does not know the new.
  // The client secret mounts the same way under either.
  let session
  try {
    session = await stripe(env, '/checkout/sessions', { params: params('embedded_page'), fetchImpl })
  } catch (error) {
    if (!(embedded && error instanceof BillingError && /ui_mode|embedded_page/i.test(error.message))) throw error
    session = await stripe(env, '/checkout/sessions', { params: params('embedded'), fetchImpl })
  }
  return { clientSecret: session.client_secret ?? null, url: session.url ?? null, embedded }
}

async function upsertBilling(db, teamId, { customerId, subscriptionId, status, periodEnd }) {
  await db.run(
    `INSERT INTO billing (team_id, customer_id, subscription_id, status, current_period_end, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(team_id) DO UPDATE SET
       customer_id = COALESCE(excluded.customer_id, billing.customer_id),
       subscription_id = COALESCE(excluded.subscription_id, billing.subscription_id),
       status = excluded.status,
       current_period_end = COALESCE(excluded.current_period_end, billing.current_period_end),
       updated_at = excluded.updated_at`,
    [teamId, customerId ?? null, subscriptionId ?? null, status, periodEnd ?? null, nowIso()],
  )
}

function periodEndIso(subscription) {
  const seconds = subscription?.current_period_end
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null
}

/**
 * Verifies a returned checkout session and records the subscription.
 * The session id comes from the buyer's redirect; everything trusted comes
 * from Stripe's answer, nothing from the URL.
 */
export async function confirmCheckout(db, env, sessionId, { fetchImpl = fetch } = {}) {
  const session = await stripe(env, `/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=subscription`, {
    method: 'GET',
    fetchImpl,
  })
  if (session.status !== 'complete') {
    return { active: false, status: session.status ?? 'incomplete' }
  }

  const teamId = session.client_reference_id
  const subscription = session.subscription
  if (!teamId || !subscription) {
    return { active: false, status: 'incomplete' }
  }

  await upsertBilling(db, teamId, {
    customerId: typeof session.customer === 'string' ? session.customer : session.customer?.id,
    subscriptionId: subscription.id,
    status: subscription.status,
    periodEnd: periodEndIso(subscription),
  })
  return { active: ['active', 'trialing'].includes(subscription.status), status: subscription.status, teamId }
}

/**
 * Mints a single-use, 100%-off-forever promotion code.
 *
 * The operator's way to hand someone the product free without touching the
 * Stripe dashboard: the code goes in at checkout, brings the total to zero,
 * and — because checkout collects no card at zero — the invitee never enters
 * payment details at all.
 */
export async function mintFreeCode(env, { fetchImpl = fetch } = {}) {
  const coupon = await stripe(env, '/coupons', {
    params: { percent_off: 100, duration: 'forever', name: 'Free forever (operator invite)' },
    fetchImpl,
  })
  // Stripe moved the coupon under a `promotion` object in its recent API
  // versions and rejects the bare `coupon` field there; older pinned
  // versions know only the bare field. The request carries no version
  // header, so it lands on whatever the account defaults to — try the
  // current shape, and fall back to the old one only if Stripe says it
  // does not know the parameter.
  let promo
  try {
    promo = await stripe(env, '/promotion_codes', {
      params: { promotion: { type: 'coupon', coupon: coupon.id }, max_redemptions: 1 },
      fetchImpl,
    })
  } catch (error) {
    if (!(error instanceof BillingError && /promotion/i.test(error.message))) throw error
    promo = await stripe(env, '/promotion_codes', {
      params: { coupon: coupon.id, max_redemptions: 1 },
      fetchImpl,
    })
  }
  return { code: promo.code }
}

/** A Stripe-hosted page where the subscriber updates cards or cancels. */
export async function portalUrl(db, env, teamId, returnUrl, { fetchImpl = fetch } = {}) {
  const row = await db.get('SELECT customer_id FROM billing WHERE team_id = ?', [teamId])
  if (!row?.customer_id) throw new BillingError('No subscription exists for this team yet.')
  const session = await stripe(env, '/billing_portal/sessions', {
    params: { customer: row.customer_id, return_url: returnUrl },
    fetchImpl,
  })
  return session.url
}

const ACTIVE = new Set(['active', 'trialing'])

/**
 * Whether the team may use the app right now.
 *
 * Lazy revalidation is the webhook-free path to honesty: while the paid
 * period (plus grace) is running, the stored answer stands; once it lapses,
 * the subscription is re-fetched from Stripe before the gate decides.
 */
export async function billingState(db, env, teamId, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!stripeConfigured(env)) return { active: true, status: 'unmetered' }

  const row = await db.get('SELECT * FROM billing WHERE team_id = ?', [teamId])
  if (!row || !row.subscription_id) return { active: false, status: row?.status ?? 'none' }

  const graceEnd = row.current_period_end
    ? new Date(row.current_period_end).getTime() + GRACE_DAYS * 24 * 60 * 60 * 1000
    : 0

  if (ACTIVE.has(row.status) && now < graceEnd) {
    return { active: true, status: row.status, periodEnd: row.current_period_end }
  }

  // Stored state is stale or inactive — ask Stripe before turning anyone away.
  try {
    const subscription = await stripe(env, `/subscriptions/${encodeURIComponent(row.subscription_id)}`, {
      method: 'GET',
      fetchImpl,
    })
    await upsertBilling(db, teamId, {
      customerId: row.customer_id,
      subscriptionId: subscription.id,
      status: subscription.status,
      periodEnd: periodEndIso(subscription),
    })
    return {
      active: ACTIVE.has(subscription.status),
      status: subscription.status,
      periodEnd: periodEndIso(subscription),
    }
  } catch {
    // Stripe unreachable: the stored answer, however stale, beats locking a
    // paying customer out over an outage that is not theirs.
    return { active: ACTIVE.has(row.status), status: row.status, periodEnd: row.current_period_end }
  }
}

/** Teams whose owner never pays: the operator and the test account. */
export function isExemptEmail(env, email) {
  return String(env.STRIPE_EXEMPT_EMAILS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .includes(String(email ?? '').toLowerCase())
}

/**
 * Verifies a Stripe webhook signature: HMAC-SHA256 of `${t}.${payload}`.
 * Returns the parsed event, or null for anything that does not verify.
 */
export async function verifyWebhook(env, payload, signatureHeader) {
  const secret = env.STRIPE_WEBHOOK_SECRET
  if (!secret || !signatureHeader) return null

  const parts = Object.fromEntries(
    String(signatureHeader)
      .split(',')
      .map((entry) => entry.split('=').map((piece) => piece.trim()))
      .filter((pair) => pair.length === 2),
  )
  if (!parts.t || !parts.v1) return null

  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${parts.t}.${payload}`)))
  const expected = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')

  if (!timingSafeEqual(encoder.encode(expected), encoder.encode(parts.v1))) return null

  try {
    return JSON.parse(payload)
  } catch {
    return null
  }
}

/** Applies a verified webhook event to the billing table. */
export async function applyWebhook(db, event) {
  const kind = event?.type ?? ''
  const object = event?.data?.object

  if (kind === 'checkout.session.completed' && object?.client_reference_id) {
    const subscription = typeof object.subscription === 'string' ? null : object.subscription
    await upsertBilling(db, object.client_reference_id, {
      customerId: typeof object.customer === 'string' ? object.customer : object.customer?.id,
      subscriptionId: typeof object.subscription === 'string' ? object.subscription : subscription?.id,
      status: 'active',
      periodEnd: subscription ? periodEndIso(subscription) : null,
    })
    return true
  }

  if (kind.startsWith('customer.subscription.') && object?.id) {
    const teamId =
      object.metadata?.team_id ??
      (await db.get('SELECT team_id FROM billing WHERE subscription_id = ?', [object.id]))?.team_id
    if (!teamId) return false
    await upsertBilling(db, teamId, {
      customerId: typeof object.customer === 'string' ? object.customer : object.customer?.id,
      subscriptionId: object.id,
      status: kind === 'customer.subscription.deleted' ? 'canceled' : object.status,
      periodEnd: periodEndIso(object),
    })
    return true
  }

  return false
}
