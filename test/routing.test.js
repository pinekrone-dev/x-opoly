/**
 * Drive times, road geometry, and the clock schedule built from them.
 *
 * The routing service is injected, so these run without a network and still
 * exercise the real parsing — including every way the service can let us down.
 */

import assert from 'node:assert/strict'
import test, { describe } from 'node:test'

import { estimateLegs, routeLegs } from '../app/lib/routing.js'
import { buildItinerary, formatClock, formatDuration, parseClock } from '../app/lib/tour.js'

const AUSTIN = { lat: 30.2672, lng: -97.7431 }
const PECAN = { lat: 30.4, lng: -97.72 }
const BELTERRA = { lat: 30.16, lng: -98.0 }

/** A stand-in for OSRM that answers with whatever the test needs. */
function fakeOsrm(payload, { ok = true, status = 200 } = {}) {
  return async () => ({
    ok,
    status,
    json: async () => payload,
  })
}

function okRoute(legs, coordinates = [[-97.74, 30.26], [-97.72, 30.4]]) {
  return {
    code: 'Ok',
    routes: [{ legs, geometry: { type: 'LineString', coordinates } }],
  }
}

describe('road routing', () => {
  test('reads distance and duration per leg', async () => {
    const fetchImpl = fakeOsrm(
      okRoute([
        { distance: 16093.44, duration: 1140 },
        { distance: 32186.88, duration: 2160 },
      ]),
    )

    const result = await routeLegs([AUSTIN, PECAN, BELTERRA], { fetchImpl })

    assert.equal(result.source, 'osrm')
    assert.deepEqual(result.legs, [
      { miles: 10, minutes: 19 },
      { miles: 20, minutes: 36 },
    ])
  })

  test('returns geometry as lat/lng, not the lng/lat GeoJSON ships', async () => {
    const fetchImpl = fakeOsrm(
      okRoute([{ distance: 1000, duration: 60 }], [[-97.74, 30.26], [-97.72, 30.4]]),
    )

    const { geometry } = await routeLegs([AUSTIN, PECAN], { fetchImpl })

    // Austin is near 30°N, -97°E. Getting this backwards puts the route in Asia.
    assert.deepEqual(geometry, [[30.26, -97.74], [30.4, -97.72]])
  })

  test('falls back to an estimate when the service errors', async () => {
    const fetchImpl = fakeOsrm({}, { ok: false, status: 503 })
    const result = await routeLegs([AUSTIN, PECAN], { fetchImpl })

    assert.equal(result.source, 'estimate')
    assert.equal(result.legs.length, 1)
    assert.ok(result.legs[0].minutes > 0)
  })

  test('falls back when the service refuses to route', async () => {
    const fetchImpl = fakeOsrm({ code: 'NoRoute', message: 'no route' })
    const { source } = await routeLegs([AUSTIN, PECAN], { fetchImpl })
    assert.equal(source, 'estimate')
  })

  test('falls back when the leg count does not match the stops', async () => {
    // Trusting a short leg list would silently shift every arrival time.
    const fetchImpl = fakeOsrm(okRoute([{ distance: 1000, duration: 60 }]))
    const { source } = await routeLegs([AUSTIN, PECAN, BELTERRA], { fetchImpl })
    assert.equal(source, 'estimate')
  })

  test('falls back when the network throws outright', async () => {
    const fetchImpl = async () => {
      throw new Error('getaddrinfo ENOTFOUND router.project-osrm.org')
    }
    const { source, legs } = await routeLegs([AUSTIN, PECAN], { fetchImpl })
    assert.equal(source, 'estimate')
    assert.equal(legs.length, 1)
  })

  test('a single point needs no routing at all', async () => {
    let called = false
    const fetchImpl = async () => {
      called = true
      throw new Error('should not be called')
    }
    const result = await routeLegs([AUSTIN], { fetchImpl })
    assert.equal(called, false)
    assert.deepEqual(result.legs, [])
  })

  test('the estimate allows for streets not being straight', async () => {
    const { legs } = estimateLegs([AUSTIN, PECAN])
    // Crow-flies is about 9.3 miles here; driving is further.
    assert.ok(legs[0].miles > 10, `expected a detour allowance, got ${legs[0].miles}`)
  })
})

