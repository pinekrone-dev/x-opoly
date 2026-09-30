/**
 * Jev in the brain panel: a rating for the judgement in a question, and a
 * second look at uploaded addresses that matched nothing.
 *
 * TypeSafe's API is answered here by a fake that reads the question and the
 * context, so what is pinned is the plumbing: the wire format the live API
 * was measured with, a null (never a no) for anything that goes wrong, the
 * ceiling on calls, only public county facts in a rating, and a near match
 * taken only on a confident yes.
 */

import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { JEV_URL, createJev, parcelState } from '../app/lib/jev.js'
import { forgetParcelSchema, putParcels, sealMarket } from '../app/lib/parcels.js'
import { nodeAdapter } from '../app/lib/sql.js'
import { createServer } from '../server/index.js'
import { useTempData } from './helpers.js'

function fakeTypesafe(decide) {
  const seen = []
  const fetchImpl = async (url, init) => {
    assert.equal(url, JEV_URL)
    const body = JSON.parse(init.body)
    seen.push({ body, auth: init.headers.authorization })
    const p = decide(body)
    if (p === 'fail') return new Response('nope', { status: 500 })
    return Response.json({ answers: { q: { noul: p } }, usage: { input_tokens: 120 } })
  }
  return { fetchImpl, seen }
}

describe('the Jev client', () => {
  test('asks in the format the live API was measured with, and reads the probability back', async () => {
    const fake = fakeTypesafe(() => 0.82)
    const jev = createJev({ TYPESAFE_API_KEY: 'k' }, { fetchImpl: fake.fetchImpl })
    assert.equal(await jev.ask('context', 'Is it?'), 0.82)
    const [{ body, auth }] = fake.seen
    assert.equal(auth, 'Bearer k')
    assert.equal(body.model, 'jev-latest')
    assert.deepEqual(body.questions, { q: { type: 'noul', instructions: 'Is it?' } })
    assert.deepEqual(jev.spent(), { calls: 1, inputTokens: 120, failures: 0 })
  })

  test('no key, a failure or a nonsense answer is null, never a no', async () => {
    assert.equal(await createJev({}).ask('s', 'q'), null)
    const failing = createJev({ TYPESAFE_API_KEY: 'k' }, { fetchImpl: fakeTypesafe(() => 'fail').fetchImpl })
    assert.equal(await failing.ask('s', 'q'), null)
    const odd = createJev({ TYPESAFE_API_KEY: 'k' }, { fetchImpl: fakeTypesafe(() => 7).fetchImpl })
    assert.equal(await odd.ask('s', 'q'), null)
  })

  test('stops at its ceiling, and answers a list in order', async () => {
    const fake = fakeTypesafe((body) => Number(body.state) / 10)
    const jev = createJev({ TYPESAFE_API_KEY: 'k' }, { fetchImpl: fake.fetchImpl, maxCalls: 3 })
    const answers = await jev.many([1, 2, 3, 4].map((n) => ({ state: String(n), question: 'q' })))
    assert.deepEqual(answers, [0.1, 0.2, 0.3, null])
    assert.equal(fake.seen.length, 3)
  })

  test('a rating reads only the county record and the map layers', () => {
    const text = parcelState({ ad: '9 Dock Rd', at: 'Industrial', mv: 2500000, ac: 12.4, ow: 'Somebody Private' }, { zoning: 'M-1 (Industrial)', flood: 'outside' })
    assert.match(text, /9 Dock Rd/)
    assert.match(text, /M-1/)
    assert.doesNotMatch(text, /Somebody Private/, 'owner names are not needed to judge a site, so they are not sent')
  })
})

describe('Jev in the ask route', () => {
  const temp = useTempData()
  let app
  let cookie
  const realFetch = globalThis.fetch
  const asked = []

  before(async () => {
    // TypeSafe answers by what it is asked; the catalogue has no layers here.
    globalThis.fetch = async (url, init) => {
      const target = String(url)
      if (target === JEV_URL) {
        const body = JSON.parse(init.body)
        asked.push(body)
        if (/same property/.test(body.questions.q.instructions)) {
          return Response.json({ answers: { q: { noul: /Warehouse Wy/.test(body.state) && /Warehouse Way/i.test(body.state) ? 0.93 : 0.1 } } })
        }
        return Response.json({ answers: { q: { noul: /Industrial/.test(body.state) ? 0.9 : 0.2 } } })
      }
      if (target.includes('data.realestateaistudio.com')) return new Response('missing', { status: 404 })
      return realFetch(url, init)
    }
    forgetParcelSchema()
    const db = nodeAdapter(new DatabaseSync(`${temp.directory}/test.db`))
    await db.migrate()
    await putParcels(db, 'austin-tx', [
      { id: 201, ad: '400 Congress Ave', ow: 'Ridgeline Partners', at: 'Office', mv: 8200000, ac: 0.9, bb: [-97.74, 30.26, -97.73, 30.27] },
      { id: 202, ad: '18 Warehouse Way', ow: 'Vance Logistics', at: 'Industrial', mv: 3100000, ac: 6.5, bb: [-97.6, 30.4, -97.59, 30.41] },
      { id: 203, ad: '9 Scrub Rd', ow: 'Okafor Family Trust', at: 'Land', mv: 120000, ac: 55, bb: [-97.5, 30.5, -97.49, 30.51] },
    ])
    await sealMarket(db, 'austin-tx', { keys: ['id', 'ad', 'mv', 'ac'] })
    forgetParcelSchema()
    app = await createServer({ DATA_DIR: temp.directory, DB_FILE: `${temp.directory}/test.db`, TYPESAFE_API_KEY: 'test-key' })
    const response = await app.fetch(
      new Request('http://localhost/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'jev@example.com', password: 'a long enough password', name: 'Jev' }),
      }),
    )
    cookie = response.headers.get('set-cookie').split(';')[0]
  })

  after(() => {
    globalThis.fetch = realFetch
    temp.cleanup()
  })

  const ask = async (body) => {
    const response = await app.fetch(
      new Request('http://localhost/api/gis/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ market: 'austin-tx', ...body }),
      }),
    )
    return { status: response.status, body: await response.json() }
  }

  test('a judgement in the plan rates each parcel that meets it, best first, from public facts only', async () => {
    asked.length = 0
    const res = await ask({
      prompt: 'which of these would suit a warehouse user',
      plan: { action: 'show', acresMin: 5, score: 'Would this parcel suit a warehouse user?' },
      source: 'ai',
      area: 'view',
      box: [-97.7, 30.35, -97.45, 30.55],
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.mode, 'set', 'a rating needs the rows, so it is not handed back as filters')
    assert.equal(res.body.scored, true)
    assert.deepEqual(res.body.rows.map((r) => r.id), ['202', '203'], 'the warehouse site rates first')
    assert.equal(res.body.rows[0].score, 0.9)
    assert.equal(res.body.page.size, 100)
    assert.ok(asked.every((q) => !/Vance|Okafor/.test(q.state)), 'no owner names go to TypeSafe')
  })

  test('an uploaded address that matched nothing gets a second look, and only a confident yes is taken', async () => {
    const csv = ['Address', '18 Warehouse Wy', '9 Nowhere Pl'].join('\n')
    const res = await ask({ prompt: '', upload: { name: 'a.csv', text: csv } })
    assert.equal(res.status, 200)
    const [first, second] = res.body.rows
    assert.equal(first.id, '202')
    assert.equal(first.match, 'likely')
    assert.match(first.why, /Jev, 93% sure/)
    assert.equal(second.id, null)
    assert.equal(res.body.page.size, 100, 'an upload Jev may look at comes a hundred rows at a time')
  })
})
