/**
 * HTTP entry point.
 *
 * In development Vite serves the UI and proxies `/api` here; in production this
 * process serves both.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import express from 'express'

import { uploadsDir } from './lib/db.js'
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
import { GeocodeError, geocode } from './lib/geocode.js'
import { DemographicsUnavailable, demographicsFor } from './lib/demographics.js'
import { FlyerExtractionError, extractFromFlyer, isConfigured, toPropertyInput } from './lib/flyer.js'
import { legs, planTour } from './lib/tour.js'
import { placeholderTile, resolveTiles } from './lib/tiles.js'
import { CATEGORIES, PlacesUnavailable, RING_MILES, nearbyBusinesses } from './lib/places.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.join(__dirname, '..', 'dist')

const UPLOAD_LIMIT = '12mb'
const EXTENSIONS = {
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
}

/** Wraps an async handler so a rejected promise becomes a 500 rather than a hang. */
function route(handler) {
  return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next)
}

function requireSurvey(request, response) {
  const survey = getSurvey(request.params.id)
  if (!survey) {
    response.status(404).json({ error: 'That survey does not exist.' })
    return null
  }
  return survey
}

/** Persists an uploaded body to the uploads directory under a generated name. */
function storeUpload(buffer, mimeType) {
  const extension = EXTENSIONS[mimeType] || ''
  const name = `${randomUUID()}${extension}`
  fs.writeFileSync(path.join(uploadsDir(), name), buffer)
  return name
}

