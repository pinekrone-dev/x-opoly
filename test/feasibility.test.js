/**
 * The site feasibility screen: the arithmetic (src/lib/feasibility.ts), the
 * four services read through a stand-in, the route and the connector's tool.
 *
 * The lot is a square about 200 m a side at 36N. Its ground rises steadily to
 * the east at ten metres in a hundred, so every cell's slope is 10%. The
 * western half is in FEMA's special flood hazard area; a pond covers the
 * north-east corner; a park's own land covers the southern eighth.
 */
import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'
import zlib from 'node:zlib'

import { createServer } from '../server/index.js'
import { useTempData } from './helpers.js'
import { feasibilityReport, runTool } from '../app/lib/mcp.js'
import { siteFeasibility } from '../app/lib/feasibility.js'
import { RESULT_COLORS, acresOf, assess, boxOf, cellFeatures, cellTileReader, gridOver, inRingSet, insideSite, partsOf, resultsOn, slopesOf, validCellMap } from '../src/lib/feasibility.ts'
import { renderMap } from '../app/lib/mapimage.js'
import { decodePng } from '../app/lib/png.js'
import { project } from '../app/lib/shapes.js'
import { shardOf } from '../src/lib/parcelRows.ts'

const LAT = 36
const K = Math.cos((LAT * Math.PI) / 180)
const M = 111320
const W = -115.2
const E = W + 200 / (M * K)
const S = LAT
const N = LAT + 200 / M
const rect = (w, s, e, n) => [[w, s], [e, s], [e, n], [w, n], [w, s]]
const LOT = { type: 'Polygon', coordinates: [rect(W, S, E, N)] }
const MID = (W + E) / 2

// Elevation in metres: rising east at `grade` metres a metre from the lot's west edge.
const ground = (grade) => ([lng]) => 500 + (lng - W) * M * K * grade
const overlay = (ring, attributes) => ({ rings: [ring], attributes })
const FLOOD = [
  overlay(rect(W - 1, S - 1, MID, N + 1), { FLD_ZONE: 'AE', ZONE_SUBTY: 'FLOODWAY', SFHA_TF: 'T' }),
  overlay(rect(MID, S - 1, E + 1, N + 1), { FLD_ZONE: 'X', ZONE_SUBTY: 'AREA OF MINIMAL FLOOD HAZARD', SFHA_TF: 'F' }),
]
const POND = [overlay(rect(E - (E - W) * 0.2, N - (N - S) * 0.2, E + 1, N + 1), { WETLAND_TYPE: 'Freshwater Pond', ATTRIBUTE: 'PUBHx' })]
const PARK = [
  overlay(rect(W - 1, S - 1, E + 1, S + (N - S) * 0.12), { Unit_Nm: 'Test Regional Park', MngNm_Desc: 'City Land', DesTp_Desc: 'Local Park', Category: 'Fee', GAP_Sts: '4', Pub_Access: 'OA' }),
  overlay(rect(W - 1, S - 1, E + 1, N + 1), { Unit_Nm: 'Test National Forest', MngNm_Desc: 'Forest Service', DesTp_Desc: 'Proclamation Boundary', Category: 'Proclamation', GAP_Sts: '4' }),
]

