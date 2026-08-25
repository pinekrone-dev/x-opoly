/**
 * Trade-area figures.
 *
 * The arithmetic matters more than the plumbing here: these numbers go in
 * front of a client, and the difference between adding a median and weighting
 * one is the difference between a defensible figure and a made-up one.
 */

import assert from 'node:assert/strict'
import test, { describe } from 'node:test'

import {
  DemographicsUnavailable,
  aggregate,
  demographicsFor,
  fetchBlockGroups,
  resetLayerCache,
} from '../app/lib/demographics.js'

/** TIGERweb's service metadata, which names the block group layer. */
const LAYERS = {
  layers: [
    { id: 4, name: 'Counties' },
    { id: 8, name: 'Census Tracts' },
    { id: 12, name: 'Census Block Groups' },
  ],
}

/**
 * Answers the layer-metadata request first, then whatever the test supplies.
 * Layer discovery replaced a hardcoded id that was wrong.
 */
function withLayerLookup(...responses) {
  let call = 0
  return async (url) => {
    call += 1
    if (call === 1) return { ok: true, status: 200, json: async () => LAYERS }
    const next = responses[call - 2] ?? responses[responses.length - 1]
    return typeof next === 'function' ? next(url) : next
  }
}

const AUSTIN = { lat: 30.2672, lng: -97.7431 }

function blockGroup(overrides = {}) {
  return {
    population: 1000,
    households: 400,
    medianHouseholdIncome: 80000,
    medianHomeValue: 300000,
    medianAge: 35,
    occupiedUnits: 400,
    renterOccupied: 100,
    educationUniverse: 700,
    bachelors: 200,
    masters: 50,
    professional: 10,
    doctorate: 5,
    ...overrides,
  }
}

describe('aggregating block groups into a ring', () => {
  test('counts add up', () => {
    const { metrics, blockGroups } = aggregate([
      blockGroup({ population: 600, households: 200 }),
      blockGroup({ population: 900, households: 350 }),
    ])

    assert.equal(metrics.population, 1500)
    assert.equal(metrics.households, 550)
    assert.equal(blockGroups, 2)
  })

  test('medians are weighted by population, never summed', () => {
    const { metrics } = aggregate([
      blockGroup({ population: 1000, medianHouseholdIncome: 50000 }),
      blockGroup({ population: 3000, medianHouseholdIncome: 150000 }),
    ])

    // Adding these would give 200000; averaging them flat would give 100000.
    // Weighted by the people behind each figure it is 125000.
    assert.equal(metrics.medianHouseholdIncome, 125000)
  })

  test('a block group with no residents cannot skew a median', () => {
    const { metrics } = aggregate([
      blockGroup({ population: 1000, medianAge: 40 }),
      // An industrial block group: a published median, nobody living there.
      blockGroup({ population: 0, medianAge: 90 }),
    ])
    assert.equal(metrics.medianAge, 40)
  })

  test('shares come from the summed counts, not averaged percentages', () => {
    const { metrics } = aggregate([
      // 10% renters among 1000 units, and 90% among 10. Averaging the two
      // percentages would say 50%; the truth is close to 10%.
      blockGroup({ occupiedUnits: 1000, renterOccupied: 100 }),
      blockGroup({ occupiedUnits: 10, renterOccupied: 9 }),
    ])
    assert.equal(metrics.renterShare, 10.8)
  })

  test('education counts every degree at or above a bachelor’s', () => {
    const { metrics } = aggregate([
      blockGroup({
        educationUniverse: 1000,
        bachelors: 200,
        masters: 100,
        professional: 30,
        doctorate: 20,
      }),
    ])
    assert.equal(metrics.educationShare, 35)
  })

  test('a suppressed value is left null rather than counted as zero', () => {
    const { metrics } = aggregate([
      blockGroup({ medianHouseholdIncome: null, population: 500 }),
    ])
    assert.equal(metrics.medianHouseholdIncome, null)
  })

  test('an empty ring reports nothing rather than zeroes for medians', () => {
    const { metrics, blockGroups } = aggregate([])
    assert.equal(blockGroups, 0)
    assert.equal(metrics.population, 0)
    assert.equal(metrics.medianHouseholdIncome, null)
    assert.equal(metrics.renterShare, null)
  })
})

