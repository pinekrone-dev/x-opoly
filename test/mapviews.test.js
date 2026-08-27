/**
 * Saved map views: a market, configured, under a name.
 *
 * Two things matter here. A view must survive the round trip whole, because
 * the map applies whatever comes back and a silently truncated blob is a view
 * that opens wrong. And a view belongs to a team — the workspace is the unit
 * of privacy everywhere else in this app, and a saved view is a broker's read
 * on a market, which is not something to leak.
 */

import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'

import { createServer } from '../server/index.js'
import { MAX_VIEW_BYTES } from '../app/lib/mapviews.js'
import { useTempData } from './helpers.js'

const temp = useTempData()
let app

function client() {
  let cookie = null
  return async (path, init = {}) => {
    const response = await app.fetch(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers || {}) },
      }),
    )
    const set = response.headers.get('set-cookie')
    if (set) cookie = set.split(';')[0]
    const text = await response.text()
    let body = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }
    return { status: response.status, body }
  }
}

const asJson = (payload, method = 'POST') => ({ method, body: JSON.stringify(payload) })

const ENV = {
  STRIPE_SECRET_KEY: 'sk_test_not_called_in_these_tests',
  RESEND_API_KEY: 're_test_stub',
  STRIPE_EXEMPT_EMAILS: 'bob@example.com',
}

const sentEmails = []
const realFetch = globalThis.fetch
let alice
let bob

before(async () => {
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.resend.com/')) {
      sentEmails.push(JSON.parse(init.body))
      return new Response(JSON.stringify({ id: `email_${sentEmails.length}` }), { status: 200 })
    }
    return realFetch(url, init)
  }
  app = await createServer({ DATA_DIR: temp.directory, DB_FILE: `${temp.directory}/test.db`, ...ENV })

  alice = client()
  await alice(
    '/api/auth/register',
    asJson({ name: 'Alice', email: 'alice@example.com', password: 'a long enough password' }),
  )
  bob = client()
  await bob(
    '/api/auth/register',
    asJson({ name: 'Bob', email: 'bob@example.com', password: 'another long password' }),
  )
  const mail = sentEmails[sentEmails.length - 1]
  const token = new URL(mail.text.match(/https?:\/\/\S+/)[0]).searchParams.get('verify')
  await bob('/api/auth/verify-email', asJson({ token }))
})
after(() => {
  globalThis.fetch = realFetch
  temp.cleanup()
})

/** A view roughly as the map captures one. */
const INDUSTRIAL = {
  v: 1,
  center: [-95.37, 29.76],
  zoom: 13.5,
  showParcels: true,
  showCensus: true,
  opacity: 0.2,
  metric: 'inc',
  layerOn: { zoning: true, comps: true },
  layerStyle: { zoning: { color: '#2a78d6', opacity: 0.55 } },
  layerColorBy: { zoning: 'Zoning' },
  assets: ['Industrial', 'Land'],
  value: { min: '1000000', max: '' },
  acres: { min: '5', max: '' },
  query: 'warehouse',
}

describe('saved map views', () => {
  test('a view survives the round trip whole', async () => {
    const saved = await alice(
      '/api/gis/views',
      asJson({ market: 'houston-tx', name: 'Industrial over 5 acres', state: INDUSTRIAL }),
    )
    assert.equal(saved.status, 201)
    assert.equal(saved.body.view.name, 'Industrial over 5 acres')

    const listed = await alice('/api/gis/views?market=houston-tx')
    assert.equal(listed.body.views.length, 1)
    // Deep equality, not a spot check: the map applies whatever comes back,
    // so anything lost in transit is a view that opens wrong.
    assert.deepEqual(listed.body.views[0].state, INDUSTRIAL)
  })

  test('a view belongs to one market', async () => {
    await alice(
      '/api/gis/views',
      asJson({ market: 'las-vegas-nv', name: 'The Strip', state: { v: 1, zoom: 15 } }),
    )
    const houston = await alice('/api/gis/views?market=houston-tx')
    const vegas = await alice('/api/gis/views?market=las-vegas-nv')
    assert.deepEqual(
      houston.body.views.map((v) => v.name),
      ['Industrial over 5 acres'],
    )
    assert.deepEqual(
      vegas.body.views.map((v) => v.name),
      ['The Strip'],
    )
    // Without a market it is every view this team has.
    assert.equal((await alice('/api/gis/views')).body.views.length, 2)
  })

  test('saving the same name again refines it rather than duplicating', async () => {
    const again = await alice(
      '/api/gis/views',
      asJson({
        market: 'houston-tx',
        name: 'Industrial over 5 acres',
        state: { ...INDUSTRIAL, zoom: 11 },
      }),
    )
    assert.equal(again.status, 201)
    const listed = await alice('/api/gis/views?market=houston-tx')
    assert.equal(listed.body.views.length, 1, 'one view, refined — not six near-identical ones')
    assert.equal(listed.body.views[0].state.zoom, 11)
  })

  test('a nameless or marketless view is refused', async () => {
    const noName = await alice('/api/gis/views', asJson({ market: 'houston-tx', state: {} }))
    assert.equal(noName.status, 400)
    const noMarket = await alice('/api/gis/views', asJson({ name: 'Anywhere', state: {} }))
    assert.equal(noMarket.status, 400)
    const noState = await alice('/api/gis/views', asJson({ market: 'houston-tx', name: 'Empty' }))
    assert.equal(noState.status, 400)
  })

  test('a view is settings, not a place to smuggle data', async () => {
    const huge = await alice(
      '/api/gis/views',
      asJson({
        market: 'houston-tx',
        name: 'Too big',
        state: { blob: 'x'.repeat(MAX_VIEW_BYTES + 1) },
      }),
    )
    assert.equal(huge.status, 400)
    assert.match(huge.body.error, /settings, not data/)
  })

  test('a view can be renamed', async () => {
    const listed = await alice('/api/gis/views?market=houston-tx')
    const id = listed.body.views[0].id
    const renamed = await alice(`/api/gis/views/${id}`, asJson({ name: 'Big industrial' }, 'PATCH'))
    assert.equal(renamed.status, 200)
    assert.equal(renamed.body.view.name, 'Big industrial')
    assert.deepEqual(renamed.body.view.state, { ...INDUSTRIAL, zoom: 11 }, 'renaming keeps the configuration')
  })

  test("one team's views are invisible to another, and undeletable by it", async () => {
    assert.equal((await bob('/api/gis/views')).body.views.length, 0)

    const alices = await alice('/api/gis/views?market=houston-tx')
    const id = alices.body.views[0].id

    const stolen = await bob(`/api/gis/views/${id}`, { method: 'DELETE' })
    assert.equal(stolen.status, 404, 'not 403 — that would confirm the view exists')
    const renamedByBob = await bob(`/api/gis/views/${id}`, asJson({ name: 'Mine now' }, 'PATCH'))
    assert.equal(renamedByBob.status, 404)

    assert.equal((await alice('/api/gis/views?market=houston-tx')).body.views.length, 1)

    const removed = await alice(`/api/gis/views/${id}`, { method: 'DELETE' })
    assert.equal(removed.status, 200)
    assert.equal((await alice('/api/gis/views?market=houston-tx')).body.views.length, 0)
  })

  test('views need a session', async () => {
    const stranger = client()
    assert.equal((await stranger('/api/gis/views')).status, 401)
    assert.equal(
      (await stranger('/api/gis/views', asJson({ market: 'houston-tx', name: 'x', state: {} }))).status,
      401,
    )
  })
})
