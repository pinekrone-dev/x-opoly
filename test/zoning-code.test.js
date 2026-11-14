/**
 * Ask the zoning code: a district's brief read from AI Search and checked
 * against the passages it quotes, the lot arithmetic, the month's cap, and
 * the pipeline's door that loads the pages.
 */
import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'

import { createServer } from '../server/index.js'
import { useTempData } from './helpers.js'
import { groundBrief, lotYield, readJson, routeFor, squash, STANDARDS } from '../app/lib/zoningcode.js'

const INDEX = {
  as_of: '2026-11-14', edition: 'May 7, 2026', ready: true,
  jurisdiction: 'City and County of Denver', title: 'Denver Zoning Code',
  publisher: 'Denver Community Planning and Development', source: 'https://city.test/code',
  routes: [
    { match: '^PUD', skip: 'A planned unit development is governed by its own approved plan.' },
    { match: '^U-', folder: 'a05', label: 'Urban (U-) Neighborhood Context' },
  ],
  docs: [
    { key: 'a05-p0001', item: 'a05/a05-p0001.md', bundle: 'zoning-code-a05.md', part: 0, title: 'Article 5: Urban', page: 12, url: 'https://city.test/a5.pdf#page=12', chars: 80 },
    { key: 'a05-p0002', item: 'a05/a05-p0002.md', bundle: 'zoning-code-a05.md', part: 1, title: 'Article 5: Urban', page: 13, url: 'https://city.test/a5.pdf#page=13', chars: 80 },
  ],
}

const CHUNKS = [
  { text: 'U-MX-3   Stories (max) 3   Feet (max) 45\'   Primary street setback (min) 0\'', item: { key: 'a05/a05-p0001.md' } },
  { text: 'Permitted uses: Dwelling, Multi-Unit; Office; Retail Sales. Lot coverage (max) 70%. Zone lot size (min) 3,000 sf', item: { key: 'a05/a05-p0002.md' } },
]

describe('reading a model reply', () => {
  test('the first JSON object, whatever surrounds it', () => {
    assert.deepEqual(readJson('Here you go:\n```json\n{"a": {"b": "}"}, "c": 1}\n``` thanks'), { a: { b: '}' }, c: 1 })
    assert.equal(readJson('no object here'), null)
    assert.equal(readJson('{"cut": '), null)
  })

  test('squash flattens case, spacing and typographic marks', () => {
    assert.equal(squash('  Feet\n (max)— 45’ '), "feet (max)- 45'")
  })
})

describe('grounding a brief in the passages', () => {
  const raw = {
    summary: 'A mixed use district of up to three stories.',
    highest_use: 'Three-story mixed use building',
    standards: [
      { key: 'stories', value: 3, quote: 'Stories (max) 3' },
      { key: 'height_ft', value: 45, quote: 'Maximum height is forty-five feet' },
      { key: 'lot_coverage_pct', value: 70, quote: 'Lot coverage (max) 70%' },
      { key: 'far', value: 250, quote: 'FAR 2.5' },
      { key: 'min_lot_area_sf', value: 3000, quote: 'Zone lot size (min) 3,000 sf' },
      { key: 'made_up', value: 9, quote: 'Stories (max) 3' },
      { key: 'stories', value: 5, quote: 'Stories (max) 3' },
    ],
    uses: [
      { use: 'Office', how: 'by right', quote: 'Office' },
      { use: 'Casino', how: 'by right', quote: 'Casino gaming permitted' },
      { use: 'Retail Sales', how: 'sometimes', quote: 'nothing like the text' },
    ],
    notes: ['Upper story setbacks apply.'],
  }
  const brief = groundBrief(raw, CHUNKS, INDEX)

  test('a figure whose words are in the passages is cited, with its page', () => {
    const stories = brief.standards.find((s) => s.key === 'stories')
    assert.equal(stories.status, 'cited')
    assert.equal(stories.value, 3)
    assert.equal(stories.source.page, 12)
    assert.equal(stories.source.url, 'https://city.test/a5.pdf#page=12')
    assert.equal(brief.standards.find((s) => s.key === 'min_lot_area_sf').status, 'cited')
  })

  test('a figure with only its number in the passages is marked check', () => {
    const height = brief.standards.find((s) => s.key === 'height_ft')
    assert.equal(height.status, 'check')
    assert.equal(height.quote, null)
  })

  test('a figure found nowhere in the passages is dropped, and so is an unknown key', () => {
    assert.equal(brief.standards.find((s) => s.key === 'far'), undefined)
    assert.equal(brief.standards.some((s) => s.key === 'made_up'), false)
    assert.equal(brief.standards.filter((s) => s.key === 'stories').length, 1)
  })

  test('a use is kept only when the passages name it', () => {
    assert.deepEqual(brief.uses.map((u) => u.use), ['Office', 'Retail Sales'])
    assert.equal(brief.uses[1].how, 'by right')
  })
})

