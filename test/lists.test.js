/**
 * Lists: named sets of CRM places, filed by client and tags, kept per team.
 */
import assert from 'node:assert/strict'
import test, { before } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { nodeAdapter } from '../app/lib/sql.js'
import { createRecord } from '../app/lib/crm.js'
import { addToList, cleanTags, createList, deleteList, forgetPlace, getList, listLists, removeFromList, updateList } from '../app/lib/lists.js'

let db
let a
let b
let other

before(async () => {
  db = nodeAdapter(new DatabaseSync(':memory:'))
  await db.migrate()
  a = (await createRecord(db, 'place', 'team-1', { name: '4522 Burnet Rd', address: '4522 Burnet Rd, Austin, TX' })).record
  b = (await createRecord(db, 'place', 'team-1', { name: '4700 Grover Ave' })).record
  other = (await createRecord(db, 'place', 'team-2', { name: 'Not ours' })).record
})

test('tags are cleaned, de-duplicated and capped', () => {
  assert.deepEqual(cleanTags('Industrial,  q3 , industrial,,'), ['Industrial', 'q3'])
  assert.deepEqual(cleanTags(['A', 'a', ' B ']), ['A', 'B'])
  assert.equal(cleanTags(Array.from({ length: 30 }, (_, i) => `t${i}`)).length, 12)
})

test('a list is made with a client and tags, holds places once, and is the team’s alone', async () => {
  const { list } = await createList(db, 'team-1', { name: ' Acme  retail targets ', client: 'Acme Co', tags: 'Retail, Q3' }, { userId: 'u1' })
  assert.equal(list.name, 'Acme retail targets')
  assert.equal(list.client, 'Acme Co')
  assert.deepEqual(list.tags, ['Retail', 'Q3'])

  const first = await addToList(db, 'team-1', list.id, [a.id, b.id, a.id, other.id])
  assert.equal(first.added, 2)
  assert.deepEqual(first.missing, [other.id], 'another team’s place is not added')
  const again = await addToList(db, 'team-1', list.id, [a.id])
  assert.equal(again.added, 0, 'already on it')

  const read = await getList(db, 'team-1', list.id)
  assert.equal(read.count, 2)
  assert.equal(read.places.length, 2)
  assert.equal(await getList(db, 'team-2', list.id), null, 'not visible to another team')

  const marked = await listLists(db, 'team-1', { placeId: a.id })
  assert.equal(marked.find((l) => l.id === list.id).has, true)
  assert.equal((await listLists(db, 'team-2')).length, 0)
})

test('a list can be renamed and refiled, and empties and goes cleanly', async () => {
  const { list } = await createList(db, 'team-1', { name: 'Temp', client: 'Old client' })
  await addToList(db, 'team-1', list.id, [b.id])
  const { list: changed } = await updateList(db, 'team-1', list.id, { client: 'New client', tags: ['Industrial'] })
  assert.equal(changed.client, 'New client')
  assert.deepEqual(changed.tags, ['Industrial'])
  assert.equal(changed.name, 'Temp')
  assert.equal((await updateList(db, 'team-1', list.id, { name: '  ' })).error, 'A list needs a name.')

  await removeFromList(db, 'team-1', list.id, b.id)
  assert.equal((await getList(db, 'team-1', list.id)).count, 0)
  assert.equal(await deleteList(db, 'team-1', list.id), true)
  assert.equal(await getList(db, 'team-1', list.id), null)
  assert.equal(await deleteList(db, 'team-2', 'nope'), false)
})

test('a deleted place leaves every list', async () => {
  const { list } = await createList(db, 'team-1', { name: 'Keep' })
  await addToList(db, 'team-1', list.id, [a.id, b.id])
  await forgetPlace(db, 'team-1', a.id)
  assert.equal((await getList(db, 'team-1', list.id)).count, 1)
})

test('a list needs a name', async () => {
  assert.equal((await createList(db, 'team-1', { name: '' })).error, 'Give the list a name.')
})

test('the connector files parcels on a named list, making it with its client the first time', async () => {
  const { runTool } = await import('../app/lib/mcp.js')
  const state = { lists: [], items: [], places: [] }
  const reply = (status, body) => Response.json(body, { status })
  const call = async (path, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null
    if (path === '/api/lists' && !init.method) return reply(200, { lists: state.lists })
    if (path === '/api/lists' && init.method === 'POST') {
      const list = { id: `L${state.lists.length + 1}`, name: body.name, client: body.client, tags: body.tags, count: 0 }
      state.lists.push(list)
      return reply(201, { list })
    }
    if (path.startsWith('/api/crm/parcel?')) {
      const parcel = new URLSearchParams(path.split('?')[1]).get('parcel')
      const place = state.places.find((p) => p.parcelId === parcel)
      return reply(200, { place: place ?? null, deals: [] })
    }
    if (path.startsWith('/api/gis/parcel?')) return reply(200, { parcel: { ad: '4522 Burnet Rd', ac: 0.14, bb: [-97.74, 30.31, -97.73, 30.32] } })
    if (path === '/api/crm/places') {
      const record = { id: `P${state.places.length + 1}`, parcelId: body.parcelId }
      state.places.push(record)
      return reply(201, { record })
    }
    if (/^\/api\/lists\/L\d+\/places$/.test(path)) {
      const fresh = body.placeIds.filter((id) => !state.items.includes(id))
      state.items.push(...fresh)
      return reply(200, { added: fresh.length, missing: [] })
    }
    return reply(404, { error: path })
  }
  const ctx = { call, origin: 'https://lq.test', scope: ['read', 'crm'] }
  const first = await runTool('add_to_list', { list: 'Acme retail', client: 'Acme', tags: ['Retail'], market: 'austin-tx', ids: ['223165', '223168'] }, ctx)
  assert.ok(!first.isError, JSON.stringify(first))
  assert.equal(first.structuredContent.made, true)
  assert.equal(first.structuredContent.added, 2)
  assert.equal(state.lists[0].client, 'Acme')
  const again = await runTool('add_to_list', { list: 'acme RETAIL', market: 'austin-tx', ids: ['223165'] }, ctx)
  assert.equal(again.structuredContent.made, undefined, 'the same list, found by name')
  assert.equal(again.structuredContent.added, 0)
  assert.equal(state.places.length, 2, 'a parcel already in the CRM is not saved twice')
  const refused = await runTool('add_to_list', { list: 'x', market: 'austin-tx', ids: ['1'] }, { ...ctx, scope: ['read'] })
  assert.equal(refused.isError, true)
})
