/**
 * The Google Maps Platform providers, and how they layer over the free ones.
 *
 * The service is injected throughout, so these run without a network and
 * without a key. What matters most here is the fallback behaviour: a key that
 * is missing, rejected, over quota, or answering nonsense must degrade to the
 * free source rather than break a tour or empty a competitor list.
 */

import assert from 'node:assert/strict'
import test, { describe } from 'node:test'

import { GoogleUnavailable, googleNearby, googleRoute, hasGoogleKey } from '../app/lib/google.js'
import { routeLegs } from '../app/lib/routing.js'
import { nearbyBusinesses } from '../app/lib/places.js'

const A = { lat: 30.2672, lng: -97.7431 }
const B = { lat: 30.4, lng: -97.72 }
const C = { lat: 30.16, lng: -98.0 }

const KEY = { GOOGLE_MAPS_API_KEY: 'test-key' }

function respond(payload, { ok = true, status = 200 } = {}) {
  return async () => ({
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  })
}

function routePayload(legs, coordinates = [[-97.7431, 30.2672], [-97.72, 30.4]]) {
  return {
    routes: [
      {
        legs,
        polyline: { geoJsonLinestring: { type: 'LineString', coordinates } },
      },
    ],
  }
}

describe('google routing', () => {
  test('reads the duration format the Routes API uses', async () => {
    const fetchImpl = respond(
      routePayload([
        { distanceMeters: 16093, duration: '1140s' },
        { distanceMeters: 32187, duration: '2160s' },
      ]),
    )

    const result = await googleRoute([A, B, C], { apiKey: 'k', fetchImpl })

    assert.equal(result.source, 'google')
    assert.deepEqual(result.legs, [
      { miles: 10, minutes: 19 },
      { miles: 20, minutes: 36 },
    ])
  })

  test('returns geometry as lat/lng, not the lng/lat GeoJSON ships', async () => {
    const fetchImpl = respond(routePayload([{ distanceMeters: 1000, duration: '60s' }]))
    const { geometry } = await googleRoute([A, B], { apiKey: 'k', fetchImpl })
    assert.deepEqual(geometry, [[30.2672, -97.7431], [30.4, -97.72]])
  })

  test('sends intermediates for the stops between the ends', async () => {
    let sent = null
    const fetchImpl = async (_url, init) => {
      sent = JSON.parse(init.body)
      return {
        ok: true,
        status: 200,
        json: async () => routePayload([
          { distanceMeters: 1, duration: '1s' },
          { distanceMeters: 1, duration: '1s' },
        ]),
        text: async () => '',
      }
    }

    await googleRoute([A, B, C], { apiKey: 'k', fetchImpl })

    assert.equal(sent.intermediates.length, 1, 'the middle stop is an intermediate')
    assert.equal(sent.origin.location.latLng.latitude, A.lat)
    assert.equal(sent.destination.location.latLng.latitude, C.lat)
    assert.equal(sent.travelMode, 'DRIVE')
  })

  test('a rejected key says so, rather than reading as a routing failure', async () => {
    const fetchImpl = respond({ error: 'denied' }, { ok: false, status: 403 })
    await assert.rejects(
      () => googleRoute([A, B], { apiKey: 'k', fetchImpl }),
      (error) => error instanceof GoogleUnavailable && /API key/i.test(error.message),
    )
  })

  test('a leg count that does not match the stops is refused', async () => {
    // Using it anyway would shift every arrival time in the itinerary.
    const fetchImpl = respond(routePayload([{ distanceMeters: 1000, duration: '60s' }]))
    await assert.rejects(
      () => googleRoute([A, B, C], { apiKey: 'k', fetchImpl }),
      (error) => error instanceof GoogleUnavailable,
    )
  })

  test('no key is an error, not a silent empty route', async () => {
    await assert.rejects(
      () => googleRoute([A, B], { apiKey: null, fetchImpl: respond({}) }),
      (error) => error instanceof GoogleUnavailable,
    )
  })
})

describe('choosing a router', () => {
  test('uses Google when a key is configured', async () => {
    const fetchImpl = respond(routePayload([{ distanceMeters: 16093, duration: '1140s' }]))
    const { source } = await routeLegs([A, B], { fetchImpl, env: KEY })
    assert.equal(source, 'google')
  })

  test('uses OSRM when no key is configured', async () => {
    const fetchImpl = respond({
      code: 'Ok',
      routes: [{ legs: [{ distance: 16093, duration: 1140 }], geometry: { coordinates: [] } }],
    })
    const { source } = await routeLegs([A, B], { fetchImpl, env: {} })
    assert.equal(source, 'osrm')
  })

  test('falls back to OSRM when Google refuses the key', async () => {
    let call = 0
    const fetchImpl = async () => {
      call += 1
      if (call === 1) return { ok: false, status: 403, json: async () => ({}), text: async () => '' }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 'Ok',
          routes: [{ legs: [{ distance: 16093, duration: 1140 }], geometry: { coordinates: [] } }],
        }),
        text: async () => '',
      }
    }

    const { source, legs } = await routeLegs([A, B], { fetchImpl, env: KEY })
    assert.equal(source, 'osrm', 'a bad key must not break the tour')
    assert.equal(legs.length, 1)
  })

  test('falls all the way to an estimate when both services are down', async () => {
    const fetchImpl = async () => {
      throw new Error('network unreachable')
    }
    const { source, legs } = await routeLegs([A, B], { fetchImpl, env: KEY })
    assert.equal(source, 'estimate')
    assert.ok(legs[0].minutes > 0)
  })

  test('hasGoogleKey only reports true for a real value', () => {
    assert.equal(hasGoogleKey({}), false)
    assert.equal(hasGoogleKey({ GOOGLE_MAPS_API_KEY: '' }), false)
    assert.equal(hasGoogleKey(KEY), true)
  })
})