describe('what a lot could carry', () => {
  const line = (key, value, status = 'cited') => ({ key, value, status, label: STANDARDS[key].label, unit: STANDARDS[key].unit })

  test('floor area from a ratio, written either way', () => {
    assert.equal(lotYield([line('far', 500)], 1)[0].value, 217800)
    assert.equal(lotYield([line('far', 5)], 1)[0].value, 217800)
  })

  test('footprint and floor area at full height from coverage and stories', () => {
    const out = lotYield([line('lot_coverage_pct', 70), line('stories', 3, 'check')], 0.5)
    assert.equal(out.find((o) => o.label === 'Largest building footprint').value, 15246)
    const full = out.find((o) => o.label === 'Floor area at full height')
    assert.equal(full.value, 45738)
    assert.equal(full.check, true)
  })

  test('units and lots, and nothing without a lot size', () => {
    const out = lotYield([line('lot_area_per_unit_sf', 1000), line('min_lot_area_sf', 6000)], 1)
    assert.equal(out.find((o) => o.label === 'Dwelling units').value, 43)
    assert.equal(out.find((o) => o.label === 'Lots it could divide into').value, 7)
    assert.deepEqual(lotYield([line('far', 500)], null), [])
  })
})

describe('routes', () => {
  test('the first matching route decides the article', () => {
    assert.equal(routeFor('U-MX-3', INDEX).folder, 'a05')
    assert.ok(routeFor('PUD-G', INDEX).skip)
    assert.equal(routeFor('B-4', INDEX), null)
  })
})

/* The routes, against a stand-in for the AI Search binding. */
const temp = useTempData()
let app
let cookie = null
const calls = { completions: [], uploads: [], created: [] }
let reply = null

const AI_SEARCH = {
  get: () => ({
    chatCompletions: async (request) => {
      calls.completions.push(request)
      return { choices: [{ message: { content: reply } }], chunks: CHUNKS, model: 'test-model' }
    },
    items: {
      upload: async (name, text) => { calls.uploads.push({ name, text }); return { id: name, key: name } },
      list: async ({ status }) => ({ result: [], result_info: { total_count: status === 'completed' ? 2 : 0 } }),
    },
  }),
  list: async () => ({ result: [] }),
  create: async (options) => { calls.created.push(options.id) },
}

const objects = new Map()
const PROSPECTOR_DATA = {
  get: async (key) => (objects.has(key) ? { text: async () => objects.get(key) } : null),
  put: async (key, body) => { objects.set(key, typeof body === 'string' ? body : new TextDecoder().decode(body)) },
}

const call = async (path, body, headers = {}) => {
  const res = await app.fetch(new Request(`http://localhost${path}`, {
    method: 'POST', body: JSON.stringify(body ?? {}),
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
  }))
  const set = res.headers.get('set-cookie')
  if (set) cookie = set.split(';')[0]
  return { status: res.status, body: await res.json().catch(() => null) }
}

