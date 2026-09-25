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
 *
 * A new team starts on a free trial (TRIAL_DAYS, 14 unless set; 0 turns it
 * off) and gives a card to start it, so the trial becomes a subscription
 * without a second decision. A team that has had a subscription before gets
 * no second trial. Cancelling is one button in Settings: it stops the renewal
 * at the end of the period already running, so a trial cancelled on day two
 * is never charged and keeps its remaining days.
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

/** Trial length for a new team, from TRIAL_DAYS; 14 when unset, none at 0. */
export function trialDays(env = {}) {
  const raw = env.TRIAL_DAYS
  if (raw == null || String(raw).trim() === '') return 14
  const days = Math.floor(Number(raw))
  return Number.isFinite(days) && days > 0 ? Math.min(days, 730) : 0
}

/** Whether this team may still start a trial: it has never had a subscription. */
export async function trialEligible(db, env, teamId) {
  if (!trialDays(env)) return false
  const row = await db.get('SELECT subscription_id FROM billing WHERE team_id = ?', [teamId])
  return !row?.subscription_id
}

/**
 * The live promotion code a buyer typed, or a BillingError saying it is not.
 *
 * Invite codes are resolved here rather than in Stripe's own promo field
 * because the trial needs a card and an invite must not: Stripe collects
 * cards per checkout, not per code, so a checkout that already carries the
 * code is the only one that can skip the card.
 */
async function promotionCode(env, code, fetchImpl) {
  const found = await stripe(
    env,
    `/promotion_codes?active=true&limit=1&code=${encodeURIComponent(String(code).trim())}`,
    { method: 'GET', fetchImpl },
  )
  const promo = found?.data?.[0]
  if (!promo?.id) throw new BillingError('That code is not valid, or it has already been used.')
  return promo.id
}

/**
 * Starts a checkout for the team.
 *
 * Embedded when the frontend can mount it (publishable key set); hosted
 * redirect otherwise. Either way the return path carries the session id so
 * activation is verified server-side, not assumed from a redirect.
 *
 * Two shapes. The usual one opens the trial and always takes a card, with
 * Stripe's promo field left open for partial discounts. The other carries an
 * invite code the buyer typed before checkout: the discount is applied up
 * front and the card is asked for only if something is still owed, so a
 * free-forever invite never touches payment details.
 */
