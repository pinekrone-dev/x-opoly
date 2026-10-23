/**
 * The month's cap on writes into the parcel stores.
 *
 * Every pipeline write comes through /api/gis/ingest/parcels, so the cap is
 * held there: a request is charged its estimated billed rows, and one that
 * would carry the month past PARCEL_WRITE_CAP is refused before it writes.
 * Here the cap is 38 rows, so one three-parcel batch (thirty) fits and a
 * second does not.
 */
import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'
import { createSign, generateKeyPairSync } from 'node:crypto'

import { resetKeyCache } from '../app/lib/oidc.js'
import { capOf, charge, declaredSpent, DEFAULT_CAP, monthOf, room, spent } from '../app/lib/writebudget.js'
import { createServer } from '../server/index.js'
import { useTempData } from './helpers.js'

const temp = useTempData()
let app

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' }
const b64url = (input) => Buffer.from(typeof input === 'string' ? input : JSON.stringify(input)).toString('base64url')

function sign() {
  const now = Math.floor(Date.now() / 1000)
  const claims = {
    iss: 'https://token.actions.githubusercontent.com',
    aud: 'landquotient-ingest',
    repository: 'pinekrone-dev/prospector',
    ref: 'refs/heads/main',
    exp: now + 300,
    nbf: now - 30,
  }
  const header = b64url({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })
  const payload = b64url(claims)
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${payload}`)
  return `${header}.${payload}.${signer.sign(privateKey).toString('base64url')}`
}

const jwks = async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })

const batch = (start) =>
  [0, 1, 2].map((i) => ({ id: start + i, ad: `${start + i} Main St`, ow: 'Owner', at: 'Office', mv: 1000, ac: 1, bb: [-97.7, 30.2, -97.69, 30.21] }))

const ingest = async (query, body) => {
  const res = await app.fetch(
    new Request(`http://localhost/api/gis/ingest/parcels?${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${sign()}` },
      body: JSON.stringify(body),
    }),
  )
  return { status: res.status, body: await res.json() }
}

before(async () => {
  resetKeyCache()
  app = await createServer({
    DATA_DIR: temp.directory,
    DB_FILE: `${temp.directory}/test.db`,
    JWKS_FETCH: jwks,
    PARCEL_WRITE_CAP: '38',
  })
})

after(() => temp.cleanup())

describe('the ledger', () => {
  test('the cap defaults under the 30M the owner set, and reads from the environment', () => {
    assert.ok(DEFAULT_CAP < 30_000_000)
    assert.equal(capOf({}), DEFAULT_CAP)
    assert.equal(capOf({ PARCEL_WRITE_CAP: '5000000' }), 5_000_000)
    assert.equal(capOf({ PARCEL_WRITE_CAP: 'lots' }), DEFAULT_CAP)
    assert.equal(monthOf(Date.UTC(2026, 9, 31, 23, 59)), '2026-10')
  })

  test('a month spent before the ledger existed can be declared, and only that month', async () => {
    const env = { PARCEL_WRITE_CAP: '100', PARCEL_WRITES_SPENT: '2026-10=100, 2026-11=bad' }
    assert.equal(declaredSpent(env, '2026-10'), 100)
    assert.equal(declaredSpent(env, '2026-11'), 0)
    const empty = { get: async () => null }
    assert.equal((await room(empty, env, 1, '2026-10')).ok, false, 'October is spent')
    assert.equal((await room(empty, env, 1, '2026-11')).ok, true, 'November starts fresh')
  })
})

describe('writes past the cap', () => {
  test('a batch that fits is written and charged', async () => {
    const res = await ingest('market=cap-zz&action=rows', batch(1))
    assert.equal(res.status, 200)
    assert.equal(res.body.stored, 3)
  })

  test('the next one would pass the cap, so nothing is written and the answer says why', async () => {
    const res = await ingest('market=cap-zz&action=rows', batch(10))
    assert.equal(res.status, 429)
    assert.equal(res.body.code, 'write_cap')
    assert.equal(res.body.used, 30)
    assert.equal(res.body.cap, 38)
    assert.match(res.body.error, /Nothing was written/)
  })

  test('reads still answer: the cap stops writes, not the pipeline asking what is stored', async () => {
    const res = await ingest('market=cap-zz&action=hashes', {})
    assert.equal(res.status, 200)
    assert.equal(res.body.hashes.length, 3, 'and only the first batch is there')
  })

  test('once the month is spent, even an action of unknown size is refused', async () => {
    // Two building tags at four rows each bring the month to exactly 38.
    const tags = await ingest('market=cap-zz&action=building-tags', [[1, 1, 100, 4], [2, 1, 100, 4]])
    assert.equal(tags.status, 200)
    const cleared = await ingest('market=cap-zz&action=clear', {})
    assert.equal(cleared.status, 429)
    assert.equal(cleared.body.used, 38)
  })
})

describe('the ledger functions on their own', () => {
  test('charges add up per month and room() says where the month stands', async () => {
    const rows = new Map()
    const fake = {
      get: async (_sql, [month]) => (rows.has(month) ? { rows: rows.get(month) } : null),
      run: async (_sql, [month, n]) => rows.set(month, (rows.get(month) ?? 0) + n),
    }
    await charge(fake, 12.2, '2026-11')
    await charge(fake, 0, '2026-11')
    await charge(fake, 5, '2026-11')
    assert.equal(await spent(fake, '2026-11'), 18)
    assert.equal(await spent(fake, '2026-12'), 0, 'a new month starts empty')
    const left = await room(fake, { PARCEL_WRITE_CAP: '20' }, 3, '2026-11')
    assert.equal(left.ok, false)
    assert.equal((await room(fake, { PARCEL_WRITE_CAP: '20' }, 2, '2026-11')).ok, true)
  })
})
