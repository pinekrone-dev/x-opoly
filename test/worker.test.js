import assert from 'node:assert/strict'
import test, { describe } from 'node:test'

import worker from '../worker/index.js'
import { workerEnv } from './cloudflare-shims.js'

const BASE = 'https://sitesurvey.example.com'

async function call(env, path, init) {
  const response = await worker.fetch(new Request(BASE + path, init), env, {})
  const text = await response.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: response.status, body, response }
}

const asJson = (payload, method = 'POST') => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
})

describe('the Cloudflare Worker', () => {
  test('reports that it is running on Cloudflare bindings', async () => {
    const env = await workerEnv()
    const { status, body } = await call(env, '/api/health')
    assert.equal(status, 200)
    assert.equal(body.runtime, 'cloudflare', 'the D1 adapter is in use')
    assert.equal(body.checks.database.ok, true)
    assert.equal(body.checks.storage.ok, true)
    assert.ok(body.features.tiles.url.includes('{z}'))
  })

  test('a deployment missing its bindings fails health instead of passing it', async () => {
    // Exactly the failure a Worker deployed without wrangler.toml's bindings
    // hits: the adapters construct fine, then every real request 500s.
    const env = { ...(await workerEnv()), DB: undefined, BUCKET: undefined }
    const { status, body } = await call(env, '/api/health')

    assert.equal(status, 503)
    assert.equal(body.ok, false)
    assert.equal(body.checks.database.ok, false)
    assert.match(body.checks.database.error, /DB binding looks missing/)
    assert.match(body.checks.storage.error, /BUCKET binding looks missing/)
  })

  test('serves the single-page app for non-API paths', async () => {
    const env = await workerEnv()
    for (const path of ['/', '/survey/abc123', '/s/deadbeef']) {
      const { status, body } = await call(env, path)
      assert.equal(status, 200, `${path} should serve the app`)
      assert.match(body, /<!doctype html>/i, `${path} should fall back to index.html`)
    }
  })

  test('runs a whole survey through D1', async () => {
    const env = await workerEnv()

    const created = await call(env, '/api/surveys', asJson({ name: 'Retail — 78704', clientName: 'Vega Foods' }))
    assert.equal(created.status, 201)
    const surveyId = created.body.survey.id

    for (const property of [
      { name: 'South Congress', lat: 30.249, lng: -97.75, stage: 'touring', rentRate: 32 },
      { name: 'Burnet Rd', lat: 30.35, lng: -97.74, stage: 'loi' },
      { name: 'Riverside', lat: 30.24, lng: -97.72 },
    ]) {
      assert.equal((await call(env, `/api/surveys/${surveyId}/properties`, asJson(property))).status, 201)
    }

    const loaded = await call(env, `/api/surveys/${surveyId}`)
    assert.equal(loaded.body.properties.length, 3)

    const tour = await call(env, `/api/surveys/${surveyId}/tour`, asJson({}))
    assert.equal(tour.body.stops.length, 3)
    assert.ok(tour.body.miles > 0)

    // The atomic reorder has to work through D1's batch API, not BEGIN/COMMIT.
    const ids = loaded.body.properties.map((property) => property.id)
    const reordered = await call(env, `/api/surveys/${surveyId}/tour`, { ...asJson({ order: [ids[2], ids[0], ids[1]] }), method: 'PUT' })
    assert.deepEqual(reordered.body.properties.map((property) => property.id), [ids[2], ids[0], ids[1]])
  })

  test('gates the client link exactly as the Node server does', async () => {
    const env = await workerEnv()
    const created = await call(env, '/api/surveys', asJson({ name: 'Shared', clientName: 'Client' }))
    const surveyId = created.body.survey.id
    const token = created.body.survey.share.token

    await call(env, `/api/surveys/${surveyId}/properties`, asJson({ name: 'Site', lat: 30.1, lng: -97.1, notes: 'Landlord is motivated' }))

    assert.equal((await call(env, `/api/share/${token}`)).status, 410, 'sharing is off by default')

    await call(env, `/api/surveys/${surveyId}/share`, asJson({ enabled: true }))
    const shared = await call(env, `/api/share/${token}`)
    assert.equal(shared.status, 200)
    assert.ok(!('notes' in shared.body.properties[0]), 'private notes stay out of the client payload')

    assert.equal((await call(env, '/api/share/nope')).status, 404)
  })

  test('stores an upload in R2 and serves it back', async () => {
    const env = await workerEnv()
    const created = await call(env, '/api/surveys', asJson({ name: 'Flyer intake' }))
    const surveyId = created.body.survey.id

    const upload = await call(env, `/api/surveys/${surveyId}/flyer`, {
      method: 'POST',
      headers: { 'content-type': 'application/pdf', 'x-filename': 'parmer-flyer.pdf' },
      body: new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52]),
    })

    // No API key in the test environment, so extraction declines — but the file
    // must still be in R2 and still be downloadable.
    assert.equal(upload.status, 422)
    assert.ok(upload.body.property.flyerUrl)
    assert.equal(env.BUCKET.objects.size, 1, 'the object reached R2')

    const file = await call(env, upload.body.property.flyerUrl)
    assert.equal(file.status, 200)
    assert.equal(file.response.headers.get('content-type'), 'application/pdf')
  })

  test('refuses a file name that tries to climb out of the bucket', async () => {
    const env = await workerEnv()
    assert.equal((await call(env, '/api/files/..%2F..%2Fsecrets')).status, 400)
  })

  test('reads configuration from the Worker env, not process.env', async () => {
    const env = await workerEnv({ TILE_PROVIDER: 'carto-dark', ANTHROPIC_API_KEY: 'sk-test' })
    const { body } = await call(env, '/api/health')
    assert.equal(body.features.tiles.provider, 'carto-dark')
    assert.equal(body.features.flyerExtraction, true, 'the key is read from the binding environment')
  })
})
