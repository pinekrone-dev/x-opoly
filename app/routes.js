/**
 * The HTTP API, written once for both runtimes.
 *
 * Hono runs unchanged on Node and on Cloudflare Workers, so these routes are
 * the single definition of the API. Everything environment-specific — which
 * database, which file store, which secrets — arrives through the context that
 * `createApp` closes over, so nothing in here knows where it is running.
 */

import { Hono } from 'hono'
import { VectorTile } from '@mapbox/vector-tile'
// pbf v5 split the old default export into reader and writer; only reading
// happens here, and @mapbox/vector-tile v3 is built against this interface.
import { PbfReader } from 'pbf'
import { FetchSource, PMTiles } from 'pmtiles'

import { BUILD_COMMIT } from './lib/build-info.js'
import { nowIso } from './lib/ids.js'

import {
  STAGES,
  STAGE_LABELS,
  createProperty,
  createSurvey,
  deleteProperty,
  deleteSurvey,
  getProperty,
  getPropertyRow,
  getSurvey,
  listProperties,
  listSurveys,
  mapProperty,
  resolveShare,
  setTourOrder,
  updateProperty,
  updateShare,
  updateSurvey,
} from './lib/surveys.js'
import {
  createStage,
  deleteStage,
  listStages,
  reorderStages,
  setPropertyFields,
  updateStage,
} from './lib/stages.js'
import {
  addImage,
  deleteImage,
  listImages,
  reorderImages,
  updateImage,
} from './lib/images.js'
import {
  MIN_PASSWORD_LENGTH,
  adoptOrphanSurveys,
  authenticate,
  beginTotpEnrollment,
  confirmTotpEnrollment,
  createTotpChallenge,
  disableTotp,
  countUsers,
  createChallenge,
  createSession,
  createUser,
  destroyAllSessions,
  destroySession,
  createEmailVerification,
  findByEmail,
  getUser,
  markLogin,
  normalizePhone,
  sessionUser,
  verifyChallenge,
  verifyEmailToken,
} from './lib/auth.js'
import { EmailError, emailConfigured, sendEmail, verificationEmail } from './lib/email.js'
import {
  addParty,
  camel as camelRow,
  countRecords,
  createRecord,
  dealWithParties,
  deleteRecord,
  getRecord,
  listRecords,
  propertyFromPlace,
  rememberPlace,
  removeParty,
  updateRecord,
} from './lib/crm.js'
import { clientAddress, rateLimit } from './lib/ratelimit.js'
import { checkInvite, createInvite, listInvites, redeemInvite, revokeInvite } from './lib/invites.js'
import { extractFromText } from './lib/paste.js'
import { askJson, resolveProvider } from './lib/ai.js'
import { BOOK_STYLE_PROMPT, normalizeBookStyle } from './lib/bookstyle.js'
import { heuristicScout, runScout } from './lib/scout.js'
import { verifyActionsToken } from './lib/oidc.js'
import { createZone, deleteZone, listZones, updateZone } from './lib/zones.js'
import {
  BillingError,
  applyWebhook,
  billingState,
  confirmCheckout,
  createCheckout,
  isExemptEmail,
  mintFreeCode,
  publishableKey,
  portalUrl,
  stripeConfigured,
  verifyWebhook,
} from './lib/billing.js'
import { SmsUnavailable, codeMessage, sendSms, smsConfigured } from './lib/sms.js'
import { GeocodeError, geocode } from './lib/geocode.js'
import {
  MAX_COMPS_PER_IMPORT,
  clearComps,
  deleteComp,
  listComps,
  placeComps,
  readComps,
  readDelimited,
  saveComps,
} from './lib/comps.js'
import { deleteView, listViews, renameView, saveView } from './lib/mapviews.js'
import {
  clearMarket,
  dropParcels,
  getParcel,
  listHashes,
  marketSummary,
  putParcels,
  readyMarkets,
  reindexMarket,
  searchParcels,
  sealMarket,
} from './lib/parcels.js'
import { edgeCached } from './lib/edgecache.js'
import { spend, sweepUsage, usageToday } from './lib/aibudget.js'
import { DemographicsUnavailable, demographicsFor } from './lib/demographics.js'
import {
  FlyerExtractionError,
  extractFromFlyer,
  isConfigured,
  mergeExtraction,
  toPropertyInput,
} from './lib/flyer.js'
import { CATEGORIES, PlacesUnavailable, RING_MILES, nearbyBusinesses } from './lib/places.js'
import { buildItinerary, legs, planTour } from './lib/tour.js'
import { routeLegs } from './lib/routing.js'
import { availableBasemaps, placeholderTile, resolveTiles } from './lib/tiles.js'
import { EXTENSIONS, contentTypeFor } from './lib/storage.js'
import { DAY, HOUR, coordinateKey, createLookupCache } from './lib/lookupcache.js'

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024

/**
 * Puts a newly read flyer on the map.
 *
 * Extraction returns an address as text, which is not a location — a property
 * with no coordinates draws no pin and is invisible to the tour planner, so a
 * flyer upload appeared to do nothing. Geocoding closes that gap.
 *
 * Falls back to the survey's centre rather than leaving the site unplaced: a
 * pin in roughly the right city that the broker can drag is far more use than
 * no pin at all, and it is obvious it needs moving. Never throws — a geocoder
 * outage must not cost someone their upload.
 */
async function locateFromFields(fields, survey, env, { hint = null, siblings = [] } = {}) {
  const parts = [fields?.address, fields?.city, fields?.state, fields?.zip].filter(Boolean)

  if (parts.length > 0) {
    try {
      // geocode() returns the candidate array itself. Destructuring a
      // `results` property off it silently yielded undefined, so a flyer
      // naming a full street address still landed at the map centre.
      const results = await geocode(parts.join(', '), { env })
      if (results?.length > 0) {
        return { lat: results[0].lat, lng: results[0].lng, placed: 'geocoded' }
      }
    } catch {
      // Fall through to the cruder guesses below.
    }
  }

  // Where the broker is actually looking, sent by the client. The best of the
  // fallbacks, because a flyer is nearly always dropped while looking at the
  // area it belongs to.
  if (hint && Number.isFinite(hint.lat) && Number.isFinite(hint.lng)) {
    return { lat: hint.lat, lng: hint.lng, placed: 'map-centre' }
  }

  if (survey?.center) {
    return { lat: survey.center.lat, lng: survey.center.lng, placed: 'survey-centre' }
  }

  // The survey's own centre of gravity. A survey stores no centre until
  // someone sets one, so without this a flyer dropped on a survey that already
  // has pins still landed nowhere — which is exactly how the bug was reported.
  const placed = siblings.filter((row) => row.lat != null && row.lng != null)
  if (placed.length > 0) {
    return {
      lat: placed.reduce((total, row) => total + row.lat, 0) / placed.length,
      lng: placed.reduce((total, row) => total + row.lng, 0) / placed.length,
      placed: 'near-existing-sites',
    }
  }

  return { lat: null, lng: null, placed: 'unplaced' }
}

/** An optional "where the map is looking" hint from the client. */
function mapHint(c) {
  const lat = Number(c.req.header('x-map-lat'))
  const lng = Number(c.req.header('x-map-lng'))
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
  return { lat, lng }
}

