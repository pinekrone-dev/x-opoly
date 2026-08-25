/**
 * The measurement layer, pinned to independently known values.
 *
 * Everything spatial in the app reduces to three primitives: the haversine
 * in tour.js, the international mile (1609.344 m exactly), and the envelope
 * prefilter demographics uses before its true-circle cut. A silent drift in
 * any of them moves every ring, radius, and drive distance, so each is held
 * here against numbers computed outside this codebase.
 */

import assert from 'node:assert/strict'
import test, { describe } from 'node:test'

import { haversineMiles, routeLength } from '../app/lib/tour.js'
import { estimateLegs } from '../app/lib/routing.js'
import { buildQuery, parseElements, RING_MILES } from '../app/lib/places.js'

/** The app's sphere: mean Earth radius 3958.8 mi, so one degree of arc is… */
const MILES_PER_DEGREE_ARC = (2 * Math.PI * 3958.8) / 360 // 69.09324…

describe('haversine distance', () => {
  test('zero for the same point, and symmetric', () => {
    const austin = { lat: 30.2672, lng: -97.7431 }
    const dallas = { lat: 32.7767, lng: -96.797 }
    assert.equal(haversineMiles(austin, austin), 0)
    assert.equal(haversineMiles(austin, dallas), haversineMiles(dallas, austin))
  })

  test('one degree of latitude measures one degree of arc', () => {
    const d = haversineMiles({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })
    assert.ok(Math.abs(d - MILES_PER_DEGREE_ARC) < 0.0001, `expected ${MILES_PER_DEGREE_ARC}, got ${d}`)
  })

  test('one degree of longitude at the equator measures the same arc', () => {
    const d = haversineMiles({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })
    assert.ok(Math.abs(d - MILES_PER_DEGREE_ARC) < 0.0001)
  })

  test('one degree of longitude at 60°N measures half the equatorial arc', () => {
    // cos(60°) = 0.5 exactly, so the parallel is half-size. Small-separation
    // great-circle vs parallel-arc differ below the tolerance used here.
    const d = haversineMiles({ lat: 60, lng: 0 }, { lat: 60, lng: 1 })
    assert.ok(Math.abs(d - MILES_PER_DEGREE_ARC / 2) < 0.01, `got ${d}`)
  })

  test('antipodal points measure half the circumference', () => {
    const d = haversineMiles({ lat: 0, lng: 0 }, { lat: 0, lng: 180 })
    assert.ok(Math.abs(d - Math.PI * 3958.8) < 0.001)
  })

  test('a known city pair lands on the textbook great-circle distance', () => {
    // LAX (33.9425, −118.4081) to JFK (40.6398, −73.7789): the canonical
    // spherical-earth test pair, ≈ 2,470 statute miles. A kilometre/nautical
    // radius mix-up would miss this by hundreds of miles.
    const d = haversineMiles({ lat: 33.9425, lng: -118.4081 }, { lat: 40.6398, lng: -73.7789 })
    assert.ok(Math.abs(d - 2470) < 6, `expected ≈2470, got ${d}`)
  })

  test('route length is the sum of its legs', () => {
    const a = { lat: 30, lng: -97 }
    const b = { lat: 30.5, lng: -97.5 }
    const c = { lat: 31, lng: -97 }
    assert.equal(routeLength([a, b, c]), haversineMiles(a, b) + haversineMiles(b, c))
  })
})

describe('mile conversions', () => {
  test('the Overpass radius uses the exact international mile', () => {
    // 5 miles = 8046.72 m exactly; the query must carry the rounded metre figure.
    const query = buildQuery({ lat: 30, lng: -97, radiusMeters: Math.round(5 * 1609.344), category: null, keyword: 'x' })
    assert.ok(query.includes('around:8047,'), query)
  })

  test('the frontend draws circles with the same exact mile', async () => {
    const source = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/lib/geo.ts', import.meta.url), 'utf8'))
    assert.ok(source.includes('1609.344'), 'src/lib/geo.ts must carry the exact international mile')
    const canvas = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/components/MapCanvas.tsx', import.meta.url), 'utf8'),
    )
    assert.ok(!/1609\.34\b/.test(canvas), 'no truncated mile constant may survive in the map')
    assert.ok(canvas.includes('METERS_PER_MILE'), 'circles convert through the shared constant')
  })
})

