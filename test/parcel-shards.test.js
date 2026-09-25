/**
 * Several parcel stores, one door.
 *
 * One D1 holds about twelve million parcels before it is full, and the
 * twenty largest metros hold more than that between them. So a market may be
 * assigned to a further store by name, and the assignment must be invisible
 * from outside: the publisher addresses a market, the app answers for it, and
 * the rows land on the shelf the setting names. A market assigned to a shelf
 * the deployment does not have is refused rather than quietly filed in the
 * first store, which is the store that is already full.
 */

import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'
import { createSign, generateKeyPairSync } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

import { createApp } from '../app/routes.js'
import { resetKeyCache } from '../app/lib/oidc.js'
import { forgetParcelSchema, parcelStores, parseShards, readyMarketsAcross } from '../app/lib/parcels.js'
import { nodeAdapter } from '../app/lib/sql.js'
import { diskStorage } from '../app/lib/storage.js'
import { useTempData } from './helpers.js'

const temp = useTempData()

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' }
const b64url = (input) =>
  Buffer.from(typeof input === 'string' ? input : JSON.stringify(input)).toString('base64url')

function sign() {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })
  const payload = b64url({
    iss: 'https://token.actions.githubusercontent.com',
    aud: 'landquotient-ingest',
    repository: 'pinekrone-dev/prospector',
    exp: now + 300,
    nbf: now - 30,
  })
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${payload}`)
  return `${header}.${payload}.${signer.sign(privateKey).toString('base64url')}`
}

const jwks = async () =>
  new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'content-type': 'application/json' } })

const ROWS = [
  { id: 1, ad: '1 Main St', ow: 'Alder Holdings', at: 'Office', mv: 900000, ac: 0.4, bb: [-118.3, 34.0, -118.29, 34.01] },
  { id: 2, ad: '2 Main St', ow: 'Birch Partners', at: 'Retail', mv: 400000, ac: 0.2, bb: [-118.3, 34.0, -118.29, 34.01] },
]

describe('the setting', () => {
  test('reads market=BINDING pairs and skips anything that is not one', () => {
    assert.deepEqual(parseShards('los-angeles-ca=PARCELS_2, cook-il=PARCELS_2 ,,bad entry,x=lower'), {
      'los-angeles-ca': 'PARCELS_2',
      'cook-il': 'PARCELS_2',
    })
    assert.deepEqual(parseShards(undefined), {})
  })

  test('an unnamed market lives in the first store; a named one in its shard; an unbound one refuses', async () => {
    const primary = nodeAdapter(new DatabaseSync(':memory:'))
    const two = nodeAdapter(new DatabaseSync(':memory:'))
    const stores = parcelStores({
      primary,
      shards: { PARCELS_2: two },
      map: parseShards('far-zz=PARCELS_2,lost-zz=PARCELS_9'),
    })
    assert.equal(stores.storeFor('austin-tx'), primary)
    assert.equal(stores.storeFor('far-zz'), two)
    assert.deepEqual(stores.all, [primary, two])
    await assert.rejects(() => stores.storeFor('lost-zz').all('SELECT 1'), /PARCELS_9, which this deployment does not bind/)
    assert.deepEqual(await readyMarketsAcross(stores.all), [])
  })
})

describe('publishing into a shard', () => {
  let app, primary, two, call, cookie
  const ingest = (query, body) =>
    app.fetch(
      new Request(`http://localhost/api/gis/ingest/parcels?${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${sign()}` },
        body: JSON.stringify(body),
      }),
    )

  before(async () => {
    resetKeyCache()
    forgetParcelSchema()
    primary = nodeAdapter(new DatabaseSync(':memory:'))
    await primary.migrate()
    two = nodeAdapter(new DatabaseSync(':memory:'))
    app = createApp({
      db: primary,
      storage: await diskStorage(`${temp.directory}/uploads`),
      env: { JWKS_FETCH: jwks, PARCEL_SHARDS: 'far-zz=PARCELS_2,lost-zz=PARCELS_9' },
      parcelShards: { PARCELS_2: two },
    })
    const registered = await app.fetch(
      new Request('http://localhost/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'broker@example.com', password: 'a long enough password', name: 'Broker' }),
      }),
    )
    cookie = registered.headers.get('set-cookie').split(';')[0]
    call = async (path) => {
      const response = await app.fetch(new Request(`http://localhost${path}`, { headers: { cookie } }))
      return { status: response.status, body: await response.json() }
    }
  })

  after(() => temp.cleanup())

  test('rows for a sharded market land in the shard and nowhere else, and the market answers', async () => {
    assert.equal((await ingest('market=far-zz&action=rows', ROWS)).status, 200)
    assert.equal((await ingest('market=far-zz&action=seal', { keys: ['id', 'ad', 'ow', 'mv', 'ac'] })).status, 200)
    assert.equal((await ingest('market=near-zz&action=rows', ROWS.slice(0, 1))).status, 200)
    assert.equal((await ingest('market=near-zz&action=seal', { keys: ['id', 'ad', 'ow', 'mv', 'ac'] })).status, 200)

    assert.equal((await two.get("SELECT count(*) AS n FROM parcels WHERE market = 'far-zz'")).n, 2)
    assert.equal((await primary.get("SELECT count(*) AS n FROM parcels WHERE market = 'far-zz'")).n, 0)
    assert.equal((await primary.get("SELECT count(*) AS n FROM parcels WHERE market = 'near-zz'")).n, 1)

    const markets = await call('/api/gis/markets')
    assert.deepEqual(markets.body.ready, ['far-zz', 'near-zz'])

    const market = await call('/api/gis/market?market=far-zz')
    assert.equal(market.body.ready, true)
    assert.equal(market.body.count, 2)

    const found = await call('/api/gis/parcels?market=far-zz&at=Retail')
    assert.equal(found.status, 200)
    assert.equal(found.body.count, 1)
    assert.equal(found.body.rows[0].ow, 'Birch Partners')
  })

  test('a market assigned to a store this deployment lacks is refused, not filed in the first store', async () => {
    const res = await ingest('market=lost-zz&action=rows', ROWS)
    assert.equal(res.status, 500)
    assert.match((await res.json()).error, /PARCELS_9, which this deployment does not bind/)
    assert.equal((await primary.get("SELECT count(*) AS n FROM parcels WHERE market = 'lost-zz'")).n, 0)
    const market = await call('/api/gis/market?market=lost-zz')
    assert.equal(market.body.ready, false)
  })
})
