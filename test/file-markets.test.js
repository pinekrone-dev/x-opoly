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
