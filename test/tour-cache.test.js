/**
 * The saved tour: routed once, reused on every view, and shipped to the
 * client through the share link. A replan with different stops routes fresh
 * and overwrites the save, which is how the shared map stays current.
 */

import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'

import { createServer } from '../server/index.js'
import { useTempData } from './helpers.js'

const temp = useTempData()
let app
let cookie = null
let surveyId
let osrmCalls = 0

const realFetch = globalThis.fetch

const osrmAnswer = (legCount) => ({
  code: 'Ok',
  routes: [
    {
      legs: Array.from({ length: legCount }, () => ({ distance: 1609.344, duration: 120 })),
      geometry: { coordinates: [[-97.7, 30.2], [-97.71, 30.21], [-97.72, 30.22]] },
    },
  ],
})

async function call(path, init = {}) {
  const response = await app.fetch(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers || {}) },
    }),
  )
  const set = response.headers.get('set-cookie')
  if (set) cookie = set.split(';')[0]
  return { status: response.status, body: await response.json().catch(() => null) }
}

const asJson = (payload, method = 'POST') => ({ method, body: JSON.stringify(payload) })

before(async () => {
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes('router.project-osrm.org')) {
      osrmCalls += 1
      const coords = String(url).split('/driving/')[1].split('?')[0].split(';').length
      return new Response(JSON.stringify(osrmAnswer(coords - 1)), { status: 200 })
    }
    return realFetch(url, init)
  }

  app = await createServer({ DATA_DIR: temp.directory, DB_FILE: `${temp.directory}/test.db` })
  await call('/api/auth/register', asJson({ email: 'owner@example.com', password: 'a long enough password' }))
  const { body } = await call('/api/surveys', asJson({ name: 'Cache test' }))
  surveyId = body.survey.id
  await call(`/api/surveys/${surveyId}/properties`, asJson({ name: 'A', lat: 30.2, lng: -97.7 }))
  await call(`/api/surveys/${surveyId}/properties`, asJson({ name: 'B', lat: 30.25, lng: -97.72 }))
})

after(() => {
  globalThis.fetch = realFetch
  temp.cleanup()
})

describe('the saved tour route', () => {
  test('the first plan routes over the network and saves the answer', async () => {
    const planned = await call(`/api/surveys/${surveyId}/tour`, asJson({}))
    assert.equal(planned.status, 200)
    assert.equal(planned.body.routeSource, 'osrm')
    assert.ok(planned.body.geometry.length > 1)
    assert.equal(osrmCalls, 1)
  })

  test('planning the same tour again reuses the save — no routing call', async () => {
    const again = await call(`/api/surveys/${surveyId}/tour`, asJson({}))
    assert.equal(again.status, 200)
    assert.equal(again.body.routeSource, 'osrm')
    assert.equal(osrmCalls, 1, 'the stored route answered; the router was not called again')
  })

  test('the shared link carries the routed path', async () => {
    await call(`/api/surveys/${surveyId}/share`, asJson({ enabled: true }))
    const { body: opened } = await call(`/api/surveys/${surveyId}`)
    const token = opened.survey.share.token
    const shared = await call(`/api/share/${token}`)
    assert.equal(shared.status, 200)
    assert.ok(Array.isArray(shared.body.tourPlan?.geometry), 'the client map gets the route to draw')
    assert.equal(shared.body.tourPlan.stopIds.length, 2)
  })

  test('changing the stops routes fresh and replaces the save', async () => {
    await call(`/api/surveys/${surveyId}/properties`, asJson({ name: 'C', lat: 30.3, lng: -97.75 }))
    const replanned = await call(`/api/surveys/${surveyId}/tour`, asJson({}))
    assert.equal(replanned.status, 200)
    assert.equal(osrmCalls, 2, 'a different stop list is a different route')
  })
})
