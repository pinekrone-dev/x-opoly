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
import { GeocodeError, geocode } from './lib/geocode.js'
import { DemographicsUnavailable, demographicsFor } from './lib/demographics.js'
import { FlyerExtractionError, extractFromFlyer, isConfigured, toPropertyInput } from './lib/flyer.js'
import { CATEGORIES, PlacesUnavailable, RING_MILES, nearbyBusinesses } from './lib/places.js'
import { legs, planTour } from './lib/tour.js'
import { availableBasemaps, placeholderTile, resolveTiles } from './lib/tiles.js'
import { EXTENSIONS, contentTypeFor } from './lib/storage.js'

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024

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
    const plan = planTour(await listProperties(db, survey.id), { startId: body?.startId || null })
    return c.json({ ...plan, legs: legs(plan.stops) })
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
      const property = await createProperty(db, survey.id, {
        ...toPropertyInput(fields),
        flyer_path: stored,
        flyer_name: filename,
      })
      return c.json(
        { property, extraction: { model, confidence: fields.confidence, uncertainFields: fields.uncertainFields } },
        201,
      )
    } catch (cause) {
      if (cause instanceof FlyerExtractionError) {
        // Keep the file and file a stub so the upload is never wasted.
        const property = await createProperty(db, survey.id, { name: filename, flyer_path: stored, flyer_name: filename })
        return c.json({ error: cause.message, configured: cause.configured, property }, 422)
      }
      throw cause
    }
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