before(async () => {
  app = await createServer({ DATA_DIR: temp.directory, DB_FILE: `${temp.directory}/test.db`, AI_SEARCH, PROSPECTOR_DATA,
    CODE_SEARCH_MONTHLY_CAP: '3' })
  objects.set('denver-co/zoning-code.json', JSON.stringify(INDEX))
  objects.set('denver-co/zoning-code-a05.md', 'page one text\fpage two text')
})

after(() => temp.cleanup())

describe('the zoning code route', () => {
  test('needs a signed-in user', async () => {
    assert.equal((await call('/api/gis/zoning-code', { market: 'denver-co', zone: 'U-MX-3' })).status, 401)
  })

  test('a market with no published code is not covered', async () => {
    await call('/api/auth/register', { email: 'code@example.com', password: 'a long enough password', name: 'C' })
    const res = await call('/api/gis/zoning-code', { market: 'austin-tx', zone: 'SF-3' })
    assert.equal(res.status, 200)
    assert.equal(res.body.covered, false)
  })

  test('a district is read once, grounded, and the lot arithmetic follows', async () => {
    reply = JSON.stringify({
      summary: 'Mixed use, up to three stories.', highest_use: 'Three-story mixed use',
      standards: [{ key: 'stories', value: 3, quote: 'Stories (max) 3' }, { key: 'lot_coverage_pct', value: 70, quote: 'Lot coverage (max) 70%' }],
      uses: [{ use: 'Office', how: 'by right', quote: 'Office' }],
    })
    const first = await call('/api/gis/zoning-code', { market: 'denver-co', zone: 'U-MX-3', acres: 0.5 })
    assert.equal(first.status, 200)
    assert.equal(first.body.covered, true)
    assert.equal(first.body.about.title, 'Denver Zoning Code')
    assert.equal(first.body.brief.standards.length, 2)
    assert.equal(first.body.yield.find((y) => y.label === 'Floor area at full height').value, 45738)
    // The district's own article, and no other, was searched.
    assert.deepEqual(calls.completions[0].ai_search_options.retrieval.filters, { folder: 'a05/' })
    assert.match(calls.completions[0].messages[1].content, /U-MX-3 \(Urban \(U-\) Neighborhood Context\)/)

    const again = await call('/api/gis/zoning-code', { market: 'denver-co', zone: 'U-MX-3', acres: 2 })
    assert.equal(again.body.brief.standards.length, 2)
    assert.equal(calls.completions.length, 1, 'the stored brief answers the second lot')
  })

  test('a planned unit development is answered without a search', async () => {
    const res = await call('/api/gis/zoning-code', { market: 'denver-co', zone: 'PUD-G' })
    assert.match(res.body.note, /its own approved plan/)
    assert.equal(calls.completions.length, 1)
  })

  test('a question is answered with the pages it read, until the month is spent', async () => {
    reply = 'Office is permitted.'
    const res = await call('/api/gis/zoning-code', { market: 'denver-co', zone: 'U-MX-3', question: 'Is office allowed?' })
    assert.equal(res.status, 200)
    assert.equal(res.body.answer, 'Office is permitted.')
    assert.equal(res.body.sources[0].page, 12)
    // The cap is 3: the brief, this question, one more, then refused.
    assert.equal((await call('/api/gis/zoning-code', { market: 'denver-co', question: 'And retail?' })).status, 200)
    const over = await call('/api/gis/zoning-code', { market: 'denver-co', question: 'And a third?' })
    assert.equal(over.status, 429)
  })

  test('a market whose index is not ready is not covered', async () => {
    objects.set('denver-co/zoning-code.json', JSON.stringify({ ...INDEX, ready: false }))
    const res = await call('/api/gis/zoning-code', { market: 'denver-co', zone: 'U-MX-3' })
    assert.equal(res.body.covered, false)
    objects.set('denver-co/zoning-code.json', JSON.stringify(INDEX))
  })

  test('the loading door refuses a caller without the pipeline\'s proof', async () => {
    const res = await call('/api/gis/ingest/code?market=denver-co', {}, { authorization: 'Bearer nonsense' })
    assert.equal(res.status, 401)
    assert.equal(calls.uploads.length, 0)
  })
})
