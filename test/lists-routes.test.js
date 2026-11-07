/**
 * The lists routes, end to end over HTTP: make a list, add a place, read it,
 * remove it. A route-level check because the first version answered a
 * successful add with 404 (an empty "missing" array read as "no list").
 */
import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'

import { createServer } from '../server/index.js'
import { useTempData } from './helpers.js'

const temp = useTempData()
let app
let cookie = null

const call = async (method, path, body) => {
  const res = await app.fetch(new Request(`http://localhost${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  }))
  const set = res.headers.get('set-cookie')
  if (set) cookie = set.split(';')[0]
  return { status: res.status, body: await res.json().catch(() => null) }
}

before(async () => {
  app = await createServer({ DATA_DIR: temp.directory, DB_FILE: `${temp.directory}/test.db` })
})

after(() => temp.cleanup())

describe('lists over HTTP', () => {
  test('need a signed-in user', async () => {
    assert.equal((await call('GET', '/api/lists')).status, 401)
  })

  test('a list is made, filled, read, emptied and deleted', async () => {
    await call('POST', '/api/auth/register', { email: 'lists@example.com', password: 'a long enough password', name: 'L' })
    const place = await call('POST', '/api/crm/places', { name: '4522 Burnet Rd', address: '4522 Burnet Rd, Austin, TX' })
    assert.equal(place.status, 201)
    const placeId = place.body.record.id

    const made = await call('POST', '/api/lists', { name: 'Acme retail', client: 'Acme', tags: 'Retail, Q3' })
    assert.equal(made.status, 201)
    const id = made.body.list.id

    const added = await call('POST', `/api/lists/${id}/places`, { placeIds: [placeId, 'not-a-place'] })
    assert.equal(added.status, 200, JSON.stringify(added.body))
    assert.equal(added.body.added, 1)
    assert.deepEqual(added.body.missing, ['not-a-place'])

    const clean = await call('POST', `/api/lists/${id}/places`, { placeIds: [placeId] })
    assert.equal(clean.status, 200, 'nothing missing is still a success')

    const marked = await call('GET', `/api/lists?place=${placeId}`)
    assert.equal(marked.body.lists[0].has, true)
    const read = await call('GET', `/api/lists/${id}`)
    assert.equal(read.body.list.places[0].name, '4522 Burnet Rd')
    assert.deepEqual(read.body.list.tags, ['Retail', 'Q3'])

    assert.equal((await call('PATCH', `/api/lists/${id}`, { client: 'Acme Co' })).body.list.client, 'Acme Co')
    assert.equal((await call('DELETE', `/api/lists/${id}/places/${placeId}`)).status, 204)
    assert.equal((await call('GET', `/api/lists/${id}`)).body.list.count, 0)
    assert.equal((await call('DELETE', `/api/lists/${id}`)).status, 204)
    assert.equal((await call('GET', `/api/lists/${id}`)).status, 404)
    assert.equal((await call('POST', `/api/lists/${id}/places`, { placeIds: [placeId] })).status, 404)
  })

  test('deleting a place takes it off its lists', async () => {
    const place = await call('POST', '/api/crm/places', { name: 'Gone soon' })
    const { body } = await call('POST', '/api/lists', { name: 'Short' })
    await call('POST', `/api/lists/${body.list.id}/places`, { placeIds: [place.body.record.id] })
    assert.equal((await call('DELETE', `/api/crm/places/${place.body.record.id}`)).status, 204)
    assert.equal((await call('GET', `/api/lists/${body.list.id}`)).body.list.count, 0)
  })
})