describe('the arithmetic', () => {
  test('a point is on the lot or off it, holes included', () => {
    assert.equal(insideSite(LOT, MID, (S + N) / 2), true)
    assert.equal(insideSite(LOT, W - 0.001, S), false)
    const holed = { type: 'Polygon', coordinates: [rect(0, 0, 10, 10), rect(4, 4, 6, 6)] }
    assert.equal(insideSite(holed, 5, 5), false)
    assert.equal(insideSite(holed, 2, 2), true)
    assert.equal(inRingSet([rect(0, 0, 1, 1)], 0.5, 0.5), true)
    assert.deepEqual(boxOf(LOT), [W, S, E, N])
  })

  test('the lot measures what it is', () => {
    // 200 m by 200 m is 9.88 acres.
    assert.ok(Math.abs(acresOf(LOT) - 9.884) < 0.02)
    const holed = { type: 'Polygon', coordinates: [rect(W, S, E, N), rect(W + (E - W) * 0.25, S + (N - S) * 0.25, W + (E - W) * 0.75, S + (N - S) * 0.75)] }
    assert.ok(Math.abs(acresOf(holed) - 9.884 * 0.75) < 0.02, 'a hole is taken out')
  })

  test('a grid of about two hundred cells, none finer than three metres, twenty a side at most', () => {
    const grid = gridOver(LOT)
    assert.equal(grid.nx, 15)
    assert.equal(grid.ny, 15)
    assert.ok(Math.abs(grid.dx - 200 / 15) < 0.01)
    assert.equal(grid.inside.every(Boolean), true, 'every centre of a rectangle is on it')
    const tiny = gridOver({ type: 'Polygon', coordinates: [rect(W, S, W + 12 / (M * K), S + 12 / M)] })
    assert.deepEqual([tiny.nx, tiny.ny], [4, 4])
    // A ranch thirty miles across still gets about two hundred cells, each a couple of miles wide.
    const vast = gridOver({ type: 'Polygon', coordinates: [rect(W, S, W + 0.5, S + 0.5)] })
    assert.deepEqual([vast.nx, vast.ny], [13, 17])
    // A strip 100 m wide and 5 km long: three cells across, and the twenty a side that one request holds.
    const strip = gridOver({ type: 'Polygon', coordinates: [rect(W, S, W + 100 / (M * K), S + 5000 / M)] })
    assert.deepEqual([strip.nx, strip.ny], [3, 20])
    // A triangle: about half its box's cells are on it.
    const triangle = gridOver({ type: 'Polygon', coordinates: [[[W, S], [E, S], [W, N], [W, S]]] })
    const on = triangle.inside.filter(Boolean).length
    assert.ok(on > 90 && on < 130)
  })

  test('slope is rise over run, whichever way the ground falls', () => {
    const grid = gridOver(LOT)
    const east = slopesOf(grid.points.map(ground(0.1)), grid)
    assert.ok(east.every((value) => Math.abs(value - 10) < 0.05), 'ten metres in a hundred is 10%, edge cells included')
    const flat = slopesOf(grid.points.map(() => 12), grid)
    assert.ok(flat.every((value) => value === 0))
    // Rising north-east at 3 in 100 east and 4 in 100 north: 5%.
    const both = slopesOf(grid.points.map(([lng, lat]) => (lng - W) * M * K * 0.03 + (lat - S) * M * 0.04), grid)
    assert.ok(both.every((value) => Math.abs(value - 5) < 0.05))
    const gap = grid.points.map(ground(0.1))
    gap[7] = NaN
    const withGap = slopesOf(gap, grid)
    assert.ok(Number.isNaN(withGap[7]))
    assert.ok(Math.abs(withGap[6] - 10) < 0.05 && Math.abs(withGap[8] - 10) < 0.05, 'a neighbour with no elevation does not spoil the cell beside it')
  })

  test('each screen takes out its share and the rest is what passes', () => {
    const grid = gridOver(LOT)
    const out = assess({
      geometry: LOT,
      grid,
      elevation: { available: true, data: { z: grid.points.map(ground(0.1)), resolutionMeters: 1 } },
      flood: { available: true, data: FLOOD },
      wetlands: { available: true, data: POND },
      protectedLand: { available: true, data: PARK },
    })
    assert.equal(out.cells.count, 225)
    assert.equal(out.cells.spacingFeet, 44)
    assert.deepEqual([out.slope.meanPercent, out.slope.maxPercent, out.slope.shareOverLimit], [10, 10, 0])
    assert.deepEqual([out.slope.elevationMinFeet, out.slope.reliefFeet], [1643, 61])
    // 7 of 15 columns have their centre west of the middle.
    assert.equal(out.flood.shareInHazardArea, 0.467)
    assert.deepEqual(out.flood.zones.map((z) => [z.zone, z.hazardArea, z.share]), [['X', false, 0.533], ['AE', true, 0.467]])
    assert.equal(out.wetlands.share, 0.04, 'three cells by three in the corner')
    assert.equal(out.protectedLand.share, 0.133, 'the park\'s own land: two rows of fifteen')
    assert.deepEqual(out.protectedLand.units.map((u) => [u.name, u.counted]), [['Test National Forest', false], ['Test Regional Park', true]])
    // East half less the park's two rows there and the pond: 8*15 - 16 - 9 = 95 of 225.
    assert.equal(out.buildable.share, 0.422)
    assert.deepEqual(out.buildable.screened, ['slope', 'flood', 'wetlands', 'protected land'])
    assert.ok(Math.abs(out.buildable.acres - 9.88 * 0.422) < 0.03)
  })

  test('a limit under the lot\'s slope takes it all out, and a missing service is said, not guessed', () => {
    const grid = gridOver(LOT)
    const out = assess({
      geometry: LOT,
      grid,
      elevation: { available: true, data: { z: grid.points.map(ground(0.1)), resolutionMeters: 10 } },
      flood: { available: false, reason: 'FEMA did not answer in time.' },
      wetlands: { available: true, data: [] },
      protectedLand: { available: true, data: [] },
      maxSlopePercent: 8,
    })
    assert.equal(out.slope.shareOverLimit, 1)
    assert.equal(out.buildable.share, 0)
    assert.deepEqual(out.flood, { available: false, reason: 'FEMA did not answer in time.' })
    assert.deepEqual(out.buildable.notScreened, ['flood'])
    const unmapped = assess({ geometry: LOT, grid, elevation: { available: false }, flood: { available: true, data: [] }, wetlands: { available: true, data: [] }, protectedLand: { available: true, data: [] } })
    assert.equal(unmapped.flood.mapped, false, 'no zone under the lot is unmapped ground, not safe ground')
    assert.equal(unmapped.slope.available, false)
    assert.equal(unmapped.buildable.share, 1)
  })
})

