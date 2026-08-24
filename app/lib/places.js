/**
 * Nearby business lookup, for scoping the competition around a site.
 *
 * Defaults to the OpenStreetMap Overpass API: free, no key, no billing
 * account. `OVERPASS_URL` points at a different instance (or your own), and a
 * Google Places key can be layered on later without changing the caller.
 *
 * Results are always real query results. When the source cannot be reached the
 * caller is told so — an empty competitor list would read as "no competition",
 * which is a materially wrong thing to tell a broker.
 */

import { haversineMiles } from './tour.js'

const DEFAULT_OVERPASS = 'https://overpass-api.de/api/interpreter'

/** The rings drawn around a site, in miles. */
export const RING_MILES = [1, 3, 5]

/**
 * Plain-language categories mapped to OSM tag filters.
 * Each entry is a list of `key=value` pairs, ORed together.
 */
export const CATEGORIES = {
  dentist: { label: 'Dental offices', tags: ['amenity=dentist', 'healthcare=dentist'] },
  medical: { label: 'Medical & clinics', tags: ['amenity=clinic', 'amenity=doctors', 'healthcare=centre'] },
  pharmacy: { label: 'Pharmacies', tags: ['amenity=pharmacy'] },
  veterinary: { label: 'Veterinary', tags: ['amenity=veterinary'] },
  restaurant: { label: 'Restaurants', tags: ['amenity=restaurant', 'amenity=fast_food'] },
  cafe: { label: 'Coffee & cafes', tags: ['amenity=cafe'] },
  grocery: { label: 'Grocery', tags: ['shop=supermarket', 'shop=grocery', 'shop=convenience'] },
  fitness: { label: 'Gyms & fitness', tags: ['leisure=fitness_centre', 'leisure=sports_centre'] },
  salon: { label: 'Salons & barbers', tags: ['shop=hairdresser', 'shop=beauty'] },
  bank: { label: 'Banks & credit unions', tags: ['amenity=bank'] },
  childcare: { label: 'Childcare & preschool', tags: ['amenity=childcare', 'amenity=kindergarten'] },
  retail: { label: 'Retail (any)', tags: ['shop'] },
}

export class PlacesUnavailable extends Error {
  constructor(message) {
    super(message)
    this.name = 'PlacesUnavailable'
  }
}

/** Escapes a free-text term for use inside an Overpass regex literal. */
function escapeRegex(value) {
  return value.replace(/["\\]/g, '\\$&').replace(/[.*+?^${}()|[\]]/g, '\\$&')
}

/**
 * Builds the Overpass QL for a radius search.
 * Exported so the query shape is testable without a network call.
 */
export function buildQuery({ lat, lng, radiusMeters, category, keyword }) {
  const clauses = []

  if (category && CATEGORIES[category]) {
    for (const tag of CATEGORIES[category].tags) {
      const [key, value] = tag.split('=')
      const selector = value ? `["${key}"="${value}"]` : `["${key}"]`
      clauses.push(`nwr${selector}(around:${radiusMeters},${lat},${lng});`)
    }
  }

  if (keyword) {
    clauses.push(`nwr["name"~"${escapeRegex(keyword)}",i](around:${radiusMeters},${lat},${lng});`)
  }

  if (clauses.length === 0) {
    // With no filter, return named businesses rather than every fire hydrant.
    clauses.push(`nwr["shop"]["name"](around:${radiusMeters},${lat},${lng});`)
    clauses.push(`nwr["amenity"]["name"](around:${radiusMeters},${lat},${lng});`)
  }

  return `[out:json][timeout:25];(${clauses.join('')});out center 80;`
}

/** Picks a human-readable category out of an OSM element's tags. */
function categoryOf(tags = {}) {
  const value = tags.amenity || tags.shop || tags.healthcare || tags.leisure || tags.office
  if (!value) return null
  return String(value).replace(/_/g, ' ')
}

function addressOf(tags = {}) {
  const line = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ')
  return [line, tags['addr:city']].filter(Boolean).join(', ') || null
}

/** Converts raw Overpass elements into ranked, distance-tagged results. */
export function parseElements(elements, origin) {
  const seen = new Set()

  return (elements || [])
    .map((element) => {
      const lat = element.lat ?? element.center?.lat
      const lng = element.lon ?? element.center?.lon
      const name = element.tags?.name
      if (lat == null || lng == null || !name) return null

      const key = `${name}@${lat.toFixed(5)},${lng.toFixed(5)}`
      if (seen.has(key)) return null
      seen.add(key)

      const miles = haversineMiles(origin, { lat, lng })
      return {
        id: `${element.type}/${element.id}`,
        name,
        category: categoryOf(element.tags),
        address: addressOf(element.tags),
        brand: element.tags.brand || null,
        website: element.tags.website || element.tags['contact:website'] || null,
        lat,
        lng,
        miles: Math.round(miles * 100) / 100,
        // Which ring this falls into, for the summary counts.
        ring: RING_MILES.find((ring) => miles <= ring) ?? null,
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.miles - b.miles)
}

/** Counts per ring, cumulative — a 1-mile business is also within 3 and 5. */
export function summarize(results) {
  return RING_MILES.map((ring) => ({
    miles: ring,
    count: results.filter((result) => result.miles <= ring).length,
  }))
}

/**
 * Searches for businesses around a point.
 *
 * @returns {Promise<{ results: Array, rings: Array, source: string, radiusMiles: number }>}
 * @throws {PlacesUnavailable} when the data source cannot be reached
 */
export async function nearbyBusinesses({
  lat,
  lng,
  category = null,
  keyword = null,
  radiusMiles = 5,
  env = {},
  fetchImpl = fetch,
  timeout = 25000,
} = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new PlacesUnavailable('This site needs a location on the map before you can scope the competition around it.')
  }

  const radius = Math.min(Math.max(Number(radiusMiles) || 5, 0.25), 10)
  const query = buildQuery({ lat, lng, radiusMeters: Math.round(radius * 1609.34), category, keyword })
  const endpoint = env.OVERPASS_URL || DEFAULT_OVERPASS

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': env.PLACES_UA || 'SiteSurveyCRE/1.0 (self-hosted deal mapping tool)',
      },
      body: `data=${encodeURIComponent(query)}`,
    })

    if (response.status === 429) {
      throw new PlacesUnavailable('The business directory is rate limiting us. Wait a moment and try again.')
    }
    if (response.status === 401 || response.status === 403) {
      throw new PlacesUnavailable(
        'This server is not allowed to reach the business directory. Check its outbound network access, or set OVERPASS_URL to an instance it can reach.',
      )
    }
    if (!response.ok) throw new PlacesUnavailable(`The business directory returned HTTP ${response.status}.`)

    const body = await response.json()
    const results = parseElements(body.elements, { lat, lng })

    return {
      results,
      rings: summarize(results),
      radiusMiles: radius,
      source: 'OpenStreetMap via Overpass',
    }
  } catch (error) {
    if (error instanceof PlacesUnavailable) throw error
    if (error?.name === 'AbortError') throw new PlacesUnavailable('The business search timed out. Try a smaller radius.')
    throw new PlacesUnavailable(`The business directory could not be reached (${error.message}).`)
  } finally {
    clearTimeout(timer)
  }
}