export async function createCheckout(db, env, { teamId, email, origin, hosted = false, code = null, fetchImpl = fetch }) {
  const existing = await db.get('SELECT customer_id, subscription_id FROM billing WHERE team_id = ?', [teamId])
  // `hosted` is the client saying the embedded form could not mount — a
  // blocked script, an extension. Stripe gives an embedded session no URL to
  // fall back to, so the redirect version has to be asked for explicitly.
  const embedded = !hosted && Boolean(publishableKey(env))
  const promotion = code ? await promotionCode(env, code, fetchImpl) : null
  const trial = !promotion && !existing?.subscription_id ? trialDays(env) : 0

  const params = (uiMode) => ({
    mode: 'subscription',
    line_items: [lineItem(env)],
    client_reference_id: teamId,
    subscription_data: {
      metadata: { team_id: teamId },
      ...(trial
        ? {
            trial_period_days: trial,
            // A trial that somehow reaches its end with no card is cancelled,
            // never left running unpaid.
            trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
          }
        : {}),
    },
    ...(promotion
      ? { discounts: [{ promotion_code: promotion }], payment_method_collection: 'if_required' }
      : { allow_promotion_codes: 'true', payment_method_collection: 'always' }),
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
  return { clientSecret: session.client_secret ?? null, url: session.url ?? null, embedded, trialDays: trial }
}

/**
 * Records what Stripe said about a team's subscription.
 *
 * `terms` carries the trial end and scheduled cancellation, and is passed
 * only when a whole subscription object was read: those two are set exactly,
 * so a resumed subscription clears its cancel date. Callers holding less (a
 * checkout event with no subscription expanded) leave both as they were.
 */
async function upsertBilling(db, teamId, { customerId, subscriptionId, status, periodEnd, terms = null }) {
  await db.run(
    `INSERT INTO billing (team_id, customer_id, subscription_id, status, current_period_end, trial_end, cancel_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(team_id) DO UPDATE SET
       customer_id = COALESCE(excluded.customer_id, billing.customer_id),
       subscription_id = COALESCE(excluded.subscription_id, billing.subscription_id),
       status = excluded.status,
       current_period_end = COALESCE(excluded.current_period_end, billing.current_period_end),
       trial_end = ${terms ? 'excluded.trial_end' : 'billing.trial_end'},
       cancel_at = ${terms ? 'excluded.cancel_at' : 'billing.cancel_at'},
       updated_at = excluded.updated_at`,
    [
      teamId,
      customerId ?? null,
      subscriptionId ?? null,
      status,
      periodEnd ?? null,
      terms?.trialEnd ?? null,
      terms?.cancelAt ?? null,
      nowIso(),
    ],
  )
}

const iso = (seconds) => (Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null)

/**
 * When the period now running ends.
 *
 * Stripe moved the period off the subscription and onto each item in its
 * recent API versions, and the account has no pinned version, so the old
 * top-level field reads undefined there. Reading only that one stored every
 * period end as NULL, and a NULL period end made the gate ask Stripe, and
 * write a row, on every request a paying team made. Both places are read,
 * then the trial's end.
 */
export function periodEndIso(subscription) {
  if (!subscription) return null
  const top = iso(subscription.current_period_end)
  if (top) return top
  const items = (subscription.items?.data ?? [])
    .map((item) => item?.current_period_end)
    .filter((seconds) => Number.isFinite(seconds))
  if (items.length) return iso(Math.max(...items))
  return subscription.status === 'trialing' ? iso(subscription.trial_end) : null
}

/** The trial end and any scheduled cancellation, from a whole subscription. */
export function subscriptionTerms(subscription) {
  const trialEnd = subscription?.status === 'trialing' ? iso(subscription.trial_end) : null
  const cancelAt =
    iso(subscription?.cancel_at) ?? (subscription?.cancel_at_period_end ? periodEndIso(subscription) : null)
  return { trialEnd, cancelAt }
}

function record(db, teamId, subscription, customerId) {
  return upsertBilling(db, teamId, {
    customerId: customerId ?? (typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id),
    subscriptionId: subscription.id,
    status: subscription.status,
    periodEnd: periodEndIso(subscription),
    terms: subscriptionTerms(subscription),
  })
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

  await record(db, teamId, subscription, typeof session.customer === 'string' ? session.customer : session.customer?.id)
  return {
    active: ['active', 'trialing'].includes(subscription.status),
    status: subscription.status,
    teamId,
    ...subscriptionTerms(subscription),
  }
}

/**
 * Claims the one "your trial has started" email for a team. True exactly
 * once, however many times the return page is loaded.
 */
export async function claimStartedMail(db, teamId) {
  const { changes } = await db.run(
    'UPDATE billing SET started_mail_at = ? WHERE team_id = ? AND started_mail_at IS NULL',
    [nowIso(), teamId],
  )
  return changes === 1
}

/**
 * Stops the team's subscription renewing, or starts it renewing again.
 *
 * Cancelling sets cancel_at_period_end, never an immediate cancel: the
 * subscriber keeps what they have paid for, or the trial days they have
 * left, and nothing further is charged. Resuming clears it, which Stripe
 * allows until that date passes. Returns the stored state afterwards.
 */
export async function setRenewal(db, env, teamId, renew, { fetchImpl = fetch } = {}) {
  const row = await db.get('SELECT customer_id, subscription_id FROM billing WHERE team_id = ?', [teamId])
  if (!row?.subscription_id) throw new BillingError('This workspace has no subscription to change.')
  const path = `/subscriptions/${encodeURIComponent(row.subscription_id)}`
  let subscription = await stripe(env, path, { params: { cancel_at_period_end: renew ? 'false' : 'true' }, fetchImpl })
  // A cancellation made on Stripe's own page can be a fixed cancel_at date
  // rather than the period-end flag; clearing the flag leaves that in place.
  if (renew && subscription?.cancel_at) {
    subscription = await stripe(env, path, { params: { cancel_at: '' }, fetchImpl })
  }
  if (subscription?.status === 'canceled') {
    throw new BillingError('This subscription has already ended. Start a new one from the billing page.')
  }
  await record(db, teamId, subscription, row.customer_id)
  return {
    status: subscription.status,
    periodEnd: periodEndIso(subscription),
    ...subscriptionTerms(subscription),
  }
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
  // A scheduled cancellation ends access on its date, not three days later:
  // grace is for a card being retried, and nothing is being retried here.
  const ending = row.cancel_at ? new Date(row.cancel_at).getTime() : Infinity
  const stored = { trialEnd: row.trial_end ?? null, cancelAt: row.cancel_at ?? null }

  if (ACTIVE.has(row.status) && now < graceEnd && now < ending) {
    return { active: true, status: row.status, periodEnd: row.current_period_end, ...stored }
  }

  // Stored state is stale or inactive — ask Stripe before turning anyone away.
  try {
    const subscription = await stripe(env, `/subscriptions/${encodeURIComponent(row.subscription_id)}`, {
      method: 'GET',
      fetchImpl,
    })
    await record(db, teamId, subscription, row.customer_id)
    return {
      active: ACTIVE.has(subscription.status),
      status: subscription.status,
      periodEnd: periodEndIso(subscription),
      ...subscriptionTerms(subscription),
    }
  } catch {
    // Stripe unreachable: the stored answer, however stale, beats locking a
    // paying customer out over an outage that is not theirs.
    return { active: ACTIVE.has(row.status), status: row.status, periodEnd: row.current_period_end, ...stored }
  }
}

/** How far ahead of a trial's end the reminder goes out. */
export const REMINDER_DAYS = 7
const DAY = 24 * 60 * 60 * 1000

/**
 * The "your trial ends soon" emails, run once a day by the Worker's cron.
 *
 * Seven days ahead because that is what the card networks ask of a merchant
 * whose trial turns into a charge, and because a reminder three days out
 * reaches people who are travelling after the charge. One query finds the
 * trials ending inside the window that have not been reminded; each is
 * claimed before anything is sent, so an overlapping run cannot mail twice.
 *
 * The stored row can be behind Stripe (a cancellation made on Stripe's own
 * page with no webhook to report it), so each subscription is read fresh
 * before its email goes: a trial that is no longer running, or is already
 * set to end, gets nothing. A trial that started within two days is skipped
 * too, because the "trial started" email already said everything this one
 * would. Bounded to `limit` a run; the rest go tomorrow.
 *
 * `send(team, subscription)` does the mailing and is the caller's, so this
 * stays free of addresses and templates. Returns what happened, by count.
 */
export async function sendTrialReminders(db, env, { send, now = Date.now(), limit = 50, fetchImpl = fetch } = {}) {
  const tally = { due: 0, sent: 0, skipped: 0, failed: 0 }
  if (!stripeConfigured(env)) return tally
  const rows = await db.all(
    `SELECT b.team_id, b.subscription_id, b.customer_id, u.email, u.name
       FROM billing b JOIN users u ON u.id = b.team_id
      WHERE b.status = 'trialing'
        AND b.reminder_mail_at IS NULL
        AND b.cancel_at IS NULL
        AND b.trial_end > ? AND b.trial_end <= ?
        AND (b.started_mail_at IS NULL OR b.started_mail_at <= ?)
      LIMIT ?`,
    [
      new Date(now).toISOString(),
      new Date(now + REMINDER_DAYS * DAY).toISOString(),
      new Date(now - 2 * DAY).toISOString(),
      limit,
    ],
  )
  tally.due = rows.length
  for (const row of rows) {
    const { changes } = await db.run(
      'UPDATE billing SET reminder_mail_at = ? WHERE team_id = ? AND reminder_mail_at IS NULL',
      [new Date(now).toISOString(), row.team_id],
    )
    if (changes !== 1) continue
    try {
      const subscription = await stripe(env, `/subscriptions/${encodeURIComponent(row.subscription_id)}`, {
        method: 'GET',
        fetchImpl,
      })
      await record(db, row.team_id, subscription, row.customer_id)
      const terms = subscriptionTerms(subscription)
      if (subscription.status !== 'trialing' || terms.cancelAt || !terms.trialEnd) {
        tally.skipped += 1
        continue
      }
      await send({ email: row.email, name: row.name, teamId: row.team_id }, terms)
      tally.sent += 1
    } catch {
      // Released, so tomorrow's run tries again rather than the reminder
      // being lost to one bad minute at Stripe or the mail provider.
      await db.run('UPDATE billing SET reminder_mail_at = NULL WHERE team_id = ?', [row.team_id]).catch(() => {})
      tally.failed += 1
    }
  }
  return tally
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
      status: subscription?.status ?? 'active',
      periodEnd: subscription ? periodEndIso(subscription) : null,
    })
    return true
  }

  if (kind.startsWith('customer.subscription.') && object?.id) {
    const teamId =
      object.metadata?.team_id ??
      (await db.get('SELECT team_id FROM billing WHERE subscription_id = ?', [object.id]))?.team_id
    if (!teamId) return false
    await record(db, teamId, { ...object, status: kind === 'customer.subscription.deleted' ? 'canceled' : object.status })
    return true
  }

  return false
}
