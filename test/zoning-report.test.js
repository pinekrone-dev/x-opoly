/**
 * The zoning report route: a City of Los Angeles lot's measured facts and
 * the code's rules, read back as cited lines.
 */
import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'

import { createServer } from '../server/index.js'
import { useTempData } from './helpers.js'

const temp = useTempData()
const realFetch = globalThis.fetch
let app
let cookie = null

const SHARD = {
  as_of: '2026-11-06',
  lots: {
    4214014023: { zone: 'R1-1', area_sf: 5200, width_ft: 50, depth_ft: 104, type: 'interior', why: '',
      streets: { 'MCLAUGHLIN AVE': 50 }, front_street: 'MCLAUGHLIN AVE', hillside: false, coastal: false,
      face: { street: 'MCLAUGHLIN AVE', prevailing_ft: 21.9, share: 0.53, lots_on_face: 15 } },
    4214014025: { zone: 'C2-1', area_sf: 5200, width_ft: 50, depth_ft: 104, type: 'corner', hillside: false, coastal: false },
  },
}

const call = async (path, body) => {
  const res = await app.fetch(new Request(`http://localhost${path}`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  }))
  const set = res.headers.get('set-cookie')
  if (set) cookie = set.split(';')[0]
  return { status: res.status, body: await res.json().catch(() => null) }
}

before(async () => {
  globalThis.fetch = async (url) => {
    if (String(url) === 'https://catalogue.test/los-angeles-ca/lotfacts-4214.json') {
      return new Response(JSON.stringify(SHARD), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('not found', { status: 404 })
  }
  app = await createServer({ DATA_DIR: temp.directory, DB_FILE: `${temp.directory}/test.db`,
    PARCEL_CATALOG_ORIGIN: 'https://catalogue.test' })
})

after(() => {
  globalThis.fetch = realFetch
  return temp.cleanup()
})

describe('the zoning report', () => {
  test('needs a signed-in user', async () => {
    const res = await call('/api/gis/zoning-report', { market: 'los-angeles-ca', apn: '4214014023' })
    assert.equal(res.status, 401)
  })

  test('an R1 lot: cited lines, the prevailing front yard and the lot facts', async () => {
    await call('/api/auth/register', { email: 'zoning@example.com', password: 'a long enough password', name: 'Z' })
    const res = await call('/api/gis/zoning-report', { market: 'los-angeles-ca', apn: '4214-014-023' })
    assert.equal(res.status, 200)
    assert.equal(res.body.covered, true)
    assert.equal(res.body.zone, 'R1-1')
    const prevailing = res.body.lines.find((l) => l.label === 'Front yard (prevailing)')
    assert.equal(prevailing.value, 21.9)
    assert.equal(prevailing.cite.section, 'LAMC 12.08 C.1')
    assert.equal(res.body.lines.find((l) => l.label === 'Residential floor area (max)').value, 2340)
    assert.equal(res.body.lot.front_street, 'MCLAUGHLIN AVE')
    assert.ok(res.body.note.includes('not a zoning determination'))
  })

  test('a commercial lot is not yet covered and says so', async () => {
    const res = await call('/api/gis/zoning-report', { market: 'los-angeles-ca', apn: '4214014025' })
    assert.equal(res.body.covered, false)
    assert.ok(res.body.flags[0].includes('not yet covered'))
  })

  test('a lot outside the City, and a market outside Los Angeles', async () => {
    assert.equal((await call('/api/gis/zoning-report', { market: 'los-angeles-ca', apn: '9999999999' })).body.covered, false)
    assert.equal((await call('/api/gis/zoning-report', { market: 'austin-tx', apn: '1' })).body.covered, false)
  })
})
