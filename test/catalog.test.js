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
const realFetch = globalThis.fetch

before(async () => {
  // No bucket here, so the route fetches the public file through — the path a
  // deployment without the binding takes. Standing in for that origin is what
  // turns "did not 404" into "asked for exactly this file".
  globalThis.fetch = async (url) => {
    asked.push(String(url))
    return new Response('{"markets":[]}', {
      status: 200, headers: { 'content-type': 'application/json' },
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
