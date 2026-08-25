/**
 * Google Maps Platform providers.
 *
 * Two things Google does better than the free sources: driving times that
 * account for traffic, and a business directory that actually knows about
 * every tenant in a strip centre. Both are optional. Without
 * `GOOGLE_MAPS_API_KEY` the app uses OSRM and Overpass and works fine; with
 * it, these take over and the free ones become the fallback.
 *
 * The key is only ever read inside the Worker. Nothing here runs in the
 * browser, so the key is never shipped to a client — which is also why the
 * competitor search is a server route rather than a direct call from the map.
 */

const ROUTES_ENDPOINT = 'https://routes.googleapis.com/directions/v2:computeRoutes'
const PLACES_ENDPOINT = 'https://places.googleapis.com/v1/places:searchNearby'

const METRES_PER_MILE = 1609.344

/** Google caps a nearby search at 50km; well above the 10-mile ceiling here. */
const MAX_PLACES_RESULTS = 20

export class GoogleUnavailable extends Error {
  constructor(message) {
    super(message)
    this.name = 'GoogleUnavailable'
  }
}

export function hasGoogleKey(env = {}) {
  return Boolean(env.GOOGLE_MAPS_API_KEY)
}

/** "1234s" — the Routes API's duration format. */
function seconds(value) {
  const match = /^(\d+(?:\.\d+)?)s$/.exec(String(value ?? ''))
  return match ? Number(match[1]) : null
}

async function post(url, { body, headers, fetchImpl, timeout, label }) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeout) : null
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      signal: controller?.signal,
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
    if (response.status === 401 || response.status === 403) {
      // Google's own message names the actual problem — "billing is not
      // enabled", "API not enabled on project N", "requests blocked by key
      // restriction" — where a generic "rejected" sends people checking the
      // wrong thing.
      const detail = await response.text().catch(() => '')
      let reason = ''
      try {
        reason = JSON.parse(detail)?.error?.message ?? ''
      } catch {
        reason = detail.slice(0, 200)
      }
      throw new GoogleUnavailable(
        `${label} rejected the API key${reason ? `: ${reason}` : '. Check that the key is valid and that the API is enabled for it.'}`,
      )
    }
    if (response.status === 429) {
      throw new GoogleUnavailable(`${label} is rate limiting this key.`)
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new GoogleUnavailable(`${label} returned HTTP ${response.status}. ${detail.slice(0, 200)}`)
    }
    return await response.json()
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/* -------------------------------------------------------------------------- */
/* Routing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Drive legs and geometry through `points`, in order.
 *
 * Asks for GeoJSON rather than an encoded polyline so there is no decoder to
 * get subtly wrong — the payload is larger, but a tour is a handful of legs.
 *
 * @returns {Promise<{legs: {miles:number,minutes:number}[], geometry: [number,number][], source: string}>}
 */
export async function googleRoute(
  points,
  { apiKey, fetchImpl = fetch, timeout = 10000, departureTime = null } = {},
) {
  if (!apiKey) throw new GoogleUnavailable('No Google Maps API key is configured.')
  if (points.length < 2) throw new GoogleUnavailable('Routing needs at least two points.')

  const waypoint = (point) => ({
    location: { latLng: { latitude: point.lat, longitude: point.lng } },
  })

  const body = {
    origin: waypoint(points[0]),
    destination: waypoint(points[points.length - 1]),
    travelMode: 'DRIVE',
    // Traffic-aware without a departure time uses conditions now, which
    // cannot fail the way a timestamp in the past does.
    routingPreference: 'TRAFFIC_AWARE',
    polylineEncoding: 'GEO_JSON_LINESTRING',
    ...(points.length > 2 ? { intermediates: points.slice(1, -1).map(waypoint) } : {}),
    ...(departureTime ? { departureTime } : {}),
  }

  const payload = await post(ROUTES_ENDPOINT, {
    body,
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask':
        'routes.duration,routes.distanceMeters,routes.polyline.geoJsonLinestring,routes.legs.duration,routes.legs.distanceMeters',
    },
    fetchImpl,
    timeout,
    label: 'The Google Routes API',
  })

  const route = payload?.routes?.[0]
  if (!route) throw new GoogleUnavailable('Google could not build a route between those points.')

  const legs = (route.legs ?? []).map((leg) => ({
    miles: round1(Number(leg.distanceMeters ?? 0) / METRES_PER_MILE),
    minutes: Math.round((seconds(leg.duration) ?? 0) / 60),
  }))

  // A leg count that does not match the stops would shift every arrival time,
  // so it is treated as a failure rather than quietly used.
  if (legs.length !== points.length - 1) {
    throw new GoogleUnavailable('Google returned an unexpected number of legs.')
  }

  const coordinates = route.polyline?.geoJsonLinestring?.coordinates ?? []
  const geometry = coordinates.map(([lng, lat]) => [lat, lng])

  return { legs, geometry, source: 'google' }
}

