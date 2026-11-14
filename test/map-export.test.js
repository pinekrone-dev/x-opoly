/**
 * A map as a picture, parcels as shapes, and the platform's totals: the
 * three things the connector could not hand over.
 *
 * The drawing is tested on real bytes at both ends: tiles built in the
 * vector tile format go in, and the PNG that comes out is decoded and its
 * pixels looked at.
 */
import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'
import { createSign, generateKeyPairSync } from 'node:crypto'

import { resetKeyCache } from '../app/lib/oidc.js'
import { createServer } from '../server/index.js'
import { useTempData } from './helpers.js'
import { encodeTile, fakeArchive } from './tiles-helper.js'
import { decodePng, encodePng, isPng } from '../app/lib/png.js'
import { decodeFeatures, parcelShape, project, unproject } from '../app/lib/shapes.js'
import { frameOf, renderMap, zoomToFit } from '../app/lib/mapimage.js'
import { fitText, textWidth } from '../app/lib/raster.js'
import { runTool, stateParams, viewState } from '../app/lib/mcp.js'

const bytesOf = (b64) => Uint8Array.from(Buffer.from(b64, 'base64'))

describe('PNG', () => {
  test('what is written reads back the same', async () => {
    const width = 37
    const height = 23
    const rgba = new Uint8ClampedArray(width * height * 4)
    for (let i = 0; i < width * height; i += 1) {
      rgba[i * 4] = (i * 7) % 256
      rgba[i * 4 + 1] = (i * 13) % 256
      rgba[i * 4 + 2] = i % 2 ? 250 : 5
      rgba[i * 4 + 3] = 255
    }
    const png = await encodePng(width, height, rgba)
    assert.ok(isPng(png))
    const back = await decodePng(png)
    assert.equal(back.width, width)
    assert.equal(back.height, height)
    assert.deepEqual([...back.rgba], [...rgba])
  })

  test('a two-bit palette with transparency, as a map tile can be', async () => {
    const image = await decodePng(bytesOf('iVBORw0KGgoAAAANSUhEUgAAAAQAAAACAgMAAAACxpXwAAAADFBMVEX/AAAA/wAAAP8KFB4iiCkEAAAABHRSTlP/gP8AH4eGmQAAAAxJREFUeJxjkGZ4AgABOQEARWSRmwAAAABJRU5ErkJggg=='))
    assert.equal(image.width, 4)
    assert.deepEqual([...image.rgba.slice(0, 16)], [255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 10, 20, 30, 0])
    assert.deepEqual([...image.rgba.slice(16, 20)], [10, 20, 30, 0])
  })

  test('grey with alpha, and a refusal for what is not a PNG', async () => {
    const image = await decodePng(bytesOf('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAQAAABeK7cBAAAADUlEQVR4nGM48d8oBQAG6gJetBNdgQAAAABJRU5ErkJggg=='))
    assert.deepEqual([...image.rgba], [200, 200, 200, 255, 50, 50, 50, 100])
    await assert.rejects(() => decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])), /not a PNG/)
  })
})

/* Three lots near downtown Denver, as longitude and latitude. */
const C = [-104.99, 39.74]
const square = ([lng, lat], d) => [[lng - d, lat - d], [lng + d, lat - d], [lng + d, lat + d], [lng - d, lat + d]]
const EDGE = (427 / 2048) * 360 - 180 // a tile line at zoom 11, and so at every finer zoom
const LOTS = [
  { id: 501, gp: 'Commercial', ring: square(C, 0.0004) },
  { id: 502, gp: 'Vacant land', ring: square([C[0] + 0.002, C[1]], 0.0004) },
  { id: 503, gp: 'Single family', ring: square([EDGE, 39.741], 0.0003) },
]
const boxOf = (ring) => [Math.min(...ring.map((p) => p[0])), Math.min(...ring.map((p) => p[1])), Math.max(...ring.map((p) => p[0])), Math.max(...ring.map((p) => p[1]))]