describe('reading the clock', () => {
  test('accepts the forms the field actually receives', () => {
    assert.equal(parseClock('10:00'), 600)
    assert.equal(parseClock('10:00 AM'), 600)
    assert.equal(parseClock('9:30 pm'), 1290)
    assert.equal(parseClock('12:00 AM'), 0)
    assert.equal(parseClock('12:30 PM'), 750)
  })

  test('falls back rather than producing a nonsense schedule', () => {
    assert.equal(parseClock('half past ten'), 600)
    assert.equal(parseClock('25:00'), 600)
    assert.equal(parseClock('10:75'), 600)
    assert.equal(parseClock(null), 600)
  })

  test('formats the way the itinerary reads', () => {
    assert.equal(formatClock(600), '10:00 AM')
    assert.equal(formatClock(619), '10:19 AM')
    assert.equal(formatClock(675), '11:15 AM')
    assert.equal(formatClock(720), '12:00 PM')
    assert.equal(formatClock(0), '12:00 AM')
  })

  test('durations read as a broker would say them', () => {
    assert.equal(formatDuration(55), '55 min')
    assert.equal(formatDuration(95), '1 hr 35 min')
    assert.equal(formatDuration(120), '2 hr')
  })
})

describe('building the itinerary', () => {
  test('schedules a two-stop afternoon end to end', () => {
    const itinerary = buildItinerary({
      stops: [{ id: 'pecan' }, { id: 'belterra' }],
      driveMinutes: [19, 36],
      startTime: '10:00',
      stopMinutes: 20,
    })

    assert.equal(itinerary.items[0].arrive, '10:19 AM')
    assert.equal(itinerary.items[0].depart, '10:39 AM')
    assert.equal(itinerary.items[1].arrive, '11:15 AM')
    assert.equal(itinerary.items[1].depart, '11:35 AM')

    assert.equal(itinerary.startTime, '10:00 AM')
    assert.equal(itinerary.endTime, '11:35 AM')
    assert.equal(itinerary.driveMinutes, 55)
    assert.equal(itinerary.driveLabel, '55 min')
    assert.equal(itinerary.totalLabel, '1 hr 35 min')
  })

  test('a stop can overrun the default without moving the others’ dwell', () => {
    const itinerary = buildItinerary({
      stops: [{ id: 'a', tourMinutes: 90 }, { id: 'b' }],
      driveMinutes: [0, 30],
      startTime: '9:00',
      stopMinutes: 20,
    })

    assert.equal(itinerary.items[0].stopMinutes, 90)
    assert.equal(itinerary.items[0].depart, '10:30 AM')
    assert.equal(itinerary.items[1].stopMinutes, 20)
    assert.equal(itinerary.items[1].arrive, '11:00 AM')
  })

  test('a dwell of zero is honoured, not treated as unset', () => {
    const itinerary = buildItinerary({
      stops: [{ id: 'a', tourMinutes: 0 }],
      driveMinutes: [10],
      startTime: '10:00',
      stopMinutes: 20,
    })
    assert.equal(itinerary.items[0].stopMinutes, 0)
    assert.equal(itinerary.items[0].depart, '10:10 AM')
  })

  test('the drive home lengthens the day but adds no stop', () => {
    const itinerary = buildItinerary({
      stops: [{ id: 'a' }],
      driveMinutes: [15],
      endDriveMinutes: 25,
      startTime: '10:00',
      stopMinutes: 20,
    })

    assert.equal(itinerary.items.length, 1)
    assert.equal(itinerary.endTime, '11:00 AM')
    assert.equal(itinerary.driveMinutes, 40)
  })

  test('an empty tour is a valid, empty answer', () => {
    const itinerary = buildItinerary({ stops: [], startTime: '10:00' })
    assert.deepEqual(itinerary.items, [])
    assert.equal(itinerary.totalMinutes, 0)
    assert.equal(itinerary.startTime, '10:00 AM')
  })
})