/* -------------------------------------------------------------------------- */
/* Places                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The app's categories mapped to Google place types.
 *
 * Kept beside the OSM tags rather than replacing them, so switching provider
 * does not change what the category means to the broker choosing it.
 */
export const GOOGLE_TYPES = {
  dentist: ['dentist'],
  medical: ['doctor', 'medical_lab', 'hospital'],
  pharmacy: ['pharmacy', 'drugstore'],
  veterinary: ['veterinary_care'],
  restaurant: ['restaurant', 'fast_food_restaurant'],
  cafe: ['cafe', 'coffee_shop'],
  grocery: ['supermarket', 'grocery_store', 'convenience_store'],
  fitness: ['gym', 'fitness_center'],
  salon: ['hair_salon', 'beauty_salon', 'barber_shop'],
  bank: ['bank', 'atm'],
  childcare: ['child_care_agency', 'preschool'],
  retail: ['store'],
}

/**
 * Businesses near a point, from Google Places.
 *
 * Returns the same shape the Overpass path does, so the caller and the UI do
 * not need to know which one answered.
 */
export async function googleNearby({
  lat,
  lng,
  category = null,
  keyword = null,
  radiusMiles = 5,
  apiKey,
  fetchImpl = fetch,
  timeout = 15000,
} = {}) {
  if (!apiKey) throw new GoogleUnavailable('No Google Maps API key is configured.')

  const includedTypes = category && GOOGLE_TYPES[category] ? GOOGLE_TYPES[category] : []

  const body = {
    maxResultCount: MAX_PLACES_RESULTS,
    locationRestriction: {
      circle: {
        center: { latitude: lat, longitude: lng },
        radius: Math.min(50000, Math.round(radiusMiles * METRES_PER_MILE)),
      },
    },
    ...(includedTypes.length > 0 ? { includedTypes } : {}),
  }

  const payload = await post(PLACES_ENDPOINT, {
    body,
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask':
        'places.id,places.displayName,places.formattedAddress,places.location,places.primaryTypeDisplayName,places.websiteUri,places.rating,places.userRatingCount',
    },
    fetchImpl,
    timeout,
    label: 'The Google Places API',
  })

  const places = Array.isArray(payload?.places) ? payload.places : []
  const term = keyword ? String(keyword).toLowerCase() : null

  return places
    .map((place) => {
      const placeLat = Number(place?.location?.latitude)
      const placeLng = Number(place?.location?.longitude)
      const name = place?.displayName?.text
      if (!Number.isFinite(placeLat) || !Number.isFinite(placeLng) || !name) return null

      return {
        id: place.id ? `google/${place.id}` : `google/${name}@${placeLat},${placeLng}`,
        name,
        category: place?.primaryTypeDisplayName?.text ?? null,
        address: place.formattedAddress ?? null,
        brand: null,
        website: place.websiteUri ?? null,
        rating: Number.isFinite(place.rating) ? place.rating : null,
        reviews: Number.isFinite(place.userRatingCount) ? place.userRatingCount : null,
        lat: placeLat,
        lng: placeLng,
      }
    })
    .filter(Boolean)
    .filter((place) => {
      // Places has no free-text filter on a nearby search, so a keyword is
      // applied here rather than silently ignored.
      if (!term) return true
      return `${place.name} ${place.category ?? ''}`.toLowerCase().includes(term)
    })
}

function round1(value) {
  return Math.round(value * 10) / 10
}