/** The tile at z/x/y holding whichever lots reach into it, in the tile's own units. */
function parcelTile(z, x, y) {
  const features = []
  for (const lot of LOTS) {
    const ring = lot.ring.map(([lng, lat]) => {
      const [wx, wy] = project(lng, lat, z)
      return [Math.round((wx / 256 - x) * 4096), Math.round((wy / 256 - y) * 4096)]
    })
    const xs = ring.map((p) => p[0])
    const ys = ring.map((p) => p[1])
    if (Math.max(...xs) < 0 || Math.min(...xs) > 4096 || Math.max(...ys) < 0 || Math.min(...ys) > 4096) continue
    features.push({ type: 3, id: lot.id, properties: { gp: lot.gp }, geometry: [ring] })
  }
  return features.length ? encodeTile('parcels', features) : null
}

describe('shapes from tiles', () => {
  const read = async (z, x, y) => decodeFeatures(parcelTile(z, x, y), 'parcels')

  test('longitude and latitude survive the trip to pixels and back', () => {
    const [x, y] = project(C[0], C[1], 15)
    const [lng, lat] = unproject(x, y, 15)
    assert.ok(Math.abs(lng - C[0]) < 1e-9 && Math.abs(lat - C[1]) < 1e-9)
  })

  test('a lot inside one tile comes back whole, to about a foot', async () => {
    const lot = LOTS[0]
    const shape = await parcelShape(read, lot.id, boxOf(lot.ring))
    assert.equal(shape.geometry.type, 'Polygon')
    assert.equal(shape.pieces, 1)
    const ring = shape.geometry.coordinates[0]
    assert.deepEqual(ring[0], ring[ring.length - 1], 'the ring is closed')
    assert.equal(ring.length, 5)
    for (const [lng, lat] of lot.ring) {
      assert.ok(ring.some((p) => Math.abs(p[0] - lng) < 5e-6 && Math.abs(p[1] - lat) < 5e-6), `corner ${lng},${lat}`)
    }
  })

  test('a lot across a tile line at every zoom comes back as its pieces', async () => {
    const lot = LOTS[2]
    const shape = await parcelShape(read, lot.id, boxOf(lot.ring))
    assert.equal(shape.geometry.type, 'MultiPolygon')
    assert.ok(shape.pieces >= 2)
    assert.equal(shape.geometry.coordinates.length, shape.pieces)
  })

  test('a lot the tiles do not hold is null, not a guess', async () => {
    assert.equal(await parcelShape(read, 999, boxOf(LOTS[0].ring)), null)
    assert.equal(await parcelShape(read, 501, null), null)
  })
})

