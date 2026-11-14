/**
 * Client pins: a place put on a client's open deal is a pin on the map for
 * that client, and an opportunity on the client's own page.
 */
import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'

import { createServer } from '../server/index.js'
import { useTempData } from './helpers.js'

const temp = useTempData()
let app

function client() {
  let cookie = null
  return async (path, init = {}) => {
    const response = await app.fetch(new Request(`http://localhost${path}`, {
      ...init, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers || {}) },
    }))
    const set = response.headers.get('set-cookie')
    if (set) cookie = set.split(';')[0]
    const text = await response.text()
    let body = null
    try { body = text ? JSON.parse(text) : null } catch { body = text }
    return { status: response.status, body }
  }
}
const asJson = (payload, method = 'POST') => ({ method, body: JSON.stringify(payload) })

let alice
let mallory
let dana
let acme
const sites = []

before(async () => {
  app = await createServer({ DATA_DIR: temp.directory, DB_FILE: `${temp.directory}/test.db`, SIGNUP_TOKEN: 'open-sesame' })
  alice = client()
  await alice('/api/auth/register', asJson({ name: 'Alice', email: 'alice@example.com', password: 'a long enough password' }))
  mallory = client()
  await mallory('/api/auth/register', asJson({ name: 'Mallory', email: 'mallory@example.com', password: 'a long enough password', inviteToken: 'open-sesame' }))
  dana = (await alice('/api/crm/people', asJson({ firstName: 'Dana', lastName: 'Ortiz', email: 'dana@example.com' }))).body.record
  acme = (await alice('/api/crm/companies', asJson({ name: 'Acme Retail' }))).body.record
  for (let i = 0; i < 3; i += 1) {
    const made = await alice('/api/crm/places', asJson({ name: `Site ${i + 1}`, address: `${100 + i} Main St`, lat: 33.4 + i * 0.01, lng: -112.0, market: 'phoenix-az', parcelId: String(5000 + i) }))
    assert.equal(made.status, 201)
    sites.push(made.body.record)
  }
})

after(() => temp.cleanup())

describe('pinning a place for a client', () => {
  test('the first pin opens a deal for the client; the next ones join it', async () => {
    const first = await alice('/api/crm/pins', asJson({ client: { kind: 'person', id: dana.id }, placeId: sites[0].id }))
    assert.equal(first.status, 201, JSON.stringify(first.body))
    assert.equal(first.body.opened, true)
    const second = await alice('/api/crm/pins', asJson({ client: { kind: 'person', id: dana.id }, placeId: sites[1].id }))
    assert.equal(second.body.opened, false)
    assert.equal(second.body.dealId, first.body.dealId)
    const deal = await alice(`/api/crm/deals/${first.body.dealId}`)
    assert.equal(deal.body.record.name, 'Dana Ortiz: site search')
    assert.equal(deal.body.record.parties.length, 3, 'the client and two places')
  })

  test('pinning the same place twice is one pin', async () => {
    await alice('/api/crm/pins', asJson({ client: { kind: 'person', id: dana.id }, placeId: sites[0].id }))
    const { body } = await alice(`/api/crm/pins?client=person:${dana.id}`)
    assert.equal(body.pins.length, 2)
  })

  test('the client\'s page reads them as opportunities, each with its deal', async () => {
    const { status, body } = await alice(`/api/crm/pins?client=person:${dana.id}`)
    assert.equal(status, 200)
    assert.deepEqual(body.pins.map((p) => p.name).sort(), ['Site 1', 'Site 2'])
    const pin = body.pins[0]
    assert.equal(pin.clients[0].name, 'Dana Ortiz')
    assert.equal(pin.clients[0].deal.stage, 'prospect')
    assert.equal(pin.market, 'phoenix-az')
    assert.ok(Number.isFinite(pin.lat))
  })

  test('a place can be pinned for two clients, and the map reads every pin', async () => {
    const forAcme = await alice('/api/crm/pins', asJson({ client: { kind: 'company', id: acme.id }, placeId: sites[0].id }))
    assert.equal(forAcme.status, 201)
    assert.deepEqual(forAcme.body.pins[0].clients.map((c) => c.name).sort(), ['Acme Retail', 'Dana Ortiz'])
    const all = await alice('/api/crm/pins')
    assert.equal(all.body.pins.length, 2)
    const one = await alice(`/api/crm/pins?place=${sites[0].id}`)
    assert.equal(one.body.pins[0].clients.length, 2)
  })

  test('a pin comes off one client and stays for the other', async () => {
    const off = await alice(`/api/crm/pins?client=person:${dana.id}&place=${sites[0].id}`, { method: 'DELETE' })
    assert.equal(off.status, 200)
    assert.equal(off.body.removed, 1)
    assert.deepEqual(off.body.pins[0].clients.map((c) => c.name), ['Acme Retail'])
    assert.equal((await alice(`/api/crm/pins?client=person:${dana.id}`)).body.pins.length, 1)
  })

  test('a deal that is passed drops its pins from the map', async () => {
    const mine = (await alice(`/api/crm/pins?client=company:${acme.id}`)).body.pins[0].clients[0].deal.id
    await alice(`/api/crm/deals/${mine}`, asJson({ stage: 'passed' }, 'PATCH'))
    assert.equal((await alice(`/api/crm/pins?client=company:${acme.id}`)).body.pins.length, 0)
    // And the next pin for that client opens a fresh deal, not the passed one.
    const again = await alice('/api/crm/pins', asJson({ client: { kind: 'company', id: acme.id }, placeId: sites[2].id }))
    assert.equal(again.body.opened, true)
    assert.notEqual(again.body.dealId, mine)
  })

  test('what is asked for has to be said, and has to be the team\'s own', async () => {
    assert.equal((await alice('/api/crm/pins', asJson({ placeId: sites[0].id }))).status, 400)
    assert.equal((await alice('/api/crm/pins?client=deal:1')).status, 400)
    assert.equal((await alice('/api/crm/pins', asJson({ client: { kind: 'person', id: 'nobody' }, placeId: sites[0].id }))).status, 400)
    const stranger = await mallory('/api/crm/pins', asJson({ client: { kind: 'person', id: dana.id }, placeId: sites[0].id }))
    assert.equal(stranger.status, 400, 'another team cannot pin with this team\'s client')
    assert.equal((await mallory('/api/crm/pins')).body.pins.length, 0)
    assert.equal((await client()('/api/crm/pins')).status, 401)
  })
})