describe('the screen, drawn', () => {
  const grid = gridOver(LOT)
  const screen = assess({
    geometry: LOT,
    grid,
    elevation: { available: true, data: { z: grid.points.map(ground(0.1)), resolutionMeters: 1 } },
    flood: { available: true, data: FLOOD },
    wetlands: { available: true, data: POND },
    protectedLand: { available: true, data: PARK },
    maxSlopePercent: 15,
  })
  const at = (fx, fy) => [W + fx * (E - W), S + fy * (N - S)]

  test('each cell says everything that takes it out', () => {
    const { map } = screen
    assert.deepEqual([map.nx, map.ny, map.results.length], [15, 15, 225])
    const cell = (i, j) => partsOf(map.results[j * 15 + i])
    assert.deepEqual(cell(10, 7), ['Passes'])
    assert.deepEqual(cell(2, 7), ['Flood hazard area'])
    assert.deepEqual(cell(14, 14), ['Mapped wetland'])
    assert.deepEqual(cell(2, 0), ['Protected or public land', 'Flood hazard area'], 'the park, in the flood zone: both')
    assert.deepEqual(cell(10, 0), ['Protected or public land'])
    assert.deepEqual(resultsOn(map), ['Passes', 'Protected or public land', 'Mapped wetland', 'Flood hazard area'])
    const steep = assess({ geometry: LOT, grid, elevation: { available: true, data: { z: grid.points.map(ground(0.3)), resolutionMeters: 1 } }, flood: { available: true, data: FLOOD }, wetlands: { available: true, data: [] }, protectedLand: { available: true, data: [] } })
    assert.deepEqual(partsOf(steep.map.results[7 * 15 + 10]), ['Steeper than the limit'])
    assert.deepEqual(partsOf(steep.map.results[7 * 15 + 2]), ['Flood hazard area', 'Steeper than the limit'])
    assert.deepEqual(partsOf(-1), [])
    // A triangle's cells off the lot are marked so, and are not drawn.
    const triangle = { type: 'Polygon', coordinates: [[[W, S], [E, S], [W, N], [W, S]]] }
    const tri = gridOver(triangle)
    const half = assess({ geometry: triangle, grid: tri, elevation: { available: false }, flood: { available: true, data: [] }, wetlands: { available: true, data: [] }, protectedLand: { available: true, data: [] } })
    assert.equal(half.map.results.filter((r) => r === -1).length, 225 - half.cells.count)
    assert.equal(cellFeatures(half.map).features.length, half.cells.count)
  })

  test('as rectangles for the map: one colour where one thing applies, a band each where several do', () => {
    const geo = cellFeatures(screen.map)
    // 225 cells, and the fourteen in the park's two rows that are flood as well are two bands each.
    assert.equal(geo.features.length, 239)
    const names = new Set(geo.features.map((f) => f.properties.Result))
    assert.deepEqual([...names].sort(), ['Flood hazard area', 'Mapped wetland', 'Passes', 'Protected or public land'])
    const first = geo.features[0]
    const second = geo.features[1]
    const width = (E - W) / 15
    // The south-west cell: its west half the park's colour, its east half the flood's.
    assert.deepEqual([first.properties.Result, first.properties.With], ['Protected or public land', 'Flood hazard area'])
    assert.deepEqual([second.properties.Result, second.properties.With], ['Flood hazard area', 'Protected or public land'])
    assert.ok(Math.abs(first.geometry.coordinates[0][0][0] - W) < 1e-6 && Math.abs(first.geometry.coordinates[0][1][0] - (W + width / 2)) < 1e-6)
    assert.ok(Math.abs(second.geometry.coordinates[0][0][0] - (W + width / 2)) < 1e-6 && Math.abs(second.geometry.coordinates[0][1][0] - (W + width)) < 1e-6)
    const plain = geo.features.find((f) => f.properties.Result === 'Passes')
    assert.equal(plain.properties.With, undefined)
  })

  test('only a sound cell map is drawn', () => {
    assert.ok(validCellMap(screen.map))
    assert.equal(validCellMap(null), null)
    assert.equal(validCellMap({ ...screen.map, results: screen.map.results.slice(1) }), null)
    assert.equal(validCellMap({ ...screen.map, nx: 400, ny: 400, results: [] }), null)
    assert.equal(validCellMap({ ...screen.map, results: screen.map.results.map(() => 16) }), null)
    assert.ok(validCellMap({ ...screen.map, results: screen.map.results.map(() => 15) }), 'all four at once is a cell')
    assert.equal(validCellMap({ ...screen.map, box: [0, 0, 'x', 1] }), null)
  })

  test('in a picture, each part of the lot is its own colour', async () => {
    const centre = at(0.5, 0.5)
    const out = await renderMap({
      center: centre, zoom: 17, width: 600, height: 600,
      layers: [{ label: 'Site feasibility', kind: 'polygon', color: RESULT_COLORS.Passes, colors: { field: 'Result', map: RESULT_COLORS }, fill: 0.9, legend: [['Passes', RESULT_COLORS.Passes]], read: cellTileReader(screen.map), minZoom: 0, maxZoom: 22 }],
    })
    assert.equal(out.shown.layers, 1)
    const image = await decodePng(out.png)
    const colour = ([lng, lat]) => {
      const [x, y] = project(lng, lat, out.frame.z)
      const o = (Math.round(y - out.frame.top) * image.width + Math.round(x - out.frame.left)) * 4
      return [image.rgba[o], image.rgba[o + 1], image.rgba[o + 2]]
    }
    const [pr, pg, pb] = colour(at(0.72, 0.5))
    assert.ok(pg > pr + 40 && pg > pb + 40, `east of the middle passes, green: ${[pr, pg, pb]}`)
    const [fr, fg, fb] = colour(at(0.2, 0.5))
    assert.ok(fb > fr + 60 && fb > fg + 30, `the west half is flood, blue: ${[fr, fg, fb]}`)
    const [wr, wg, wb] = colour(at(0.9, 0.9))
    assert.ok(wg > wr + 60 && wb > wr + 60, `the pond is teal: ${[wr, wg, wb]}`)
    const [qr, qg, qb] = colour(at(0.5, 0.05))
    assert.ok(qb > qg + 60 && qr > qg + 30, `the park is purple: ${[qr, qg, qb]}`)
    // A cell in the park and the flood zone both: purple to the west of its middle, blue to the east.
    const cellAt = (i, j, fx) => at((i + fx) / 15, (j + 0.5) / 15)
    const [ar, ag, ab] = colour(cellAt(2, 0, 0.25))
    assert.ok(ab > ag + 60 && ar > ag + 30, `the band for the park: ${[ar, ag, ab]}`)
    const [cr, cg, cb] = colour(cellAt(2, 0, 0.75))
    assert.ok(cb > cr + 60 && cb > cg + 30, `the band for the flood zone: ${[cr, cg, cb]}`)
    const [or, og, ob] = colour([W - (E - W) * 0.3, (S + N) / 2])
    assert.ok(Math.abs(or - og) < 12 && Math.abs(og - ob) < 12, 'off the lot is the ground colour')
  })
})