describe('drawing the map', () => {
  const parcels = { read: async (z, x, y) => decodeFeatures(parcelTile(z, x, y), 'parcels'), minZoom: 11, maxZoom: 16 }
  const pixel = (image, x, y) => [...image.rgba.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)]

  test('the frame is centred where it was asked to be', () => {
    const frame = frameOf({ center: C, zoom: 16, width: 800, height: 600 })
    assert.ok(frame.box[0] < C[0] && frame.box[2] > C[0] && frame.box[1] < C[1] && frame.box[3] > C[1])
    assert.equal(zoomToFit(1, 39.7, 700) > zoomToFit(10, 39.7, 700), true)
  })

  test('a matched lot is red, its neighbour is not, and a pin is dark', async () => {
    const out = await renderMap({
      center: C, zoom: 16, width: 800, height: 600, parcels, matches: new Set(['501']),
      pins: [{ lng: C[0] - 0.003, lat: C[1], label: 'A pin' }], title: 'Test map',
    })
    const image = await decodePng(out.png)
    assert.equal(image.width, 800)
    assert.deepEqual(out.shown, { parcels: 2, matches: 1, pins: 1, layers: 2 })
    const at = ([lng, lat]) => {
      const [x, y] = project(lng, lat, out.frame.z)
      return [Math.round(x - out.frame.left), Math.round(y - out.frame.top)]
    }
    const [r, g, b] = pixel(image, ...at(C))
    assert.ok(r > 200 && g < 190 && b < 190, `the matched lot is red: ${[r, g, b]}`)
    const [r2, g2, b2] = pixel(image, ...at([C[0] + 0.002, C[1]]))
    assert.ok(Math.abs(r2 - g2) < 12 && Math.abs(g2 - b2) < 12, `the neighbour is the ground colour: ${[r2, g2, b2]}`)
    const [r3] = pixel(image, ...at([C[0] - 0.003, C[1]]))
    assert.ok(r3 < 60, 'the pin is ink')
  })

  test('land use colours fill each lot with its own', async () => {
    const out = await renderMap({ center: C, zoom: 16, width: 800, height: 600, parcels, showLandUse: true })
    const image = await decodePng(out.png)
    const [x, y] = project(C[0], C[1], out.frame.z)
    const [r, , b] = pixel(image, Math.round(x - out.frame.left), Math.round(y - out.frame.top))
    assert.ok(b > r + 30, 'commercial is blue')
  })

  test('too wide for lot lines says so and still draws', async () => {
    const out = await renderMap({ center: C, zoom: 9, width: 400, height: 300, parcels })
    assert.match(out.notes.join(' '), /too wide for lot lines/)
    assert.ok(isPng(out.png))
    // A match is still marked there, by a dot at its centre.
    const dotted = await renderMap({ center: C, zoom: 9, width: 400, height: 300, parcels, matches: new Set(['501']), matchPoints: [C] })
    assert.equal(dotted.shown.matches, 1)
    const image = await decodePng(dotted.png)
    assert.ok(pixel(image, 200, 150)[0] > 200 && pixel(image, 200, 150)[1] < 80, 'a red dot at the centre')
  })

  test('text is cut to fit and says it was', () => {
    const cut = fitText('label', 'A very long name for a place on a map', 80)
    assert.ok(cut.endsWith('...'))
    assert.ok(textWidth('label', cut) <= 80)
    assert.equal(fitText('label', 'Short', 80), 'Short')
  })
})

describe('a saved map\'s criteria, as a search', () => {
  test('what make_map stores reads back as the query search_parcels sends', () => {
    const input = {
      market: 'denver-co', text: 'colfax', assetTypes: ['Land'], valueMin: 100000, acresMax: 5,
      zoning: ['Commercial'], notZoning: ['Residential'], flood: 'out', buildings: 'vacant', owners: ['company'],
      near: [{ layer: 'transmission', miles: 1 }], circle: { lat: 39.74, lng: -104.99, miles: 2 }, match: 'any',
    }
    const params = stateParams(viewState(input), 'denver-co')
    assert.equal(params.get('q'), 'colfax')
    assert.equal(params.get('at'), 'Land')
    assert.equal(params.get('vmin'), '100000')
    assert.equal(params.get('amax'), '5')
    assert.equal(params.get('zc'), 'Commercial')
    assert.equal(params.get('znot'), 'Residential')
    assert.equal(params.get('flood'), 'out')
    assert.equal(params.get('bld'), 'vacant')
    assert.equal(params.get('own'), 'company')
    assert.equal(params.get('near'), 'transmission:1')
    assert.equal(params.get('circle'), '39.74,-104.99,2')
    assert.equal(params.get('match'), 'any')
    assert.equal(stateParams({}, 'denver-co').toString(), 'market=denver-co')
  })
})

/* The routes and the connector's tools, against a running app. */
const temp = useTempData()
let app
let cookie = null

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' }
const b64url = (input) => Buffer.from(typeof input === 'string' ? input : JSON.stringify(input)).toString('base64url')
function sign() {
  const now = Math.floor(Date.now() / 1000)
  const head = b64url({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })
  const payload = b64url({ iss: 'https://token.actions.githubusercontent.com', aud: 'landquotient-ingest', repository: 'pinekrone-dev/prospector', ref: 'refs/heads/main', exp: now + 300, nbf: now - 30 })
  const signer = createSign('RSA-SHA256')
  signer.update(`${head}.${payload}`)
  return `${head}.${payload}.${signer.sign(privateKey).toString('base64url')}`
}

