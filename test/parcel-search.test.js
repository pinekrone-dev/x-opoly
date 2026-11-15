/**
 * A search without the county: the search index (search.pack, search.json)
 * that the pipeline's make_search.py writes, read by byte range through the
 * catalogue. The fixture is a pack that make_search.py itself wrote, so the
 * key and the title-casing here are held to the pipeline's.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test, { after, before, describe } from 'node:test'

import worker from '../worker/index.js'
import { R2Shim, workerEnv } from './cloudflare-shims.js'
import { firstShard, hitOf, keyOf, readSearchManifest, searchPack, validSearchManifest } from '../src/lib/parcelSearch.ts'

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
const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url))

describe('the search index', () => {
  let env
  let manifest
  const asked = []
  const fetcher = (url, init) => {
    asked.push({ url, range: init?.headers?.range ?? null })
    return worker.fetch(new Request(`http://localhost${url}`, init), env, ctx)
  }
  const find = async (text, limit = 8) => (await searchPack('/catalog', 'test-xx', manifest, text, limit, fetcher)).map((hit) => hit.id)

  before(async () => {
    globalThis.caches = fakeCaches()
    const bucket = new R2Shim()
    env = await workerEnv({ PROSPECTOR_DATA: bucket })
    await bucket.put('test-xx/search.pack', fixture('search.pack'))
    await bucket.put('test-xx/search.json', fixture('search.json'))
    manifest = await readSearchManifest('/catalog', 'test-xx', fetcher)
  })
  after(() => {
    delete globalThis.caches
  })

  test('a key is letters, digits and single spaces', () => {
    assert.equal(keyOf("  7707 o'donnell   ct. "), '7707 O DONNELL CT')
    assert.equal(keyOf(''), '')
  })

  test('the list is read and held to its shape', () => {
    assert.ok(manifest)
    assert.equal(manifest.keys.length, manifest.shards)
    assert.equal(validSearchManifest({ ...manifest, keys: manifest.keys.slice(1) }), null)
    assert.equal(validSearchManifest({ ...manifest, offsets: [0] }), null)
    assert.equal(validSearchManifest(null), null)
  })

  test('an address is found from its number and from its street', async () => {
    assert.deepEqual(await find('123 main'), [1])
    assert.deepEqual(await find('Main St'), [1])
    assert.deepEqual(await find("o'donnell"), [2])
  })

  test('an owner is found from any of its first words, not from LLC', async () => {
    assert.deepEqual(await find('smith john'), [1])
    assert.deepEqual(await find('john a'), [1])
    assert.deepEqual((await find('smith')).sort(), [1, 3])
    assert.deepEqual(await find('acme'), [2])
    assert.deepEqual(await find('llc'), [])
  })

  test('a parcel number is found with or without its dashes', async () => {
    assert.deepEqual(await find('04-123-0015'), [1])
    assert.deepEqual(await find('041230015'), [1])
    assert.deepEqual(await find('a-12 b'), ['A-12 B'])
  })

  test('a hit reads as the county wrote it', async () => {
    const [plain] = await searchPack('/catalog', 'test-xx', manifest, '123 main', 1, fetcher)
    assert.deepEqual(plain, { id: 1, kind: 'address', label: '123 Main St', under: '' })
    const [street] = await searchPack('/catalog', 'test-xx', manifest, 'main st', 1, fetcher)
    assert.equal(street.label, '123 Main St')
    const [kept] = await searchPack('/catalog', 'test-xx', manifest, '7707', 1, fetcher)
    assert.equal(kept.label, "7707 O'Donnell Ct")
    const [owner] = await searchPack('/catalog', 'test-xx', manifest, 'john a', 1, fetcher)
    assert.deepEqual(owner, { id: 1, kind: 'owner', label: 'Smith John A', under: '123 Main St' })
    const [number] = await searchPack('/catalog', 'test-xx', manifest, '05-001', 1, fetcher)
    assert.deepEqual(number, { id: 3, kind: 'number', label: '05-001-0001', under: '' })
    assert.equal(hitOf(['NE 5TH AVE', 9, 'a0', 'NE 5th Ave']).label, 'NE 5th Ave')
  })

  test('a search reads a shard by byte range, and one more letter reads nothing new', async () => {
    // Every read so far was a byte range of the pack under its build's stamp.
    const shards = asked.filter((a) => a.url.includes('search.pack'))
    assert.ok(shards.length >= 1)
    for (const read of shards) {
      assert.match(read.url, /\/catalog\/test-xx\/search\.pack\?v=1700000000$/)
      assert.match(read.range, /^bytes=\d+-\d+$/)
    }
    asked.length = 0
    await find('oak ave 1')
    const first = asked.length
    // One shard, or two where the matches start at a shard's end; none if an
    // earlier search already read it.
    assert.ok(first <= 2, `read ${first} shards`)
    await find('oak ave 12')
    assert.equal(asked.length, first)
  })

  test('a search that crosses a shard reads on, within its reach', async () => {
    assert.equal((await find('owner', 500)).length > 300, true)
    assert.equal(firstShard(manifest, ''), 0)
    assert.equal(firstShard(manifest, 'ZZZZ'), manifest.shards - 1)
  })

  test('the catalogue serves the list for minutes and a shard for a day', async () => {
    const list = await fetcher('/catalog/test-xx/search.json')
    assert.equal(list.status, 200)
    assert.match(list.headers.get('cache-control'), /max-age=300$/)
    const shard = await fetcher('/catalog/test-xx/search.pack?v=1', { headers: { range: 'bytes=0-9' } })
    assert.equal(shard.status, 206)
    assert.match(shard.headers.get('cache-control'), /max-age=86400$/)
  })

  test('a market without the index says so', async () => {
    assert.equal(await readSearchManifest('/catalog', 'test-yy', fetcher), null)
    assert.deepEqual(await find(''), [])
  })
})
