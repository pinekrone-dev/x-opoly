/**
 * Round-trip budgets for the hot paths.
 *
 * Each test counts the statements the API sends to the database for one
 * user action and holds it to a ceiling. The numbers are the point: a
 * property edit used to cost fifteen round trips and a Worker cold start
 * sixty-five, and nothing but a test keeps them from creeping back.
 */
import test, { describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { createApp } from '../app/routes.js'
import { nodeAdapter } from '../app/lib/sql.js'
import { diskStorage } from '../app/lib/storage.js'
import { forgetKeyedTeams } from '../app/lib/crm.js'
import { createLookupCache, coordinateKey } from '../app/lib/lookupcache.js'

/** The adapter, with every statement it sends written down. */
function countingAdapter(database) {
  const raw = nodeAdapter(database)
  const log = []
  const adapter = {
    kind: 'node',
    log,
    reset: () => log.splice(0, log.length),
    trips: () => log.length,
    writes: () => log.filter((entry) => entry.kind === 'run' || entry.kind === 'batch').length,
    all: (sql, params) => (log.push({ kind: 'all', sql }), raw.all(sql, params)),
    get: (sql, params) => (log.push({ kind: 'get', sql }), raw.get(sql, params)),
    run: (sql, params) => (log.push({ kind: 'run', sql }), raw.run(sql, params)),
    batch: (statements) => (log.push({ kind: 'batch', sql: `${statements.length} statements` }), raw.batch(statements)),
    migrate: (options) => raw.migrate.call(adapter, options),
  }
  return adapter
}

describe('database round trips per action', () => {
  let dir, db, app, cookie

  const call = async (method, url, body) => {
    db.reset()
    const init = { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) } }
    if (body !== undefined) init.body = JSON.stringify(body)
    const response = await app.request(`http://test${url}`, init)
    const setCookie = response.headers.get('set-cookie')
    if (setCookie) cookie = setCookie.split(';')[0]
    return { status: response.status, body: await response.json().catch(() => null), trips: db.trips(), writes: db.writes() }
  }

  before(async () => {
    forgetKeyedTeams()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'io-'))
    db = countingAdapter(new DatabaseSync(path.join(dir, 'io.db')))
    await db.migrate()
    app = createApp({ db, storage: await diskStorage(path.join(dir, 'uploads')), env: {} })
    const registered = await call('POST', '/api/auth/register', { email: 'io@example.com', password: 'password123' })
    assert.equal(registered.status, 201)
  })

  after(() => fs.rmSync(dir, { recursive: true, force: true }))

  test('a second boot against a current schema is one read, not a full sweep', async () => {
    db.reset()
    const result = await db.migrate()
    assert.equal(result.skipped, true)
    assert.equal(db.trips(), 1)
    assert.equal(db.writes(), 0)
  })

  test('an authenticated list costs one auth query plus the list', async () => {
    await call('GET', '/api/surveys') // warms the has-users check
    const { status, trips } = await call('GET', '/api/surveys')
    assert.equal(status, 200)
    assert.equal(trips, 2)
  })

  test('creating a site with custom fields is one batch and no re-read', async () => {
    const survey = await call('POST', '/api/surveys', { name: 'Budget' })
    const { status, body, trips, writes } = await call('POST', `/api/surveys/${survey.body.survey.id}/properties`, {
      name: 'Site', address: '1 Main St', city: 'Dallas', state: 'TX', lat: 32.7, lng: -96.8,
      fields: [{ label: 'a', value: '1' }, { label: 'b', value: '2' }],
    })
    assert.equal(status, 201)
    assert.deepEqual(body.property.fields, [{ label: 'a', value: '1' }, { label: 'b', value: '2' }])
    assert.ok(trips <= 6, `expected at most 6 round trips, saw ${trips}`)
    assert.equal(writes, 2, 'one batch for the site, one for the place it files into the CRM')
  })

  test('a second site at a known address matches the place by index, not by scanning', async () => {
    const survey = await call('POST', '/api/surveys', { name: 'Budget 2' })
    const first = await call('POST', `/api/surveys/${survey.body.survey.id}/properties`, { address: '9 Elm St', city: 'Austin', state: 'TX' })
    const second = await call('POST', `/api/surveys/${survey.body.survey.id}/properties`, { address: '9 elm st.', city: 'Austin', state: 'tx' })
    assert.equal(first.status, 201)
    assert.equal(second.status, 201)
    assert.equal(second.writes, 1, 'the place already existed, so only the site is written')
    assert.ok(!db.log.some((entry) => /address_key IS NULL/.test(entry.sql)), 'the legacy scan does not run once the team is keyed')
    const places = await call('GET', '/api/crm/places?q=elm')
    assert.equal(places.body.records.length, 1)
  })

  test('an edit that changes nothing writes nothing', async () => {
    const survey = await call('POST', '/api/surveys', { name: 'Budget 3' })
    const created = await call('POST', `/api/surveys/${survey.body.survey.id}/properties`, { name: 'Site', notes: 'hello', lat: 1, lng: 2 })
    const id = created.body.property.id
    const before = (await call('GET', `/api/surveys/${survey.body.survey.id}`)).body.survey.updatedAt

    const same = await call('PATCH', `/api/properties/${id}`, { notes: 'hello', lat: 1, lng: 2 })
    assert.equal(same.status, 200)
    assert.equal(same.writes, 0)
    assert.equal(same.body.property.notes, 'hello')
    const after = (await call('GET', `/api/surveys/${survey.body.survey.id}`)).body.survey.updatedAt
    assert.equal(after, before, 'the survey timestamp is untouched by a no-op edit')

    const changed = await call('PATCH', `/api/properties/${id}`, { notes: 'changed' })
    assert.equal(changed.writes, 1, 'one batch carries the row and the survey timestamp')
    assert.ok(changed.trips <= 5, `expected at most 5 round trips, saw ${changed.trips}`)
    assert.equal(changed.body.property.notes, 'changed')
  })

  test('deleting a site is one read and one batch', async () => {
    const survey = await call('POST', '/api/surveys', { name: 'Budget 4' })
    const created = await call('POST', `/api/surveys/${survey.body.survey.id}/properties`, { name: 'Gone' })
    const removed = await call('DELETE', `/api/properties/${created.body.property.id}`)
    assert.equal(removed.status, 204)
    assert.equal(removed.trips, 3)
    assert.equal((await call('DELETE', `/api/properties/${created.body.property.id}`)).status, 404)
  })

  test('a deal with many parties reads a fixed number of times', async () => {
    const deal = await call('POST', '/api/crm/deals', { name: 'Big' })
    for (let i = 0; i < 6; i++) {
      const person = await call('POST', '/api/crm/people', { firstName: `P${i}` })
      await call('POST', `/api/crm/deals/${deal.body.record.id}/parties`, { kind: 'person', refId: person.body.record.id })
    }
    const company = await call('POST', '/api/crm/companies', { name: 'Co', fields: [{ label: 'k', value: 'v' }] })
    await call('POST', `/api/crm/deals/${deal.body.record.id}/parties`, { kind: 'company', refId: company.body.record.id })

    const { body, trips } = await call('GET', `/api/crm/deals/${deal.body.record.id}`)
    assert.equal(body.record.parties.length, 7)
    assert.deepEqual(body.record.parties.at(-1).record.fields.map((f) => [f.label, f.value]), [['k', 'v']])
    assert.ok(trips <= 7, `expected at most 7 round trips for 7 parties, saw ${trips}`)
  })

  test('custom fields on a CRM record are written as one batch', async () => {
    const company = await call('POST', '/api/crm/companies', { name: 'Fields' })
    const updated = await call('PATCH', `/api/crm/companies/${company.body.record.id}`, {
      fields: [{ label: 'a', value: '1' }, { label: 'b', value: '2' }, { label: 'c', value: '3' }],
    })
    assert.equal(updated.writes, 1)
    assert.deepEqual(updated.body.record.fields.map((f) => f.label), ['a', 'b', 'c'])
    const unchanged = await call('PATCH', `/api/crm/companies/${company.body.record.id}`, { name: 'Fields' })
    assert.equal(unchanged.writes, 0)
  })

  test('deleting a record removes its fields and memberships atomically', async () => {
    const company = await call('POST', '/api/crm/companies', { name: 'Doomed', fields: [{ label: 'a', value: '1' }] })
    const removed = await call('DELETE', `/api/crm/companies/${company.body.record.id}`)
    assert.equal(removed.status, 204)
    assert.equal(removed.writes, 1)
    assert.equal(db.log.at(-1).kind, 'batch')
  })

  test('lists are searched in SQL and bounded', async () => {
    for (let i = 0; i < 5; i++) await call('POST', '/api/crm/places', { name: `Warehouse ${i}`, city: i % 2 ? 'Waco' : 'Tyler' })
    const found = await call('GET', '/api/crm/places?q=waco')
    assert.equal(found.trips, 3)
    assert.ok(found.body.records.every((record) => record.city === 'Waco'))
    assert.equal(found.body.truncated, false)
    const page = await call('GET', '/api/crm/places?limit=2')
    assert.equal(page.body.records.length, 2)
    assert.equal(page.body.truncated, true)
    const escaped = await call('GET', '/api/crm/places?q=%25')
    assert.equal(escaped.body.records.length, 0, 'a literal percent sign is not a wildcard')
  })

  test('the navigation counts are one query', async () => {
    const { body, trips } = await call('GET', '/api/crm/counts')
    assert.equal(trips, 2)
    assert.ok(body.counts.places >= 5)
    assert.equal(typeof body.surveys, 'number')
  })
})