const MARKETS = {
  updated: '2026-11-13',
  markets: [
    { slug: 'denver-co', name: 'Denver', region: 'Denver County, Colorado', status: 'live', roll: '2026 roll', stats: { parcels: 240485, value: 200e9, acres: 99000 } },
    { slug: 'austin-tx', name: 'Austin', region: 'Travis County, Texas', status: 'live', stats: { parcels: 373541, value: 389e9, acres: 577493 } },
    { slug: 'kane-il', name: 'Kane', region: 'Kane County, Illinois', status: 'next', stats: { parcels: 5 } },
  ],
}
const LAYERS = { layers: [{ id: 'permits', label: 'Development pipeline', kind: 'point', color: '#f59f00', tiles: 'permits.pmtiles', sourceLayer: 'permits' }] }
const objects = new Map([['markets.json', JSON.stringify(MARKETS)], ['denver-co/layers.json', JSON.stringify(LAYERS)]])
const PROSPECTOR_DATA = {
  get: async (key) => (objects.has(key) ? { text: async () => objects.get(key), arrayBuffer: async () => new TextEncoder().encode(objects.get(key)).buffer, body: objects.get(key), httpEtag: 'e', size: objects.get(key).length, writeHttpMetadata: () => {} } : null),
  head: async (key) => (objects.has(key) ? { httpEtag: 'e', size: objects.get(key).length } : null),
}
const archives = (key) => {
  if (key === 'denver-co/parcels.pmtiles') return fakeArchive({}, parcelTile)
  if (key === 'denver-co/permits.pmtiles') {
    return fakeArchive({ minZoom: 8, maxZoom: 14 }, () => encodeTile('permits', [{ type: 1, id: 1, properties: {}, geometry: [[[2048, 2048]]] }]))
  }
  return null
}
let tilesAsked = 0
const MAP_TILE_FETCH = async () => {
  tilesAsked += 1
  const rgba = new Uint8ClampedArray(256 * 256 * 4).fill(255)
  return encodePng(256, 256, rgba)
}

const call = async (path, init = {}, anonymous = false) => {
  const res = await app.fetch(new Request(`http://localhost${path}`, {
    ...init, headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}), ...(cookie && !anonymous ? { cookie } : {}) },
  }))
  const set = res.headers.get('set-cookie')
  if (set && !anonymous) cookie = set.split(';')[0]
  return res
}
const json = async (path, body, anonymous = false) => {
  const res = await call(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }, anonymous)
  return { status: res.status, body: await res.json().catch(() => null) }
}
const callApp = (path, init = {}) => call(path, init)
const ctx = { call: callApp, origin: 'https://lq.test', scope: ['read', 'maps'] }

before(async () => {
  resetKeyCache()
  app = await createServer({
    DATA_DIR: temp.directory, DB_FILE: `${temp.directory}/test.db`,
    JWKS_FETCH: async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    PROSPECTOR_DATA, TILE_ARCHIVES: archives, MAP_TILE_FETCH,
  })
  await json('/api/auth/register', { email: 'maps@example.com', password: 'a long enough password', name: 'M' })
  const rows = LOTS.map((lot, i) => ({ id: lot.id, ad: `${lot.id} Test St`, ow: 'Owner LLC', at: 'Land', mv: [900000, 100000, 50000][i], ac: 0.3, bb: boxOf(lot.ring) }))
  const ingest = (query, body) => call(`/api/gis/ingest/parcels?${query}`, { method: 'POST', body: JSON.stringify(body), headers: { authorization: `Bearer ${sign()}` } }, true)
  assert.equal((await ingest('market=denver-co&action=rows', rows)).status, 200)
  assert.equal((await ingest('market=denver-co&action=seal', { keys: ['id', 'ad', 'ow', 'mv', 'ac'] })).status, 200)
})

after(() => temp.cleanup())

