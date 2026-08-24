import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'

import { useTempData } from './helpers.js'

const temp = useTempData()
const { resetDb } = await import('../server/lib/db.js')
const { createServer } = await import('../server/index.js')

let server
let base

before(async () => {
  server = createServer().listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

after(() => {
  server.close()
  resetDb()
  temp.cleanup()
})

async function call(path, options) {
  const response = await fetch(base + path, options)
  const body = response.status === 204 ? null : await response.json().catch(() => null)
  return { status: response.status, body }
}

const asJson = (payload, method = 'POST') => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
})

describe('http api', () => {
  test('reports which optional features are configured', async () => {
    const { body } = await call('/api/health')
    assert.equal(body.ok, true)
    assert.equal(typeof body.features.flyerExtraction, 'boolean')
    assert.ok(body.stages.some((stage) => stage.id === 'under_contract'))
  })

  test('refuses a survey with no name', async () => {
    const { status } = await call('/api/surveys', asJson({ name: '  ' }))
    assert.equal(status, 400)
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
      const added = await call(`/api/surveys/${surveyId}/properties`, asJson(property))
      assert.equal(added.status, 201)
    }

    const loaded = await call(`/api/surveys/${surveyId}`)
    assert.equal(loaded.body.properties.length, 3)

    const tour = await call(`/api/surveys/${surveyId}/tour`, asJson({}))
    assert.equal(tour.body.stops.length, 3)
    assert.equal(tour.body.legs.length, 2)
    assert.ok(tour.body.miles > 0)

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

    const response = await fetch(`${base}/api/surveys/${surveyId}/flyer`, {
      method: 'POST',
      headers: { 'content-type': 'application/pdf', 'x-filename': 'parmer-flyer.pdf' },
      body: Buffer.from('%PDF-1.4 not a real flyer'),
    })
    const body = await response.json()

    // No API key in the test environment, so extraction declines — but the
    // upload must not be lost.
    assert.equal(response.status, 422)
    assert.match(body.error, /API key|by hand/)
    assert.ok(body.property, 'a stub record is still created')
    assert.equal(body.property.flyerName, 'parmer-flyer.pdf')
    assert.ok(body.property.flyerUrl, 'the file stays downloadable')

    const file = await fetch(base + body.property.flyerUrl)
    assert.equal(file.status, 200)
  })

  test('rejects a file path that tries to climb out of the uploads directory', async () => {
    assert.equal((await call('/api/files/..%2F..%2Fetc%2Fpasswd')).status, 400)
  })

  test('reports an unreachable geocoder as a service error, not a crash', async () => {
    const { status, body } = await call('/api/geocode?q=austin+texas')
    // This environment blocks the geocoder; either outcome is valid, but it
    // must always be a clean answer.
    assert.ok(status === 200 || status === 503, `unexpected status ${status}`)
    if (status === 503) assert.match(body.error, /not allowed to reach|unreachable|timed out|rate limiting/)
  })
})
