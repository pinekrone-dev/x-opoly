/**
 * A market that was never loaded into the database, answered by the API and
 * the connector from its packed files: a parcel opened by id (rows.pack) and
 * found by address, owner or parcel number (search.pack), each a read of a
 * few kilobytes by byte range.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test, { after, before, describe } from 'node:test'
import zlib from 'node:zlib'

import { createServer } from '../server/index.js'
import { useTempData } from './helpers.js'
import { runTool } from '../app/lib/mcp.js'
import { shardOf } from '../src/lib/parcelRows.ts'

const temp = useTempData()
const realFetch = globalThis.fetch
let app
let cookie = null
const asked = []

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url))

// The records behind the search fixture's ids, packed as make_rows.py packs them.
const RECORDS = {
  1: { id: 1, ad: '123 Main St', ow: 'Smith John A', gid: '04-123-0015', mv: 410000, ac: 0.2, at: 'Residential', bb: [-75.5, 39.1, -75.49, 39.11], ma: 'PO Box 9, Dover DE 19901' },
  2: { id: 2, ad: "7707 O'Donnell Ct", ow: 'ACME HOLDINGS LLC', gid: '04-123-0016', mv: 2500000, ac: 3.1, at: 'Retail', bb: [-75.4, 39.2, -75.39, 39.21] },
  3: { id: 3, ad: '', ow: 'Smith, Mary', gid: '05-001-0001', mv: 90000, ac: 12, at: 'Land', bb: [-75.3, 39.3, -75.29, 39.31] },
}
function packRows(records, shards, built = 1700000000) {
  const parts = Array.from({ length: shards }, () => ({}))
  for (const [id, row] of Object.entries(records)) parts[shardOf(id, shards)][id] = row
  const blobs = parts.map((part) => zlib.gzipSync(Buffer.from(JSON.stringify(part))))
  const offsets = [0]
  for (const blob of blobs) offsets.push(offsets[offsets.length - 1] + blob.length)
  return { bytes: Buffer.concat(blobs), manifest: { v: 1, n: Object.keys(records).length, per: 300, shards, offsets, built } }
}
const rows = packRows(RECORDS, 2)
const FILES = {
  // The columns fixture is its own seven parcels (see parcel-cols.test.js),
  // under another market so its ids are not confused with the three above.
  'kent-de/cols.bin': fixture('cols.bin'),
  'kent-de/rows.json': Buffer.from(JSON.stringify(packRows({
    5: { id: 5, ad: '5 Mill Rd', ow: 'Vance Logistics', mv: 5200000, ac: 8.5, at: 'Industrial', bb: [-75.45, 39.15, -75.44, 39.16] },
    2: { id: 2, ad: '2 High St', ow: 'Reyes Holdings', mv: 2500000, ac: 3.1, at: 'Retail', bb: [-75.4, 39.2, -75.39, 39.21] },
    3: { id: 3, ad: '3 Farm Ln', ow: 'Okafor Trust', mv: 90000, ac: 12, at: 'Land', bb: [-75.3, 39.3, -75.29, 39.31] },
  }, 1).manifest)),
  'kent-de/rows.pack': packRows({
    5: { id: 5, ad: '5 Mill Rd', ow: 'Vance Logistics', mv: 5200000, ac: 8.5, at: 'Industrial', bb: [-75.45, 39.15, -75.44, 39.16] },
    2: { id: 2, ad: '2 High St', ow: 'Reyes Holdings', mv: 2500000, ac: 3.1, at: 'Retail', bb: [-75.4, 39.2, -75.39, 39.21] },
    3: { id: 3, ad: '3 Farm Ln', ow: 'Okafor Trust', mv: 90000, ac: 12, at: 'Land', bb: [-75.3, 39.3, -75.29, 39.31] },
  }, 1).bytes,
  'dover-de/rows.json': Buffer.from(JSON.stringify(rows.manifest)),
  'dover-de/rows.pack': rows.bytes,
  'dover-de/search.json': fixture('search.json'),
  'dover-de/search.pack': fixture('search.pack'),
}

const call = async (path, body) => {
  const res = await app.fetch(new Request(`http://localhost${path}`, {
    method: body ? 'POST' : 'GET',
    body: body ? JSON.stringify(body) : undefined,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  }))
  const set = res.headers.get('set-cookie')
  if (set) cookie = set.split(';')[0]
  return { status: res.status, body: await res.json().catch(() => null) }
}

before(async () => {
  globalThis.fetch = async (url, init) => {
    const key = String(url).replace('https://catalogue.test/', '')
    const file = FILES[key]
    if (!file) return new Response('not found', { status: 404 })
    const range = /^bytes=(\d+)-(\d+)$/.exec(init?.headers?.range ?? '')
    asked.push(`${key}${range ? ` ${range[0]}` : ''}`)
    if (!range) return new Response(file, { status: 200 })
    return new Response(file.subarray(Number(range[1]), Number(range[2]) + 1), { status: 206 })
  }
  app = await createServer({ DATA_DIR: temp.directory, DB_FILE: `${temp.directory}/test.db`,
    PARCEL_CATALOG_ORIGIN: 'https://catalogue.test' })
  await call('/api/auth/register', { email: 'files@example.com', password: 'a long enough password', name: 'F' })
})

after(() => {
  globalThis.fetch = realFetch
  return temp.cleanup()
})

describe('a market served from county files', () => {
  test('a parcel opens by id from the packed rows', async () => {
    const res = await call('/api/gis/parcel?market=dover-de&id=2')
    assert.equal(res.status, 200)
    assert.equal(res.body.parcel.ad, "7707 O'Donnell Ct")
    assert.equal(res.body.parcel.mv, 2500000)
    assert.deepEqual(res.body.parcel.bb, [-75.4, 39.2, -75.39, 39.21])
    // One shard by byte range, never the pack whole.
    const packs = asked.filter((a) => a.startsWith('dover-de/rows.pack'))
    assert.equal(packs.length, 1)
    assert.match(packs[0], / bytes=\d+-\d+$/)
  })

  test('a parcel that is in no shard is not found', async () => {
    assert.equal((await call('/api/gis/parcel?market=dover-de&id=999999')).status, 404)
    assert.equal((await call('/api/gis/parcel?market=nowhere-xx&id=1')).status, 404)
  })

  test('the lookup finds a parcel by address, owner or parcel number, with its record', async () => {
    const byAddress = await call('/api/gis/lookup?market=dover-de&q=123%20main')
    assert.equal(byAddress.status, 200)
    assert.equal(byAddress.body.source, 'files')
    assert.deepEqual(byAddress.body.rows.map((row) => row.id), [1])
    assert.equal(byAddress.body.rows[0].ow, 'Smith John A')
    const byOwner = await call('/api/gis/lookup?market=dover-de&q=acme')
    assert.deepEqual(byOwner.body.rows.map((row) => row.id), [2])
    const byNumber = await call('/api/gis/lookup?market=dover-de&q=05-001-0001')
    assert.deepEqual(byNumber.body.rows.map((row) => row.id), [3])
    assert.equal((await call('/api/gis/lookup?market=dover-de&q=zzzz')).body.rows.length, 0)
  })

  test('the lookup needs a user, a market and three characters', async () => {
    const held = cookie
    cookie = null
    assert.equal((await call('/api/gis/lookup?market=dover-de&q=main')).status, 401)
    cookie = held
    assert.equal((await call('/api/gis/lookup?market=dover-de&q=ma')).status, 400)
    assert.equal((await call('/api/gis/lookup?market=Bad%20Slug&q=main')).status, 400)
    assert.equal((await call('/api/gis/lookup?market=nowhere-xx&q=main')).status, 404)
  })

  test('the manifests are read once and held, not once a request', async () => {
    const before = asked.filter((a) => /\.json$/.test(a)).length
    await call('/api/gis/lookup?market=dover-de&q=smith%20mary')
    await call('/api/gis/parcel?market=dover-de&id=1')
    assert.equal(asked.filter((a) => /\.json$/.test(a)).length, before)
  })

  test('a filtered search is answered from the packed columns, in the store\'s shape', async () => {
    const res = await call('/api/gis/parcels?market=kent-de&vmin=1000000&limit=10')
    assert.equal(res.status, 200)
    assert.equal(res.body.ready, true)
    assert.equal(res.body.source, 'files')
    assert.equal(res.body.count, 2)
    assert.equal(res.body.total, 7700000)
    assert.deepEqual(res.body.byAsset, [['Industrial', 1], ['Retail', 1]])
    assert.deepEqual(res.body.ids, ['5', '2'], 'in order of value')
    assert.deepEqual(res.body.rows.map((row) => row.ad), ['5 Mill Rd', '2 High St'])
    const all = await call('/api/gis/parcels?market=kent-de')
    assert.equal(all.body.count, 7)
    assert.equal(all.body.ids, null, 'no highlight list when nothing narrows the market')
    const area = await call('/api/gis/parcels?market=kent-de&circle=39.205,-75.395,0.2')
    assert.deepEqual(area.body.ids, ['2'])
    const held = await call('/api/gis/parcels?market=kent-de&own=outOfState&amin=5')
    assert.deepEqual(held.body.ids, ['5'])
  })

  test('the market says its files can answer, with its own totals', async () => {
    const res = await call('/api/gis/market?market=kent-de')
    assert.equal(res.status, 200)
    assert.equal(res.body.ready, false)
    assert.equal(res.body.files, true)
    assert.equal(res.body.count, 7)
    assert.equal(res.body.total, 8800000)
    assert.deepEqual(res.body.assets[0], { value: 'Residential', count: 3 })
    assert.ok(!res.body.assets.some((a) => a.value === 'Unclassified'))
    assert.equal(res.body.otagged, true)
    // A market with rows and a search index but no columns answers as before.
    const plain = await call('/api/gis/market?market=dover-de')
    assert.equal(plain.body.ready, false)
    assert.equal(plain.body.files, undefined)
  })

  test('the columns are read from storage once, not once a search', async () => {
    const reads = () => asked.filter((a) => a.startsWith('kent-de/cols.bin')).length
    const before = reads()
    await call('/api/gis/parcels?market=kent-de&amin=10')
    await call('/api/gis/parcels?market=kent-de&at=Land')
    assert.equal(reads(), before)
    assert.equal(before, 1)
  })

  test('a filter the columns cannot answer is refused by name, and a market with nothing packed is not ready', async () => {
    const zoning = await call('/api/gis/parcels?market=kent-de&zc=Industrial&vmin=1')
    assert.equal(zoning.status, 400)
    assert.equal(zoning.body.code, 'file_market')
    assert.match(zoning.body.error, /cannot use zoning/)
    const flood = await call('/api/gis/parcels?market=kent-de&flood=in')
    assert.match(flood.body.error, /flood zone/)
    const none = await call('/api/gis/parcels?market=nowhere-xx&vmin=1')
    assert.equal(none.status, 404)
    assert.equal(none.body.ready, false)
  })

  test('text alone on the search route is the search index', async () => {
    const res = await call('/api/gis/parcels?market=dover-de&q=acme')
    assert.equal(res.status, 200)
    assert.equal(res.body.source, 'files')
    assert.equal(res.body.brief, true)
    assert.deepEqual(res.body.rows.map((row) => row.id), [2])
  })

  test('the connector answers a filtered search there and says what the market leaves out', async () => {
    const tool = (name, input) => runTool(name, input, {
      origin: 'http://localhost',
      call: (path, init) => app.fetch(new Request(`http://localhost${path}`, { ...init, headers: { ...(init?.headers ?? {}), cookie } })),
    })
    const found = await tool('search_parcels', { market: 'kent-de', acresMin: 5, valueMin: 50000 })
    assert.notEqual(found.isError, true)
    assert.equal(found.structuredContent.count, 2)
    assert.equal(found.structuredContent.totalValue, 5290000)
    assert.match(found.structuredContent.note, /county files/)
    assert.match(JSON.stringify(found.structuredContent.matches[0]), /5 Mill Rd/)
    const zoned = await tool('search_parcels', { market: 'kent-de', zoning: ['Industrial'] })
    assert.equal(zoned.isError, true)
    assert.match(zoned.content[0].text, /cannot use zoning/)
  })

  test('the connector searches it by text and opens a lot, and says what it cannot do', async () => {
    const tool = (name, input) => runTool(name, input, {
      origin: 'http://localhost',
      call: (path, init) => app.fetch(new Request(`http://localhost${path}`, { ...init, headers: { ...(init?.headers ?? {}), cookie } })),
    })
    const found = await tool('search_parcels', { market: 'dover-de', text: 'acme' })
    assert.notEqual(found.isError, true)
    assert.equal(found.structuredContent.shown, 1)
    assert.match(JSON.stringify(found.structuredContent.matches[0]), /O'Donnell/)
    assert.match(found.structuredContent.note, /county files/)
    const filtered = await tool('search_parcels', { market: 'dover-de', valueMin: 1000000 })
    assert.equal(filtered.isError, true)
    assert.match(filtered.content[0].text, /address, owner name or parcel number/)
    const one = await tool('get_parcel', { market: 'dover-de', id: '3', records: false })
    assert.notEqual(one.isError, true)
    assert.match(JSON.stringify(one.structuredContent.parcel), /Smith, Mary/)
  })
})