// The four services, standing in: what each is asked and what it hands back.
function services({ grade = 0.1, flood = FLOOD, wetlands = POND, land = PARK, down = [] } = {}) {
  const asked = []
  const esri = (overlays) => ({ features: overlays.map((o) => ({ attributes: o.attributes, geometry: { rings: o.rings } })) })
  const fetcher = async (url, init = {}) => {
    const address = String(url)
    asked.push(address.split('?')[0])
    const says = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (down.some((name) => address.includes(name))) return says({}, 503)
    if (address.includes('3DEPElevation')) {
      assert.equal(init.method, 'POST')
      const points = JSON.parse(new URLSearchParams(String(init.body)).get('geometry')).points
      return says({ samples: points.map((p, i) => ({ locationId: i, value: String(ground(grade)(p)), resolution: 1 })) })
    }
    const query = new URL(address).searchParams
    assert.equal(query.get('geometryType'), 'esriGeometryEnvelope')
    assert.equal(query.get('outSR'), '4326')
    if (address.includes('NFHL')) return says(esri(flood))
    if (address.includes('wetlands')) return says(esri(wetlands))
    if (address.includes('PADUS')) return says(esri(land))
    return says({ error: { message: 'unknown service' } })
  }
  return { fetcher, asked }
}

describe('the four services', () => {
  test('one request to each, for the lot\'s box, and the screen over what they return', async () => {
    const { fetcher, asked } = services()
    const out = await siteFeasibility({ geometry: LOT, fetcher })
    assert.equal(asked.length, 4)
    assert.equal(out.buildable.share, 0.422)
    assert.equal(out.slope.resolutionMeters, 1)
    assert.equal(out.sources.length, 4)
    assert.match(out.sources[0].name, /3D Elevation Program/)
  })

  test('one that is down is not screened and the others stand', async () => {
    const { fetcher } = services({ down: ['PADUS', '3DEPElevation'] })
    const out = await siteFeasibility({ geometry: LOT, fetcher })
    assert.equal(out.protectedLand.available, false)
    assert.match(out.protectedLand.reason, /Protected Areas Database.*answered 503/)
    assert.equal(out.slope.available, false)
    assert.deepEqual(out.buildable.notScreened, ['slope', 'protected land'])
    assert.equal(out.flood.shareInHazardArea, 0.467)
  })
})

