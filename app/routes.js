/**
 * The HTTP API, written once for both runtimes.
 *
 * Hono runs unchanged on Node and on Cloudflare Workers, so these routes are
 * the single definition of the API. Everything environment-specific — which
 * database, which file store, which secrets — arrives through the context that
 * `createApp` closes over, so nothing in here knows where it is running.
 */

import { Hono } from 'hono'

import {
  STAGES,
  STAGE_LABELS,
  createProperty,
  createSurvey,
  deleteProperty,
  deleteSurvey,
  getProperty,
  getSurvey,
  listProperties,
  listSurveys,
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
  findByEmail,
  getUser,
  markLogin,
  normalizePhone,
  sessionUser,
  verifyChallenge,
} from './lib/auth.js'
import { SmsUnavailable, codeMessage, sendSms, smsConfigured } from './lib/sms.js'
import { GeocodeError, geocode } from './lib/geocode.js'
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
async function locateFromFields(fields, survey, env) {
  const parts = [fields?.address, fields?.city, fields?.state, fields?.zip].filter(Boolean)

  if (parts.length > 0) {
    try {
      const { results } = await geocode(parts.join(', '), { env })
      if (results?.length > 0) {
        return { lat: results[0].lat, lng: results[0].lng, placed: 'geocoded' }
      }
    } catch {
      // Fall through to the survey centre.
    }
  }

  if (survey?.center) {
    return { lat: survey.center.lat, lng: survey.center.lng, placed: 'survey-centre' }
  }
  return { lat: null, lng: null, placed: 'unplaced' }
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
export function createApp({ db, storage, env = {} }) {
  const app = new Hono()

  const notFound = (c, message) => c.json({ error: message }, 404)

  /** Loads a survey or ends the request. */
  async function requireSurvey(c) {
    const survey = await getSurvey(db, c.req.param('id'))
    if (!survey) return { error: notFound(c, 'That survey does not exist.') }
    return { survey }
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
            anthropic: isConfigured(env),
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
  const PUBLIC_PATHS = [/^\/api\/health$/, /^\/api\/auth\//, /^\/api\/share\//, /^\/api\/tiles\//, /^\/api\/files\//]

  /**
   * Requires a session for everything else — unless no account exists yet.
   *
   * That exception is the setup window. Locking the API down before anyone can
   * create an account would make the instance unusable and unrecoverable
   * through the browser, which is the only tool the operator has here.
   */
  app.use('/api/*', async (c, next) => {
    const path = new URL(c.req.url).pathname
    if (PUBLIC_PATHS.some((pattern) => pattern.test(path))) return next()

    if ((await countUsers(db)) === 0) {
      c.set('setupMode', true)
      return next()
    }

    const user = await sessionUser(db, tokenFrom(c))
    if (!user) return c.json({ error: 'Sign in to continue.' }, 401)
    c.set('user', user)
    return next()
  })

  app.get('/api/auth/me', async (c) => {
    const user = await sessionUser(db, tokenFrom(c))
    return c.json({
      user,
      setupRequired: (await countUsers(db)) === 0,
      smsConfigured: smsConfigured(env),
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
    const body = await c.req.json().catch(() => ({}))
    const existing = await countUsers(db)

    if (existing > 0) {
      const offered = String(body?.inviteToken ?? '')
      if (!env.SIGNUP_TOKEN || offered !== env.SIGNUP_TOKEN) {
        return c.json({ error: 'Registration is closed on this instance.' }, 403)
      }
    }

    const result = await createUser(db, body)
    if (result.error) return c.json({ error: result.error }, 400)

    // The first account adopts anything created before accounts existed,
    // rather than letting real work become unreachable.
    const adopted = existing === 0 ? await adoptOrphanSurveys(db, result.user.id) : 0

    const token = await createSession(db, result.user.id)
    await markLogin(db, result.user.id)
    setSessionCookie(c, token)
    return c.json({ user: result.user, adoptedSurveys: adopted }, 201)
  })

  app.post('/api/auth/login', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const result = await authenticate(db, body?.email, body?.password)
    if (result.error) return c.json({ error: result.error }, result.locked ? 429 : 401)

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

  app.get('/api/surveys', async (c) => c.json({ surveys: await listSurveys(db) }))

  app.post('/api/surveys', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    if (!String(body?.name || '').trim()) return c.json({ error: 'Give the survey a name.' }, 400)
    return c.json({ survey: await createSurvey(db, body) }, 201)
  })

  app.get('/api/surveys/:id', async (c) => {
    const { survey, error } = await requireSurvey(c)
    if (error) return error
    return c.json({
      survey,
      properties: await listProperties(db, survey.id),
      stages: await listStages(db, survey.id),
    })
  })

  app.patch('/api/surveys/:id', async (c) => {
    const { error } = await requireSurvey(c)
    if (error) return error
    const body = await c.req.json().catch(() => ({}))
    return c.json({ survey: await updateSurvey(db, c.req.param('id'), body) })
  })

  app.delete('/api/surveys/:id', async (c) => {
    if (!(await deleteSurvey(db, c.req.param('id')))) return notFound(c, 'That survey does not exist.')
    return c.body(null, 204)
  })

  // --- properties ----------------------------------------------------------

  app.post('/api/surveys/:id/properties', async (c) => {
    const { survey, error } = await requireSurvey(c)
    if (error) return error
    const body = await c.req.json().catch(() => ({}))
    const property = await createProperty(db, survey.id, body)
    if (Array.isArray(body?.fields)) await setPropertyFields(db, property.id, body.fields)
    return c.json({ property: await getProperty(db, property.id) }, 201)
  })

  app.patch('/api/properties/:id', async (c) => {
    const id = c.req.param('id')
    if (!(await getProperty(db, id))) return notFound(c, 'That property does not exist.')
    const body = await c.req.json().catch(() => ({}))
    await updateProperty(db, id, body)
    if (Array.isArray(body?.fields)) await setPropertyFields(db, id, body.fields)
    return c.json({ property: await getProperty(db, id) })
  })

  app.delete('/api/properties/:id', async (c) => {
    if (!(await deleteProperty(db, c.req.param('id')))) return notFound(c, 'That property does not exist.')
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

    const routed = await routeLegs(points, { fetchImpl: fetch, env })

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
    return c.json(result)
  })

  // --- lookups -------------------------------------------------------------

  app.get('/api/geocode', async (c) => {
    try {
      return c.json({ results: await geocode(c.req.query('q'), { env }) })
    } catch (error) {
      if (error instanceof GeocodeError) {
        return c.json({ error: error.message, retryable: error.retryable }, error.retryable ? 503 : 400)
      }
      throw error
    }
  })

  app.get('/api/demographics', async (c) => {
    try {
      return c.json(await demographicsFor(Number(c.req.query('lat')), Number(c.req.query('lng')), { env }))
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
    try {
      return c.json(
        await nearbyBusinesses({
          lat: Number(c.req.query('lat')),
          lng: Number(c.req.query('lng')),
          category: c.req.query('category') || null,
          keyword: c.req.query('keyword') || null,
          radiusMiles: Number(c.req.query('radius')) || 5,
          env,
        }),
      )
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

  app.post('/api/surveys/:id/flyer', async (c) => {
    const { survey, error } = await requireSurvey(c)
    if (error) return error

    const upload = await readUpload(c)
    if (upload.error) return upload.error

    const filename = decodeURIComponent(c.req.header('x-filename') || 'flyer')
    const stored = `${crypto.randomUUID()}${EXTENSIONS[upload.mimeType] || ''}`
    await storage.put(stored, upload.bytes, upload.mimeType || 'application/octet-stream')

    try {
      const { fields, model } = await extractFromFlyer(upload.bytes, upload.mimeType, { env })
      const located = await locateFromFields(fields, survey, env)

      const property = await createProperty(db, survey.id, {
        ...toPropertyInput(fields),
        lat: located.lat,
        lng: located.lng,
        flyer_path: stored,
        flyer_name: filename,
      })
      const rows = mergeExtraction({ fields: [] }, fields).fields
      if (rows.length > 0) await setPropertyFields(db, property.id, rows)

      return c.json(
        {
          property: await getProperty(db, property.id),
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
        const located = await locateFromFields(null, survey, env)
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
    if (!(await getProperty(db, c.req.param('id')))) return notFound(c, 'That property does not exist.')
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
    if (!(await getProperty(db, id))) return notFound(c, 'That property does not exist.')

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

  app.patch('/api/images/:id', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const result = await updateImage(db, c.req.param('id'), body)
    if (result.error) return notFound(c, result.error)
    return c.json({ image: result.image })
  })

  app.delete('/api/images/:id', async (c) => {
    if (!(await deleteImage(db, c.req.param('id'), storage))) {
      return notFound(c, 'That image does not exist.')
    }
    return c.body(null, 204)
  })

  app.put('/api/properties/:id/images', async (c) => {
    const id = c.req.param('id')
    if (!(await getProperty(db, id))) return notFound(c, 'That property does not exist.')
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
    const id = c.req.param('id')
    const property = await getProperty(db, id)
    if (!property) return notFound(c, 'That property does not exist.')
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
        const located = await locateFromFields(fields, survey, env)
        if (located.lat != null) {
          patch.lat = located.lat
          patch.lng = located.lng
          filled.push('lat', 'lng')
        }
      }

      if (Object.keys(patch).length > 0) await updateProperty(db, id, patch)
      if (rows.length > 0) await setPropertyFields(db, id, rows)

      return c.json({
        property: await getProperty(db, id),
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
    if (!(await getProperty(db, id))) return notFound(c, 'That property does not exist.')

    const upload = await readUpload(c)
    if (upload.error) return upload.error

    const filename = decodeURIComponent(c.req.header('x-filename') || 'flyer')
    const stored = `${crypto.randomUUID()}${EXTENSIONS[upload.mimeType] || ''}`
    await storage.put(stored, upload.bytes, upload.mimeType || 'application/octet-stream')

    return c.json({
      property: await updateProperty(db, id, { flyer_path: stored, flyer_name: filename }),
    })
  })

  app.post('/api/properties/:id/photo', async (c) => {
    if (!(await getProperty(db, c.req.param('id')))) return notFound(c, 'That property does not exist.')

    const upload = await readUpload(c)
    if (upload.error) return upload.error
    if (!upload.mimeType.startsWith('image/')) return c.json({ error: 'Photos must be an image file.' }, 400)

    const stored = `${crypto.randomUUID()}${EXTENSIONS[upload.mimeType] || ''}`
    await storage.put(stored, upload.bytes, upload.mimeType)
    return c.json({ property: await updateProperty(db, c.req.param('id'), { photo_path: stored }) })
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
