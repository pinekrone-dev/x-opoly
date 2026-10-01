/**
 * Keeping the county data from being carried off whole.
 *
 * Two doors are pinned here. The catalogue (tiles, the county index, owners)
 * answers only a signed-in account, apart from the market list and each
 * market's summary, which the marketing pages show. And the parcel search,
 * card and Ask count the rows they serve against a daily allowance per
 * workspace, so a script paging a county to the end is stopped while a
 * person working a market never notices.
 */

import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import worker from '../worker/index.js'
import { R2Shim, workerEnv } from './cloudflare-shims.js'
import { createServer } from '../server/index.js'
import { putParcels, sealMarket, forgetParcelSchema } from '../app/lib/parcels.js'
import { nodeAdapter } from '../app/lib/sql.js'
import { createUser } from '../app/lib/auth.js'
import { generateKeyPairSync, createSign } from 'node:crypto'
import { resetKeyCache } from '../app/lib/oidc.js'

// A GitHub Actions token, signed by a key the test hands the app as GitHub's.
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' }
const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url')
function actionsToken(repository = 'pinekrone-dev/prospector') {
  const now = Math.floor(Date.now() / 1000)
  const head = b64url({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })
  const body = b64url({ iss: 'https://token.actions.githubusercontent.com', aud: 'landquotient-ingest', repository, exp: now + 300, nbf: now - 30 })
  const signer = createSign('RSA-SHA256')
  signer.update(`${head}.${body}`)
  return `${head}.${body}.${signer.sign(privateKey).toString('base64url')}`
}
const JWKS_FETCH = async () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'content-type': 'application/json' } })
import { useTempData } from './helpers.js'

const ctx = { waitUntil: (p) => p, passThroughOnException() {} }

describe('the catalogue behind sign-in', () => {
  let env
  let cookie
  before(async () => {
    const bucket = new R2Shim()
    await bucket.put('markets.json', JSON.stringify({ markets: [] }))
    await bucket.put('austin-tx/meta.json', JSON.stringify({ name: 'Austin' }))
    await bucket.put('austin-tx/index.json', JSON.stringify({ n: 1 }))
    await bucket.put('austin-tx/owners.json', JSON.stringify({ p: {} }))
    await bucket.put('austin-tx/parcels.pmtiles', new TextEncoder().encode('x'.repeat(2000)))
    env = await workerEnv({ PROSPECTOR_DATA: bucket, JWKS_FETCH })
    resetKeyCache()
    // The first account claims the instance; after that the catalogue is closed.
    const joined = await worker.fetch(
      new Request('http://localhost/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'owner@example.com', password: 'a long enough password', name: 'Owner' }),
      }),
      env,
      ctx,
    )
    cookie = (joined.headers.get('set-cookie') || '').split(';')[0]
    assert.ok(cookie, 'the first account is signed in on registering')
  })

  const read = (path, headers = {}) => worker.fetch(new Request(`http://localhost/catalog/${path}`, { headers }), env, ctx)

  test('the market list and a market summary stay public', async () => {
    assert.equal((await read('markets.json')).status, 200)
    const meta = await read('austin-tx/meta.json')
    assert.equal(meta.status, 200)
    assert.equal(meta.headers.get('access-control-allow-origin'), '*')
  })

  test('the county itself needs an account', async () => {
    for (const path of ['austin-tx/index.json', 'austin-tx/owners.json', 'austin-tx/parcels.pmtiles']) {
      assert.equal((await read(path)).status, 401, `${path} is closed to a stranger`)
    }
    assert.equal((await read('austin-tx/parcels.pmtiles', { range: 'bytes=0-99' })).status, 401, 'ranges too')
    assert.equal((await read('austin-tx/lite/14/3740/6800.json')).status, 401, 'and the lite tiles')
  })

  test('a signed-in account reads it, privately', async () => {
    const index = await read('austin-tx/index.json', { cookie })
    assert.equal(index.status, 200)
    assert.match(index.headers.get('cache-control'), /^private/)
    assert.equal(index.headers.get('access-control-allow-origin'), null)
    assert.equal((await read('austin-tx/parcels.pmtiles', { cookie, range: 'bytes=0-99' })).status, 206)
  })

  test('the data pipeline reads with its GitHub Actions token; a forged one is refused', async () => {
    const piped = await read('austin-tx/owners.json', { authorization: `Bearer ${actionsToken()}` })
    assert.equal(piped.status, 200)
    const stranger = await read('austin-tx/owners.json', { authorization: `Bearer ${actionsToken('someone/else')}` })
    assert.equal(stranger.status, 401, 'a token from another repository is not the pipeline')
    assert.equal((await read('austin-tx/owners.json', { authorization: 'Bearer nonsense' })).status, 401)
  })

  test('a whole county file is downloaded a handful of times an hour, not on a loop', async () => {
    let refused = 0
    for (let i = 0; i < 10; i++) {
      if ((await read('austin-tx/index.json', { cookie })).status === 429) refused += 1
    }
    assert.ok(refused >= 4, `downloads past the hourly few are refused (${refused} refused)`)
  })
})

describe('a daily allowance of parcel rows per workspace', () => {
  const temp = useTempData()
  let app
  let cookie

  before(async () => {
    forgetParcelSchema()
    const db = nodeAdapter(new DatabaseSync(`${temp.directory}/test.db`))
    await db.migrate()
    await putParcels(
      db,
      'austin-tx',
      Array.from({ length: 30 }, (_, i) => ({ id: i + 1, ad: `${i + 1} Main St`, mv: 100000 + i, ac: 1, bb: [-97.7, 30.2, -97.69, 30.21] })),
    )
    await sealMarket(db, 'austin-tx', { keys: ['id', 'ad', 'mv', 'ac'] })
    forgetParcelSchema()
    // The first account is the operator and is never counted, so the
    // allowance is tested on a second workspace.
    app = await createServer({
      DATA_DIR: temp.directory,
      DB_FILE: `${temp.directory}/test.db`,
      PARCEL_ROW_BUDGET: '25',
    })
    const register = async (email) => {
      const response = await app.fetch(
        new Request('http://localhost/api/auth/register', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password: 'a long enough password', name: 'Someone' }),
        }),
      )
      return (response.headers.get('set-cookie') || '').split(';')[0]
    }
    await register('operator@example.com')
    // A second workspace of its own, made the way an operator would by hand.
    const raw = nodeAdapter(new DatabaseSync(`${temp.directory}/test.db`))
    await createUser(raw, { email: 'scraper@example.com', password: 'a long enough password', name: 'Scraper' })
    const login = await app.fetch(
      new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'scraper@example.com', password: 'a long enough password' }),
      }),
    )
    cookie = (login.headers.get('set-cookie') || '').split(';')[0]
  })

  after(() => temp.cleanup())

  const search = (offset) =>
    app.fetch(new Request(`http://localhost/api/gis/parcels?market=austin-tx&limit=10&offset=${offset}`, { headers: { cookie } }))

  test('pages are served until the day is spent, then refused with the reason', async () => {
    assert.ok(cookie, 'the second account is signed in')
    assert.equal((await search(0)).status, 200)
    assert.equal((await search(10)).status, 200)
    const third = await search(20)
    assert.equal(third.status, 429, '30 rows asked against an allowance of 25')
    const body = await third.json()
    assert.equal(body.code, 'row_budget')
    assert.match(body.error, /resets at midnight UTC/)
    const card = await app.fetch(new Request('http://localhost/api/gis/parcel?market=austin-tx&id=1', { headers: { cookie } }))
    assert.equal(card.status, 429, 'and a card counts too')
  })
})
