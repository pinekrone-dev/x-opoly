/**
 * Reported crime round a site: the reader (src/lib/crime.ts), the route and
 * the connector's tool, against the scene prospector's tests pack
 * (tests/test_crime.py writes test/fixtures/crime.bin). One agency polices a
 * square; Henderson beside it is another's. Due east of the site at
 * -115.15, 36.15, in the last twelve months:
 *
 *   0.10 mi violent    0.20 mi property   0.30 mi violent (a robbery)
 *   0.45 mi property   0.80 mi other      1.50 mi violent (outside every circle)
 *
 * and one violent offense at 0.10 mi reported two years ago.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test, { after, before, describe } from 'node:test'

import { createServer } from '../server/index.js'
import { useTempData } from './helpers.js'
import { crimeReport, runTool } from '../app/lib/mcp.js'
import { crimeFeatures, crimeNear, crimeSummary, crimeTileReader, inRings, readCrime, shareBelow } from '../src/lib/crime.ts'

const bytes = fs.readFileSync(new URL('./fixtures/crime.bin', import.meta.url))
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
const SITE = { lat: 36.15, lng: -115.15 }

describe('the packed file', () => {
  const crime = readCrime(buffer)

  test('reads as arrays, latest first, with where its figures hold', () => {
    assert.equal(crime.n, 7)
    assert.equal(crime.to, '2026-11-01')
    assert.deepEqual(crime.radii, [0.25, 0.5, 1])
    assert.equal(crime.agencies[0].name, 'Test Metropolitan Police')
    assert.deepEqual(crime.elsewhere.map((e) => e.name), ['Henderson'])
    for (let i = 1; i < crime.n; i += 1) assert.ok(crime.day[i] <= crime.day[i - 1])
  })

  test('anything that is not a sound file is no file', () => {
    assert.equal(readCrime(new ArrayBuffer(4)), null)
    assert.equal(readCrime(new TextEncoder().encode('LQC1' + 'x'.repeat(40)).buffer), null)
    assert.equal(readCrime(buffer.slice(0, buffer.byteLength - 3)), null, 'cut short')
  })

  test('each circle counts what was reported inside it in the last twelve months', () => {
    const a = crimeNear(crime, SITE)
    assert.equal(a.covered, true)
    assert.equal(a.agency, 'Test Metropolitan Police')
    assert.equal(a.from, '2025-11-02')
    assert.equal(a.to, '2026-11-01')
    assert.deepEqual(a.rings.map((r) => [r.miles, r.violent, r.property, r.other]), [
      [0.25, 1, 1, 0],
      [0.5, 2, 2, 0],
      [1, 2, 2, 1],
    ])
    // The robbery is violent, once; the offense of two years ago is in no circle.
    const robbery = a.categories.find((c) => c.category === 'ROBBERY')
    assert.equal(robbery.kind, 'violent')
    assert.deepEqual(robbery.counts, [0, 1, 1])
    assert.deepEqual(a.categories.find((c) => c.category === 'ASSAULT OFFENSES').counts, [1, 1, 1])
    assert.equal(a.definitions.violent, 'What the agency flags violent.')
    assert.deepEqual(a.source, { name: 'Test Metropolitan Police', page: 'https://example.test/' })
  })

  test('a count comes with where it stands among the market\'s parcels', () => {
    const a = crimeNear(crime, SITE)
    // 399 of 400 parcels saw nothing: the site is above nearly all of them.
    assert.deepEqual(a.rings.map((r) => r.violentAbove), [99, 99, 99])
    assert.deepEqual(a.compared, { parcels: 400 })
    // A lot where nothing was reported stands above none.
    const quiet = crimeNear(crime, { lat: 36.26, lng: -115.28 })
    assert.deepEqual(quiet.rings.map((r) => [r.violent, r.property, r.violentAbove, r.propertyAbove]), [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]])
  })

  test('the marks read back as a share of parcels below', () => {
    const marks = [0, 0, 0, 0, 0, 1, 1, 2, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30, 50, 90]
    assert.equal(shareBelow(marks, 0), 0)
    assert.equal(shareBelow(marks, 1), 25, 'the count the 25% mark reaches')
    assert.equal(shareBelow(marks, 4), 50)
    assert.equal(shareBelow(marks, 40), 93, 'halfway from the 90% mark to the 95%')
    assert.equal(shareBelow(marks, 90), 99, 'the most any sampled parcel saw is not above them all')
    assert.equal(shareBelow(marks, 91), 99, 'and neither is one past it: the parcels compared are a sample')
    assert.equal(shareBelow(undefined, 5), null)
  })

  test('a site another agency polices is named and given no figures', () => {
    const a = crimeNear(crime, { lat: 36.05, lng: -114.95 })
    assert.equal(a.covered, false)
    assert.equal(a.elsewhere, 'Henderson')
    assert.deepEqual(a.rings, [])
    const nowhere = crimeNear(crime, { lat: 37.5, lng: -116.5 })
    assert.equal(nowhere.covered, false)
    assert.equal(nowhere.elsewhere, null)
  })

  test('a circle that runs into another agency\'s area says how much of it is covered', () => {
    // 0.1 mile inside the east edge: the quarter-mile circle is mostly in, the mile circle about half.
    const edge = crimeNear(crime, { lat: 36.15, lng: -115.0018 })
    assert.equal(edge.covered, true)
    assert.ok(edge.rings[0].covered > 0.6 && edge.rings[0].covered < 1)
    assert.ok(edge.rings[2].covered > 0.4 && edge.rings[2].covered < 0.65)
    assert.equal(crimeNear(crime, SITE).rings[2].covered, 1)
  })

  test('the last twelve months as a layer: violent and property points, the rest left off', () => {
    assert.deepEqual(crimeSummary(crime), { agencies: ['Test Metropolitan Police'], from: '2025-11-02', to: '2026-11-01', violent: 3, property: 2 })
    const geo = crimeFeatures(crime)
    // Five of the seven: not the drug offense, not the one of two years ago.
    assert.equal(geo.features.length, 5)
    assert.deepEqual(geo.features.map((f) => f.properties.Kind).sort(), ['Property', 'Property', 'Violent', 'Violent', 'Violent'])
    const robbery = geo.features.find((f) => f.properties.Category === 'ROBBERY')
    assert.equal(robbery.properties.Kind, 'Violent')
    assert.equal(robbery.properties.Reported, '2026-11-01')
    // 0.30 mile east of the site, to within a few yards.
    assert.ok(Math.abs(robbery.geometry.coordinates[0] - -115.14463) < 0.0002)
    assert.ok(Math.abs(robbery.geometry.coordinates[1] - 36.15) < 0.0002)
  })

  test('the same points a tile at a time, for the image the server draws', async () => {
    const read = crimeTileReader(crime)
    // The tile at zoom 12 that holds the site, and where the site falls in it.
    const z = 12
    const size = 2 ** z
    const wx = ((SITE.lng + 180) / 360) * size
    const rad = (SITE.lat * Math.PI) / 180
    const wy = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * size
    const [tx, ty] = [Math.floor(wx), Math.floor(wy)]
    const tile = await read(z, tx, ty)
    assert.equal(tile.extent, 4096)
    const all = [tile, await read(z, tx + 1, ty), await read(z, tx - 1, ty)].flatMap((t) => t.features)
    assert.equal(all.length, 5, 'the five on the map, each in one tile only')
    // Every point is on the site's own latitude, east of it.
    for (const f of tile.features) {
      const [px, py] = f.geometry[0][0]
      assert.ok(Math.abs(py - (wy - ty) * 4096) <= 2)
      assert.ok(px >= Math.floor((wx - tx) * 4096))
      assert.match(f.properties.Kind, /^(Violent|Property)$/)
    }
    assert.equal((await read(z, tx, ty + 40)).features.length, 0)
    assert.equal((await read(3, 0, 0)).features.length, 0, 'a tile nowhere near the file')
  })

  test('inside and outside, holes included', () => {
    const outer = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]
    const hole = [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]
    assert.equal(inRings([outer, hole], 2, 2), true)
    assert.equal(inRings([outer, hole], 5, 5), false)
    assert.equal(inRings([outer, hole], 11, 5), false)
  })
})

describe('the route and the connector', () => {
  const temp = useTempData()
  const realFetch = globalThis.fetch
  let app
  let cookie = null
  const asked = []
  const call = async (path) => {
    const res = await app.fetch(new Request(`http://localhost${path}`, { headers: cookie ? { cookie } : {} }))
    return { status: res.status, body: await res.json().catch(() => null) }
  }

  before(async () => {
    globalThis.fetch = async (url) => {
      const key = String(url).replace('https://catalogue.test/', '')
      asked.push(key)
      if (key === 'las-vegas-nv/crime.bin') return new Response(bytes, { status: 200 })
      if (/^(las-vegas-nv|austin-tx)\/layers\.json$/.test(key)) return new Response(JSON.stringify({ layers: [{ id: 'permits', label: 'Permits', kind: 'point', count: 12 }] }), { status: 200 })
      return new Response('not found', { status: 404 })
    }
    app = await createServer({ DATA_DIR: temp.directory, DB_FILE: `${temp.directory}/test.db`, PARCEL_CATALOG_ORIGIN: 'https://catalogue.test' })
    const res = await app.fetch(new Request('http://localhost/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'crime@example.com', password: 'a long enough password', name: 'C' }),
    }))
    cookie = res.headers.get('set-cookie').split(';')[0]
  })
  after(() => {
    globalThis.fetch = realFetch
    return temp.cleanup()
  })

  test('a site is answered from the file, read once', async () => {
    const res = await call(`/api/gis/crime?market=las-vegas-nv&lat=${SITE.lat}&lng=${SITE.lng}`)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.rings.map((r) => [r.violent, r.property]), [[1, 1], [2, 2], [2, 2]])
    await call('/api/gis/crime?market=las-vegas-nv&lat=36.26&lng=-115.28')
    assert.equal(asked.filter((a) => a === 'las-vegas-nv/crime.bin').length, 1)
  })

  test('it needs a user, a market and a place, and says when a market has none', async () => {
    const held = cookie
    cookie = null
    assert.equal((await call('/api/gis/crime?market=las-vegas-nv&lat=36.15&lng=-115.15')).status, 401)
    cookie = held
    assert.equal((await call('/api/gis/crime?market=las-vegas-nv&lat=36.15')).status, 400)
    assert.equal((await call('/api/gis/crime?market=las-vegas-nv&lat=abc&lng=-115')).status, 400)
    assert.equal((await call('/api/gis/crime?market=Bad%20Slug&lat=36&lng=-115')).status, 400)
    const none = await call('/api/gis/crime?market=austin-tx&lat=30.27&lng=-97.74')
    assert.equal(none.status, 404)
    assert.equal(none.body.ready, false)
  })

  test('the tool says it the way a person asking about a site would want it', async () => {
    const tool = (input) => runTool('nearby_crime', input, {
      origin: 'http://localhost',
      scope: ['read', 'maps'],
      call: (path, init = {}) => app.fetch(new Request(`http://localhost${path}`, { ...init, headers: { ...(init.headers || {}), cookie } })),
    })
    const out = (await tool({ market: 'las-vegas-nv', lat: SITE.lat, lng: SITE.lng })).structuredContent
    assert.equal(out.covered, true)
    assert.equal(out.policedBy, 'Test Metropolitan Police')
    assert.deepEqual(out.within.map((w) => [w.miles, w.violent, w.property, w.otherOffenses]), [[0.25, 1, 1, 0], [0.5, 2, 2, 0], [1, 2, 2, 1]])
    assert.equal(out.within[0].violentHigherThanPercentOfParcels, 99)
    assert.equal(out.within[0].shareOfCircleCovered, undefined, 'said only when part of the circle is not covered')
    assert.match(out.summary, /Nov 2, 2025 to Nov 1, 2026/)
    assert.match(out.summary, /Within a quarter mile: 1 violent \(more than 99% of parcels\), 1 property/)
    assert.deepEqual(out.categories.find((c) => c.category === 'ROBBERY').counts, { 'within0.25mi': 0, 'within0.5mi': 1, within1mi: 1 })

    const henderson = (await tool({ market: 'las-vegas-nv', lat: 36.05, lng: -114.95 })).structuredContent
    assert.equal(henderson.covered, false)
    assert.match(henderson.summary, /in Henderson, which has its own police/)
    assert.match(henderson.summary, /not a count of zero/)
    assert.equal(henderson.within, undefined)

    const unpublished = await tool({ market: 'austin-tx', lat: 30.27, lng: -97.74 })
    assert.equal(unpublished.isError, true)
    assert.match(unpublished.content[0].text, /No police agency's reported crime is published for austin-tx/)
    assert.equal((await tool({ market: 'las-vegas-nv' })).isError, true, 'a place is needed')
  })

  test('with no place, the route says what the market holds; the connector lists crime first among its layers', async () => {
    const info = await call('/api/gis/crime?market=las-vegas-nv')
    assert.equal(info.status, 200)
    assert.deepEqual([info.body.ready, info.body.violent, info.body.property, info.body.to], [true, 3, 2, '2026-11-01'])
    assert.equal((await call('/api/gis/crime?market=austin-tx')).status, 404)
    const tool = (input) => runTool('market_layers', input, {
      origin: 'http://localhost',
      scope: ['read', 'maps'],
      call: (path, init = {}) => app.fetch(new Request(`http://localhost${path}`, { ...init, headers: { ...(init.headers || {}), cookie } })),
    })
    const vegas = (await tool({ market: 'las-vegas-nv' })).structuredContent
    assert.deepEqual(vegas.layers.map((l) => l.id), ['crime', 'permits'])
    assert.equal(vegas.layers[0].count, 5)
    assert.match(vegas.layers[0].note, /3 violent and 2 property offenses reported to Test Metropolitan Police/)
    const austin = (await tool({ market: 'austin-tx' })).structuredContent
    assert.deepEqual(austin.layers.map((l) => l.id), ['permits'], 'no crime layer where none is published')
  })

  test('a circle that leaves the agency\'s area is flagged in the notes', () => {
    const crime = readCrime(buffer)
    const report = crimeReport({ lat: 36.15, lng: -115.0018, ...crimeNear(crime, { lat: 36.15, lng: -115.0018 }) }, { market: 'las-vegas-nv' })
    assert.ok(report.within[2].shareOfCircleCovered < 0.65)
    assert.match(report.notes.join(' '), /circles? lies? where another agency polices/)
  })
})