describe('the map image route', () => {
  test('needs a signed-in user', async () => {
    assert.equal((await json('/api/gis/map-image', { market: 'denver-co' }, true)).status, 401)
  })

  test('draws the frame, picks out what the criteria match, and keeps the picture under its own name', async () => {
    const res = await json('/api/gis/map-image', {
      market: 'denver-co', title: 'Over half a million', criteria: 'market=denver-co&vmin=500000',
      state: { center: C, zoom: 16, layerOn: { permits: true }, basemap: 'satellite' },
    })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.match(res.body.path, /^\/api\/map-exports\/\d{8}-[0-9a-f]{32}\.png$/)
    assert.equal(res.body.shown.matches, 1)
    assert.equal(res.body.shown.matchesInFrame, 1)
    assert.ok(tilesAsked > 0, 'the basemap was asked for')
    assert.match(res.body.notes.join(' '), /Satellite basemap cannot be drawn/)

    // The picture opens with no session at all: the name is the permission.
    const file = await call(res.body.path, {}, true)
    assert.equal(file.status, 200)
    assert.equal(file.headers.get('content-type'), 'image/png')
    const image = await decodePng(new Uint8Array(await file.arrayBuffer()))
    assert.equal(image.width, 1000)
    const frame = frameOf({ center: C, zoom: 16, width: 1000, height: 700 })
    const [x, y] = project(C[0], C[1], frame.z)
    const o = (Math.round(y - frame.top) * image.width + Math.round(x - frame.left)) * 4
    assert.ok(image.rgba[o] > 200 && image.rgba[o + 1] < 190, 'the lot over the threshold is red')
  })

  test('a name that was never issued, or has aged out, opens nothing', async () => {
    assert.equal((await call(`/api/map-exports/20260101-${'a'.repeat(32)}.png`, {}, true)).status, 410)
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    assert.equal((await call(`/api/map-exports/${today}-${'b'.repeat(32)}.png`, {}, true)).status, 404)
  })

  test('a market with no published map is refused', async () => {
    assert.equal((await json('/api/gis/map-image', { market: 'nowhere-xx' })).status, 404)
  })
})

describe('the connector\'s tools', () => {
  test('platform_stats sums the live markets and leaves out the rest', async () => {
    const out = await runTool('platform_stats', {}, ctx)
    const stats = out.structuredContent
    assert.equal(stats.markets, 2)
    assert.equal(stats.states, 2)
    assert.equal(stats.parcels, 240485 + 373541)
    assert.equal(stats.totalValue, 589e9)
    assert.equal(stats.byMarket[0].slug, 'austin-tx')
    assert.equal(stats.asOf, '2026-11-13')
  })

  test('export_parcels_geojson returns each match with its real outline', async () => {
    const out = await runTool('export_parcels_geojson', { market: 'denver-co', valueMin: 60000, limit: 10 }, ctx)
    assert.equal(out.isError, undefined, out.content[0].text)
    const collection = out.structuredContent
    assert.equal(collection.type, 'FeatureCollection')
    assert.equal(collection.returned, 2)
    assert.equal(String(collection.features[0].id), '501')
    assert.equal(collection.features[0].geometry.type, 'Polygon')
    assert.equal(collection.features[0].properties.address, '501 Test St')
    assert.equal(collection.features[0].properties.value, 900000)
  })

  test('export_map_image draws a described map and hands back the picture and a link', async () => {
    const out = await runTool('export_map_image', { market: 'denver-co', center: { lat: C[1], lng: C[0] }, zoom: 16, valueMin: 500000, title: 'Described', width: 640, height: 480 }, ctx)
    assert.equal(out.isError, undefined, out.content[0].text)
    assert.match(out.structuredContent.image, /^https:\/\/lq\.test\/api\/map-exports\/\d{8}-[0-9a-f]{32}\.png$/)
    assert.equal(out.structuredContent.width, 640)
    assert.equal(out.structuredContent.shown.matches, 1)
    const picture = out.content.find((part) => part.type === 'image')
    assert.equal(picture.mimeType, 'image/png')
    assert.ok(isPng(bytesOf(picture.data)))
    const linkOnly = await runTool('export_map_image', { market: 'denver-co', center: { lat: C[1], lng: C[0] }, zoom: 16, inline: false }, ctx)
    assert.equal(linkOnly.content.some((part) => part.type === 'image'), false)
  })

  test('export_map_image draws a map saved with make_map, by its name', async () => {
    const made = await runTool('make_map', { market: 'denver-co', name: 'Capitol Hill land', valueMin: 500000, center: { lat: C[1], lng: C[0] }, zoom: 16, pins: [{ lat: C[1], lng: C[0] - 0.003, label: 'Pin' }] }, ctx)
    assert.equal(made.isError, undefined, made.content[0].text)
    const out = await runTool('export_map_image', { market: 'denver-co', map: 'capitol hill LAND' }, ctx)
    assert.equal(out.isError, undefined, out.content[0].text)
    assert.equal(out.structuredContent.shown.matches, 1)
    assert.equal(out.structuredContent.shown.pins, 1)
    const missing = await runTool('export_map_image', { market: 'denver-co', map: 'No such map' }, ctx)
    assert.equal(missing.isError, true)
    assert.match(missing.content[0].text, /Capitol Hill land/)
  })
})

