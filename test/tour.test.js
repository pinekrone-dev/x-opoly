import assert from 'node:assert/strict'
import test, { describe } from 'node:test'

import { haversineMiles, legs, planTour, routeLength } from '../server/lib/tour.js'

// Real Austin-area coordinates, deliberately out of geographic order.
const SITES = [
  { id: 'georgetown', name: 'Georgetown', lat: 30.6333, lng: -97.677 },
  { id: 'south', name: 'South Lamar', lat: 30.2494, lng: -97.7713 },
  { id: 'roundrock', name: 'Round Rock', lat: 30.5083, lng: -97.6789 },
  { id: 'downtown', name: 'Downtown', lat: 30.2672, lng: -97.7431 },
  { id: 'parmer', name: 'Parmer', lat: 30.4014, lng: -97.7128 },
]

describe('distance', () => {
  test('measures a known distance correctly', () => {
    // Downtown Austin to Round Rock is roughly 17 miles as the crow flies.
    const miles = haversineMiles(SITES[3], SITES[2])
    assert.ok(miles > 15 && miles < 19, `expected ~17 miles, got ${miles.toFixed(1)}`)
  })

  test('a point is zero miles from itself', () => {
    assert.equal(Math.round(haversineMiles(SITES[0], SITES[0])), 0)
  })
})

describe('tour planning', () => {
  test('produces a shorter route than the order it was given', () => {
    const plan = planTour(SITES)
    assert.equal(plan.stops.length, 5)
    assert.ok(plan.miles < routeLength(SITES), `optimized ${plan.miles} should beat original ${routeLength(SITES).toFixed(1)}`)
  })

  test('orders the metro from one end to the other rather than zig-zagging', () => {
    const names = planTour(SITES).stops.map((stop) => stop.name)
    const southFirst = names[0] === 'South Lamar' || names[0] === 'Downtown'
    const northFirst = names[0] === 'Georgetown'
    assert.ok(southFirst || northFirst, `route should start at one end, started at ${names[0]}`)

    // Whichever end it starts from, Georgetown and South Lamar are the extremes.
    const ends = [names[0], names[names.length - 1]].sort()
    assert.deepEqual(ends, ['Georgetown', 'South Lamar'])
  })

  test('honours a pinned starting point', () => {
    const plan = planTour(SITES, { startId: 'parmer' })
    assert.equal(plan.stops[0].id, 'parmer')
    assert.equal(plan.stops.length, 5)
  })

  test('sets aside sites that have no location', () => {
    const plan = planTour([...SITES, { id: 'nogeo', name: 'No coordinates' }])
    assert.equal(plan.stops.length, 5)
    assert.equal(plan.unlocated.length, 1)
    assert.equal(plan.unlocated[0].id, 'nogeo')
  })

  test('handles trivial surveys without failing', () => {
    assert.deepEqual(planTour([]).stops, [])
    assert.equal(planTour([SITES[0]]).miles, 0)
    assert.equal(planTour([SITES[0]]).minutes, 20)
  })

  test('estimates drive time plus time spent at each stop', () => {
    const plan = planTour(SITES)
    // 5 stops at 20 minutes each is the floor, before any driving.
    assert.ok(plan.minutes > 100, `expected more than 100 minutes, got ${plan.minutes}`)
  })

  test('reports one leg between each consecutive pair', () => {
    const plan = planTour(SITES)
    const list = legs(plan.stops)
    assert.equal(list.length, 4)
    assert.equal(list[0].fromId, plan.stops[0].id)
    assert.ok(list.every((leg) => leg.miles >= 0))
  })
})

describe('route quality', () => {
  // These five sites lie roughly on a line up the I-35 corridor, so the
  // shortest open route is simply one end to the other.
  const IDEAL = ['South Lamar', 'Downtown', 'Burnet', 'Parmer', 'Round Rock', 'Georgetown']

  const CORRIDOR = [
    { id: 'parmer', name: 'Parmer', lat: 30.4014, lng: -97.7128 },
    { id: 'south', name: 'South Lamar', lat: 30.2494, lng: -97.7713 },
    { id: 'burnet', name: 'Burnet', lat: 30.3475, lng: -97.7392 },
    { id: 'roundrock', name: 'Round Rock', lat: 30.5083, lng: -97.6789 },
    { id: 'georgetown', name: 'Georgetown', lat: 30.6333, lng: -97.677 },
  ]

  test('finds the end-to-end run instead of starting in the middle', () => {
    const names = planTour(CORRIDOR).stops.map((stop) => stop.name)
    const expected = IDEAL.filter((name) => CORRIDOR.some((site) => site.name === name))
    const forwards = names.join(' > ') === expected.join(' > ')
    const backwards = names.join(' > ') === [...expected].reverse().join(' > ')

    assert.ok(forwards || backwards, `expected the corridor in order, got ${names.join(' > ')}`)
  })

  test('beats the naive nearest-neighbour-from-the-first-site route', () => {
    // The input order starts at Parmer, in the middle of the corridor.
    const optimized = planTour(CORRIDOR).miles
    assert.ok(optimized < 30, `expected under 30 miles for the corridor, got ${optimized}`)
  })

  test('a pinned start is still honoured even though it costs distance', () => {
    const plan = planTour(CORRIDOR, { startId: 'parmer' })
    assert.equal(plan.stops[0].name, 'Parmer')
    assert.ok(plan.miles >= planTour(CORRIDOR).miles, 'pinning cannot beat a free choice of start')
  })
})