describe('google places', () => {
  const PLACES = {
    places: [
      {
        id: 'abc',
        displayName: { text: 'Bright Smiles Dental' },
        formattedAddress: '100 Main St, Austin, TX',
        location: { latitude: 30.268, longitude: -97.744 },
        primaryTypeDisplayName: { text: 'Dentist' },
        websiteUri: 'https://example.com',
        rating: 4.6,
        userRatingCount: 210,
      },
      {
        id: 'def',
        displayName: { text: 'Congress Coffee' },
        location: { latitude: 30.27, longitude: -97.75 },
        primaryTypeDisplayName: { text: 'Coffee shop' },
      },
    ],
  }

  test('maps a place onto the shape the app already uses', async () => {
    const results = await googleNearby({ ...A, apiKey: 'k', fetchImpl: respond(PLACES) })

    assert.equal(results.length, 2)
    assert.equal(results[0].name, 'Bright Smiles Dental')
    assert.equal(results[0].address, '100 Main St, Austin, TX')
    assert.equal(results[0].category, 'Dentist')
    assert.equal(results[0].rating, 4.6)
    assert.equal(results[0].reviews, 210)
  })

  test('a keyword narrows the results, rather than being ignored', async () => {
    // Places has no free-text filter on a nearby search, so dropping the
    // keyword would quietly return everything and look like it had worked.
    const results = await googleNearby({
      ...A,
      keyword: 'coffee',
      apiKey: 'k',
      fetchImpl: respond(PLACES),
    })
    assert.equal(results.length, 1)
    assert.equal(results[0].name, 'Congress Coffee')
  })

  test('a place with no coordinates is dropped, not plotted at zero', async () => {
    const results = await googleNearby({
      ...A,
      apiKey: 'k',
      fetchImpl: respond({ places: [{ id: 'x', displayName: { text: 'Nowhere' } }] }),
    })
    assert.deepEqual(results, [])
  })

  test('a category is sent as Google place types', async () => {
    let sent = null
    const fetchImpl = async (_url, init) => {
      sent = JSON.parse(init.body)
      return { ok: true, status: 200, json: async () => ({ places: [] }), text: async () => '' }
    }

    await googleNearby({ ...A, category: 'dentist', radiusMiles: 3, apiKey: 'k', fetchImpl })

    assert.deepEqual(sent.includedTypes, ['dentist'])
    assert.equal(sent.locationRestriction.circle.radius, 4828, '3 miles in metres')
  })
})

describe('choosing a business directory', () => {
  test('uses Google Places when a key is configured', async () => {
    const fetchImpl = respond({
      places: [
        {
          id: 'abc',
          displayName: { text: 'Bright Smiles Dental' },
          location: { latitude: 30.268, longitude: -97.744 },
        },
      ],
    })

    const result = await nearbyBusinesses({ ...A, env: KEY, fetchImpl })

    assert.equal(result.source, 'Google Places')
    assert.equal(result.results.length, 1)
    assert.ok(result.results[0].miles >= 0, 'distance from the site is computed')
    assert.equal(result.results[0].ring, 1, 'and the ring it falls in')
  })

  test('falls back to Overpass when Google refuses the key', async () => {
    let call = 0
    const fetchImpl = async () => {
      call += 1
      if (call === 1) return { ok: false, status: 403, json: async () => ({}), text: async () => '' }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          elements: [
            { type: 'node', id: 1, lat: 30.268, lon: -97.744, tags: { name: 'Corner Dentist', amenity: 'dentist' } },
          ],
        }),
        text: async () => '',
      }
    }

    const result = await nearbyBusinesses({ ...A, env: KEY, fetchImpl })

    assert.equal(result.source, 'OpenStreetMap via Overpass')
    assert.equal(result.results.length, 1, 'a bad key must not read as "no competition"')
  })

  test('uses Overpass when no key is configured', async () => {
    const fetchImpl = respond({ elements: [] })
    const result = await nearbyBusinesses({ ...A, env: {}, fetchImpl })
    assert.equal(result.source, 'OpenStreetMap via Overpass')
  })
})