describe('finding block groups', () => {
  test('reads centroids and measures them from the site', async () => {
    resetLayerCache()
    const fetchImpl = withLayerLookup({
      ok: true,
      status: 200,
      json: async () => ({
        features: [
          {
            properties: {
              GEOID: '484530011001',
              STATE: '48',
              COUNTY: '453',
              TRACT: '001100',
              BLKGRP: '1',
              CENTLAT: '30.2700',
              CENTLON: '-97.7400',
            },
            geometry: { type: 'Polygon', coordinates: [] },
          },
        ],
      }),
    })

    const groups = await fetchBlockGroups(AUSTIN.lat, AUSTIN.lng, 5, { fetchImpl })

    assert.equal(groups.length, 1)
    assert.equal(groups[0].geoid, '484530011001')
    assert.ok(groups[0].miles < 1, 'a centroid a few hundred metres away is under a mile')
  })

  test('a feature with no centroid and no geometry is a reported failure', async () => {
    // Silently returning [] here is what made a real outage look like "this
    // address has no census coverage".
    resetLayerCache()
    const fetchImpl = withLayerLookup({
      ok: true,
      status: 200,
      json: async () => ({
        features: [{ properties: { GEOID: 'x', CENTLAT: '', CENTLON: '' }, geometry: null }],
      }),
    })
    await assert.rejects(
      () => fetchBlockGroups(AUSTIN.lat, AUSTIN.lng, 5, { fetchImpl }),
      /none carried a usable location/,
    )
  })

  test('the polygon layer is picked over the labels layer of the same name', async () => {
    // TIGERweb lists "Census Block Groups Labels" before "Census Block Groups",
    // so a loose name match lands on the labels and the query comes back with
    // nothing — which reads as "this area has no census coverage".
    resetLayerCache()
    let queried = null
    const fetchImpl = async (url) => {
      if (!url.includes('/query')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            layers: [
              { id: 11, name: 'Census Block Groups Labels' },
              { id: 12, name: 'Census Block Groups' },
            ],
          }),
        }
      }
      queried = url
      return {
        ok: true,
        status: 200,
        json: async () => ({
          features: [
            {
              attributes: { GEOID: '1', STATE: '48', COUNTY: '453', CENTLAT: '30.27', CENTLON: '-97.74' },
              geometry: null,
            },
          ],
        }),
      }
    }

    await fetchBlockGroups(AUSTIN.lat, AUSTIN.lng, 5, { fetchImpl })
    assert.match(queried, /MapServer\/12\/query/, 'the labels layer holds no polygons to return')
  })

  test('a layer that answers with nothing is not the end of the search', async () => {
    // Live, discovery picked layer 4 and the request came back empty, which
    // was reported as "no block groups for that area" over downtown Dallas.
    // Several layers share the name; only one of them holds the polygons, and
    // which one is not worth encoding. Try them.
    resetLayerCache()
    const asked = []
    const fetchImpl = async (url) => {
      if (!url.includes('/query')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            layers: [
              { id: 4, name: 'Census Block Groups', subLayerIds: [5, 6] },
              { id: 5, name: 'Census Block Groups Labels' },
              { id: 6, name: 'Census Block Groups' },
            ],
          }),
        }
      }
      const layer = Number(url.match(/MapServer\/(\d+)\/query/)[1])
      asked.push(layer)
      return {
        ok: true,
        status: 200,
        json: async () =>
          layer === 6
            ? {
                features: [
                  {
                    attributes: {
                      GEOID: '484530011001',
                      STATE: '48',
                      COUNTY: '453',
                      CENTLAT: '30.27',
                      CENTLON: '-97.74',
                    },
                  },
                ],
              }
            : { features: [] },
      }
    }

    const groups = await fetchBlockGroups(AUSTIN.lat, AUSTIN.lng, 5, { fetchImpl })
    assert.equal(groups.length, 1)
    assert.equal(groups[0].geoid, '484530011001')
    assert.ok(asked.includes(6), 'the polygons were reached')

    // And the layer that worked is remembered, rather than rediscovered.
    const before = asked.length
    await fetchBlockGroups(AUSTIN.lat, AUSTIN.lng, 5, { fetchImpl })
    assert.deepEqual(asked.slice(before), [6])
  })

  test('the geometry is asked for in the format every ArcGIS server speaks', async () => {
    // `f=geojson` is optional, and this MapServer answers it with an error
    // object and HTTP 200 — so `features` was simply absent and the failure
    // surfaced as an empty area rather than a rejected request.
    resetLayerCache()
    let queried = null
    const fetchImpl = withLayerLookup((url) => {
      queried = url
      return {
        ok: true,
        status: 200,
        json: async () => ({
          features: [
            {
              attributes: { GEOID: '1', STATE: '48', COUNTY: '453', CENTLAT: '30.27', CENTLON: '-97.74' },
            },
          ],
        }),
      }
    })

    await fetchBlockGroups(AUSTIN.lat, AUSTIN.lng, 5, { fetchImpl })
    assert.match(queried, /[?&]f=json(&|$)/, 'esriJSON is the format that is always supported')
  })

  test('an ArcGIS error carried in a 200 is reported, not read as empty coverage', async () => {
    resetLayerCache()
    const fetchImpl = withLayerLookup({
      ok: true,
      status: 200,
      json: async () => ({
        error: { code: 400, message: 'Unable to complete operation.', details: [] },
      }),
    })

    await assert.rejects(
      () => fetchBlockGroups(AUSTIN.lat, AUSTIN.lng, 5, { fetchImpl }),
      /Unable to complete operation/,
    )
  })

  test('esriJSON is read as readily as GeoJSON', async () => {
    // ArcGIS answers `attributes`, not `properties`. Reading only one shape
    // dropped every feature and looked identical to empty coverage.
    resetLayerCache()
    const fetchImpl = withLayerLookup({
      ok: true,
      status: 200,
      json: async () => ({
        features: [
          {
            attributes: {
              GEOID: '484530011001',
              STATE: '48',
              COUNTY: '453',
              TRACT: '001100',
              BLKGRP: '1',
              CENTLAT: '30.2700',
              CENTLON: '-97.7400',
            },
            geometry: { rings: [[[-97.74, 30.27], [-97.73, 30.27], [-97.73, 30.28]]] },
          },
        ],
      }),
    })

    const groups = await fetchBlockGroups(AUSTIN.lat, AUSTIN.lng, 5, { fetchImpl })
    assert.equal(groups.length, 1)
    assert.equal(groups[0].geoid, '484530011001')
  })

  test('a missing centroid falls back to the polygon rather than being dropped', async () => {
    resetLayerCache()
    const fetchImpl = withLayerLookup({
      ok: true,
      status: 200,
      json: async () => ({
        features: [
          {
            properties: { GEOID: '1', STATE: '48', COUNTY: '453', TRACT: '1', BLKGRP: '1' },
            geometry: {
              type: 'Polygon',
              coordinates: [[[-97.75, 30.26], [-97.73, 30.26], [-97.73, 30.28], [-97.75, 30.28]]],
            },
          },
        ],
      }),
    })

    const groups = await fetchBlockGroups(AUSTIN.lat, AUSTIN.lng, 5, { fetchImpl })
    assert.equal(groups.length, 1)
    assert.ok(Math.abs(groups[0].lat - 30.27) < 0.01, `got ${groups[0].lat}`)
    assert.ok(Math.abs(groups[0].lng - -97.74) < 0.01, `got ${groups[0].lng}`)
  })

  test('an empty answer says the service returned nothing', async () => {
    resetLayerCache()
    const fetchImpl = withLayerLookup({ ok: true, status: 200, json: async () => ({ features: [] }) })
    await assert.rejects(
      () => fetchBlockGroups(AUSTIN.lat, AUSTIN.lng, 5, { fetchImpl }),
      /returned no block groups/,
    )
  })

  test('the block group layer is discovered, not guessed', async () => {
    resetLayerCache()
    const seen = []
    const fetchImpl = async (url) => {
      seen.push(String(url))
      if (seen.length === 1) return { ok: true, status: 200, json: async () => LAYERS }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          features: [
            {
              properties: { GEOID: '1', CENTLAT: '30.27', CENTLON: '-97.74' },
              geometry: null,
            },
          ],
        }),
      }
    }

    await fetchBlockGroups(AUSTIN.lat, AUSTIN.lng, 5, { fetchImpl })
    // 12 is the block group layer in the stubbed metadata, not the 10 that was
    // originally hardcoded.
    assert.match(seen[1], /MapServer\/12\/query/)
  })
})

