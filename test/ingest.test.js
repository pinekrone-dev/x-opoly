/**
 * The ingest door, pinned shut.
 *
 * This endpoint writes into the public parcel data bucket, so its
 * verification is the security boundary: a forged or borrowed token must
 * never pass, and a valid one must only be able to touch the fixed data
 * filenames. The tokens here are real RS256 JWTs signed with a throwaway
 * key served through a stubbed JWKS, so what is tested is the actual
 * verification path, not a mock of it.
 */

import { describe, test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, createSign } from 'node:crypto'

import { verifyActionsToken, resetKeyCache } from '../app/lib/oidc.js'
import { createServer } from '../server/index.js'
import { useTempData } from './helpers.js'

const ISSUER = 'https://token.actions.githubusercontent.com'
const AUD = 'landquotient-ingest'

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' }

const b64url = (input) =>
  Buffer.from(typeof input === 'string' ? input : JSON.stringify(input))
    .toString('base64url')

function sign(claims, { kid = 'test-key', alg = 'RS256' } = {}) {
  const header = b64url({ alg, kid, typ: 'JWT' })
  const payload = b64url(claims)
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${payload}`)
  const signature = signer.sign(privateKey).toString('base64url')
  return `${header}.${payload}.${signature}`
}

function actionsClaims(overrides = {}) {
  const now = Math.floor(Date.now() / 1000)
  return {
    iss: ISSUER,
    aud: AUD,
    repository: 'pinekrone-dev/prospector',
    exp: now + 300,
    nbf: now - 30,
    ...overrides,
  }
}

const jwks = async () =>
  new Response(JSON.stringify({ keys: [jwk] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

describe('verifyActionsToken', () => {
  beforeEach(() => resetKeyCache())
  const opts = { audience: AUD, repositories: ['pinekrone-dev/prospector'], fetchImpl: jwks }

  test('a genuine token verifies and returns its claims', async () => {
    const claims = await verifyActionsToken(sign(actionsClaims()), opts)
    assert.equal(claims.repository, 'pinekrone-dev/prospector')
  })

  test('the wrong repository is refused by name', async () => {
    await assert.rejects(
      verifyActionsToken(sign(actionsClaims({ repository: 'someone-else/repo' })), opts),
      /someone-else\/repo is not allowed/,
    )
  })

  test('the wrong audience is refused', async () => {
    await assert.rejects(
      verifyActionsToken(sign(actionsClaims({ aud: 'another-service' })), opts),
      /different audience/,
    )
  })

  test('an expired token is refused', async () => {
    const now = Math.floor(Date.now() / 1000)
    await assert.rejects(
      verifyActionsToken(sign(actionsClaims({ exp: now - 120 })), opts),
      /expired/,
    )
  })

  test('a tampered payload fails the signature', async () => {
    const token = sign(actionsClaims())
    const [h, , s] = token.split('.')
    const forged = `${h}.${b64url(actionsClaims({ repository: 'pinekrone-dev/prospector', sub: 'evil' }))}.${s}`
    await assert.rejects(verifyActionsToken(forged, opts), /signature does not verify/)
  })

  test('an alg downgrade is refused before any crypto runs', async () => {
    const header = b64url({ alg: 'none', kid: 'test-key' })
    const payload = b64url(actionsClaims())
    await assert.rejects(
      verifyActionsToken(`${header}.${payload}.${b64url('x')}`, opts),
      /not RS256/,
    )
  })

  test('a key GitHub does not publish is refused', async () => {
    await assert.rejects(
      verifyActionsToken(sign(actionsClaims(), { kid: 'unknown-key' }), opts),
      /signing key/,
    )
  })
})

describe('POST /api/gis/ingest', () => {
  const temp = useTempData()
  let app
  const store = new Map()
  const uploads = new Map()

  /** Just enough of an R2 bucket for the endpoint's four actions. */
  const fakeBucket = {
    async put(key, value, options) {
      store.set(key, { bytes: Buffer.from(value), contentType: options?.httpMetadata?.contentType })
    },
    async createMultipartUpload(key, options) {
      const uploadId = `up-${uploads.size + 1}`
      uploads.set(uploadId, { key, parts: new Map(), contentType: options?.httpMetadata?.contentType })
      return { uploadId }
    },
    resumeMultipartUpload(key, uploadId) {
      const upload = uploads.get(uploadId)
      return {
        async uploadPart(partNumber, value) {
          upload.parts.set(partNumber, Buffer.from(value))
          return { etag: `etag-${partNumber}`, partNumber }
        },
        async complete(parts) {
          const bytes = Buffer.concat(
            parts
              .sort((a, b) => a.partNumber - b.partNumber)
              .map((p) => upload.parts.get(p.partNumber)),
          )
          store.set(upload.key, { bytes, contentType: upload.contentType })
        },
      }
    },
  }

  before(async () => {
    resetKeyCache()
    app = await createServer({
      DATA_DIR: temp.directory,
      DB_FILE: `${temp.directory}/test.db`,
      PROSPECTOR_DATA: fakeBucket,
      JWKS_FETCH: jwks,
    })
  })

  after(() => temp.cleanup())

  const call = (query, init = {}) =>
    app.fetch(new Request(`http://localhost/api/gis/ingest?${query}`, { method: 'POST', ...init }))

  const auth = { authorization: `Bearer ${sign(actionsClaims())}` }

  test('no token, no write', async () => {
    const res = await call('market=austin-tx&file=index.json', { body: '{}' })
    assert.equal(res.status, 401)
    assert.equal(store.size, 0)
  })

  test('a verified run can put a data file, and only a data file', async () => {
    const ok = await call('market=austin-tx&file=index.json', { headers: auth, body: '{"n":1}' })
    assert.equal(ok.status, 200)
    assert.equal(store.get('austin-tx/index.json').bytes.toString(), '{"n":1}')
    assert.equal(store.get('austin-tx/index.json').contentType, 'application/json')

    const no = await call('market=austin-tx&file=../../secrets.txt', { headers: auth, body: 'x' })
    assert.equal(no.status, 400)
    const badMarket = await call('market=Austin TX&file=index.json', { headers: auth, body: 'x' })
    assert.equal(badMarket.status, 400)
  })

  test('a large file arrives in parts and lands whole', async () => {
    const created = await (await call('market=austin-tx&file=parcels.pmtiles&action=create', { headers: auth })).json()
    assert.ok(created.uploadId)
    const p1 = await (await call(`market=austin-tx&file=parcels.pmtiles&action=part&uploadId=${created.uploadId}&part=1`, { headers: auth, body: 'AAAA' })).json()
    const p2 = await (await call(`market=austin-tx&file=parcels.pmtiles&action=part&uploadId=${created.uploadId}&part=2`, { headers: auth, body: 'BBBB' })).json()
    const done = await call(`market=austin-tx&file=parcels.pmtiles&action=complete&uploadId=${created.uploadId}`, {
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ parts: [p1, p2] }),
    })
    assert.equal(done.status, 200)
    assert.equal(store.get('austin-tx/parcels.pmtiles').bytes.toString(), 'AAAABBBB')
    assert.equal(store.get('austin-tx/parcels.pmtiles').contentType, 'application/octet-stream')
  })
})

describe('POST /api/gis/ingest without the binding', () => {
  const temp = useTempData()
  let app
  before(async () => {
    app = await createServer({ DATA_DIR: temp.directory, DB_FILE: `${temp.directory}/node.db` })
  })
  after(() => temp.cleanup())

  test('answers 501 rather than pretending', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/gis/ingest?market=austin-tx&file=index.json', {
        method: 'POST',
        headers: { authorization: `Bearer ${sign(actionsClaims())}` },
        body: 'x',
      }),
    )
    assert.equal(res.status, 501)
  })
})