export function createServer() {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '2mb' }))

  app.get('/api/health', (_request, response) => {
    const tiles = resolveTiles()
    response.json({
      ok: true,
      stages: STAGES.map((id) => ({ id, label: STAGE_LABELS[id] })),
      features: {
        flyerExtraction: isConfigured(),
        tiles,
        // Kept for older clients that read the flat fields.
        tileUrl: tiles.url,
        tileAttribution: tiles.attribution,
      },
    })
  })

  /**
   * Placeholder basemap tiles, served when no external provider is reachable.
   * A neutral grid — never invented geography.
   */
  app.get('/api/tiles/:z/:x/:y.svg', (request, response) => {
    const z = Number(request.params.z)
    const x = Number(request.params.x)
    const y = Number(request.params.y)

    if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y) || z < 0 || z > 22) {
      response.status(400).json({ error: 'Bad tile coordinates.' })
      return
    }

    response.type('image/svg+xml')
    response.set('cache-control', 'public, max-age=86400')
    response.send(placeholderTile(z, x, y))
  })

  // --- surveys -------------------------------------------------------------

  app.get('/api/surveys', (_request, response) => {
    response.json({ surveys: listSurveys() })
  })

  app.post('/api/surveys', (request, response) => {
    if (!String(request.body?.name || '').trim()) {
      response.status(400).json({ error: 'Give the survey a name.' })
      return
    }
    response.status(201).json({ survey: createSurvey(request.body) })
  })

  app.get('/api/surveys/:id', (request, response) => {
    const survey = requireSurvey(request, response)
    if (!survey) return
    response.json({ survey, properties: listProperties(survey.id) })
  })

  app.patch('/api/surveys/:id', (request, response) => {
    if (!requireSurvey(request, response)) return
    response.json({ survey: updateSurvey(request.params.id, request.body || {}) })
  })

  app.delete('/api/surveys/:id', (request, response) => {
    if (!deleteSurvey(request.params.id)) {
      response.status(404).json({ error: 'That survey does not exist.' })
      return
    }
    response.status(204).end()
  })

  // --- properties ----------------------------------------------------------

  app.post('/api/surveys/:id/properties', (request, response) => {
    const survey = requireSurvey(request, response)
    if (!survey) return
    response.status(201).json({ property: createProperty(survey.id, request.body || {}) })
  })

  app.patch('/api/properties/:id', (request, response) => {
    if (!getProperty(request.params.id)) {
      response.status(404).json({ error: 'That property does not exist.' })
      return
    }
    response.json({ property: updateProperty(request.params.id, request.body || {}) })
  })

  app.delete('/api/properties/:id', (request, response) => {
    if (!deleteProperty(request.params.id)) {
      response.status(404).json({ error: 'That property does not exist.' })
      return
    }
    response.status(204).end()
  })

  // --- tour ----------------------------------------------------------------

  app.post('/api/surveys/:id/tour', (request, response) => {
    const survey = requireSurvey(request, response)
    if (!survey) return
    const plan = planTour(listProperties(survey.id), { startId: request.body?.startId || null })
    response.json({ ...plan, legs: legs(plan.stops) })
  })

  app.put('/api/surveys/:id/tour', (request, response) => {
    const survey = requireSurvey(request, response)
    if (!survey) return
    const order = Array.isArray(request.body?.order) ? request.body.order.map(String) : []
    response.json({ properties: setTourOrder(survey.id, order) })
  })

  // --- sharing -------------------------------------------------------------

  app.post('/api/surveys/:id/share', (request, response) => {
    if (!requireSurvey(request, response)) return
    response.json({ survey: updateShare(request.params.id, request.body || {}) })
  })

  app.get('/api/share/:token', (request, response) => {
    const result = resolveShare(request.params.token)
    if (!result.ok) {
      const messages = {
        not_found: 'This link is not valid. Ask your broker for a new one.',
        disabled: 'Sharing has been turned off for this survey.',
        expired: 'This link has expired. Ask your broker for a new one.',
      }
      response.status(result.reason === 'not_found' ? 404 : 410).json({ error: messages[result.reason], reason: result.reason })
      return
    }
    response.json(result)
  })

  // --- lookups -------------------------------------------------------------

  app.get('/api/geocode', route(async (request, response) => {
    try {
      response.json({ results: await geocode(request.query.q) })
    } catch (error) {
      if (error instanceof GeocodeError) {
        response.status(error.retryable ? 503 : 400).json({ error: error.message, retryable: error.retryable })
        return
      }
      throw error
    }
  }))

  app.get('/api/demographics', route(async (request, response) => {
    try {
      const data = await demographicsFor(Number(request.query.lat), Number(request.query.lng))
      response.json(data)
    } catch (error) {
      if (error instanceof DemographicsUnavailable) {
        response.status(503).json({ error: error.message })
        return
      }
      throw error
    }
  }))

  // --- competition ---------------------------------------------------------

  app.get('/api/places/categories', (_request, response) => {
    response.json({
      categories: Object.entries(CATEGORIES).map(([id, entry]) => ({ id, label: entry.label })),
      rings: RING_MILES,
    })
  })

  app.get('/api/places/nearby', route(async (request, response) => {
    try {
      const data = await nearbyBusinesses({
        lat: Number(request.query.lat),
        lng: Number(request.query.lng),
        category: request.query.category || null,
        keyword: request.query.keyword || null,
        radiusMiles: Number(request.query.radius) || 5,
      })
      response.json(data)
    } catch (error) {
      if (error instanceof PlacesUnavailable) {
        response.status(503).json({ error: error.message })
        return
      }
      throw error
    }
  }))

  // --- uploads -------------------------------------------------------------

  app.post(
    '/api/surveys/:id/flyer',
    express.raw({ type: '*/*', limit: UPLOAD_LIMIT }),
    route(async (request, response) => {
      const survey = requireSurvey(request, response)
      if (!survey) return

      const mimeType = (request.headers['content-type'] || '').split(';')[0].trim()
      const filename = decodeURIComponent(request.headers['x-filename'] || 'flyer')
      const stored = storeUpload(request.body, mimeType)

      try {
        const { fields, model } = await extractFromFlyer(request.body, mimeType)
        const property = createProperty(survey.id, {
          ...toPropertyInput(fields),
          flyer_path: stored,
          flyer_name: filename,
        })
        response.status(201).json({
          property,
          extraction: { model, confidence: fields.confidence, uncertainFields: fields.uncertainFields },
        })
      } catch (error) {
        if (error instanceof FlyerExtractionError) {
          // Keep the file and make a stub record so the upload is not wasted.
          const property = createProperty(survey.id, { name: filename, flyer_path: stored, flyer_name: filename })
          response.status(422).json({ error: error.message, configured: error.configured, property })
          return
        }
        throw error
      }
    }),
  )

  app.post(
    '/api/properties/:id/photo',
    express.raw({ type: '*/*', limit: UPLOAD_LIMIT }),
    (request, response) => {
      if (!getProperty(request.params.id)) {
        response.status(404).json({ error: 'That property does not exist.' })
        return
      }
      const mimeType = (request.headers['content-type'] || '').split(';')[0].trim()
      if (!mimeType.startsWith('image/')) {
        response.status(400).json({ error: 'Photos must be an image file.' })
        return
      }
      const stored = storeUpload(request.body, mimeType)
      response.json({ property: updateProperty(request.params.id, { photo_path: stored }) })
    },
  )

  app.get('/api/files/:name', (request, response) => {
    // Generated names only — reject anything that could climb out of the directory.
    if (!/^[\w.-]+$/.test(request.params.name)) {
      response.status(400).json({ error: 'Bad file name.' })
      return
    }
    const file = path.join(uploadsDir(), request.params.name)
    if (!fs.existsSync(file)) {
      response.status(404).json({ error: 'That file is no longer stored.' })
      return
    }
    response.sendFile(file)
  })

  // --- static UI -----------------------------------------------------------

  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir, { index: false, maxAge: '1h' }))
    app.get('*', (request, response, next) => {
      if (request.path.startsWith('/api/')) {
        next()
        return
      }
      response.sendFile(path.join(distDir, 'index.html'))
    })
  }

  app.use('/api', (_request, response) => {
    response.status(404).json({ error: 'Unknown endpoint.' })
  })

  // eslint-disable-next-line no-unused-vars -- Express detects error handlers by arity.
  app.use((error, _request, response, _next) => {
    if (error?.type === 'entity.too.large') {
      response.status(413).json({ error: 'That file is too large. The limit is 12 MB.' })
      return
    }
    response.status(500).json({ error: error?.message || 'Unexpected server error.' })
  })

  return app
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isDirectRun) {
  const port = Number(process.env.PORT) || 8080
  createServer().listen(port, '0.0.0.0', () => {
    console.log(`Site survey server listening on http://0.0.0.0:${port}`)
  })
}
