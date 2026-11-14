/**
 * One parcel read without the county: the packed rows (rows.pack, rows.json)
 * that the pipeline's make_rows.py writes, read by byte range through the
 * catalogue the way the map reads them on a click.
 */
import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'
import zlib from 'node:zlib'

import worker from '../worker/index.js'
import { R2Shim, workerEnv } from './cloudflare-shims.js'
import { readManifest, readRow, shardOf, validManifest } from '../src/lib/parcelRows.ts'

function fakeCaches() {
  const held = new Map()
  return {
    held,
    default: {
      match: async (key) => held.get(key.url)?.clone(),
      put: async (key, response) => {
        held.set(key.url, response)
      },
    },
  }
}
const ctx = { waitUntil: (p) => p, passThroughOnException() {} }

/** A pack as make_rows.py lays it out: gzipped shards end to end, and where each starts. */
function pack(records, shards, built = 1700000000) {
  const parts = Array.from({ length: shards }, () => ({}))
  for (const [id, row] of Object.entries(records)) parts[shardOf(id, shards)][id] = row
  const blobs = parts.map((part) => zlib.gzipSync(Buffer.from(JSON.stringify(part))))
  const offsets = [0]
  for (const blob of blobs) offsets.push(offsets[offsets.length - 1] + blob.length)
  return { bytes: Buffer.concat(blobs), manifest: { v: 1, n: Object.keys(records).length, per: 300, shards, offsets, built, breaks: [1, 2, 3, 4, 5, 6] } }
}

describe('packed parcel rows', () => {
  let env
  let bucket
  const asked = []
  const fetcher = (url, init) => {
    asked.push({ url, range: init?.headers?.range ?? null })
    return worker.fetch(new Request(`http://localhost${url}`, init), env, ctx)
  }
  const records = {}
  for (let i = 0; i < 900; i += 1) records[String(1000 + i * 7)] = { id: 1000 + i * 7, ad: `${i} Main St`, mv: i * 1000, bb: [-97 - i, 30, -96.9 - i, 30.1], ma: `PO Box ${i}` }
  records['A-12 B'] = { id: 'A-12 B', ad: 'Rural Route 2', lg: 'Lot "7", Block é' }

  before(async () => {
    globalThis.caches = fakeCaches()
    bucket = new R2Shim()
    env = await workerEnv({ PROSPECTOR_DATA: bucket })
    const made = pack(records, 4)
    await bucket.put('test-xx/rows.pack', made.bytes)
    await bucket.put('test-xx/rows.json', new TextEncoder().encode(JSON.stringify(made.manifest)))
  })
  after(() => {
    delete globalThis.caches
  })

  test('the hash is the one the pipeline computes', () => {
    // make_rows.shard_of('1000', 2**32) and of a Florida parcel id, pinned in prospector's tests too.
    assert.equal(shardOf('1000', 2 ** 32), 1507423)
    assert.equal(shardOf(1000, 97), 1507423 % 97)
    assert.equal(shardOf('3263 37 00095980000100', 2 ** 32), 2807283102)
  })

  test('a parcel is read as one shard by byte range, never the pack whole', async () => {
    const manifest = await readManifest('/catalog', 'test-xx', fetcher)
    assert.equal(manifest.shards, 4)
    asked.length = 0
    const row = await readRow('/catalog', 'test-xx', manifest, 1070, fetcher)
    assert.equal(row.ad, '10 Main St')
    assert.equal(row.ma, 'PO Box 10')
    assert.deepEqual(row.bb, [-107, 30, -106.9, 30.1])
    assert.equal(asked.length, 1)
    assert.match(asked[0].url, /\/catalog\/test-xx\/rows\.pack\?v=1700000000$/)
    const shard = shardOf(1070, 4)
    assert.equal(asked[0].range, `bytes=${manifest.offsets[shard]}-${manifest.offsets[shard + 1] - 1}`)

    // A parcel id that is not a number, and text the JSON has to carry whole.
    assert.equal((await readRow('/catalog', 'test-xx', manifest, 'A-12 B', fetcher)).lg, 'Lot "7", Block é')
    // The same shard again asks nothing.
    const before = asked.length
    await readRow('/catalog', 'test-xx', manifest, 1070, fetcher)
    assert.equal(asked.length, before)
    // A parcel the pack does not hold.
    assert.equal(await readRow('/catalog', 'test-xx', manifest, 'no-such-parcel', fetcher), null)
  })

  test('the manifest is kept for minutes and a shard for the day', async () => {
    const list = await fetcher('/catalog/test-xx/rows.json')
    // Answered from the edge's copy by now, and still under the file's own
    // header rather than the edge's "public, s-maxage": a browser that got
    // the edge's header kept nothing and asked again on every visit.
    assert.equal(list.headers.get('x-edge-cache'), 'hit')
    assert.match(list.headers.get('cache-control'), /^private, max-age=300$/)
    const shard = await fetcher('/catalog/test-xx/rows.pack?v=1', { headers: { range: 'bytes=0-9' } })
    assert.equal(shard.status, 206)
    assert.match(shard.headers.get('cache-control'), /max-age=86400$/)
  })

  test('a market published before the pack existed has no manifest', async () => {
    assert.equal(await readManifest('/catalog', 'nowhere-xx', fetcher), null)
    assert.equal(validManifest({ shards: 2, offsets: [0, 5] }), null)
    assert.equal(validManifest({ shards: 2, offsets: [0, 9, 5] }), null)
    assert.ok(validManifest({ shards: 2, offsets: [0, 5, 9], built: 1 }))
  })
})
