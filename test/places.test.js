import assert from 'node:assert/strict'
import test, { describe } from 'node:test'

import { CATEGORIES, PlacesUnavailable, buildQuery, nearbyBusinesses, parseElements, summarize } from '../server/lib/places.js'

const ORIGIN = { lat: 30.4014, lng: -97.7128 }

const ELEMENTS = [
  { type: 'node', id: 1, lat: 30.405, lon: -97.713, tags: { name: 'Parmer Dental', amenity: 'dentist', 'addr:housenumber': '4100', 'addr:street': 'Parmer Ln', 'addr:city': 'Austin' } },
  { type: 'way', id: 2, center: { lat: 30.44, lon: -97.72 }, tags: { name: 'North Austin Smiles', healthcare: 'dentist' } },
  { type: 'node', id: 3, lat: 30.62, lon: -97.6, tags: { name: 'Georgetown Dental', amenity: 'dentist' } },
  { type: 'node', id: 4, lat: 30.41, lon: -97.71, tags: { amenity: 'dentist' } },
]

describe('query building', () => {
  test('expands a category into its OSM tag filters', () => {
    const query = buildQuery({ lat: 30.4, lng: -97.7, radiusMeters: 1609, category: 'dentist' })
    assert.ok(query.includes('["amenity"="dentist"]'))
    assert.ok(query.includes('["healthcare"="dentist"]'))
    assert.ok(query.includes('around:1609,30.4,-97.7'))
    assert.ok(query.startsWith('[out:json]'))
  })

  test('adds a case-insensitive name filter for a keyword', () => {
    const query = buildQuery({ lat: 30.4, lng: -97.7, radiusMeters: 800, keyword: 'Aspen' })
    assert.ok(query.includes('["name"~"Aspen",i]'))
  })

  test('neutralises regex and quote characters in a keyword', () => {
    const query = buildQuery({ lat: 30.4, lng: -97.7, radiusMeters: 800, keyword: 'a"b.*c' })
    assert.ok(!query.includes('a"b.*c'), 'the raw keyword must not reach the query')
    assert.ok(query.includes('\\"'), 'the quote is escaped')
  })

  test('falls back to named businesses when nothing is specified', () => {
    const query = buildQuery({ lat: 30.4, lng: -97.7, radiusMeters: 800 })
    assert.ok(query.includes('["shop"]["name"]'))
    assert.ok(query.includes('["amenity"]["name"]'))
  })
})

describe('result parsing', () => {
  test('handles both node and way geometry and measures distance', () => {
    const results = parseElements(ELEMENTS, ORIGIN)
    assert.equal(results.length, 3, 'the unnamed element is dropped')
    assert.equal(results[0].name, 'Parmer Dental')
    assert.ok(results[0].miles < 0.5)
    assert.equal(results[0].address, '4100 Parmer Ln, Austin')
    assert.equal(results[1].name, 'North Austin Smiles', 'a way is located by its center')
  })

  test('sorts by distance and assigns each result to a ring', () => {
    const results = parseElements(ELEMENTS, ORIGIN)
    assert.deepEqual(results.map((r) => r.ring), [1, 3, null])
    for (let i = 1; i < results.length; i += 1) {
      assert.ok(results[i].miles >= results[i - 1].miles, 'results are ordered by distance')
    }
  })

  test('deduplicates the same business returned twice', () => {
    const doubled = [...ELEMENTS, { ...ELEMENTS[0], id: 99 }]
    assert.equal(parseElements(doubled, ORIGIN).length, 3)
  })

  test('ring counts are cumulative', () => {
    const rings = summarize(parseElements(ELEMENTS, ORIGIN))
    assert.deepEqual(rings, [
      { miles: 1, count: 1 },
      { miles: 3, count: 2 },
      { miles: 5, count: 2 },
    ])
  })
})

describe('the search itself', () => {
  const okResponse = (elements) => ({ ok: true, status: 200, json: async () => ({ elements }) })

  test('returns ranked results with their ring summary', async () => {
    const data = await nearbyBusinesses({ ...ORIGIN, category: 'dentist', fetchImpl: async () => okResponse(ELEMENTS) })
    assert.equal(data.results.length, 3)
    assert.equal(data.rings.length, 3)
    assert.match(data.source, /OpenStreetMap/)
  })

  test('posts the query rather than putting it in the URL', async () => {
    let captured
    await nearbyBusinesses({
      ...ORIGIN,
      category: 'cafe',
      fetchImpl: async (url, init) => {
        captured = { url, init }
        return okResponse([])
      },
    })
    assert.equal(captured.init.method, 'POST')
    assert.ok(captured.init.body.startsWith('data='))
  })

  test('clamps an absurd radius instead of hammering the directory', async () => {
    const data = await nearbyBusinesses({ ...ORIGIN, radiusMiles: 500, fetchImpl: async () => okResponse([]) })
    assert.equal(data.radiusMiles, 10)
  })

  test('refuses a site with no location', async () => {
    await assert.rejects(() => nearbyBusinesses({ lat: null, lng: null }), PlacesUnavailable)
  })

  test('an unreachable directory is an error, never an empty list', async () => {
    await assert.rejects(
      () => nearbyBusinesses({ ...ORIGIN, fetchImpl: async () => ({ ok: false, status: 403 }) }),
      (error) => error instanceof PlacesUnavailable && /not allowed to reach/.test(error.message),
    )

    await assert.rejects(
      () => nearbyBusinesses({ ...ORIGIN, fetchImpl: async () => { throw new Error('socket hang up') } }),
      PlacesUnavailable,
    )
  })

  test('every category maps to at least one real tag filter', () => {
    for (const [id, entry] of Object.entries(CATEGORIES)) {
      assert.ok(entry.tags.length > 0, `${id} has no tags`)
      assert.ok(entry.label.length > 0, `${id} has no label`)
    }
  })
})
