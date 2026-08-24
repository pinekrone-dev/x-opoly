import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'

import { createServer } from '../server/index.js'
import { useTempData } from './helpers.js'

/**
 * The Node runtime, exercised through the same routes the Worker runs.
 * `worker.test.js` runs this same API over D1 and R2 instead.
 */
const temp = useTempData()
let app

const BASE = 'http://localhost'

before(async () => {
  app = await createServer({ DATA_DIR: temp.directory, DB_FILE: `${temp.directory}/test.db` })
})

after(() => temp.cleanup())

async function call(path, init) {
  const response = await app.fetch(new Request(BASE + path, init))
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

describe('http api on node', () => {
  test('probes its bindings rather than just claiming to be healthy', async () => {
    const { status, body } = await call('/api/health')
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.runtime, 'node')
    assert.equal(body.checks.database.ok, true, 'the database was actually queried')
    assert.equal(body.checks.storage.ok, true, 'the file store was actually read')
    assert.equal(typeof body.features.flyerExtraction, 'boolean')
    assert.ok(body.stages.some((stage) => stage.id === 'under_contract'))
  })

  test('refuses a survey with no name', async () => {
    assert.equal((await call('/api/surveys', asJson({ name: '  ' }))).status, 400)
  })

  test('runs a full survey through to a client link', async () => {
    const created = await call('/api/surveys', asJson({ name: 'Retail — 78704', clientName: 'Vega Foods' }))
    assert.equal(created.status, 201)
    const surveyId = created.body.survey.id

    for (const property of [
      { name: 'South Congress', lat: 30.249, lng: -97.75, stage: 'touring' },
      { name: 'Riverside', lat: 30.24, lng: -97.72 },
      { name: 'Burnet Rd', lat: 30.35, lng: -97.74, stage: 'loi' },
    ]) {
      assert.equal((await call(`/api/surveys/${surveyId}/properties`, asJson(property))).status, 201)
    }

    assert.equal((await call(`/api/surveys/${surveyId}`)).body.properties.length, 3)

    const tour = await call(`/api/surveys/${surveyId}/tour`, asJson({}))
    assert.equal(tour.body.stops.length, 3)
    assert.equal(tour.body.legs.length, 2)
    assert.ok(tour.body.miles > 0)

    // A schedule comes back whether or not the routing service was reachable.
    assert.equal(tour.body.itinerary.items.length, 3)
    assert.match(tour.body.itinerary.startTime, /^\d{1,2}:\d{2} (AM|PM)$/)
    assert.match(tour.body.itinerary.items[0].arrive, /^\d{1,2}:\d{2} (AM|PM)$/)
    assert.ok(['osrm', 'estimate'].includes(tour.body.routeSource))
    assert.ok(Array.isArray(tour.body.geometry))

    const chosen = await call(
      `/api/surveys/${surveyId}/tour`,
      asJson({
        propertyIds: tour.body.stops.slice(0, 2).map((stop) => stop.id),
        startTime: '9:00 AM',
        stopMinutes: 30,
      }),
    )
    assert.equal(chosen.body.stops.length, 2, 'tours only the sites that were selected')
    assert.equal(chosen.body.itinerary.startTime, '9:00 AM')
    assert.equal(chosen.body.itinerary.items[0].stopMinutes, 30)

    const token = created.body.survey.share.token
    assert.equal((await call(`/api/share/${token}`)).status, 410, 'sharing is off by default')

    await call(`/api/surveys/${surveyId}/share`, asJson({ enabled: true }))
    const shared = await call(`/api/share/${token}`)
    assert.equal(shared.status, 200)
    assert.equal(shared.body.properties.length, 3)
    assert.equal(shared.body.survey.clientName, 'Vega Foods')
  })

  test('an unknown share link returns 404, not a server error', async () => {
    assert.equal((await call('/api/share/does-not-exist')).status, 404)
  })

  test('missing records return 404 rather than crashing', async () => {
    assert.equal((await call('/api/surveys/nope')).status, 404)
    assert.equal((await call('/api/properties/nope', asJson({ stage: 'loi' }, 'PATCH'))).status, 404)
  })

  test('a flyer still files against the survey when extraction is unavailable', async () => {
    const created = await call('/api/surveys', asJson({ name: 'Flyer intake' }))
    const surveyId = created.body.survey.id

    const upload = await call(`/api/surveys/${surveyId}/flyer`, {
      method: 'POST',
      headers: { 'content-type': 'application/pdf', 'x-filename': 'parmer-flyer.pdf' },
      body: new Uint8Array([37, 80, 68, 70]),
    })

    assert.equal(upload.status, 422)
    assert.match(upload.body.error, /API key|by hand/)
    assert.ok(upload.body.property, 'a stub record is still created')
    assert.equal(upload.body.property.flyerName, 'parmer-flyer.pdf')

    const file = await call(upload.body.property.flyerUrl)
    assert.equal(file.status, 200, 'the file is served back off disk')
  })

  test('rejects a file path that tries to climb out of the uploads directory', async () => {
    assert.equal((await call('/api/files/..%2F..%2Fetc%2Fpasswd')).status, 400)
  })

  test('serves placeholder tiles and rejects nonsense coordinates', async () => {
    const tile = await call('/api/tiles/11/472/838.svg')
    assert.equal(tile.status, 200)
    assert.match(tile.response.headers.get('content-type'), /svg/)
    assert.equal((await call('/api/tiles/99/1/1.svg')).status, 400)
  })

  test('reports an unreachable geocoder as a service error, not a crash', async () => {
    const { status, body } = await call('/api/geocode?q=austin+texas')
    assert.ok(status === 200 || status === 503, `unexpected status ${status}`)
    if (status === 503) assert.match(body.error, /not allowed to reach|unreachable|timed out|rate limiting/)
  })
})