describe('lookup cache', () => {
  test('remembers a successful answer and forgets it after its ttl', async () => {
    let calls = 0
    const cache = createLookupCache({ ttlMs: 50 })
    const produce = async () => ++calls
    assert.equal(await cache.remember('k', produce), 1)
    assert.equal(await cache.remember('k', produce), 1)
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(await cache.remember('k', produce), 2)
  })

  test('never remembers a failure', async () => {
    let calls = 0
    const cache = createLookupCache({ ttlMs: 1000 })
    const flaky = async () => {
      calls += 1
      if (calls === 1) throw new Error('down')
      return 'up'
    }
    await assert.rejects(cache.remember('k', flaky))
    assert.equal(await cache.remember('k', flaky), 'up')
    assert.equal(calls, 2)
  })

  test('evicts least recently used past its size', async () => {
    const cache = createLookupCache({ ttlMs: 1000, max: 2 })
    await cache.remember('a', async () => 1)
    await cache.remember('b', async () => 2)
    await cache.remember('a', async () => 'stale')
    await cache.remember('c', async () => 3)
    assert.equal(cache.size, 2)
    assert.equal(await cache.remember('a', async () => 'refetched'), 1)
    assert.equal(await cache.remember('b', async () => 'refetched'), 'refetched')
  })

  test('keys coordinates to about eleven metres', () => {
    assert.equal(coordinateKey(32.78081, -96.79724), coordinateKey(32.78084, -96.79719))
    assert.notEqual(coordinateKey(32.7808, -96.7972), coordinateKey(32.7818, -96.7972))
  })
})

describe('the demographics route', () => {
  test('answers a repeat of the same point from the cache', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'io-demo-'))
    const db = nodeAdapter(new DatabaseSync(path.join(dir, 'd.db')))
    await db.migrate()
    const app = createApp({ db, storage: await diskStorage(path.join(dir, 'uploads')), env: {} })
    let hits = 0
    app.lookups.demographics.remember = ((original) => async (key, produce) => {
      hits += 1
      return original(key, async () => ({ cachedFor: key }))
    })(app.lookups.demographics.remember.bind(app.lookups.demographics))
    const first = await (await app.request('http://test/api/demographics?lat=32.78&lng=-96.79')).json()
    const second = await (await app.request('http://test/api/demographics?lat=32.78&lng=-96.79')).json()
    assert.deepEqual(first, second)
    assert.equal(hits, 2, 'both requests went through the cache')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