/** A tour start/end point: a real coordinate, or nothing at all. */
function anchor(value) {
  const lat = Number(value?.lat)
  const lng = Number(value?.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
  return { address: value?.address ? String(value.address).slice(0, 300) : null, lat, lng }
}

/**
 * Turns the unhelpful error a missing Worker binding produces into something
 * that names the binding to add.
 */
function bindingError(error, binding) {
  const message = error?.message || String(error)
  if (/undefined|not a function|null/i.test(message)) {
    return `The ${binding} binding looks missing from this deployment. Add it in the Worker's Settings → Bindings, then redeploy. (${message})`
  }
  return message
}

/**
 * @param {object} context
 * @param {object} context.db      SQL adapter (node:sqlite or D1)
 * @param {object} context.storage file store (disk or R2)
 * @param {object} context.env     configuration and secrets
 */
export function createApp({ db, storage, env = {}, parcelDb = null }) {
  const app = new Hono()

  /*
   * Where the county lives.
   *
   * Its own database when the deployment gives it one — parcels outnumber
   * every other row in the product and do not belong beside the surveys — and
   * the same database otherwise, which is what the local rig and the tests
   * run against.
   */
  const parcels = parcelDb || db

  const notFound = (c, message) => c.json({ error: message }, 404)

  /*
   * Answers from outside services, remembered for a while.
   *
   * Demographics change once a year and businesses over months; a geocode of
   * the same address is the same point. Each is keyed by what the caller
   * asked, and only successful answers are kept, so an outage is never
   * remembered as a result.
   */
  const lookups = {
    demographics: createLookupCache({ ttlMs: DAY, max: 500 }),
    places: createLookupCache({ ttlMs: HOUR, max: 500 }),
    geocode: createLookupCache({ ttlMs: DAY, max: 2000 }),
  }
  app.lookups = lookups

  /** Loads a survey or ends the request. */
  /**
   * The survey, only if it belongs to the caller's team.
   *
   * A mismatch answers 404, not 403: another team's survey ids are not this
   * caller's business, not even their existence. A survey with no owner —
   * created before teams — is claimed by the first team to touch it.
   */
  async function requireSurvey(c) {
    const survey = await getSurvey(db, c.req.param('id'))
    if (!survey) return { error: notFound(c, 'That survey does not exist.') }

    const user = c.get('user')
    if (user) {
      if (survey.ownerId && survey.ownerId !== user.teamId) {
        return { error: notFound(c, 'That survey does not exist.') }
      }
      if (!survey.ownerId) {
        await db.run('UPDATE surveys SET owner_id = ? WHERE id = ? AND owner_id IS NULL', [user.teamId, survey.id])
      }
    }
    return { survey }
  }

  /**
   * A property, only if its survey belongs to the caller's team.
   *
   * One query: the row joined to its survey's owner. `property` is the mapped
   * record without custom fields or images; a route that needs those reads
   * the full record with `getProperty`.
   */
  async function requireProperty(c, id = c.req.param('id')) {
    const row = await getPropertyRow(db, id)
    if (!row) return { error: notFound(c, 'That property does not exist.') }

    const user = c.get('user')
    if (user && row.survey_owner_id && row.survey_owner_id !== user.teamId) {
      return { error: notFound(c, 'That property does not exist.') }
    }
    return { row, property: mapProperty(row) }
  }

  // --- health --------------------------------------------------------------

  /**
   * Health, including a real probe of each binding.
   *
   * Reporting the runtime alone is worthless on Cloudflare: the adapter is
   * constructed whether or not the binding exists, so a Worker deployed with
   * no database still claimed to be healthy. These checks actually touch the
   * database and the file store, so a missing binding is visible here rather
   * than as a 500 on the first real request.
   */
  app.get('/api/health', async (c) => {
    const tiles = resolveTiles(env)
    const checks = {}

    try {
      await db.get('SELECT 1 AS ok')
      checks.database = { ok: true, kind: db.kind }
    } catch (error) {
      checks.database = { ok: false, kind: db.kind, error: bindingError(error, 'DB') }
    }

    try {
      // Reading a key that does not exist is cheap and writes nothing; it
      // still fails loudly when the bucket binding is absent.
      await storage.get('__health_probe__')
      checks.storage = { ok: true, kind: storage.kind }
    } catch (error) {
      checks.storage = { ok: false, kind: storage.kind, error: bindingError(error, 'BUCKET') }
    }

    const ok = checks.database.ok && checks.storage.ok

    return c.json(
      {
        ok,
        runtime: db.kind === 'd1' ? 'cloudflare' : 'node',
        // Which commit is actually running. A backend-only change leaves the
        // frontend bundle untouched, so without this there is no way to tell a
        // finished rollout from a stale one still answering every request.
        commit: BUILD_COMMIT,
        checks,
        stages: STAGES.map((id) => ({ id, label: STAGE_LABELS[id] })),
        features: {
          flyerExtraction: isConfigured(env),
          tiles,
          basemaps: availableBasemaps(env),
          tileUrl: tiles.url,
          tileAttribution: tiles.attribution,
          /*
           * Which optional integrations are wired up.
           *
           * Booleans only — never the values. The point is to answer "did my
           * key land?" without anyone having to guess from behaviour, or read
           * a secret back out of a running deployment to check.
           *
           * Census is the odd one: the ACS is free and keyless for light use,
           * so `false` here means "rate-limited", not "broken".
           */
          integrations: {
            census: Boolean(env.CENSUS_API_KEY),
            google: Boolean(env.GOOGLE_MAPS_API_KEY),
            sms: smsConfigured(env),
            email: emailConfigured(env),
            // Which extraction provider will answer — anthropic, gemini or
            // grok — or null when no key is set. "misconfigured" flags an
            // AI_PROVIDER naming a provider this list does not know.
            ai: (() => {
              try {
                return resolveProvider(env)
              } catch {
                return 'misconfigured'
              }
            })(),
          },
        },
      },
      ok ? 200 : 503,
    )
  })

  app.get('/api/tiles/:z/:x/:y', (c) => {
    const z = Number(c.req.param('z'))
    const x = Number(c.req.param('x'))
    // The route param is greedy and includes the ".svg" the tile URL carries.
    const y = Number(c.req.param('y').replace(/\.svg$/, ''))

    if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y) || z < 0 || z > 22) {
      return c.json({ error: 'Bad tile coordinates.' }, 400)
    }
    return c.body(placeholderTile(z, x, y), 200, {
      'content-type': 'image/svg+xml',
      'cache-control': 'public, max-age=86400',
    })
  })

  // --- surveys -------------------------------------------------------------

  // --- accounts --------------------------------------------------------------

  const SESSION_COOKIE = 'session'

  /**
   * Secure is set only on HTTPS, because a Secure cookie is never sent over
   * http and local development would silently fail to hold a session.
   * SameSite=Lax keeps the cookie off cross-site POSTs while still surviving
   * an ordinary link into the app.
   */
  function setSessionCookie(c, token, maxAgeSeconds = 14 * 24 * 60 * 60) {
    const secure = new URL(c.req.url).protocol === 'https:' ? ' Secure;' : ''
    c.header(
      'set-cookie',
      `${SESSION_COOKIE}=${token}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`,
    )
  }

  function clearSessionCookie(c) {
    const secure = new URL(c.req.url).protocol === 'https:' ? ' Secure;' : ''
    c.header('set-cookie', `${SESSION_COOKIE}=; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=0`)
  }

  function tokenFrom(c) {
    const header = c.req.header('cookie') || ''
    const match = header.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`))
    return match ? decodeURIComponent(match[1]) : null
  }

  /**
   * Paths that must work without a session.
   *
   * Client share links are the reason /api/share and /api/files are open: a
   * client following a link has no account and must never need one. The stored
   * filenames are random UUIDs, so they are unguessable rather than listable.
   */
  const PUBLIC_PATHS = [
    /^\/api\/health$/,
    /^\/api\/auth\//,
    /^\/api\/share\//,
    /^\/api\/tiles\//,
    /^\/api\/files\//,
    // Public census data: the shared client map shades its block groups
    // without a session, and nothing here is private to the workspace.
    /^\/api\/demographics$/,
    // The map's own trouble reports. Public of necessity: this fires at the
    // exact moment the app is failing, possibly before anyone could sign in,
    // and a beacon that requires a session cannot describe a broken login
    // screen. Write-only — no GET is registered on the path, so exempting it
    // exposes nothing to read.
    /^\/api\/diag\/map$/,
    // Stripe calls this unauthenticated; the webhook signature is the auth.
    /^\/api\/billing\/webhook$/,
    // The parcel pipeline calls this from GitHub Actions; a verified OIDC
    // token from an allowed repository is the auth, not a session.
    /^\/api\/gis\/ingest$/,
    /*
     * The same door, for rows rather than files.
     *
     * This has its own path rather than sharing /api/gis/parcels with the
     * search, and the reason is the shape of this list: it matches on path
     * alone, with no idea of method. Exempting /api/gis/parcels to let the
     * pipeline POST to it would have un-gated the GET beside it, which serves
     * a whole county to anyone who asks. Both anchors end in $, so neither
     * entry can widen to cover the other.
     */
    /^\/api\/gis\/ingest\/parcels$/,
  ]

  /**
   * Requires a session for everything else — unless no account exists yet.
   *
   * That exception is the setup window. Locking the API down before anyone can
   * create an account would make the instance unusable and unrecoverable
   * through the browser, which is the only tool the operator has here.
   */
  /**
   * Whether any account exists yet.
   *
   * Asked on every authenticated request to detect the setup window, which
   * made it a full-table COUNT per API call. The answer only ever moves from
   * "no" to "yes" — accounts are never deleted — so once it is yes it is
   * remembered for the life of this app instance and costs nothing further.
   */
  let anyUsers = false
  const hasUsers = async () => {
    if (!anyUsers) anyUsers = (await countUsers(db)) > 0
    return anyUsers
  }

  app.use('/api/*', async (c, next) => {
    const path = new URL(c.req.url).pathname
    if (PUBLIC_PATHS.some((pattern) => pattern.test(path))) return next()

    if (!(await hasUsers())) {
      c.set('setupMode', true)
      return next()
    }

    const user = await sessionUser(db, tokenFrom(c))
    if (!user) return c.json({ error: 'Sign in to continue.' }, 401)
    c.set('user', user)
    return next()
  })

  /**
   * The subscription gate.
   *
   * Auth and billing endpoints stay reachable — a lapsed subscriber must be
   * able to sign in and pay — and everything else answers 402 until the
   * team's subscription is active. No Stripe key means no gate at all, and
   * exempt teams (the operator, the smoke account) never see it.
   */
  const UNGATED = [/^\/api\/auth(\/|$)/, /^\/api\/billing(\/|$)/]
  const exemptTeams = new Map()

  /**
   * Whether a team ever sees the paywall. Two doors out: the operator's own
   * team — whoever claimed the instance first is the person selling it, and
   * their collaborators ride along — and any owner email named in
   * STRIPE_EXEMPT_EMAILS. Cached per isolate; neither answer changes.
   */
  const teamIsExempt = async (teamId, fallbackEmail) => {
    if (!exemptTeams.has(teamId)) {
      const owner = await db.get('SELECT email FROM users WHERE id = ?', [teamId])
      const first = await db.get('SELECT id FROM users ORDER BY created_at, id LIMIT 1')
      exemptTeams.set(teamId, teamId === first?.id || isExemptEmail(env, owner?.email ?? fallbackEmail))
    }
    return exemptTeams.get(teamId)
  }

  app.use('/api/*', async (c, next) => {
    if (!stripeConfigured(env)) return next()
    const user = c.get('user')
    if (!user) return next()

    const path = new URL(c.req.url).pathname
    if (PUBLIC_PATHS.some((pattern) => pattern.test(path))) return next()
    if (UNGATED.some((pattern) => pattern.test(path))) return next()

    if (await teamIsExempt(user.teamId, user.email)) return next()

    const state = await billingState(db, env, user.teamId)
    if (state.active) return next()
    return c.json(
      { error: 'This workspace needs an active subscription.', code: 'subscription_required' },
      402,
    )
  })

  /**
   * Answers 429 when this client has hit an endpoint too often, else null.
   * Keyed by address so one abuser does not close the door for everyone.
   */
  const limited = (c, bucket, limit, windowMs, extra = '') => {
    const key = `${bucket}:${clientAddress(c)}${extra ? `:${extra}` : ''}`
    const verdict = rateLimit(key, { limit, windowMs })
    if (verdict.allowed) return null
    c.header('Retry-After', String(verdict.retryAfterSeconds))
    return c.json({ error: 'Too many attempts. Slow down and try again shortly.', code: 'rate_limited' }, 429)
  }

  /**
   * Answers 429 when this workspace has spent its day's AI budget, else null.
   *
   * Sits beside `limited` rather than replacing it, because they stop
   * different things: that one stops a burst from one address, this one stops
   * a sustained spend by one workspace. A script held just under the burst
   * limit runs seventeen thousand model calls a day and never trips it.
   *
   * The message names the cap and when it resets. "Too many attempts" tells
   * somebody who has hit a daily budget nothing they can act on.
   */
  const afforded = async (c, kind) => {
    const user = c.get('user')
    // Opportunistic housekeeping: there is no cron here, and one row per
    // workspace per kind per day is not urgent but should not grow forever.
    if (Math.random() < 0.005) await sweepUsage(db).catch(() => {})
    const verdict = await spend(db, { teamId: user?.teamId ?? null, kind, env })
    if (verdict.allowed) return null
    c.header('Retry-After', String(verdict.retryAfterSeconds))
    return c.json(
      {
        error:
          `This workspace has used its ${verdict.cap.toLocaleString()} AI requests for today. ` +
          `The budget resets at midnight UTC.`,
        code: 'ai_budget',
        cap: verdict.cap,
        used: verdict.used,
      },
      429,
    )
  }

  app.get('/api/auth/me', async (c) => {
    const user = await sessionUser(db, tokenFrom(c))
    return c.json({
      user,
      setupRequired: !(await hasUsers()),
      smsConfigured: smsConfigured(env),
      billing: {
        configured: stripeConfigured(env),
        // Selling to strangers needs both halves: a way to charge them and a
        // way to verify they own the email they signed up with.
        selfServe: stripeConfigured(env) && emailConfigured(env),
        publishableKey: publishableKey(env),
      },
    })
  })

  /**
   * Creates an account.
   *
   * Open only while no account exists, so the first person to reach a fresh
   * deployment claims it. After that it needs SIGNUP_TOKEN, which is how a
   * second broker gets added without opening registration to the internet.
   */
  app.post('/api/auth/register', async (c) => {
    const throttled = limited(c, 'register', 10, 60 * 60 * 1000)
    if (throttled) return throttled

    const body = await c.req.json().catch(() => ({}))
    const existing = await countUsers(db)

    let teamId = null
    let selfServe = false
    if (existing > 0) {
      const offered = String(body?.inviteToken ?? '')
      const isSignupToken = Boolean(env.SIGNUP_TOKEN) && offered === env.SIGNUP_TOKEN
      if (!isSignupToken) {
        if (offered) {
          // A colleague's one-time invite, bound to their email. Checked
          // before the account is created so a mismatched address costs
          // nothing — and it decides which team the account joins.
          const redeemed = await redeemInvite(db, offered, body?.email)
          if (!redeemed.ok) return c.json({ error: redeemed.error }, 403)
          teamId = redeemed.teamId
        } else if (!stripeConfigured(env) || !emailConfigured(env)) {
          // Self-serve signup exists to sell subscriptions. Without billing
          // there is nothing to sell, and without email sending the address
          // could never be verified — either way the door stays invite-only.
          return c.json({ error: 'Registration is closed on this instance.' }, 403)
        } else {
          selfServe = true
        }
      }
    }

    // An invite or setup token proves the email; a stranger's signup proves
    // nothing until they click the link this sends.
    const result = await createUser(db, { ...body, teamId, verified: !selfServe })
    if (result.error) return c.json({ error: result.error }, 400)

    // The first account adopts anything created before accounts existed,
    // rather than letting real work become unreachable.
    const adopted = existing === 0 ? await adoptOrphanSurveys(db, result.user.id) : 0

    if (selfServe) {
      const verifyToken = await createEmailVerification(db, result.user.id)
      const origin = new URL(c.req.url).origin
      try {
        await sendEmail(env, {
          to: result.user.email,
          ...verificationEmail({ name: result.user.name, url: `${origin}/?verify=${verifyToken}` }),
        })
      } catch (error) {
        if (error instanceof EmailError) {
          // The account exists but the link never left. Say so honestly:
          // resend is the recovery, not a mystery inbox wait.
          return c.json(
            { user: result.user, requiresVerification: true, emailFailed: true, error: error.message },
            201,
          )
        }
        throw error
      }
      // No session yet: the cookie is what verification earns.
      return c.json({ user: result.user, requiresVerification: true }, 201)
    }

    const token = await createSession(db, result.user.id)
    await markLogin(db, result.user.id)
    setSessionCookie(c, token)
    return c.json({ user: result.user, adoptedSurveys: adopted }, 201)
  })

  /** Redeems the emailed link: verifies the address and signs the browser in. */
  app.post('/api/auth/verify-email', async (c) => {
    const throttled = limited(c, 'verify-email', 20, 10 * 60 * 1000)
    if (throttled) return throttled

    const body = await c.req.json().catch(() => ({}))
    const result = await verifyEmailToken(db, String(body?.token ?? ''))
    if (result.error) return c.json({ error: result.error }, 410)

    const token = await createSession(db, result.userId)
    await markLogin(db, result.userId)
    setSessionCookie(c, token)
    return c.json({ user: result.user })
  })

  /**
   * Sends a fresh verification link. Always answers the same 200 whether or
   * not the address has an account, so this cannot enumerate customers.
   */
  app.post('/api/auth/resend-verification', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const email = String(body?.email ?? '').trim().toLowerCase()
    const throttled = limited(c, 'resend-verification', 3, 10 * 60 * 1000, email)
    if (throttled) return throttled

    const answer = { ok: true, message: 'If that address has an unverified account, a new link is on its way.' }
    if (!emailConfigured(env)) return c.json(answer)

    const row = await findByEmail(db, email)
    if (row && !row.verified) {
      const verifyToken = await createEmailVerification(db, row.id)
      const origin = new URL(c.req.url).origin
      try {
        await sendEmail(env, {
          to: row.email,
          ...verificationEmail({ name: row.name, url: `${origin}/?verify=${verifyToken}` }),
        })
      } catch (error) {
        if (!(error instanceof EmailError)) throw error
        // The generic answer stands: a sending hiccup is not the caller's
        // signal to learn which addresses exist.
      }
    }
    return c.json(answer)
  })

  /**
   * Who an invitation is for, before any account exists.
   *
   * Public on purpose (the holder is by definition signed out) and answered
   * from the token digest, so probing it brute-forces nothing useful.
   */
  app.get('/api/auth/invite/:token', async (c) => {
    const result = await checkInvite(db, c.req.param('token'))
    if (!result.ok) {
      const messages = {
        not_found: 'This invitation link is not valid.',
        used: 'This invitation was already used. Sign in instead.',
        expired: 'This invitation has expired. Ask for a new one.',
      }
      return c.json({ error: messages[result.reason], reason: result.reason }, 410)
    }
    return c.json({ email: result.email })
  })

  app.post('/api/auth/login', async (c) => {
    const throttled = limited(c, 'login', 20, 10 * 60 * 1000)
    if (throttled) return throttled

    const body = await c.req.json().catch(() => ({}))
    const result = await authenticate(db, body?.email, body?.password)
    if (result.error) return c.json({ error: result.error }, result.locked ? 429 : 401)

    // A correct password on an unverified account earns a resend, not a
    // session — the email has to be proven exactly once.
    if (!result.row.verified) {
      return c.json(
        {
          error: 'Confirm your email address first — check your inbox for the link.',
          code: 'email_unverified',
          email: result.user.email,
        },
        403,
      )
    }

    // With 2FA on, the password alone must not produce a session.
    //
    // TOTP is preferred when both are set up: nothing has to be sent, so there
    // is no carrier to be down, no cost per sign-in, and no SIM to swap.
    if (result.row.totp_enabled) {
      const { challengeId } = await createTotpChallenge(db, result.row.id)
      return c.json({ challengeId, twoFactor: true, method: 'totp' })
    }

    if (result.row.sms_2fa && result.row.phone) {
      const { challengeId, code } = await createChallenge(db, result.row.id)
      try {
        await sendSms(result.row.phone, codeMessage(code), { env })
      } catch (error) {
        if (error instanceof SmsUnavailable) {
          return c.json({ error: error.message, configured: error.configured }, 503)
        }
        throw error
      }
      return c.json({ challengeId, phoneHint: result.user.phoneHint, twoFactor: true, method: 'sms' })
    }

    const token = await createSession(db, result.row.id)
    await markLogin(db, result.row.id)
    setSessionCookie(c, token)
    return c.json({ user: result.user, twoFactor: false })
  })

  app.post('/api/auth/verify', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const result = await verifyChallenge(db, String(body?.challengeId ?? ''), body?.code)
    if (result.error) return c.json({ error: result.error, remaining: result.remaining }, 401)

    const token = await createSession(db, result.userId)
    setSessionCookie(c, token)
    return c.json({ user: await getUser(db, result.userId) })
  })

  app.post('/api/auth/logout', async (c) => {
    await destroySession(db, tokenFrom(c))
    clearSessionCookie(c)
    return c.body(null, 204)
  })

  /**
   * Turns the second factor on or off.
   *
   * Enabling requires the current password: an unattended logged-in browser
   * should not be able to hand someone else the second factor by pointing it
   * at their phone.
   */
  app.post('/api/auth/2fa', async (c) => {
    const user = await sessionUser(db, tokenFrom(c))
    if (!user) return c.json({ error: 'Sign in to continue.' }, 401)

    const body = await c.req.json().catch(() => ({}))
    const row = await findByEmail(db, user.email)
    const check = await authenticate(db, user.email, body?.password)
    if (check.error) return c.json({ error: 'That password is not right.' }, 403)

    const enable = body?.enabled !== false
    const phone = normalizePhone(body?.phone ?? row.phone)

    if (enable) {
      if (!phone) return c.json({ error: 'Add a mobile number to text codes to.' }, 400)
      if (!smsConfigured(env)) {
        return c.json(
          { error: 'Texting is not configured on this server yet, so a code could never arrive.', configured: false },
          503,
        )
      }
    }

    await db.run('UPDATE users SET phone = ?, sms_2fa = ? WHERE id = ?', [
      phone,
      enable ? 1 : 0,
      user.id,
    ])
    return c.json({ user: await getUser(db, user.id) })
  })

  /**
   * Starts authenticator enrollment: mints a secret and returns the otpauth
   * URI to scan. Not switched on until a code proves the phone holds it, so a
   * mistyped setup cannot lock anyone out.
   */
  app.post('/api/auth/totp/setup', async (c) => {
    const user = await sessionUser(db, tokenFrom(c))
    if (!user) return c.json({ error: 'Sign in to continue.' }, 401)

    const body = await c.req.json().catch(() => ({}))
    const check = await authenticate(db, user.email, body?.password)
    if (check.error) return c.json({ error: 'That password is not right.' }, 403)

    return c.json(await beginTotpEnrollment(db, user))
  })

  app.post('/api/auth/totp/confirm', async (c) => {
    const user = await sessionUser(db, tokenFrom(c))
    if (!user) return c.json({ error: 'Sign in to continue.' }, 401)

    const body = await c.req.json().catch(() => ({}))
    const result = await confirmTotpEnrollment(db, user.id, body?.code)
    if (result.error) return c.json({ error: result.error }, 400)

    return c.json({ user: await getUser(db, user.id) })
  })

  app.post('/api/auth/totp/disable', async (c) => {
    const user = await sessionUser(db, tokenFrom(c))
    if (!user) return c.json({ error: 'Sign in to continue.' }, 401)

    const body = await c.req.json().catch(() => ({}))
    const check = await authenticate(db, user.email, body?.password)
    if (check.error) return c.json({ error: 'That password is not right.' }, 403)

    await disableTotp(db, user.id)
    return c.json({ user: await getUser(db, user.id) })
  })

  app.post('/api/auth/password', async (c) => {
    const user = await sessionUser(db, tokenFrom(c))
    if (!user) return c.json({ error: 'Sign in to continue.' }, 401)

    const body = await c.req.json().catch(() => ({}))
    const check = await authenticate(db, user.email, body?.currentPassword)
    if (check.error) return c.json({ error: 'That password is not right.' }, 403)

    const next = String(body?.newPassword ?? '')
    if (next.length < MIN_PASSWORD_LENGTH) {
      return c.json({ error: `Use at least ${MIN_PASSWORD_LENGTH} characters.` }, 400)
    }

    const { hashPassword } = await import('./lib/crypto.js')
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(next), user.id])

    // Every other device is signed out, then this one is signed back in.
    await destroyAllSessions(db, user.id)
    setSessionCookie(c, await createSession(db, user.id))
    return c.json({ ok: true })
  })

  app.get('/api/surveys', async (c) => c.json({ surveys: await listSurveys(db, c.get('user')?.teamId ?? null) }))

  app.post('/api/surveys', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    if (!String(body?.name || '').trim()) return c.json({ error: 'Give the survey a name.' }, 400)
    return c.json({ survey: await createSurvey(db, body, c.get('user')?.teamId ?? null) }, 201)
  })

  app.get('/api/surveys/:id', async (c) => {
    const { survey, error } = await requireSurvey(c)
    if (error) return error
    return c.json({
      survey,
      properties: await listProperties(db, survey.id),
      stages: await listStages(db, survey.id),
      zones: await listZones(db, survey.id),
    })
  })

  app.patch('/api/surveys/:id', async (c) => {
    const { error } = await requireSurvey(c)
    if (error) return error
    const body = await c.req.json().catch(() => ({}))
    return c.json({ survey: await updateSurvey(db, c.req.param('id'), body) })
  })

  app.delete('/api/surveys/:id', async (c) => {
    const { error } = await requireSurvey(c)
    if (error) return error
    if (!(await deleteSurvey(db, c.req.param('id')))) return notFound(c, 'That survey does not exist.')
    return c.body(null, 204)
  })

  // --- properties ----------------------------------------------------------

  app.post('/api/surveys/:id/properties', async (c) => {
    const { survey, error } = await requireSurvey(c)
    if (error) return error
    const body = await c.req.json().catch(() => ({}))
    // Row, survey timestamp and custom fields land in one batch.
    const property = await createProperty(db, survey.id, body)
    // A building worked on a survey is filed back into the team's places, so
    // what the broker learns here is not lost when the survey is archived.
    await rememberPlace(db, c.get('user')?.teamId ?? null, property)
    return c.json({ property }, 201)
  })

  app.patch('/api/properties/:id', async (c) => {
    const id = c.req.param('id')
    const { row, error } = await requireProperty(c, id)
    if (error) return error
    const body = await c.req.json().catch(() => ({}))
    // The row just read authorises the request and supplies the current
    // values, so only genuine changes are written and nothing is read twice.
    return c.json({ property: await updateProperty(db, id, body, { row }) })
  })

  app.delete('/api/properties/:id', async (c) => {
    const { row, error } = await requireProperty(c)
    if (error) return error
    if (!(await deleteProperty(db, c.req.param('id'), { surveyId: row.survey_id }))) {
      return notFound(c, 'That property does not exist.')
    }
    return c.body(null, 204)
  })

  // --- stages --------------------------------------------------------------

  app.get('/api/surveys/:id/stages', async (c) => {
    const { survey, error } = await requireSurvey(c)
    if (error) return error
    return c.json({ stages: await listStages(db, survey.id) })
  })

  app.post('/api/surveys/:id/stages', async (c) => {
    const { survey, error } = await requireSurvey(c)
    if (error) return error
    const body = await c.req.json().catch(() => ({}))
    const result = await createStage(db, survey.id, body)
    if (result.error) return c.json({ error: result.error }, 400)
    return c.json({ stage: result.stage }, 201)
  })

  app.patch('/api/stages/:id', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const result = await updateStage(db, c.req.param('id'), body)
    if (result.error) return c.json({ error: result.error }, result.stage ? 400 : 404)
    return c.json({ stage: result.stage })
  })

  app.delete('/api/stages/:id', async (c) => {
    if (!(await deleteStage(db, c.req.param('id')))) return notFound(c, 'That stage does not exist.')
    return c.body(null, 204)
  })

  app.put('/api/surveys/:id/stages', async (c) => {
    const { survey, error } = await requireSurvey(c)
    if (error) return error
    const body = await c.req.json().catch(() => ({}))
    const order = Array.isArray(body?.order) ? body.order.map(String) : []
    return c.json({ stages: await reorderStages(db, survey.id, order) })
  })

  // --- tour ----------------------------------------------------------------

  app.post('/api/surveys/:id/tour', async (c) => {
    const { survey, error } = await requireSurvey(c)
    if (error) return error
    const body = await c.req.json().catch(() => ({}))

    const all = await listProperties(db, survey.id)
    // The broker can tour a subset — the "select sites" checkboxes.
    const chosen = Array.isArray(body?.propertyIds) && body.propertyIds.length > 0
      ? all.filter((property) => body.propertyIds.includes(property.id))
      : all

    const optimize = body?.optimize !== false
    const located = chosen.filter((p) => p.lat != null && p.lng != null)
    const plan = optimize
      ? planTour(chosen, { startId: body?.startId || null })
      : { stops: located, unlocated: chosen.filter((p) => p.lat == null || p.lng == null), miles: 0, minutes: 0 }

    // Anchors are addresses, not sites, so they bracket the routed path.
    const start = anchor(body?.start ?? survey.tour?.start)
    const end = anchor(body?.end ?? survey.tour?.end)
    const points = [...(start ? [start] : []), ...plan.stops, ...(end ? [end] : [])]

    /*
     * Route once, reuse forever. The routed path is keyed by the exact
     * sequence of coordinates; the same tour viewed again — by the broker,
     * or by the client through the shared link — reads the saved answer
     * instead of calling the routing APIs. Replanning with different stops
     * or anchors changes the key, routes fresh, and overwrites the save,
     * which is how a mid-tour change reaches the client's map.
     */
    const routeKey = points.map((point) => `${point.lat.toFixed(6)},${point.lng.toFixed(6)}`).join(';')
    let stored = null
    try {
      stored = JSON.parse((await db.get('SELECT tour_plan FROM surveys WHERE id = ?', [survey.id]))?.tour_plan ?? 'null')
    } catch {
      stored = null
    }

    let routed
    if (stored?.key === routeKey && ['google', 'osrm'].includes(stored.source) && Array.isArray(stored.geometry)) {
      routed = { legs: stored.legs, geometry: stored.geometry, source: stored.source, note: null }
    } else {
      routed = await routeLegs(points, { fetchImpl: fetch, env })
      if (['google', 'osrm'].includes(routed.source)) {
        await db.run('UPDATE surveys SET tour_plan = ? WHERE id = ?', [
          JSON.stringify({
            key: routeKey,
            source: routed.source,
            legs: routed.legs,
            geometry: routed.geometry,
            stopIds: plan.stops.map((stop) => stop.id),
            savedAt: nowIso(),
          }),
          survey.id,
        ])
      }
    }

    // Align drive times with stops: with a start anchor every stop has an
    // inbound leg; without one the first stop is where the day begins.
    const driveMinutes = start
      ? routed.legs.slice(0, plan.stops.length).map((leg) => leg.minutes)
      : [0, ...routed.legs.slice(0, Math.max(0, plan.stops.length - 1)).map((leg) => leg.minutes)]
    const endDriveMinutes = end && routed.legs.length > 0 ? routed.legs[routed.legs.length - 1].minutes : null

    const itinerary = buildItinerary({
      stops: plan.stops,
      driveMinutes,
      startTime: body?.startTime || survey.tour?.startTime || '10:00',
      stopMinutes: Number.isFinite(Number(body?.stopMinutes))
        ? Number(body.stopMinutes)
        : survey.tour?.stopMinutes ?? 20,
      endDriveMinutes,
    })

    return c.json({
      ...plan,
      legs: legs(plan.stops),
      itinerary,
      geometry: routed.geometry,
      routeSource: routed.source,
      routeNote: routed.note ?? null,
      driveMiles: Math.round(routed.legs.reduce((total, leg) => total + leg.miles, 0) * 10) / 10,
      start,
      end,
    })
  })

  app.put('/api/surveys/:id/tour', async (c) => {
    const { survey, error } = await requireSurvey(c)
    if (error) return error
    const body = await c.req.json().catch(() => ({}))
    const order = Array.isArray(body?.order) ? body.order.map(String) : []
    return c.json({ properties: await setTourOrder(db, survey.id, order) })
  })

  // --- sharing -------------------------------------------------------------

  app.post('/api/surveys/:id/share', async (c) => {
    const { error } = await requireSurvey(c)
    if (error) return error
    const body = await c.req.json().catch(() => ({}))
    return c.json({ survey: await updateShare(db, c.req.param('id'), body) })
  })

  // --- zones ---------------------------------------------------------------

  app.get('/api/surveys/:id/zones', async (c) => {
    const { survey, error } = await requireSurvey(c)
    if (error) return error
    return c.json({ zones: await listZones(db, survey.id) })
  })

  app.post('/api/surveys/:id/zones', async (c) => {
    const { survey, error } = await requireSurvey(c)
    if (error) return error
    const result = await createZone(db, survey.id, await c.req.json().catch(() => ({})))
    if (result.error) return c.json({ error: result.error }, 400)
    return c.json({ zone: result.zone }, 201)
  })

  app.patch('/api/zones/:id', async (c) => {
    const zone = await db.get('SELECT survey_id FROM zones WHERE id = ?', [c.req.param('id')])
    if (!zone) return notFound(c, 'That zone does not exist.')
    // Scoped through the survey it belongs to, exactly as delete is.
    const survey = await getSurvey(db, zone.survey_id)
    const user = c.get('user')
    if (!survey || (user && survey.ownerId && survey.ownerId !== user.teamId)) {
      return notFound(c, 'That zone does not exist.')
    }
    const result = await updateZone(db, c.req.param('id'), await c.req.json().catch(() => ({})))
    if (result.error) return c.json({ error: result.error }, 400)
    return c.json(result)
  })

  app.delete('/api/zones/:id', async (c) => {
    const zone = await db.get('SELECT survey_id FROM zones WHERE id = ?', [c.req.param('id')])
    if (!zone) return notFound(c, 'That zone is gone already.')
    const user = c.get('user')
    if (user) {
      const survey = await getSurvey(db, zone.survey_id)
      if (survey?.ownerId && survey.ownerId !== user.teamId) {
        return notFound(c, 'That zone is gone already.')
      }
    }
    if (!(await deleteZone(db, c.req.param('id')))) return notFound(c, 'That zone is gone already.')
    return c.body(null, 204)
  })

  // --- billing -------------------------------------------------------------

  app.get('/api/billing', async (c) => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Sign in to continue.' }, 401)
    const exempt = await teamIsExempt(user.teamId, user.email)
    const state = stripeConfigured(env) && !exempt ? await billingState(db, env, user.teamId) : { active: true, status: exempt ? 'exempt' : 'unmetered' }
    const row = await db.get('SELECT customer_id FROM billing WHERE team_id = ?', [user.teamId])
    return c.json({
      configured: stripeConfigured(env),
      publishableKey: publishableKey(env),
      active: state.active,
      status: state.status,
      periodEnd: state.periodEnd ?? null,
      portalAvailable: Boolean(row?.customer_id),
      priceLabel: '$29 / month',
    })
  })

  app.post('/api/billing/checkout', async (c) => {
    const throttled = limited(c, 'checkout', 10, 10 * 60 * 1000)
    if (throttled) return throttled
    const user = c.get('user')
    if (!user) return c.json({ error: 'Sign in to continue.' }, 401)
    if (!stripeConfigured(env)) return c.json({ error: 'Billing is not configured on this server.' }, 400)
    try {
      const origin = new URL(c.req.url).origin
      const body = await c.req.json().catch(() => ({}))
      return c.json(
        await createCheckout(db, env, {
          teamId: user.teamId,
          email: user.email,
          origin,
          hosted: Boolean(body?.hosted),
        }),
      )
    } catch (error) {
      if (error instanceof BillingError) return c.json({ error: error.message }, 502)
      throw error
    }
  })

  app.get('/api/billing/confirm', async (c) => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Sign in to continue.' }, 401)
    const sessionId = c.req.query('session_id')
    if (!sessionId) return c.json({ error: 'No checkout session to confirm.' }, 400)
    try {
      return c.json(await confirmCheckout(db, env, sessionId))
    } catch (error) {
      if (error instanceof BillingError) return c.json({ error: error.message }, 502)
      throw error
    }
  })

  /**
   * Mints a free-forever signup code. Operator-team only: this is the
   * house's pen, not a customer feature.
   */
  app.post('/api/billing/free-code', async (c) => {
    const throttled = limited(c, 'free-code', 10, 60 * 60 * 1000)
    if (throttled) return throttled
    const user = c.get('user')
    if (!user) return c.json({ error: 'Sign in to continue.' }, 401)
    if (!stripeConfigured(env)) return c.json({ error: 'Billing is not configured on this server.' }, 400)
    if (!(await teamIsExempt(user.teamId, user.email))) {
      return c.json({ error: 'Only the workspace operator can mint free codes.' }, 403)
    }
    try {
      return c.json(await mintFreeCode(env))
    } catch (error) {
      if (error instanceof BillingError) return c.json({ error: error.message }, 502)
      throw error
    }
  })

  app.post('/api/billing/portal', async (c) => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Sign in to continue.' }, 401)
    try {
      const origin = new URL(c.req.url).origin
      return c.json({ url: await portalUrl(db, env, user.teamId, `${origin}/`) })
    } catch (error) {
      if (error instanceof BillingError) return c.json({ error: error.message }, 400)
      throw error
    }
  })

  app.post('/api/billing/webhook', async (c) => {
    const payload = await c.req.text()
    const event = await verifyWebhook(env, payload, c.req.header('stripe-signature'))
    if (!event) return c.json({ error: 'Signature verification failed.' }, 400)
    await applyWebhook(db, event)
    return c.json({ received: true })
  })


  // --- CRM: people, companies, places, deals -------------------------------

  /*
   * One set of handlers over four record types. They differ in their columns,
   * not in their behaviour, and four hand-written copies of the same CRUD is
   * four places for the team scope to be forgotten.
   */
  const RECORD_ROUTES = { companies: 'company', people: 'person', places: 'place', deals: 'deal' }

  /*
   * What the CRM already knows about a parcel.
   *
   * The parcel map holds tens of thousands of parcels and the CRM holds a
   * handful of places, so the question is always asked in this direction: the
   * map has an id and wants to know whether it means anything here. Answering
   * with the deals as well saves a second round trip, because a place with no
   * deal on it is not what the broker clicked for.
   */
  app.get('/api/crm/parcel', async (c) => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Sign in to continue.' }, 401)

    const market = (c.req.query('market') ?? '').trim()
    const parcelId = (c.req.query('parcel') ?? '').trim()
    // A parcel id on its own is not an identifier: ids are unique per county
    // and nothing more, so answering without a market would mix up markets.
    if (!market || !parcelId) return c.json({ error: 'A market and a parcel are both required.' }, 400)

    const place = await db.get(
      'SELECT * FROM places WHERE team_id = ? AND market = ? AND parcel_id = ?',
      [user.teamId, market, parcelId],
    )
    if (!place) return c.json({ place: null, deals: [] })

    const deals = await db.all(
      `SELECT d.* FROM deals d
         JOIN deal_parties p ON p.deal_id = d.id
        WHERE d.team_id = ? AND p.kind = 'place' AND p.ref_id = ?
        ORDER BY d.updated_at DESC`,
      [user.teamId, place.id],
    )
    return c.json({ place: camelRow(place), deals: deals.map(camelRow) })
  })


  /*
   * How many of each the team holds. The navigation shows these on every
   * route; before this it fetched all four lists in full to count them.
   */
  app.get('/api/crm/counts', async (c) => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Sign in to continue.' }, 401)
    const { surveys, ...counts } = await countRecords(db, user.teamId)
    return c.json({ counts, surveys })
  })

  for (const [segment, recordType] of Object.entries(RECORD_ROUTES)) {
    app.get(`/api/crm/${segment}`, async (c) => {
      const user = c.get('user')
      if (!user) return c.json({ error: 'Sign in to continue.' }, 401)
      const { records, truncated } = await listRecords(db, recordType, user.teamId, {
        search: c.req.query('q') ?? '',
        limit: c.req.query('limit'),
        offset: c.req.query('offset'),
      })
      return c.json({ records, truncated })
    })

    app.post(`/api/crm/${segment}`, async (c) => {
      const user = c.get('user')
      if (!user) return c.json({ error: 'Sign in to continue.' }, 401)
      const result = await createRecord(db, recordType, user.teamId, await c.req.json().catch(() => ({})))
      if (result.error) return c.json({ error: result.error }, 400)
      return c.json({ record: result.record }, 201)
    })

    app.get(`/api/crm/${segment}/:id`, async (c) => {
      const user = c.get('user')
      if (!user) return c.json({ error: 'Sign in to continue.' }, 401)
      const record =
        recordType === 'deal'
          ? await dealWithParties(db, user.teamId, c.req.param('id'))
          : await getRecord(db, recordType, user.teamId, c.req.param('id'))
      if (!record) return notFound(c, 'That record does not exist.')
      return c.json({ record })
    })

    app.patch(`/api/crm/${segment}/:id`, async (c) => {
      const user = c.get('user')
      if (!user) return c.json({ error: 'Sign in to continue.' }, 401)
      const record = await updateRecord(
        db,
        recordType,
        user.teamId,
        c.req.param('id'),
        await c.req.json().catch(() => ({})),
      )
      if (!record) return notFound(c, 'That record does not exist.')
      return c.json({ record })
    })

    app.delete(`/api/crm/${segment}/:id`, async (c) => {
      const user = c.get('user')
      if (!user) return c.json({ error: 'Sign in to continue.' }, 401)
      const removed = await deleteRecord(db, recordType, user.teamId, c.req.param('id'))
      if (!removed) return notFound(c, 'That record does not exist.')
      return c.body(null, 204)
    })
  }

  app.post('/api/crm/deals/:id/parties', async (c) => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Sign in to continue.' }, 401)
    const body = await c.req.json().catch(() => ({}))
    const result = await addParty(db, user.teamId, c.req.param('id'), {
      kind: String(body?.kind ?? ''),
      refId: String(body?.refId ?? ''),
      role: body?.role ?? null,
    })
    if (result.error) return c.json({ error: result.error }, 400)
    return c.json({ deal: await dealWithParties(db, user.teamId, c.req.param('id')) }, 201)
  })

  app.delete('/api/crm/deals/:id/parties/:partyId', async (c) => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Sign in to continue.' }, 401)
    const removed = await removeParty(db, user.teamId, c.req.param('id'), c.req.param('partyId'))
    if (!removed) return notFound(c, 'That deal does not exist.')
    return c.body(null, 204)
  })

  /*
   * Sends a known building into a survey, as a site the broker can then work.
   *
   * A copy rather than a link: the survey is what the client sees and what the
   * broker annotates, and none of that should reach back and rewrite the
   * record the whole team relies on.
   */
  app.post('/api/crm/places/:id/send', async (c) => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Sign in to continue.' }, 401)

    const place = await getRecord(db, 'place', user.teamId, c.req.param('id'))
    if (!place) return notFound(c, 'That place does not exist.')

    const body = await c.req.json().catch(() => ({}))
    const surveyId = String(body?.surveyId ?? '')
    const survey = await getSurvey(db, surveyId)
    if (!survey || (survey.ownerId && survey.ownerId !== user.teamId)) {
      return notFound(c, 'That survey does not exist.')
    }

    // Onto the tour as well as the map. Sending a building to a survey is
    // saying "we are looking at this one", and there is no second intent
    // worth asking about. Appended rather than inserted: the broker's
    // existing order is theirs, and the planner can re-optimise on request.
    const onTour = Number(
      (await db.get('SELECT COUNT(*) AS n FROM properties WHERE survey_id = ? AND tour_order IS NOT NULL', [surveyId]))?.n ?? 0,
    )
    // The custom profile travels too: what the team recorded about a building
    // is most of why it was worth keeping a record of it.
    const property = await createProperty(db, surveyId, { ...propertyFromPlace(place), tourOrder: onTour })
    return c.json({ property }, 201)
  })

  // --- collaborators -------------------------------------------------------

  app.get('/api/invites', async (c) => c.json({ invites: await listInvites(db, c.get('user')?.teamId ?? null) }))

  app.post('/api/invites', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const result = await createInvite(db, {
      email: body?.email,
      createdBy: c.get('user')?.id ?? null,
    })
    if (result.error) return c.json({ error: result.error }, 400)

    // The full link is assembled here so the UI never has to guess its own
    // origin, and returned exactly once — the token is stored only as a digest.
    const origin = new URL(c.req.url).origin
    return c.json(
      {
        invite: result.invite,
        url: `${origin}/?invite=${result.token}`,
      },
      201,
    )
  })

  app.delete('/api/invites/:id', async (c) => {
    const removed = await revokeInvite(db, c.req.param('id'))
    if (!removed) return notFound(c, 'That invitation is gone already.')
    return c.body(null, 204)
  })

  app.get('/api/share/:token', async (c) => {
    const result = await resolveShare(db, c.req.param('token'))
    if (!result.ok) {
      const messages = {
        not_found: 'This link is not valid. Ask your broker for a new one.',
        disabled: 'Sharing has been turned off for this survey.',
        expired: 'This link has expired. Ask your broker for a new one.',
      }
      return c.json({ error: messages[result.reason], reason: result.reason }, result.reason === 'not_found' ? 404 : 410)
    }

    // The saved tour rides the share payload, so the client's map draws the
    // same routed path the broker planned — no routing call, and a replan
    // updates this link the moment it happens.
    let tourPlan = null
    try {
      const row = await db.get('SELECT tour_plan FROM surveys WHERE share_token = ?', [c.req.param('token')])
      const parsed = JSON.parse(row?.tour_plan ?? 'null')
      if (Array.isArray(parsed?.geometry) && parsed.geometry.length > 1) {
        tourPlan = { geometry: parsed.geometry, stopIds: parsed.stopIds ?? [] }
      }
    } catch {
      tourPlan = null
    }
    return c.json({ ...result, tourPlan })
  })

  // --- lookups -------------------------------------------------------------

  app.get('/api/geocode', async (c) => {
    const throttled = limited(c, 'geocode', 60, 60 * 1000)
    if (throttled) return throttled
    try {
      const query = String(c.req.query('q') ?? '')
      const key = query.trim().toLowerCase().replace(/\s+/g, ' ')
      const results = await lookups.geocode.remember(key, () => geocode(query, { env }))
      return c.json({ results })
    } catch (error) {
      if (error instanceof GeocodeError) {
        return c.json({ error: error.message, retryable: error.retryable }, error.retryable ? 503 : 400)
      }
      throw error
    }
  })

  app.get('/api/demographics', async (c) => {
    // Public, because the shared client map shades without a session — which
    // is exactly why it needs a limit: each miss is several Census calls.
    const throttled = limited(c, 'demographics', 60, 60 * 1000)
    if (throttled) return throttled
    const lat = Number(c.req.query('lat'))
    const lng = Number(c.req.query('lng'))
    try {
      const result = Number.isFinite(lat) && Number.isFinite(lng)
        ? await lookups.demographics.remember(coordinateKey(lat, lng), () => demographicsFor(lat, lng, { env }))
        : await demographicsFor(lat, lng, { env })
      return c.json(result)
    } catch (error) {
      if (error instanceof DemographicsUnavailable) return c.json({ error: error.message }, 503)
      throw error
    }
  })

  app.get('/api/places/categories', (c) =>
    c.json({
      categories: Object.entries(CATEGORIES).map(([id, entry]) => ({ id, label: entry.label })),
      rings: RING_MILES,
    }),
  )

  app.get('/api/places/nearby', async (c) => {
    const query = {
      lat: Number(c.req.query('lat')),
      lng: Number(c.req.query('lng')),
      category: c.req.query('category') || null,
      keyword: c.req.query('keyword') || null,
      radiusMiles: Number(c.req.query('radius')) || 5,
    }
    try {
      const search = () => nearbyBusinesses({ ...query, env })
      const cacheable = Number.isFinite(query.lat) && Number.isFinite(query.lng)
      const key = `${coordinateKey(query.lat, query.lng)}|${query.category ?? ''}|${(query.keyword ?? '').trim().toLowerCase()}|${query.radiusMiles}`
      return c.json(cacheable ? await lookups.places.remember(key, search) : await search())
    } catch (error) {
      if (error instanceof PlacesUnavailable) return c.json({ error: error.message }, 503)
      throw error
    }
  })

  // --- uploads -------------------------------------------------------------

  /** Reads a raw upload body, refusing anything over the size limit. */
  async function readUpload(c) {
    const buffer = await c.req.arrayBuffer()
    const bytes = new Uint8Array(buffer)
    if (bytes.length > MAX_UPLOAD_BYTES) return { error: c.json({ error: 'That file is too large. The limit is 12 MB.' }, 413) }
    return { bytes, mimeType: (c.req.header('content-type') || '').split(';')[0].trim() }
  }

  /**
   * Pasted listing text becomes a filled-in, placed site.
   *
   * Works with or without an Anthropic key: text is parseable by heuristics
   * where a flyer image is not, so this endpoint never answers "set a key".
   */
  /*
   * The parcel pipeline's door into R2.
   *
   * The Prospector build runs in GitHub Actions and has to land hundreds of
   * megabytes in the prospector-data bucket this Worker binds. Every
   * credential-shaped way of allowing that stores a long-lived secret
   * somewhere; instead the run authenticates as itself, with the OIDC token
   * GitHub signs for it, and this endpoint verifies the signature, the
   * audience, and an exact repository allowlist. Writes are confined to a
   * fixed set of data filenames under a market slug, so even a compromised
   * pipeline can only overwrite the map data it already owns.
   *
   * Large files arrive in parts: the multipart actions mirror R2's own
   * protocol, because a county's tile archive is bigger than a Worker
   * request is allowed to be.
   */
  const INGEST_AUDIENCE = 'landquotient-ingest'
  const INGEST_REPOS = ['pinekrone-dev/prospector', 'pinekrone-dev/x-opoly']
  const INGEST_FILES = {
    'parcels.pmtiles': 'application/octet-stream',
    'index.json': 'application/json',
    'details.json': 'application/json',
    'parcels.geojson': 'application/geo+json',
    // The catalog: light files the app reads to know what markets exist and
    // how to draw them. Publishing these through the same door makes a build
    // fully live on completion — no site deploy between the pipeline
    // finishing and customers seeing the new county.
    'meta.json': 'application/json',
    'codes.json': 'application/json',
    'census.json': 'application/json',
    'tracts.json': 'application/json',
    'tracts.geojson': 'application/geo+json',
    'owners.json': 'application/json',
    // The county's own recorded sales, for markets whose roll carries them.
    // Public data, published like the rest — separate from a workspace's own
    // imported comps, which never leave the workspace that collected them.
    'sales.json': 'application/json',
    // What extra layers this market publishes, and what each one is.
    'layers.json': 'application/json',
  }

  /*
   * The extra layers themselves.
   *
   * A fixed list cannot name these: the whole point of the layer registry is
   * that a market gains a source without this file changing. So the name is
   * bounded by shape instead — the `layer-` prefix keeps them in their own
   * namespace, the slug rules out traversal and surprises, and the extension
   * is fixed. Nothing here can address a file the pipeline does not own.
   */
  const INGEST_LAYER_FILE = /^layer-[a-z0-9-]{1,40}\.geojson$/

  /*
   * The same layers, as tile archives.
   *
   * A published overlay used to be one GeoJSON file fetched whole — Austin's
   * zoning is 41 MB of it, parsed into an object graph several times that size
   * before a single district appears. Tiled, the same layer is read by range
   * like the parcels are, and a viewport costs hundreds of kilobytes.
   *
   * Named by slug rather than with the `layer-` prefix, because the tiles are
   * cut alongside `parcels.pmtiles` and share its naming. The bound is the
   * same in either case: a slug and a fixed extension, so nothing can address
   * a file the pipeline could not have written or climb out of its county.
   */
  const INGEST_TILE_FILE = /^[a-z0-9-]{1,40}\.pmtiles$/

  // The one file that lives above the markets: the directory itself.
  const INGEST_ROOT_FILES = { 'markets.json': 'application/json' }

  /*
   * The catalogue, read from this origin.
   *
   * These files decide whether the product has anything to show: markets.json
   * is the list of counties, and a market's meta.json is where it opens and
   * how it is drawn. The browser used to fetch them straight from the data
   * domain, which makes every one of them subject to that bucket's CORS
   * policy — and a cross-origin refusal does not look like a refusal. It
   * arrives as `TypeError: Failed to fetch` with status 0, the market list
   * comes back empty, no county is ever chosen, and the whole view is blank.
   * The map appeared broken because the app had been told there were no
   * markets.
   *
   * Read through this origin instead and there is no cross-origin request to
   * refuse. The browser asks the app for the app's own data, which is what it
   * looked like it was doing all along.
   *
   * Two things keep this from becoming a way to read the bucket. The names
   * are the same allowlist the ingest side writes through, so nothing can be
   * fetched that the pipeline could not have put there; and the market is
   * matched as a slug, so no path can climb out of its county. When there is
   * no bucket bound — the Node server, a preview — it fetches the public file
   * from the data domain server-side, where CORS does not apply either.
   */
  const CATALOG_ORIGIN = (env.PARCEL_CATALOG_ORIGIN || 'https://data.realestateaistudio.com')
    .replace(/\/$/, '')

  /*
   * Open tile archives, kept for the life of the isolate.
   *
   * A PMTiles instance carries the archive's decoded directory, and the
   * directory is the expensive part: without this cache every lite tile
   * would re-read it from R2 before reading the tile itself. Bounded, since
   * an isolate serves a handful of markets, not an unbounded set.
   */
  const archives = new Map()
  const archiveFor = (key) => {
    if (archives.has(key)) return archives.get(key)
    const bucket = env.PROSPECTOR_DATA
    const source =
      bucket && typeof bucket.get === 'function'
        ? {
            getKey: () => key,
            getBytes: async (offset, length) => {
              const object = await bucket.get(key, { range: { offset, length } })
              if (!object) throw new Error(`no archive at ${key}`)
              return { data: await object.arrayBuffer() }
            },
          }
        : new FetchSource(`${CATALOG_ORIGIN}/${key}`)
    const archive = new PMTiles(source)
    if (archives.size > 16) archives.clear()
    archives.set(key, archive)
    return archive
  }

  app.get('/catalog/*', async (c) => {
    const path = new URL(c.req.url).pathname.replace(/^\/catalog\//, '')
    const parts = path.split('/')

    /*
     * The lite map's tiles: the same parcel archive, served one tile at a
     * time as plain GeoJSON.
     *
     * This exists so the map can work on a machine with no usable GPU at
     * all. The WebGL map reads the archive itself and hands binary tiles to
     * the graphics card; a browser whose WebGL is broken, disabled, or
     * software-rendered gets nothing from that path — not even the basemap,
     * since the whole map draws through one canvas. The lite path instead
     * asks this route for one tile's worth of parcels as GeoJSON and draws
     * them with Canvas 2D, which every browser has.
     *
     * The decode runs here rather than in the browser on purpose. The point
     * of the tier is to ask nothing of the weak machine: the server holds
     * the directory, seeks the tile, and unpacks the protobuf, and the
     * client receives coordinates it can draw with no library at all.
     *
     *   /catalog/<market>/lite/<z>/<x>/<y>.json
     */
    if (parts.length === 5 && parts[1] === 'lite' && /^[a-z0-9-]{2,40}$/.test(parts[0])) {
      const z = Number(parts[2])
      const x = Number(parts[3])
      const y = Number(parts[4].replace(/\.json$/, ''))
      // The parcel pyramid runs zoom 11 to 16; outside it there is no tile
      // to serve, and answering anything but 404 would invent one.
      if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) {
        return c.json({ error: 'Tiles are addressed as z/x/y integers.' }, 400)
      }
      if (z < 11 || z > 16 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) {
        return c.json({ error: 'Outside the tile pyramid.' }, 404)
      }
      try {
        const tile = await archiveFor(`${parts[0]}/parcels.pmtiles`).getZxy(z, x, y)
        const features = []
        if (tile?.data) {
          const decoded = new VectorTile(new PbfReader(new Uint8Array(tile.data)))
          const layer = decoded.layers.parcels
          for (let i = 0; layer && i < layer.length; i += 1) {
            const feature = layer.feature(i)
            const shaped = feature.toGeoJSON(x, y, z)
            if (feature.id != null) shaped.id = feature.id
            features.push(shaped)
          }
        }
        return new Response(JSON.stringify({ type: 'FeatureCollection', features }), {
          headers: {
            'content-type': 'application/geo+json',
            'cache-control': 'public, max-age=86400',
            'access-control-allow-origin': '*',
          },
        })
      } catch (cause) {
        return c.json({ error: `No tiles for that market: ${cause.message}` }, 404)
      }
    }

    let key = null
    let contentType = null
    if (parts.length === 1 && parts[0] in INGEST_ROOT_FILES) {
      key = parts[0]
      contentType = INGEST_ROOT_FILES[parts[0]]
    } else if (parts.length === 2 && /^[a-z0-9-]{2,40}$/.test(parts[0])) {
      const file = parts[1]
      if (file in INGEST_FILES) contentType = INGEST_FILES[file]
      else if (INGEST_LAYER_FILE.test(file)) contentType = 'application/geo+json'
      else if (INGEST_TILE_FILE.test(file)) contentType = 'application/octet-stream'
      if (contentType) key = `${parts[0]}/${file}`
    }
    if (!key) return c.json({ error: 'No such catalogue file.' }, 404)

    // A day in the browser. The catalogue changes when a county is rebuilt,
    // which is monthly, and a tile archive not at all within a build.
    const headers = {
      'content-type': contentType,
      'cache-control': 'public, max-age=86400',
      // Harmless here and useful everywhere: this is public county data, and
      // saying so means a preview deployment on another hostname can read it
      // too rather than rediscovering this same failure.
      'access-control-allow-origin': '*',
      // Announced on every answer, not only on ranged ones: a client decides
      // whether to ask for a range by looking at a plain response first.
      'accept-ranges': 'bytes',
    }

    /*
     * Byte ranges, because the parcel tiles are read that way.
     *
     * A pmtiles archive is one file of hundreds of megabytes that the map
     * reads a few kilobytes of at a time — it seeks a directory, then the one
     * tile under the viewport. Serving it whole would mean downloading a
     * county to draw a block, which is the download this entire change exists
     * to remove. So a Range on the way in has to be a range on the way out,
     * and anything else silently turns the map back into that download.
     */
    const asked = c.req.header('range')
    const wants = /^bytes=(\d+)-(\d*)$/.exec(asked || '')
    const offset = wants ? Number(wants[1]) : 0
    const last = wants && wants[2] !== '' ? Number(wants[2]) : null

    const bucket = env.PROSPECTOR_DATA
    if (bucket && typeof bucket.get === 'function') {
      /*
       * Kept at the edge, keyed by file and byte range. The tiles under a
       * city centre are the same few kilobytes for every visitor, and the
       * bucket bills each read; after the first visitor they cost nothing.
       * A day for an archive, which only changes when its county is
       * rebuilt; an hour for the catalogue's JSON, which the layer refresh
       * rewrites weekly.
       */
      const ttl = /\.(pmtiles|geojson)$/.test(key) ? 86400 : 3600
      return edgeCached(
        c,
        `catalog/${key}`,
        ttl,
        async () => {
          const object = await bucket.get(
            key,
            wants ? { range: last == null ? { offset } : { offset, length: last - offset + 1 } } : undefined,
          )
          if (!object) return c.json({ error: 'No such catalogue file.' }, 404)
          if (!wants) return new Response(object.body, { headers })
          const served = object.range?.length ?? object.size - offset
          const end = offset + served - 1
          return new Response(object.body, {
            status: 206,
            headers: { ...headers, 'content-range': `bytes ${offset}-${end}/${object.size}` },
          })
        },
        {
          params: { range: asked || '' },
          // Whole archives are hundreds of megabytes; the edge keeps ranges
          // and the small files, not a county in one piece.
          cacheable: (answer) =>
            (answer.status === 206 || answer.status === 200) &&
            (asked || Number(answer.headers.get('content-length') || 0) < 32 * 1024 * 1024 || !/\.pmtiles$/.test(key)),
        },
      )
    }

    // No bucket here. Fetch the public file the same way anyone would, except
    // from the server, where there is no origin to be refused for — carrying
    // the range through so this path reads tiles the same way.
    const answer = await fetch(`${CATALOG_ORIGIN}/${key}`, {
      headers: {
        'user-agent': 'LandQuotient/1.0 (+https://survey.realestateaistudio.com)',
        ...(asked ? { range: asked } : {}),
      },
    })
    if (!answer.ok && answer.status !== 206) {
      return c.json({ error: 'No such catalogue file.' }, answer.status === 404 ? 404 : 502)
    }
    const through = { ...headers }
    const span = answer.headers.get('content-range')
    if (span) through['content-range'] = span
    return new Response(answer.body, { status: answer.status, headers: through })
  })

  /*
   * What a failing map saw, reported by the map itself.
   *
   * Every diagnosis of "the map isn't loading" so far has been made from a
   * clean headless browser where the map loads fine — which is how four real
   * faults each took an extra round to find, and how a machine-level WebGL
   * failure stayed invisible for a day. This is the end of diagnosing by
   * guess: when the map cannot start, loses its GPU context, or hangs, the
   * browser that actually failed posts what it saw, and the report can be
   * read from the database instead of inferred from here.
   *
   * Deliberately small and bounded: a 4 KB cap on the report, a rate limit
   * per address, and only the newest five hundred rows kept. It stores what
   * the page chose to say and the user agent, nothing more.
   */
  app.post('/api/diag/map', async (c) => {
    const throttled = limited(c, 'diag', 30, 10 * 60 * 1000)
    if (throttled) return throttled
    let report
    try {
      report = JSON.stringify(await c.req.json()).slice(0, 4000)
    } catch {
      return c.json({ error: 'A JSON body is required.' }, 400)
    }
    await db.run(
      'CREATE TABLE IF NOT EXISTS diag (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, ua TEXT, report TEXT NOT NULL)',
    )
    await db.run('INSERT INTO diag (at, ua, report) VALUES (?, ?, ?)', [
      new Date().toISOString(),
      (c.req.header('user-agent') || '').slice(0, 300),
      report,
    ])
    // Bounded, so a looping failure cannot grow the table without limit.
    await db.run('DELETE FROM diag WHERE id <= (SELECT MAX(id) FROM diag) - 500')
    return c.json({ noted: true })
  })

  app.post('/api/gis/ingest', async (c) => {
    const throttled = limited(c, 'ingest', 300, 10 * 60 * 1000)
    if (throttled) return throttled

    const bucket = env.PROSPECTOR_DATA
    if (!bucket || typeof bucket.put !== 'function') {
      return c.json({ error: 'Only the Cloudflare deployment can ingest market data.' }, 501)
    }

    const token = (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '')
    try {
      await verifyActionsToken(token, {
        audience: INGEST_AUDIENCE,
        repositories: INGEST_REPOS,
        fetchImpl: env.JWKS_FETCH,
      })
    } catch (cause) {
      return c.json({ error: `Ingest refused: ${cause.message}.` }, 401)
    }

    const market = String(c.req.query('market') || '')
    const file = String(c.req.query('file') || '')
    let key, contentType
    if (file in INGEST_ROOT_FILES) {
      key = file
      contentType = INGEST_ROOT_FILES[file]
    } else {
      if (!/^[a-z0-9-]{2,40}$/.test(market)) {
        return c.json({ error: 'market must be a slug like austin-tx.' }, 400)
      }
      if (!(file in INGEST_FILES) && !INGEST_LAYER_FILE.test(file) && !INGEST_TILE_FILE.test(file)) {
        return c.json(
          {
            error: `file must be one of ${Object.keys(INGEST_FILES).join(', ')}, ` +
              'a layer-<name>.geojson, or a <name>.pmtiles.',
          },
          400,
        )
      }
      key = `${market}/${file}`
      contentType =
        INGEST_FILES[file] ??
        (INGEST_TILE_FILE.test(file) ? 'application/octet-stream' : 'application/geo+json')
    }
    const action = String(c.req.query('action') || 'put')

    if (action === 'put') {
      await bucket.put(key, await c.req.arrayBuffer(), { httpMetadata: { contentType } })
      return c.json({ stored: key })
    }
    if (action === 'create') {
      const upload = await bucket.createMultipartUpload(key, { httpMetadata: { contentType } })
      return c.json({ uploadId: upload.uploadId })
    }
    if (action === 'part') {
      const uploadId = String(c.req.query('uploadId') || '')
      const part = Number(c.req.query('part'))
      if (!uploadId || !Number.isInteger(part) || part < 1 || part > 10000) {
        return c.json({ error: 'part needs uploadId and a part number from 1.' }, 400)
      }
      const upload = bucket.resumeMultipartUpload(key, uploadId)
      const stored = await upload.uploadPart(part, await c.req.arrayBuffer())
      return c.json({ etag: stored.etag, partNumber: part })
    }
    if (action === 'complete') {
      const uploadId = String(c.req.query('uploadId') || '')
      const body = await c.req.json().catch(() => ({}))
      const parts = Array.isArray(body?.parts) ? body.parts : []
      if (!uploadId || parts.length === 0) {
        return c.json({ error: 'complete needs uploadId and the list of parts.' }, 400)
      }
      const upload = bucket.resumeMultipartUpload(key, uploadId)
      await upload.complete(parts.map((p) => ({ partNumber: Number(p.partNumber), etag: String(p.etag) })))
      return c.json({ stored: key })
    }
    return c.json({ error: `Unknown action "${action}".` }, 400)
  })

  /*
   * Sale comps, imported by the broker rather than harvested by the server.
   *
   * There is no crawler behind these endpoints and there is not going to be
   * one. A listing site's compiled database belongs to that site; scraping it
   * into a shared table here would redistribute their work and would be worth
   * suing over. What a broker's own browser showed them on pages they were
   * licensed to view is a different thing, and it stays in their workspace:
   * every query below is scoped by `team_id`, and nothing joins across teams.
   */
  /*
   * The county, answered rather than downloaded.
   *
   * Every one of these replaces a computation the browser used to do over the
   * whole attribute index: the search, the totals under it, the card for one
   * parcel, and the facts a market states about itself. The index is still
   * published, and a market whose rebuild has not reached this store yet still
   * works the old way — `/api/gis/market` answering `ready: false` is how the
   * app knows which of the two it is looking at.
   */

  /** Numbers to a number, blank to null. A missing bound is not a zero bound. */
  const bound = (raw) => {
    const value = (raw ?? '').toString().trim()
    if (value === '') return null
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }

  /** The filters, read off the query string exactly once. */
  const parcelFilters = (c) => {
    const ownerId = (c.req.query('owner') ?? '').trim()
    return {
      query: (c.req.query('q') ?? '').trim().slice(0, 120),
      assets: (c.req.query('at') ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
        .slice(0, 40),
      valueMin: bound(c.req.query('vmin')),
      valueMax: bound(c.req.query('vmax')),
      acresMin: bound(c.req.query('amin')),
      acresMax: bound(c.req.query('amax')),
      owner: ownerId ? { kind: c.req.query('ownerKind') === 'b' ? 'b' : 'p', id: ownerId } : null,
    }
  }

  const marketSlug = (c) => {
    const market = (c.req.query('market') ?? '').trim()
    return /^[a-z0-9-]{2,40}$/.test(market) ? market : null
  }

  /*
   * What a market is, before anything is asked of it.
   *
   * The app calls this first and branches on `ready`: served from here, or the
   * whole index downloaded the old way. Cheap enough to call on every market
   * change — it reads one row.
   */
  app.get('/api/gis/market', async (c) => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Sign in to continue.' }, 401)
    const market = marketSlug(c)
    if (!market) return c.json({ error: 'market must be a slug like austin-tx.' }, 400)
    return edgeCached(c, `market/${market}`, 5 * 60, async () => {
      const summary = await marketSummary(parcels, market).catch(() => null)
      if (!summary) return c.json({ ready: false, market })
      return c.json({ ready: true, ...summary })
    })
  })

  /** Every market this server can answer for, so the app can say so up front. */
  app.get('/api/gis/markets', async (c) => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Sign in to continue.' }, 401)
    const ready = await readyMarkets(parcels).catch(() => [])
    return c.json({ ready })
  })

  /*
   * One search: the page, the ids to highlight, and what the whole match adds
   * up to. Three readings of one predicate, so the report can never disagree
   * with the map beside it.
   */
  app.get('/api/gis/parcels', async (c) => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Sign in to continue.' }, 401)
    const throttled = limited(c, 'parcels', 600, 10 * 60 * 1000)
    if (throttled) return throttled
    const market = marketSlug(c)
    if (!market) return c.json({ error: 'market must be a slug like austin-tx.' }, 400)

    const summary = await marketSummary(parcels, market).catch(() => null)
    if (!summary) return c.json({ ready: false, market }, 404)

    /*
     * The same question from anyone gets the same answer, so the answer is
     * kept at the edge for a few minutes. Opening a market is the same
     * request from every visitor — and it is the request that used to read
     * the whole county — so after the first visitor it costs the store
     * nothing. Keyed on the market and the filters, never on who asked.
     */
    return edgeCached(c, `parcels/${market}`, 10 * 60, async () => {
      try {
        const found = await searchParcels(parcels, market, parcelFilters(c), {
          limit: Number(c.req.query('limit')) || undefined,
          offset: Number(c.req.query('offset')) || 0,
          summary,
        })
        return c.json({ ready: true, market, ...found })
      } catch (cause) {
        return c.json({ error: `The parcel search failed: ${cause.message}.` }, 500)
      }
    })
  })

  /** One parcel, for the card. Everything the county published about it. */
  app.get('/api/gis/parcel', async (c) => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Sign in to continue.' }, 401)
    const market = marketSlug(c)
    if (!market) return c.json({ error: 'market must be a slug like austin-tx.' }, 400)
    const id = (c.req.query('id') ?? '').trim()
    if (!id) return c.json({ error: 'id is required.' }, 400)
    const found = await getParcel(parcels, market, id).catch(() => null)
    if (!found) return notFound(c, 'No such parcel in that market.')
    return c.json({ parcel: found })
  })

  /*
   * Publishing a county into the store.
   *
   * The same door and the same proof as the file ingest above: a GitHub
   * Actions token from one of two repositories, no credential stored on either
   * side. A rebuild reads `hashes`, sends `rows` for the parcels whose hash
   * moved, `drop` for the ones the county no longer carries, then `seal` — and
   * only the seal makes the market answerable, so a run that dies halfway
   * leaves the app on the old path rather than on half a county.
   *
   * `clear` remains for the rare case that wants the market genuinely emptied.
   * It is no longer part of a normal publish: emptying a county and refilling
   * it bills every row twice, once for the delete and once for the insert,
   * which is the whole of what the diff exists to avoid.
   */
  app.post('/api/gis/ingest/parcels', async (c) => {
    const throttled = limited(c, 'ingest', 3000, 10 * 60 * 1000)
    if (throttled) return throttled

    const token = (c.req.header('authorization') || '').replace(/^Bearer[ ]+/i, '')
    try {
      await verifyActionsToken(token, {
        audience: INGEST_AUDIENCE,
        repositories: INGEST_REPOS,
        fetchImpl: env.JWKS_FETCH,
      })
    } catch (cause) {
      return c.json({ error: `Ingest refused: ${cause.message}.` }, 401)
    }

    const market = marketSlug(c)
    if (!market) return c.json({ error: 'market must be a slug like austin-tx.' }, 400)
    const action = String(c.req.query('action') || 'rows')

    try {
      if (action === 'clear') {
        // Bounded, and says whether it finished. A county holds more rows
        // than one request can delete inside D1's CPU budget, so the caller
        // repeats this until `done` — see clearMarket.
        const { removed, done } = await clearMarket(parcels, market)
        return c.json({ cleared: market, removed, done })
      }
      if (action === 'hashes') {
        // What the market already holds, so a publisher can send only what
        // changed. Paged by pid — see listHashes for why not by offset.
        const asked = Number(c.req.query('limit'))
        const { hashes, cursor } = await listHashes(parcels, market, {
          after: String(c.req.query('after') ?? ''),
          limit: Number.isFinite(asked) ? asked : undefined,
        })
        return c.json({ market, hashes, cursor })
      }
      if (action === 'drop') {
        const body = await c.req.json().catch(() => null)
        const pids = Array.isArray(body) ? body : body?.pids
        if (!Array.isArray(pids)) {
          return c.json({ error: 'Send the parcel ids as a JSON array.' }, 400)
        }
        if (pids.length > 20000) {
          return c.json({ error: 'Send at most 20000 parcel ids per request.' }, 413)
        }
        return c.json({ dropped: await dropParcels(parcels, market, pids) })
      }
      if (action === 'rows') {
        const body = await c.req.json().catch(() => null)
        const rows = Array.isArray(body) ? body : body?.parcels
        if (!Array.isArray(rows)) {
          return c.json({ error: 'Send the parcels as a JSON array.' }, 400)
        }
        if (rows.length > 5000) {
          return c.json({ error: 'Send at most 5000 parcels per request.' }, 413)
        }
        return c.json({ stored: await putParcels(parcels, market, rows) })
      }
      if (action === 'seal') {
        const body = await c.req.json().catch(() => ({}))
        const sealed = await sealMarket(parcels, market, {
          keys: Array.isArray(body?.keys) ? body.keys : [],
          builtAt: typeof body?.builtAt === 'string' ? body.builtAt : null,
        })
        return c.json({ sealed: market, ...sealed })
      }
      if (action === 'reindex') {
        // Mirror the market into the text index, a bounded step at a time.
        // The caller repeats with the cursor until `done` — see
        // reindexMarket for why a county cannot be indexed in one request.
        const after = Number(c.req.query('after'))
        const step = await reindexMarket(parcels, market, {
          after: Number.isFinite(after) ? after : 0,
        })
        return c.json({ market, ...step })
      }
    } catch (cause) {
      return c.json({ error: `Ingest failed: ${cause.message}.` }, 500)
    }
    return c.json({ error: `Unknown action "${action}".` }, 400)
  })

  app.get('/api/gis/comps', async (c) => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Sign in to continue.' }, 401)
    const market = (c.req.query('market') ?? '').trim() || null
    const comps = await listComps(db, user.teamId, { market })
    return c.json({
      comps,
      // What the map cannot draw yet, so the client knows whether to keep
      // asking for another geocoding pass.
      unplaced: comps.filter((comp) => !comp.placed).length,
    })
  })

  app.post('/api/gis/comps', async (c) => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Sign in to continue.' }, 401)
    const throttled = limited(c, 'comps', 60, 10 * 60 * 1000)
    if (throttled) return throttled

    const body = await c.req.json().catch(() => null)
    if (!body) return c.json({ error: 'Send the captured listings as JSON.' }, 400)
    const market = typeof body?.market === 'string' && body.market.trim() ? body.market.trim() : null
    const source = typeof body?.source === 'string' && body.source.trim() ? body.source.trim().slice(0, 60) : null

    /*
     * Two shapes, because listings do not arrive in one.
     *
     * `listings` is a parsed array — what a capture produces, and what the
     * client sends after reading a file. `csv` is the raw text of a delimited
     * export, accepted so that a broker with a spreadsheet is not told to go
     * and convert it first.
     */
    const source_rows =
      typeof body?.csv === 'string' ? readDelimited(body.csv) : (body.listings ?? body)
    const { rows, read, dropped, error } = readComps(source_rows, { source })
    if (error) return c.json({ error }, 400)
    if (!rows.length) {
      return c.json(
        {
          error: dropped
            ? `Read ${read} entries but none carried an address or a name.`
            : 'That list was empty.',
        },
        400,
      )
    }
    const { added, updated } = await saveComps(db, user.teamId, rows, { market })
    return c.json({
      added,
      updated,
      dropped,
      // Only the first page-worth is capped, and saying so beats silently
      // storing 2,000 of the 3,000 someone collected.
      truncated: read > MAX_COMPS_PER_IMPORT ? read - MAX_COMPS_PER_IMPORT : 0,
    })
  })

  /*
   * One geocoding pass. The client calls this repeatedly until `remaining`
   * reaches zero, because a single request that looked up four hundred
   * addresses would sit past the edge's timeout and lose the lot.
   */
  app.post('/api/gis/comps/place', async (c) => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Sign in to continue.' }, 401)
    const throttled = limited(c, 'comps-place', 200, 10 * 60 * 1000)
    if (throttled) return throttled
    return c.json(await placeComps(db, user.teamId, geocode, { env }))
  })

  app.delete('/api/gis/comps/:id', async (c) => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Sign in to continue.' }, 401)
    if (c.req.param('id') === 'all') {
      return c.json({ removed: await clearComps(db, user.teamId) })
    }
    if (!(await deleteComp(db, user.teamId, c.req.param('id')))) {
      return notFound(c, 'That comp does not exist.')
    }
    return c.json({ removed: 1 })
  })

  /*
   * Saved map views: a market, configured, under a name.
   *
   * Team-scoped like everything else in a workspace, so a colleague opening
   * the same market sees the same saved views. That is deliberate — a view is
   * how somebody framed a market, and framing is exactly the kind of thing a
   * brokerage wants to share rather than each person rebuilding.
   */
  app.get('/api/gis/views', async (c) => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Sign in to continue.' }, 401)
    const market = (c.req.query('market') ?? '').trim() || null
    return c.json({ views: await listViews(db, user.teamId, market) })
  })

  app.post('/api/gis/views', async (c) => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Sign in to continue.' }, 401)
    const throttled = limited(c, 'views', 120, 10 * 60 * 1000)
    if (throttled) return throttled
    const result = await saveView(db, user.teamId, await c.req.json().catch(() => ({})), {
      userId: user.id,
    })
    if (result.error) return c.json({ error: result.error }, 400)
    return c.json({ view: result.view }, 201)
  })

  app.patch('/api/gis/views/:id', async (c) => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Sign in to continue.' }, 401)
    const body = await c.req.json().catch(() => ({}))
    const result = await renameView(db, user.teamId, c.req.param('id'), body?.name)
    if (result.missing) return notFound(c, 'That view does not exist.')
    if (result.error) return c.json({ error: result.error }, 400)
    return c.json({ view: result.view })
  })

  app.delete('/api/gis/views/:id', async (c) => {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Sign in to continue.' }, 401)
    if (!(await deleteView(db, user.teamId, c.req.param('id')))) {
      return notFound(c, 'That view does not exist.')
    }
    return c.json({ removed: 1 })
  })

  /*
   * The parcel scout: a hunt in plain English, answered as the GIS view's
   * own filters. The vocabulary comes up with the request because the server
   * holds no parcel data at all — asset types are whatever the county the
   * client is looking at publishes. Same AI provider as the flyer reader;
   * without a key the heuristic answers and says so.
   */
  app.post('/api/gis/scout', async (c) => {
    // 120 in ten minutes was set when this was the only guard; with a daily
    // budget behind it the burst limit only has to stop a hammering, and 30
    // is well above what a person typing sentences reaches.
    const throttled = limited(c, 'scout', 30, 10 * 60 * 1000)
    if (throttled) return throttled


    const body = await c.req.json().catch(() => ({}))
    const prompt = String(body?.prompt ?? '').trim().slice(0, 500)
    if (!prompt) return c.json({ error: 'Describe what you are hunting for.' }, 400)
    const vocab = {
      assetTypes: Array.isArray(body?.assetTypes)
        ? body.assetTypes.filter((entry) => typeof entry === 'string').slice(0, 60)
        : [],
      valueLabel: typeof body?.valueLabel === 'string' ? body.valueLabel.slice(0, 60) : 'Value',
    }

    /*
     * Rules first, the model only as a fallback.
     *
     * Most hunts are formulaic — a type, a floor, a ceiling — and the rule
     * parser reads those for free. A model call happens only when the rules
     * come back empty-handed, behind its own tighter limit, so the common
     * case costs nothing and the AI budget goes to the sentences that
     * actually need comprehension.
     */
    const ruled = heuristicScout(prompt, vocab)
    if (!ruled.empty) {
      // Answered without a model, so nothing is charged. This is the common
      // case, and charging it would lock somebody out of the AI over three
      // hundred hunts that never cost anything.
      return c.json({ ...ruled, explanation: null, source: 'rules', provider: null, model: null })
    }

    const aiThrottled = limited(c, 'scout-ai', 10, 10 * 60 * 1000)
    if (aiThrottled) return aiThrottled

    // Only here, where a model is actually about to be called, does the day's
    // budget get spent.
    const overspent = await afforded(c, 'scout')
    if (overspent) return overspent

    try {
      const answer = await runScout(prompt, vocab, resolveProvider(env), env)
      // Carried back so the budget becomes visible as it is used rather than
      // arriving as a refusal out of nowhere.
      const budget = await usageToday(db, c.get('user')?.teamId ?? null, env)
      return c.json(budget ? { ...answer, budget: budget.scout } : answer)
    } catch (cause) {
      return c.json({ error: cause?.message || 'The scout could not read that hunt.' }, 422)
    }
  })

  /*
   * Restyles the tour book from a sentence.
   *
   * The style has six levers and the model may only move those: the answer
   * is normalized down to the known keys, so a model that invents an option
   * invents nothing. Costs a "read" from the day's AI budget, because it is
   * one small completion — and an instruction the rules could never need a
   * model for is still sent to one, since parsing style intent is exactly
   * the fuzzy step the model is for.
   */
  app.post('/api/surveys/:id/book-style', async (c) => {
    const throttled = limited(c, 'ai', 20, 10 * 60 * 1000)
    if (throttled) return throttled
    const { survey, error } = await requireSurvey(c)
    if (error) return error

    const body = await c.req.json().catch(() => ({}))
    const instruction = String(body?.instruction ?? '').trim().slice(0, 500)

    // A direct style object needs no model and costs no budget.
    if (!instruction && body?.style) {
      const saved = await updateSurvey(db, survey.id, { bookStyle: body.style })
      return c.json({ book: saved.book })
    }
    if (!instruction) return c.json({ error: 'Say how the book should change.' }, 400)

    const provider = resolveProvider(env)
    if (!provider) {
      return c.json(
        {
          error:
            'Restyling with AI needs an AI key. Set ANTHROPIC_API_KEY, GEMINI_API_KEY, or ' +
            'XAI_API_KEY on the server, or adjust the options by hand.',
        },
        422,
      )
    }
    const overspent = await afforded(c, 'read')
    if (overspent) return overspent

    try {
      const answer = await askJson(
        provider,
        {
          system: BOOK_STYLE_PROMPT,
          user:
            `Current style: ${JSON.stringify(normalizeBookStyle(survey.book))}\n` +
            `Instruction: ${instruction}`,
        },
        env,
      )
      const saved = await updateSurvey(db, survey.id, { bookStyle: answer })
      return c.json({ book: saved.book })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'The restyle failed.'
      return c.json({ error: message }, 502)
    }
  })

  app.post('/api/surveys/:id/paste', async (c) => {
    const throttled = limited(c, 'ai', 20, 10 * 60 * 1000)
    if (throttled) return throttled
    const overspent = await afforded(c, 'read')
    if (overspent) return overspent
    const { survey, error } = await requireSurvey(c)
    if (error) return error

    const body = await c.req.json().catch(() => ({}))

    try {
      const { fields, source, model } = await extractFromText(body?.text, { env })
      const located = await locateFromFields(fields, survey, env, {
        hint: body?.mapCenter ?? null,
        siblings: await listProperties(db, survey.id),
      })

      const property = await createProperty(db, survey.id, {
        ...toPropertyInput(fields),
        lat: located.lat,
        lng: located.lng,
        fields: mergeExtraction({ fields: [] }, fields).fields,
      })
      await rememberPlace(db, c.get('user')?.teamId ?? null, property)

      return c.json(
        {
          property,
          extraction: {
            source,
            model,
            confidence: fields.confidence,
            uncertainFields: fields.uncertainFields ?? [],
            placed: located.placed,
          },
        },
        201,
      )
    } catch (cause) {
      if (cause instanceof FlyerExtractionError) {
        return c.json({ error: cause.message }, 422)
      }
      throw cause
    }
  })

  app.post('/api/surveys/:id/flyer', async (c) => {
    const throttled = limited(c, 'ai', 20, 10 * 60 * 1000)
    if (throttled) return throttled
    const overspent = await afforded(c, 'read')
    if (overspent) return overspent
    const { survey, error } = await requireSurvey(c)
    if (error) return error

    const upload = await readUpload(c)
    if (upload.error) return upload.error

    const filename = decodeURIComponent(c.req.header('x-filename') || 'flyer')
    const stored = `${crypto.randomUUID()}${EXTENSIONS[upload.mimeType] || ''}`
    await storage.put(stored, upload.bytes, upload.mimeType || 'application/octet-stream')

    try {
      const { fields, model } = await extractFromFlyer(upload.bytes, upload.mimeType, { env })
      const located = await locateFromFields(fields, survey, env, {
        hint: mapHint(c),
        siblings: await listProperties(db, survey.id),
      })

      const property = await createProperty(db, survey.id, {
        ...toPropertyInput(fields),
        lat: located.lat,
        lng: located.lng,
        flyer_path: stored,
        flyer_name: filename,
        fields: mergeExtraction({ fields: [] }, fields).fields,
      })
      await rememberPlace(db, c.get('user')?.teamId ?? null, property)

      return c.json(
        {
          property,
          extraction: {
            model,
            confidence: fields.confidence,
            uncertainFields: fields.uncertainFields,
            placed: located.placed,
          },
        },
        201,
      )
    } catch (cause) {
      if (cause instanceof FlyerExtractionError) {
        // Keep the file and file a stub so the upload is never wasted — but
        // still place it, so the broker sees a pin appear and can drag it to
        // the right spot rather than wondering whether anything happened.
        const located = await locateFromFields(null, survey, env, {
          hint: mapHint(c),
          siblings: await listProperties(db, survey.id),
        })
        const property = await createProperty(db, survey.id, {
          name: filename,
          lat: located.lat,
          lng: located.lng,
          flyer_path: stored,
          flyer_name: filename,
        })
        return c.json({ error: cause.message, configured: cause.configured, property, placed: located.placed }, 422)
      }
      throw cause
    }
  })

  // --- images ---------------------------------------------------------------

  app.get('/api/properties/:id/images', async (c) => {
    {
      const { error } = await requireProperty(c)
      if (error) return error
    }
    return c.json({ images: await listImages(db, c.req.param('id')) })
  })

  /**
   * Stores an image for a property.
   *
   * Used both for a plain upload and for a region cropped out of a rendered
   * flyer page, which arrives as a PNG the browser produced from the canvas.
   */
  app.post('/api/properties/:id/images', async (c) => {
    const id = c.req.param('id')
    {
      const { error } = await requireProperty(c, id)
      if (error) return error
    }

    const upload = await readUpload(c)
    if (upload.error) return upload.error
    if (!upload.mimeType.startsWith('image/')) {
      return c.json({ error: 'That needs to be an image file.' }, 400)
    }

    const stored = `${crypto.randomUUID()}${EXTENSIONS[upload.mimeType] || '.png'}`
    await storage.put(stored, upload.bytes, upload.mimeType)

    const caption = c.req.header('x-caption')
      ? decodeURIComponent(c.req.header('x-caption'))
      : null
    const source = c.req.header('x-source') === 'flyer-crop' ? 'flyer-crop' : 'upload'

    const result = await addImage(db, id, { path: stored, caption, source })
    if (result.error) {
      // Do not leave the object behind if the row was refused.
      await storage.delete(stored).catch(() => undefined)
      return c.json({ error: result.error }, 400)
    }
    return c.json({ image: result.image, property: await getProperty(db, id) }, 201)
  })

  /** The image's owning property, team-checked; null answers are 404s. */
  async function requireImage(c) {
    const row = await db.get('SELECT property_id FROM property_images WHERE id = ?', [c.req.param('id')])
    if (!row) return { error: notFound(c, 'That image does not exist.') }
    const { error } = await requireProperty(c, row.property_id)
    if (error) return { error }
    return {}
  }

  app.patch('/api/images/:id', async (c) => {
    {
      const { error } = await requireImage(c)
      if (error) return error
    }
    const body = await c.req.json().catch(() => ({}))
    const result = await updateImage(db, c.req.param('id'), body)
    if (result.error) return notFound(c, result.error)
    return c.json({ image: result.image })
  })

  app.delete('/api/images/:id', async (c) => {
    {
      const { error } = await requireImage(c)
      if (error) return error
    }
    if (!(await deleteImage(db, c.req.param('id'), storage))) {
      return notFound(c, 'That image does not exist.')
    }
    return c.body(null, 204)
  })

  app.put('/api/properties/:id/images', async (c) => {
    const id = c.req.param('id')
    {
      const { error } = await requireProperty(c, id)
      if (error) return error
    }
    const body = await c.req.json().catch(() => ({}))
    const order = Array.isArray(body?.order) ? body.order.map(String) : []
    return c.json({ images: await reorderImages(db, id, order) })
  })

  /**
   * Reads the flyer already attached to a property and fills that property in.
   *
   * Separate from the upload route, which creates a new property: this one
   * targets a site that already exists, so it can be re-run after a better
   * copy of the flyer is attached, or after a field was cleared.
   *
   * By default only empty fields are filled. A broker who has corrected a
   * number by hand should not lose it to a re-run, so overwriting is something
   * they ask for rather than something that happens to them.
   */
  app.post('/api/properties/:id/extract', async (c) => {
    const throttled = limited(c, 'ai', 20, 10 * 60 * 1000)
    if (throttled) return throttled
    const overspent = await afforded(c, 'read')
    if (overspent) return overspent
    const id = c.req.param('id')
    {
      const { error } = await requireProperty(c, id)
      if (error) return error
    }
    // The merge below needs the custom fields, so this route reads the
    // full record. It is rare and bound by an AI call, so the extra reads
    // do not matter here the way they do on a pin drag.
    const property = await getProperty(db, id)
    if (!property.flyerUrl) {
      return c.json({ error: 'There is no flyer on this site to read. Attach one first.' }, 400)
    }

    const body = await c.req.json().catch(() => ({}))
    const overwrite = body?.overwrite === true

    // flyerUrl is /api/files/<stored>; the stored name is what storage knows.
    const stored = property.flyerUrl.split('/').pop()
    const file = await storage.get(stored)
    if (!file) {
      return c.json({ error: 'That flyer is no longer in storage. Attach it again.' }, 410)
    }

    try {
      const { fields, model } = await extractFromFlyer(file.body, file.contentType, { env })

      const { patch, filled, skipped, fields: rows } = mergeExtraction(property, fields, { overwrite })

      // A site read from a flyer but never placed still needs a pin.
      if (property.lat == null || property.lng == null) {
        const survey = await getSurvey(db, property.surveyId)
        const located = await locateFromFields(fields, survey, env, {
          siblings: await listProperties(db, property.surveyId),
        })
        if (located.lat != null) {
          patch.lat = located.lat
          patch.lng = located.lng
          filled.push('lat', 'lng')
        }
      }

      const changes = rows.length > 0 ? { ...patch, fields: rows } : patch
      const updated = Object.keys(changes).length > 0 ? await updateProperty(db, id, changes) : property

      return c.json({
        property: updated,
        extraction: {
          model,
          confidence: fields.confidence,
          uncertainFields: fields.uncertainFields,
          filled,
          skipped,
        },
      })
    } catch (cause) {
      if (cause instanceof FlyerExtractionError) {
        return c.json({ error: cause.message, configured: cause.configured }, 422)
      }
      throw cause
    }
  })

  /** Attaches a flyer to a property that already exists. */
  app.post('/api/properties/:id/flyer', async (c) => {
    const id = c.req.param('id')
    const { row, error } = await requireProperty(c, id)
    if (error) return error

    const upload = await readUpload(c)
    if (upload.error) return upload.error

    const filename = decodeURIComponent(c.req.header('x-filename') || 'flyer')
    const stored = `${crypto.randomUUID()}${EXTENSIONS[upload.mimeType] || ''}`
    await storage.put(stored, upload.bytes, upload.mimeType || 'application/octet-stream')

    return c.json({
      property: await updateProperty(db, id, { flyer_path: stored, flyer_name: filename }, { row }),
    })
  })

  app.post('/api/properties/:id/photo', async (c) => {
    const { row, error } = await requireProperty(c)
    if (error) return error

    const upload = await readUpload(c)
    if (upload.error) return upload.error
    if (!upload.mimeType.startsWith('image/')) return c.json({ error: 'Photos must be an image file.' }, 400)

    const stored = `${crypto.randomUUID()}${EXTENSIONS[upload.mimeType] || ''}`
    await storage.put(stored, upload.bytes, upload.mimeType)
    return c.json({ property: await updateProperty(db, c.req.param('id'), { photo_path: stored }, { row }) })
  })

  app.get('/api/files/:name', async (c) => {
    const name = c.req.param('name')
    // Generated names only — reject anything that could climb out of the store.
    if (!/^[\w.-]+$/.test(name)) return c.json({ error: 'Bad file name.' }, 400)

    const file = await storage.get(name)
    if (!file) return notFound(c, 'That file is no longer stored.')

    return c.body(file.body, 200, {
      'content-type': file.contentType || contentTypeFor(name),
      'cache-control': 'private, max-age=3600',
    })
  })

  app.all('/api/*', (c) => c.json({ error: 'Unknown endpoint.' }, 404))

  app.onError((error, c) => c.json({ error: error?.message || 'Unexpected server error.' }, 500))

  return app
}
