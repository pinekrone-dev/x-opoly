import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'

import worker from '../worker/index.js'
import { R2Shim, workerEnv } from './cloudflare-shims.js'

/**
 * A parcel archive served by range from the bucket, through the edge.
 *
 * What is pinned here is the rebuild: a county's archive is replaced whole,
 * and the map goes on reading it a few kilobytes at a time. The ranges the
 * edge kept of the old archive must never be paired with the new one — that
 * pairing is what a reader saw as "county parcels could not be loaded" the
 * night North Jersey grew to six counties.
 */

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

const ctx = { waitUntil: (p) => p, passThroughOnException() {} }
const archive = (fill) => new TextEncoder().encode(fill.repeat(1000))

describe('a parcel archive through the edge', () => {
  let caches
  let env
  let bucket
  before(async () => {
    caches = fakeCaches()
    globalThis.caches = caches
    bucket = new R2Shim()
    env = await workerEnv({ PROSPECTOR_DATA: bucket })
  })
  after(() => {
    delete globalThis.caches
  })

  const read = (range) =>
    worker.fetch(
      new Request('http://localhost/catalog/jersey-city-nj/parcels.pmtiles', { headers: { range } }),
      env,
      ctx,
    )

  test('a range is answered from the bucket with the archive version on it', async () => {
    await bucket.put('jersey-city-nj/parcels.pmtiles', archive('a'))
    const res = await read('bytes=0-15')
    assert.equal(res.status, 206)
    assert.equal(res.headers.get('content-range'), 'bytes 0-15/1000')
    assert.equal(await res.text(), 'a'.repeat(16))
    const first = (await bucket.head('jersey-city-nj/parcels.pmtiles')).httpEtag
    assert.equal(res.headers.get('etag'), first, 'the version travels with every range')
    // Kept under the version, so the key names the archive as well as the range.
    const keys = [...caches.held.keys()]
    assert.ok(keys.some((k) => k.includes('parcels.pmtiles') && k.includes(`v=${encodeURIComponent(first)}`)), keys.join('\n'))
    // A day in the browser is too long for bytes that a rebuild replaces.
    assert.match(res.headers.get('cache-control'), /max-age=300\b/)
  })

  test('a rebuilt archive is read fresh; the old ranges are never paired with it', async () => {
    const before = (await bucket.head('jersey-city-nj/parcels.pmtiles')).httpEtag
    await bucket.put('jersey-city-nj/parcels.pmtiles', archive('b'))
    const after = (await bucket.head('jersey-city-nj/parcels.pmtiles')).httpEtag
    assert.notEqual(before, after)

    // Within the minute the edge still names the old version, and serves the
    // old bytes consistently: the old directory with the old tiles.
    const held = await read('bytes=0-15')
    assert.equal(await held.text(), 'a'.repeat(16))
    assert.equal(held.headers.get('etag'), before)

    // The minute passes: the edge asks the bucket again, sees the new
    // version, and every range is read under it.
    for (const key of [...caches.held.keys()]) if (key.includes('%23version') || key.includes('#version')) caches.held.delete(key)
    const fresh = await read('bytes=0-15')
    assert.equal(await fresh.text(), 'b'.repeat(16))
    assert.equal(fresh.headers.get('etag'), after)
    const again = await read('bytes=0-15')
    assert.equal(await again.text(), 'b'.repeat(16), 'and the fresh range is what the edge now keeps')
  })

  test('an archive that is not there is a 404, not a cached nothing', async () => {
    const res = await worker.fetch(
      new Request('http://localhost/catalog/nowhere-xx/parcels.pmtiles', { headers: { range: 'bytes=0-15' } }),
      env,
      ctx,
    )
    assert.equal(res.status, 404)
  })
})
