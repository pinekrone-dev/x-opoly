/**
 * The catalogue, served from this origin.
 *
 * This exists because the browser used to fetch these files cross-origin, and
 * a CORS refusal there reads as `TypeError: Failed to fetch` with no status —
 * so the market list came back empty and the whole map looked broken when the
 * app had simply been told there were no counties. Reading through the app's
 * own origin removes the cross-origin request entirely.
 */
import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'

import { createServer } from '../server/index.js'
import { useTempData } from './helpers.js'

const temp = useTempData()
let app
/** Every address the route reached for, so the key mapping can be read back. */
const asked = []
/** And every Range it carried, which is what makes the tiles readable. */
const ranges = []
const realFetch = globalThis.fetch

before(async () => {
  // No bucket here, so the route fetches the public file through — the path a
  // deployment without the binding takes. Standing in for that origin is what
  // turns "did not 404" into "asked for exactly this file".
  globalThis.fetch = async (url, init = {}) => {
    asked.push(String(url))
    const range = init.headers?.range
    if (!range) {
      return new Response('{"markets":[]}', {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    ranges.push(range)
    const [, from, to] = /^bytes=(\d+)-(\d*)$/.exec(range)
    const end = to === '' ? 999 : Number(to)
    return new Response('x'.repeat(end - Number(from) + 1), {
      status: 206,
      headers: { 'content-range': `bytes ${from}-${end}/1000` },
    })
  }
  app = await createServer({
    DATA_DIR: temp.directory,
    DB_FILE: `${temp.directory}/test.db`,
    PARCEL_CATALOG_ORIGIN: 'https://catalogue.test',
  })
})

after(() => {
  globalThis.fetch = realFetch
  return temp.cleanup()
})

const get = (path) => app.fetch(new Request(`http://localhost${path}`))

describe('the catalogue route', () => {
  test('a market file is addressed by slug and allowlisted name', async () => {
    asked.length = 0
    const res = await get('/catalog/austin-tx/meta.json')
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'application/json')
    // The key, not merely the outcome: a route that answered 200 from the
    // wrong object would pass a status check and serve the wrong county.
    assert.deepEqual(asked, ['https://catalogue.test/austin-tx/meta.json'])
  })

  test('a published layer is reachable without being named in advance', async () => {
    asked.length = 0
    assert.equal((await get('/catalog/austin-tx/layer-zoning.geojson')).status, 200)
    assert.deepEqual(asked, ['https://catalogue.test/austin-tx/layer-zoning.geojson'])
  })

  test('a name outside the allowlist is refused', async () => {
    const res = await get('/catalog/austin-tx/secrets.json')
    assert.equal(res.status, 404)
  })

  test('a market that is not a slug cannot address anything', async () => {
    assert.equal((await get('/catalog/..%2F..%2Fetc/meta.json')).status, 404)
    assert.equal((await get('/catalog/AUSTIN/meta.json')).status, 404)
  })

  test('nothing deeper than a market can be reached', async () => {
    assert.equal((await get('/catalog/austin-tx/nested/meta.json')).status, 404)
  })

  test('the root holds only the market list', async () => {
    asked.length = 0
    assert.equal((await get('/catalog/markets.json')).status, 200)
    assert.deepEqual(asked, ['https://catalogue.test/markets.json'])
    // A market file has no meaning at the root and must not be fetched there.
    asked.length = 0
    assert.equal((await get('/catalog/owners.json')).status, 404)
    assert.deepEqual(asked, [], 'a refused name never reaches the origin')
  })

  /*
   * Byte ranges, because a pmtiles archive is read that way.
   *
   * The map seeks a directory and then the one tile under the viewport — a
   * few kilobytes out of hundreds of megabytes. A route that ignored Range
   * and answered with the whole file would still look correct in a browser,
   * and would turn every map open back into downloading a county, which is
   * the download this whole change exists to remove.
   */
  test('a range is carried through and answered as one', async () => {
    asked.length = 0
    ranges.length = 0
    const res = await app.fetch(new Request('http://localhost/catalog/austin-tx/parcels.pmtiles', {
      headers: { range: 'bytes=100-199' },
    }))
    assert.equal(res.status, 206, 'a ranged ask must not be answered with the whole file')
    assert.equal(res.headers.get('content-range'), 'bytes 100-199/1000')
    assert.deepEqual(ranges, ['bytes=100-199'], 'the range reached the origin unchanged')
  })

  test('an open-ended range is carried through too', async () => {
    ranges.length = 0
    const res = await app.fetch(new Request('http://localhost/catalog/austin-tx/parcels.pmtiles', {
      headers: { range: 'bytes=900-' },
    }))
    assert.equal(res.status, 206)
    assert.deepEqual(ranges, ['bytes=900-'])
  })

  test('an unranged ask still says it would accept one', async () => {
    const res = await get('/catalog/austin-tx/parcels.pmtiles')
    assert.equal(res.status, 200)
    // A client decides whether to ask for a range by reading this off a plain
    // response first, so it has to be on every answer rather than only on 206s.
    assert.equal(res.headers.get('accept-ranges'), 'bytes')
  })

  test('a refused address never becomes a request', async () => {
    asked.length = 0
    await get('/catalog/austin-tx/secrets.json')
    await get('/catalog/../../etc/passwd')
    await get('/catalog/austin-tx/nested/meta.json')
    assert.deepEqual(asked, [])
  })

  test('it needs no session, because it is public county data', async () => {
    // The gate covers /api/* only, so this must not be answered with a 401.
    const res = await get('/catalog/markets.json')
    assert.notEqual(res.status, 401)
  })
})
