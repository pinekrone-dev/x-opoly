/**
 * Road routing and drive times.
 *
 * Ordering stops by straight-line distance is fine, but a broker reading an
 * itinerary needs the real number — "19 min drive", not "4.1 miles as the crow
 * flies" — and a route drawn on the map has to follow streets or it looks
 * broken.
 *
 * OSRM's public server answers both, free and without a key, so it is the
 * default. It is a shared demo service though, and can be slow, rate-limited,
 * or blocked by a network policy, so every failure falls back to a
 * straight-line estimate rather than breaking the planner. Callers can tell
 * which they got from `source`, and the UI says so.
 */

import { haversineMiles } from './tour.js'
import { googleRoute, hasGoogleKey } from './google.js'

const OSRM_BASE = 'https://router.project-osrm.org/route/v1/driving'

/** Typical door-to-door metro average, used only when routing is unavailable. */
const FALLBACK_MPH = 30

/** Straight lines understate real driving; this brings the estimate closer. */
const DETOUR_FACTOR = 1.25

const METRES_PER_MILE = 1609.344

export class RoutingUnavailable extends Error {
  constructor(message) {
    super(message)
    this.name = 'RoutingUnavailable'
  }
}

/**
 * Drive legs between consecutive points, plus the geometry to draw.
 *
 * @param {Array<{lat:number,lng:number}>} points  in visiting order
 * @param {object} options
 * @returns {Promise<{legs: Array<{miles:number,minutes:number}>, geometry: Array<[number,number]>, source: string}>}
 */
export async function routeLegs(points, { fetchImpl = fetch, timeoutMs = 8000, env = {} } = {}) {
  if (points.length < 2) {
    return { legs: [], geometry: points.map((point) => [point.lat, point.lng]), source: 'none' }
  }

  /*
   * Why the router that should have answered did not. A key that is set but
   * silently falling through looks identical to no key at all — the broker
   * pays for traffic-aware times and gets straight-line guesses with no clue
   * why. The note rides on the plan so the reason is one glance away
   * (usually: the Routes API is not enabled on the key).
   */
  let note = null

  // Google first when a key is configured — it is the only one of the three
  // that accounts for traffic, which is the whole reason to pay for it.
  if (hasGoogleKey(env)) {
    try {
      return await googleRoute(points, {
        apiKey: env.GOOGLE_MAPS_API_KEY,
        fetchImpl,
        timeout: timeoutMs,
      })
    } catch (error) {
      // Degrade to the free router rather than break the tour — but say why.
      note = `Google routing failed (${error?.message ?? 'unknown error'}); using the free router.`
    }
  }

  try {
    const routed = await osrmRoute(points, { fetchImpl, timeoutMs })
    return note ? { ...routed, note } : routed
  } catch (error) {
    // A routing outage must not take the itinerary with it.
    const estimated = estimateLegs(points)
    const osrmNote = `Road routing was unreachable (${error?.message ?? 'unknown error'}); times are straight-line estimates.`
    return { ...estimated, note: note ? `${note} ${osrmNote}` : osrmNote }
  }
}

async function osrmRoute(points, { fetchImpl, timeoutMs }) {
  const coordinates = points.map((point) => `${point.lng},${point.lat}`).join(';')
  const url = `${OSRM_BASE}/${coordinates}?overview=full&geometries=geojson&steps=false`

  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null

  let response
  try {
    response = await fetchImpl(url, {
      signal: controller?.signal,
      // The demo OSRM server refuses anonymous clients; a Worker's fetch
      // sends no User-Agent at all, which reads as exactly that. Identify
      // ourselves and the road geometry comes back instead of a refusal.
      headers: {
        accept: 'application/json',
        'user-agent': 'LandQuotient/1.0 (+https://landquotient.com)',
      },
    })
  } finally {
    if (timer) clearTimeout(timer)
  }

  if (!response.ok) throw new RoutingUnavailable(`Routing service returned ${response.status}`)

  const body = await response.json()
  if (body?.code !== 'Ok' || !Array.isArray(body?.routes) || body.routes.length === 0) {
    throw new RoutingUnavailable(body?.message || 'Routing service could not build that route.')
  }

  const route = body.routes[0]
  const legs = (route.legs ?? []).map((leg) => ({
    miles: round1(Number(leg.distance ?? 0) / METRES_PER_MILE),
    minutes: Math.round(Number(leg.duration ?? 0) / 60),
  }))

  if (legs.length !== points.length - 1) {
    throw new RoutingUnavailable('Routing service returned an unexpected number of legs.')
  }

  // GeoJSON is [lng, lat]; Leaflet wants [lat, lng].
  const geometry = (route.geometry?.coordinates ?? []).map(([lng, lat]) => [lat, lng])

  return { legs, geometry, source: 'osrm' }
}

/** The keyless fallback: great-circle distance, nudged for real streets. */
export function estimateLegs(points) {
  const legs = []
  for (let index = 1; index < points.length; index += 1) {
    const miles = haversineMiles(points[index - 1], points[index]) * DETOUR_FACTOR
    legs.push({ miles: round1(miles), minutes: Math.round((miles / FALLBACK_MPH) * 60) })
  }
  return {
    legs,
    geometry: points.map((point) => [point.lat, point.lng]),
    source: 'estimate',
  }
}

function round1(value) {
  return Math.round(value * 10) / 10
}