describe('the route and the connector', () => {
  const temp = useTempData()
  const realFetch = globalThis.fetch
  let app
  let cookie = null
  let stand = services()
  const record = { id: 7, ad: '7 Ridge Rd', ow: 'Vance Holdings', mv: 900000, ac: 9.9, at: 'Land', bb: [W, S, E, N] }
  const blob = zlib.gzipSync(Buffer.from(JSON.stringify({ 7: record })))
  const FILES = {
    'sacramento-ca/rows.json': Buffer.from(JSON.stringify({ v: 1, n: 1, per: 300, shards: 1, offsets: [0, blob.length], built: 1700000000 })),
    'sacramento-ca/rows.pack': blob,
  }
  assert.equal(shardOf(7, 1), 0)
  const call = async (path) => {
    const res = await app.fetch(new Request(`http://localhost${path}`, { headers: cookie ? { cookie } : {} }))
    return { status: res.status, body: await res.json().catch(() => null) }
  }

  before(async () => {
    globalThis.fetch = async (url, init) => {
      const key = String(url).replace('https://catalogue.test/', '')
      const file = FILES[key]
      if (!file) return new Response('not found', { status: 404 })
      const range = /^bytes=(\d+)-(\d+)$/.exec(init?.headers?.range ?? '')
      return range ? new Response(file.subarray(Number(range[1]), Number(range[2]) + 1), { status: 206 }) : new Response(file, { status: 200 })
    }
    app = await createServer({
      DATA_DIR: temp.directory, DB_FILE: `${temp.directory}/test.db`, PARCEL_CATALOG_ORIGIN: 'https://catalogue.test',
      FEASIBILITY_FETCH: (url, init) => stand.fetcher(url, init),
    })
    const res = await app.fetch(new Request('http://localhost/api/auth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'feas@example.com', password: 'a long enough password', name: 'F' }),
    }))
    cookie = res.headers.get('set-cookie').split(';')[0]
  })
  after(() => {
    globalThis.fetch = realFetch
    return temp.cleanup()
  })

  test('a parcel in a market served from files is screened, by its box where its outline is not to be had', async () => {
    const res = await call('/api/gis/feasibility?market=sacramento-ca&id=7')
    assert.equal(res.status, 200)
    assert.equal(res.body.address, '7 Ridge Rd')
    assert.equal(res.body.outline, 'box')
    assert.equal(res.body.countyAcres, 9.9)
    assert.equal(res.body.buildable.share, 0.422)
    const steep = await call('/api/gis/feasibility?market=sacramento-ca&id=7&maxSlope=8')
    assert.equal(steep.body.buildable.share, 0)
    assert.equal(steep.body.buildable.limitPercent, 8)
  })

  test('it needs a user, a market and a parcel that exists', async () => {
    const held = cookie
    cookie = null
    assert.equal((await call('/api/gis/feasibility?market=sacramento-ca&id=7')).status, 401)
    cookie = held
    assert.equal((await call('/api/gis/feasibility?market=sacramento-ca')).status, 400)
    assert.equal((await call('/api/gis/feasibility?market=Bad%20Slug&id=7')).status, 400)
    assert.equal((await call('/api/gis/feasibility?market=sacramento-ca&id=999')).status, 404)
  })

  const tool = (input) => runTool('site_feasibility', input, {
    origin: 'http://localhost',
    scope: ['read', 'maps'],
    call: (path, init = {}) => app.fetch(new Request(`http://localhost${path}`, { ...init, headers: { ...(init.headers || {}), cookie } })),
  })

  test('the tool says what passes, what stands in the way, and what the screen is not', async () => {
    const out = (await tool({ market: 'sacramento-ca', id: '7' })).structuredContent
    assert.equal(out.address, '7 Ridge Rd')
    assert.deepEqual(out.buildable, { acres: 4.17, percent: 42.2, maxSlopePercent: 15, notScreened: undefined })
    assert.match(out.summary, /About 4\.17 of 9\.88 acres \(42\.2%\) pass the screen: slope of 15% or less, outside FEMA's flood hazard area, outside mapped wetlands, outside protected or publicly held land\./)
    assert.match(out.flags.join(' '), /46\.7% is in FEMA's special flood hazard area, zone AE \(floodway\)\./)
    assert.match(out.flags.join(' '), /4% is mapped wetland \(Freshwater Pond\)\./)
    assert.match(out.flags.join(' '), /13\.3% is within Test Regional Park, held by City Land \(Local Park\)\./)
    assert.match(out.flags.join(' '), /Inside the drawn boundary of Test National Forest, which does not by itself restrict private land\./)
    assert.equal(out.slope.meanPercent, 10)
    assert.match(out.method, /bounding box.*225 cells about 44 ft apart/)
    assert.match(out.caveats.join(' '), /not a survey/)
    assert.equal(out.map, undefined, 'the cells are for drawing, not for the reply')
    assert.equal(out.image, undefined)
    assert.match(out.imageNote, /could not be drawn: No map is published for sacramento-ca/)
    const plain = (await tool({ market: 'sacramento-ca', id: '7', image: false })).structuredContent
    assert.equal(plain.imageNote, undefined, 'no picture asked for, none attempted')
    assert.equal((await tool({ market: 'sacramento-ca' })).isError, true)
    assert.equal((await tool({ market: 'sacramento-ca', id: '999' })).isError, true)
  })

  test('a service that is down is named, and a steeper limit is passed on', async () => {
    stand = services({ down: ['NFHL'] })
    const out = (await tool({ market: 'sacramento-ca', id: '7', maxSlopePercent: 12 })).structuredContent
    assert.deepEqual(out.buildable.notScreened, ['flood'])
    assert.equal(out.buildable.maxSlopePercent, 12)
    assert.match(out.flags.join(' '), /Not screened: FEMA National Flood Hazard Layer answered 503\./)
    assert.match(out.flood.notScreened, /answered 503/)
    stand = services()
  })

  test('several lots are screened and ranked by the acres that pass', async () => {
    const many = (await tool({ market: 'sacramento-ca', ids: ['7', '999'] })).structuredContent
    assert.deepEqual(many.ranked.map((r) => r.id), ['7', '999'])
    assert.equal(many.ranked[0].buildableAcres, 4.17)
    assert.match(many.ranked[1].error, /No such parcel/)
  })

  test('a lot nothing stands in the way of says so', () => {
    const grid = gridOver(LOT)
    const clean = assess({ geometry: LOT, grid, elevation: { available: true, data: { z: grid.points.map(ground(0.02)), resolutionMeters: 1 } }, flood: { available: true, data: [FLOOD[1]] }, wetlands: { available: true, data: [] }, protectedLand: { available: true, data: [] } })
    const report = feasibilityReport({ market: 'sacramento-ca', id: '7', ...clean })
    assert.deepEqual(report.flags, [])
    assert.match(report.summary, /\(100%\) pass the screen.*Nothing on these four maps stands in the way\./)
  })
})
