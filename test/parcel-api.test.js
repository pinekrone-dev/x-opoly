/**
 * The parcel endpoints, from the outside.
 *
 * Two things matter here beyond the query itself. That publishing a county
 * goes through the same proof as the file ingest — a run in one of two
 * repositories, nothing else — and that a market only becomes answerable once
 * its rebuild seals it, so a run that dies halfway leaves the app on the
 * published index rather than on half a county.
 */

import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'
import { createSign, generateKeyPairSync } from 'node:crypto'

import { resetKeyCache } from '../app/lib/oidc.js'
import { createServer } from '../server/index.js'
import { useTempData } from './helpers.js'

const temp = useTempData()
let app

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' }
const b64url = (input) =>
  Buffer.from(typeof input === 'string' ? input : JSON.stringify(input)).toString('base64url')

function sign(overrides = {}) {
  const now = Math.floor(Date.now() / 1000)
  const claims = {
    iss: 'https://token.actions.githubusercontent.com',
    aud: 'landquotient-ingest',
    repository: 'pinekrone-dev/prospector',
    exp: now + 300,
    nbf: now - 30,
    ...overrides,
  }
  const header = b64url({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })
  const payload = b64url(claims)
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${payload}`)
  return `${header}.${payload}.${signer.sign(privateKey).toString('base64url')}`
}

const jwks = async () =>
  new Response(JSON.stringify({ keys: [jwk] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

function client() {
  let cookie = null
  return async (path, init = {}) => {
    const response = await app.fetch(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          ...(cookie ? { cookie } : {}),
          ...(init.headers || {}),
        },
      }),
    )
    const set = response.headers.get('set-cookie')
    if (set) cookie = set.split(';')[0]
    const text = await response.text()
    let body = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }
    return { status: response.status, body }
  }
}

const PARCELS = [
  { id: 201, ad: '400 Congress Ave', ow: 'Ridgeline Partners', at: 'Office', mv: 8200000, ac: 0.9, po: 'p9', bb: [-97.74, 30.26, -97.73, 30.27] },
  { id: 202, ad: '18 Warehouse Way', ow: 'Vance Logistics', at: 'Industrial', mv: 3100000, ac: 6.5, bb: [-97.6, 30.4, -97.59, 30.41] },
  { id: 203, ad: '9 Scrub Rd', ow: 'Okafor Family Trust', at: 'Land', mv: 120000, ac: 55, bb: [-97.5, 30.5, -97.49, 30.51] },
]

let call
let ingest

before(async () => {
  resetKeyCache()
  app = await createServer({
    DATA_DIR: temp.directory,
    DB_FILE: `${temp.directory}/test.db`,
    JWKS_FETCH: jwks,
  })
  call = client()
  await call('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email: 'broker@example.com', password: 'a long enough password', name: 'Broker' }),
  })
  ingest = (query, body, token = sign()) =>
    call(`/api/gis/parcels?${query}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
})

after(() => temp.cleanup())