describe('the library', () => {
  let place

  test('a parcel is added once, listed, and found by its place', async () => {
    const made = await json('/api/crm/places', { name: '501 Test St', address: '501 Test St', lat: C[1], lng: C[0], market: 'denver-co', parcelId: '501' })
    assert.equal(made.status, 201)
    place = made.body.record
    assert.equal((await json('/api/library', { placeId: place.id })).status, 201)
    assert.equal((await json('/api/library', { placeId: place.id })).status, 201, 'adding it again is not an error')
    const listed = await json('/api/library')
    assert.equal(listed.body.items.length, 1)
    assert.equal(listed.body.items[0].place.parcelId, '501')
    assert.deepEqual(listed.body.items[0].pieces, [])
    assert.equal((await json(`/api/library?place=${place.id}`)).body.inLibrary, true)
    assert.equal((await json('/api/library', { placeId: 'nothing' })).status, 400)
  })

  test('a parcel map is drawn with the subject picked out, and kept as the parcel\'s piece', async () => {
    const made = await json(`/api/library/${place.id}/pieces`, { kind: 'parcel-map' })
    assert.equal(made.status, 201, JSON.stringify(made.body))
    assert.equal(made.body.piece.title, 'Parcel map')
    assert.match(made.body.piece.path, /^\/api\/map-exports\/\d{8}-[0-9a-f]{32}\.png$/)
    const file = await call(made.body.piece.path, {}, true)
    const image = await decodePng(new Uint8Array(await file.arrayBuffer()))
    assert.equal(image.width, 1200)
    const o = (400 * image.width + 600) * 4
    assert.ok(image.rgba[o] > 200 && image.rgba[o + 1] < 190, 'the subject parcel is red at the centre of the frame')
    const listed = await json('/api/library')
    assert.deepEqual(listed.body.items[0].pieces.map((p) => p.kind), ['parcel-map'])
  })

  test('a location map takes the pins it is handed, and making a piece again replaces it', async () => {
    const first = await json(`/api/library/${place.id}/pieces`, { kind: 'location-map', pins: [{ lat: C[1] + 0.01, lng: C[0], label: 'A landmark' }] })
    assert.equal(first.status, 201, JSON.stringify(first.body))
    const again = await json(`/api/library/${place.id}/pieces`, { kind: 'location-map' })
    assert.notEqual(again.body.piece.path, first.body.piece.path)
    const kinds = (await json('/api/library')).body.items[0].pieces.map((p) => p.kind).sort()
    assert.deepEqual(kinds, ['location-map', 'parcel-map'])
    assert.equal((await json(`/api/library/${place.id}/pieces`, { kind: 'nonsense' })).status, 400)
  })

  test('a parcel taken out of the library takes its pieces with it', async () => {
    const res = await call(`/api/library/${place.id}`, { method: 'DELETE' })
    assert.equal(res.status, 200)
    assert.equal((await json('/api/library')).body.items.length, 0)
    assert.equal((await json(`/api/library/${place.id}/pieces`, { kind: 'parcel-map' })).status, 404)
    assert.equal((await json('/api/library', undefined, true)).status, 401)
  })
})