describe('rings end to end', () => {
  /**
   * Layer metadata, then TIGERweb, then ACS — the order the module calls them.
   *
   * Answering the metadata request explicitly matters: these tests previously
   * passed only because an earlier test in the file had populated the
   * module-level layer cache, so run on their own they failed.
   */
  function stubCensus() {
    let call = 0
    return async () => {
      call += 1
      if (call === 1) {
        return { ok: true, status: 200, json: async () => LAYERS }
      }
      if (call === 2) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            features: [
              near('484530011001', 30.2700, -97.7400), // ~0.3 mi
              near('484530011002', 30.2900, -97.7400), // ~1.6 mi
              near('484530011003', 30.3300, -97.7400), // ~4.3 mi
            ],
          }),
        }
      }
      return {
        ok: true,
        status: 200,
        json: async () => [
          ['NAME', 'B01003_001E', 'B11001_001E', 'state', 'county', 'tract', 'block group'],
          ['BG 1', '1000', '400', '48', '453', '001100', '1'],
          ['BG 2', '2000', '800', '48', '453', '001100', '2'],
          ['BG 3', '4000', '1600', '48', '453', '001100', '3'],
        ],
      }
    }
  }

  function near(geoid, lat, lng) {
    return {
      properties: {
        GEOID: geoid,
        STATE: '48',
        COUNTY: '453',
        TRACT: '001100',
        BLKGRP: geoid.slice(-1),
        CENTLAT: String(lat),
        CENTLON: String(lng),
      },
      geometry: { type: 'Polygon', coordinates: [] },
    }
  }

  test('each ring only counts what falls inside it', async () => {
    resetLayerCache()
    const result = await demographicsFor(AUSTIN.lat, AUSTIN.lng, { fetchImpl: stubCensus() })

    const [one, three, five] = result.radii
    assert.equal(one.miles, 1)
    assert.equal(one.metrics.population, 1000, 'only the nearest block group is within a mile')
    assert.equal(three.metrics.population, 3000, 'the 1.6-mile group joins at three miles')
    assert.equal(five.metrics.population, 7000, 'all three are within five')
  })

  test('rings are cumulative, as a trade area is', async () => {
    resetLayerCache()
    const { radii } = await demographicsFor(AUSTIN.lat, AUSTIN.lng, { fetchImpl: stubCensus() })
    assert.ok(radii[0].metrics.population <= radii[1].metrics.population)
    assert.ok(radii[1].metrics.population <= radii[2].metrics.population)
  })

  test('block groups come back for the map to colour', async () => {
    resetLayerCache()
    const { areas } = await demographicsFor(AUSTIN.lat, AUSTIN.lng, { fetchImpl: stubCensus() })
    assert.equal(areas.length, 3)
    assert.ok(areas[0].geometry, 'geometry is included so the choropleth can draw')
    assert.equal(areas[0].metrics.population, 1000)
  })

  test('geometry can be left out when only the numbers are wanted', async () => {
    resetLayerCache()
    const { areas } = await demographicsFor(AUSTIN.lat, AUSTIN.lng, {
      fetchImpl: stubCensus(),
      includeGeometry: false,
    })
    assert.equal(areas[0].geometry, null)
  })

  test('an unreachable service says so rather than inventing figures', async () => {
    resetLayerCache()
    const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) })
    await assert.rejects(
      () => demographicsFor(AUSTIN.lat, AUSTIN.lng, { fetchImpl }),
      (error) => error instanceof DemographicsUnavailable,
    )
  })

  test('a site with no location is rejected before any request', async () => {
    resetLayerCache()
    await assert.rejects(
      () => demographicsFor(null, null, { fetchImpl: stubCensus() }),
      (error) => error instanceof DemographicsUnavailable,
    )
  })
})