describe('straight-line estimates', () => {
  test('estimate legs apply the detour factor and the fallback speed', () => {
    // One degree of longitude at the equator: 69.0932 mi crow-flies.
    const { legs, source } = estimateLegs([
      { lat: 0, lng: 0 },
      { lat: 0, lng: 1 },
    ])
    assert.equal(source, 'estimate')
    const expectedMiles = MILES_PER_DEGREE_ARC * 1.25
    assert.ok(Math.abs(legs[0].miles - Math.round(expectedMiles * 10) / 10) < 0.001)
    assert.equal(legs[0].minutes, Math.round((expectedMiles / 30) * 60))
  })
})

describe('ring assignment', () => {
  test('a business lands in the innermost ring that contains it', () => {
    const origin = { lat: 30, lng: -97 }
    // ~0.5, ~2, ~4 and ~6 miles due north of the origin on the app's sphere.
    const at = (miles) => ({
      type: 'node',
      id: miles * 1000,
      lat: 30 + miles / MILES_PER_DEGREE_ARC,
      lon: -97,
      tags: { name: `Site ${miles}`, shop: 'yes' },
    })
    const parsed = parseElements([at(0.5), at(2), at(4), at(6)], origin)
    assert.deepEqual(parsed.map((p) => p.ring), [1, 3, 5, null])
    assert.deepEqual(RING_MILES, [1, 3, 5])
  })

  test('the ring boundary itself is inclusive', () => {
    const origin = { lat: 30, lng: -97 }
    const exactlyOne = {
      type: 'node',
      id: 1,
      lat: 30 + 1 / MILES_PER_DEGREE_ARC,
      lon: -97,
      tags: { name: 'Boundary', shop: 'yes' },
    }
    const [parsed] = parseElements([exactlyOne], origin)
    assert.equal(parsed.ring, 1)
    assert.equal(parsed.miles, 1)
  })
})

describe('the demographics envelope prefilter', () => {
  /**
   * Reimplements the spans from fetchBlockGroups to prove the property that
   * matters: every point the app's own haversine admits into the widest ring
   * lies inside the envelope, at any latitude the product serves. The
   * envelope may be generous — it is a prefilter — but it must never clip.
   */
  const MILES_PER_DEGREE = 69
  const spans = (lat, miles) => ({
    latSpan: miles / MILES_PER_DEGREE,
    lngSpan: miles / (MILES_PER_DEGREE * Math.max(0.01, Math.cos((lat * Math.PI) / 180))),
  })

  test('the envelope contains the full circle at every tested latitude', () => {
    for (const lat of [0, 25.76, 30.27, 40.71, 47.61, 61.22]) {
      for (const miles of [1, 3, 5, 10]) {
        const { latSpan, lngSpan } = spans(lat, miles)
        for (let bearing = 0; bearing < 360; bearing += 15) {
          // Walk out along the bearing until the haversine reads `miles`.
          const rad = (bearing * Math.PI) / 180
          let low = 0
          let high = 1
          const at = (t) => ({
            lat: lat + t * Math.cos(rad),
            lng: 0 + (t * Math.sin(rad)) / Math.cos((lat * Math.PI) / 180),
          })
          while (haversineMiles({ lat, lng: 0 }, at(high)) < miles) high *= 2
          for (let i = 0; i < 40; i += 1) {
            const mid = (low + high) / 2
            if (haversineMiles({ lat, lng: 0 }, at(mid)) < miles) low = mid
            else high = mid
          }
          const edge = at(high)
          assert.ok(
            Math.abs(edge.lat - lat) <= latSpan + 1e-9 && Math.abs(edge.lng - 0) <= lngSpan + 1e-9,
            `point ${miles} mi out at bearing ${bearing}° from lat ${lat} escaped the envelope`,
          )
        }
      }
    }
  })
})