describe('publishing a county', () => {
  test('no token, no rows', async () => {
    const res = await call('/api/gis/parcels?market=austin-tx&action=rows', {
      method: 'POST',
      body: JSON.stringify(PARCELS),
    })
    assert.equal(res.status, 401)
  })

  test('a run from another repository is refused by name', async () => {
    const res = await ingest('market=austin-tx&action=rows', PARCELS, sign({ repository: 'someone/else' }))
    assert.equal(res.status, 401)
    assert.match(res.body.error, /someone\/else is not allowed/)
  })

  test('a market name that is not a slug is refused', async () => {
    const res = await ingest('market=../../etc&action=rows', PARCELS)
    assert.equal(res.status, 400)
  })

  test('rows land, but nothing is answerable until the market is sealed', async () => {
    const stored = await ingest('market=austin-tx&action=rows', PARCELS)
    assert.equal(stored.status, 200)
    assert.equal(stored.body.stored, 3)

    const early = await call('/api/gis/market?market=austin-tx')
    assert.equal(early.body.ready, false, 'half a county is not a county')

    const sealed = await ingest('market=austin-tx&action=seal', { keys: ['id', 'ad', 'ow', 'mv', 'ac'] })
    assert.equal(sealed.status, 200)
    assert.equal(sealed.body.n, 3)
  })

  test('a sealed market states its totals, assets and breaks', async () => {
    const res = await call('/api/gis/market?market=austin-tx')
    assert.equal(res.body.ready, true)
    assert.equal(res.body.count, 3)
    assert.equal(res.body.total, 11420000)
    assert.deepEqual(res.body.assets.map((a) => a.value).sort(), ['Industrial', 'Land', 'Office'])
    assert.equal(res.body.breaks.length, 4)
  })

  test('an oversized chunk is refused rather than half-stored', async () => {
    const many = Array.from({ length: 5001 }, (_, i) => ({ id: i, mv: 1, ac: 1 }))
    const res = await ingest('market=austin-tx&action=rows', many)
    assert.equal(res.status, 413)
  })

  test('an unknown action is named rather than ignored', async () => {
    const res = await ingest('market=austin-tx&action=drop', {})
    assert.equal(res.status, 400)
    assert.match(res.body.error, /drop/)
  })
})

describe('searching a county', () => {
  test('signing in is required', async () => {
    const stranger = client()
    const res = await stranger('/api/gis/parcels?market=austin-tx')
    assert.equal(res.status, 401)
  })

  test('an unfiltered search pages the market and withholds the id list', async () => {
    const res = await call('/api/gis/parcels?market=austin-tx')
    assert.equal(res.body.count, 3)
    assert.equal(res.body.ids, null)
    assert.equal(res.body.rows[0].ad, '400 Congress Ave', 'most valuable first')
  })

  test('a filter returns the ids the map highlights', async () => {
    const res = await call('/api/gis/parcels?market=austin-tx&amin=5')
    assert.equal(res.body.count, 2)
    assert.deepEqual(res.body.ids.sort(), ['202', '203'])
    assert.equal(res.body.truncated, false)
  })

  test('text search reaches the address and the owner', async () => {
    assert.equal((await call('/api/gis/parcels?market=austin-tx&q=congress')).body.count, 1)
    assert.equal((await call('/api/gis/parcels?market=austin-tx&q=vance')).body.count, 1)
    assert.equal((await call('/api/gis/parcels?market=austin-tx&q=nothing here')).body.count, 0)
  })

  test('asset types arrive comma separated', async () => {
    const res = await call('/api/gis/parcels?market=austin-tx&at=Office,Land')
    assert.equal(res.body.count, 2)
  })

  test('an owner narrows to their holdings', async () => {
    const res = await call('/api/gis/parcels?market=austin-tx&owner=p9&ownerKind=p')
    assert.equal(res.body.count, 1)
  })

  test('a blank bound is not a zero bound', async () => {
    const res = await call('/api/gis/parcels?market=austin-tx&vmin=&vmax=')
    assert.equal(res.body.count, 3)
    assert.equal(res.body.ids, null, 'empty inputs are not a filter')
  })

  test('a market with nothing published says so, so the app can fall back', async () => {
    const res = await call('/api/gis/parcels?market=nowhere-zz')
    assert.equal(res.status, 404)
    assert.equal(res.body.ready, false)
  })

  test('one parcel comes back whole, bounding box included', async () => {
    const res = await call('/api/gis/parcel?market=austin-tx&id=202')
    assert.equal(res.status, 200)
    assert.equal(res.body.parcel.ow, 'Vance Logistics')
    assert.deepEqual(res.body.parcel.bb, [-97.6, 30.4, -97.59, 30.41])
  })

  test('a parcel from another market is not found here', async () => {
    const res = await call('/api/gis/parcel?market=austin-tx&id=999')
    assert.equal(res.status, 404)
  })

  test('the ready list names the markets that can skip the download', async () => {
    const res = await call('/api/gis/markets')
    assert.deepEqual(res.body.ready, ['austin-tx'])
  })
})
