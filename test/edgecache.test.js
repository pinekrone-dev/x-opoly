import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'

import { edgeCached, edgeKey } from '../app/lib/edgecache.js'

/** A Cache API in miniature: a map from key URL to stored response. */
function fakeCaches() {
  const held = new Map()
  return {
    held,
    default: {
      match: async (key) => {
        const found = held.get(key.url)
        return found ? found.clone() : undefined
      },
      put: async (key, response) => {
        held.set(key.url, response)
      },
    },
  }
}

const context = (url) => ({ req: { url }, executionCtx: { waitUntil: () => {} } })

describe('answers kept at the edge', () => {
  let caches
  before(() => {
    caches = fakeCaches()
    globalThis.caches = caches
  })
  after(() => {
    delete globalThis.caches
  })

  test('the key is the question, with its parameters in one order', () => {
    const a = edgeKey('https://x.test/api?b=2&a=1', 'parcels/austin-tx', { b: '2', a: '1' })
    const b = edgeKey('https://x.test/api?a=1&b=2', 'parcels/austin-tx', { a: '1', b: '2' })
    assert.equal(a.url, b.url)
    assert.equal(a.url, 'https://x.test/__edge/parcels/austin-tx?a=1&b=2')
    const c = edgeKey('https://x.test/api', 'parcels/austin-tx', { a: '', b: null })
    assert.equal(c.url, 'https://x.test/__edge/parcels/austin-tx', 'blank parameters are no parameters')
  })

  test('the first answer is produced and the second comes from the edge', async () => {
    let produced = 0
    const produce = async () => {
      produced += 1
      return new Response(JSON.stringify({ n: produced }), { headers: { 'content-type': 'application/json' } })
    }
    const c = context('https://x.test/api/gis/parcels?market=austin-tx&q=main')
    const first = await edgeCached(c, 'parcels/austin-tx', 60, produce)
    assert.equal(first.headers.get('x-edge-cache'), 'miss')
    assert.deepEqual(await first.json(), { n: 1 })
    const second = await edgeCached(c, 'parcels/austin-tx', 60, produce)
    assert.equal(second.headers.get('x-edge-cache'), 'hit')
    assert.deepEqual(await second.json(), { n: 1 }, 'the same answer, not a second production')
    assert.equal(produced, 1)
    const stored = caches.held.get('https://x.test/__edge/parcels/austin-tx?market=austin-tx&q=main')
    assert.equal(stored.headers.get('cache-control'), 'public, s-maxage=60')
  })

  test('a different question is a different entry', async () => {
    let produced = 0
    const produce = async () => {
      produced += 1
      return new Response('{}', { headers: { 'content-type': 'application/json' } })
    }
    await edgeCached(context('https://x.test/api?market=austin-tx&q=main'), 'parcels/austin-tx', 60, produce)
    await edgeCached(context('https://x.test/api?market=austin-tx&q=elm'), 'parcels/austin-tx', 60, produce)
    assert.equal(produced, 1, 'the first question was already held')
  })

  test('an error is a moment, not an answer', async () => {
    let produced = 0
    const produce = async () => {
      produced += 1
      return new Response('{"error":"no"}', { status: 500 })
    }
    const c = context('https://x.test/api?market=broken-zz')
    await edgeCached(c, 'parcels/broken-zz', 60, produce)
    await edgeCached(c, 'parcels/broken-zz', 60, produce)
    assert.equal(produced, 2)
  })

  test('a byte range is its own entry, and a cookie never reaches the edge', async () => {
    const produce = async () =>
      new Response('bytes', { status: 206, headers: { 'content-range': 'bytes 0-4/100', 'set-cookie': 'a=b' } })
    const c = context('https://x.test/catalog/austin-tx/parcels.pmtiles')
    await edgeCached(c, 'catalog/austin-tx/parcels.pmtiles', 60, produce, { params: { range: 'bytes=0-4' } })
    const stored = caches.held.get('https://x.test/__edge/catalog/austin-tx/parcels.pmtiles?range=bytes%3D0-4')
    assert.ok(stored, 'stored under the range')
    assert.equal(stored.headers.get('set-cookie'), null)
    assert.equal(stored.status, 206)
  })

  test('without a cache, every call produces', async () => {
    delete globalThis.caches
    let produced = 0
    const produce = async () => {
      produced += 1
      return new Response('{}')
    }
    const c = context('https://x.test/api?market=austin-tx')
    await edgeCached(c, 'parcels/austin-tx', 60, produce)
    await edgeCached(c, 'parcels/austin-tx', 60, produce)
    assert.equal(produced, 2)
    globalThis.caches = caches
  })
})
