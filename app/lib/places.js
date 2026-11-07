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
import { googleNearby, hasGoogleKey } from './google.js'

const DEFAULT_OVERPASS = 'https://overpass-api.de/api/interpreter'

/** Other public Overpass instances, asked in turn when the first is busy. */
export const OVERPASS_MIRRORS = ['https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.private.coffee/api/interpreter']

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
  // Every storefront OpenStreetMap ties to a brand on Wikidata: the national
  // and regional chains, Target to Zaxby's, across shops, restaurants, banks
  // and fuel. The Name Suggestion Index adds the tag only for known brands,
  // so independents are left out by the data, not by a list kept here.
  chains: { label: 'National & regional chains', tags: ['brand:wikidata'], storefronts: true, max: 300 },
}

/*
 * Brand-tagged things that are not a tenant: cash machines, lockers,
 * chargers, vending machines, bike docks. Left out of a chains search so
 * they do not crowd real storefronts out of the result cap.
 */
const NOT_STOREFRONTS = 'atm|vending_machine|parcel_locker|charging_station|bicycle_rental|kick-scooter_rental|post_box|telephone|bench|waste_basket|drinking_water|recycling|ice_cream_machine|money_transfer|payment_terminal|letter_box|car_sharing|motorcycle_parking|parking'

/**
 * The kind of tenant, for a co-tenancy read: an anchor and a QSR say
 * different things about a site. From the OSM tags, coarse on purpose.
 */
export function sectorOf(tags = {}) {
  const shop = tags.shop
  const amenity = tags.amenity
  if (amenity === 'fast_food') return 'Quick service'
  if (amenity === 'cafe' || shop === 'coffee') return 'Coffee'
  if (amenity === 'restaurant' || amenity === 'pub' || amenity === 'bar' || amenity === 'ice_cream') return 'Restaurants'
  if (amenity === 'pharmacy' || shop === 'chemist') return 'Pharmacy'
  if (amenity === 'bank') return 'Banks'
  if (amenity === 'fuel' || shop === 'convenience') return 'Convenience & fuel'
  if (shop === 'supermarket' || shop === 'grocery' || shop === 'wholesale') return 'Grocery & club'
  if (shop === 'department_store' || shop === 'general' || shop === 'mall') return 'Department & big box'
  if (shop === 'variety_store' || shop === 'discount') return 'Discount & dollar'
  if (shop === 'doityourself' || shop === 'hardware' || shop === 'garden_centre' || shop === 'trade') return 'Home improvement'
  if (shop === 'clothes' || shop === 'shoes' || shop === 'bag' || shop === 'jewelry' || shop === 'boutique') return 'Apparel'
  if (shop === 'mobile_phone' || shop === 'electronics' || shop === 'computer') return 'Phones & electronics'
  if (/^(car|car_repair|car_parts|tyres|car_wash)$/.test(shop || '') || amenity === 'car_wash' || amenity === 'car_rental') return 'Auto'
  if (tags.leisure === 'fitness_centre' || tags.leisure === 'sports_centre') return 'Fitness'
  if (shop === 'hairdresser' || shop === 'beauty' || shop === 'cosmetics' || shop === 'massage') return 'Beauty'
  if (tags.healthcare || amenity === 'clinic' || amenity === 'doctors' || amenity === 'dentist' || amenity === 'veterinary') return 'Medical'
  if (shop === 'pet' || shop === 'books' || shop === 'sports' || shop === 'toys' || shop === 'craft' || shop === 'furniture' || shop === 'beds') return 'Specialty retail'
  if (shop) return 'Other retail'
  if (tags.office || amenity) return 'Services'
  return 'Other'
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
 * A brand as a forgiving pattern: its letters and digits in order, with
 * anything between them, so "Zaxbys" finds "Zaxby's" and "chick fil a"
 * finds "Chick-fil-A".
 */
export function loosePattern(term) {
  const chars = [...String(term ?? '').toLowerCase()].filter((ch) => /[\p{L}\p{N}]/u.test(ch))
  return chars.map((ch) => escapeRegex(ch)).join('[^[:alnum:]]*')
}

/** A name squeezed to letters and digits, for matching brands either side. */
export function squeeze(text) {
  return [...String(text ?? '').toLowerCase()].filter((ch) => /[\p{L}\p{N}]/u.test(ch)).join('')
}

/**
 * Builds the Overpass QL for a radius search.
 * Exported so the query shape is testable without a network call.
 */
export function buildQuery({ lat, lng, radiusMeters, category, keyword }) {
  const clauses = []

  const entry = category && CATEGORIES[category] ? CATEGORIES[category] : null
  if (entry) {
    const only = entry.storefronts ? `["amenity"!~"^(${NOT_STOREFRONTS})$"]` : ''
    for (const tag of entry.tags) {
      const [key, value] = tag.split('=')
      const selector = value ? `["${key}"="${value}"]` : `["${key}"]`
      clauses.push(`nwr${selector}${only}(around:${radiusMeters},${lat},${lng});`)
    }
  }

  if (keyword && entry?.storefronts) {
    // Brands within the chains, by brand tag or name; one or a list.
    const term = (Array.isArray(keyword) ? keyword : [keyword]).map(loosePattern).filter(Boolean).join('|')
    clauses.length = 0
    clauses.push(`nwr["brand:wikidata"]["brand"~"${term}",i](around:${radiusMeters},${lat},${lng});`)
    clauses.push(`nwr["brand:wikidata"]["name"~"${term}",i](around:${radiusMeters},${lat},${lng});`)
  } else if (keyword) {
    clauses.push(`nwr["name"~"${escapeRegex(keyword)}",i](around:${radiusMeters},${lat},${lng});`)
  }

  if (clauses.length === 0) {
    // With no filter, return named businesses rather than every fire hydrant.
    clauses.push(`nwr["shop"]["name"](around:${radiusMeters},${lat},${lng});`)
    clauses.push(`nwr["amenity"]["name"](around:${radiusMeters},${lat},${lng});`)
  }

  return `[out:json][timeout:25];(${clauses.join('')});out center ${entry?.max ?? 80};`
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
      // A chain's store is sometimes tagged with the brand and no name.
      const name = element.tags?.name || element.tags?.brand
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
        // The brand's Wikidata id, which is how its logo is found (logos.js).
        brandWikidata: element.tags['brand:wikidata'] || null,
        sector: sectorOf(element.tags),
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
  hedgeMs = 4000,
} = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new PlacesUnavailable('This site needs a location on the map before you can scope the competition around it.')
  }

  const radius = Math.min(Math.max(Number(radiusMiles) || 5, 0.25), 10)

  // Google knows about far more small tenants than OSM does, so it leads when
  // a key is configured — except for chains, which Google cannot tell from
  // independents and OSM can, by the brand tag. A failure falls through to Overpass rather than
  // returning nothing — an empty competitor list reads as "no competition",
  // which is a materially wrong thing to tell a broker.
  if (hasGoogleKey(env) && !CATEGORIES[category]?.storefronts) {
    try {
      const places = await googleNearby({
        lat,
        lng,
        category,
        keyword,
        radiusMiles: radius,
        apiKey: env.GOOGLE_MAPS_API_KEY,
        fetchImpl,
        timeout,
      })
      const results = places
        .map((place) => {
          const miles = haversineMiles({ lat, lng }, { lat: place.lat, lng: place.lng })
          return {
            ...place,
            miles: Math.round(miles * 100) / 100,
            ring: RING_MILES.find((ring) => miles <= ring) ?? null,
          }
        })
        .sort((a, b) => a.miles - b.miles)

      return {
        results,
        rings: summarize(results),
        radiusMiles: radius,
        source: 'Google Places',
      }
    } catch {
      // Fall through to the free directory below.
    }
  }

  const query = buildQuery({ lat, lng, radiusMeters: Math.round(radius * 1609.344), category, keyword })
  // The public instances are unevenly reachable and unevenly busy (from a
  // runner: one unreachable, one hanging a minute, one answering in 13 s).
  // So the search is hedged: the first is asked, and if it has not answered
  // in a few seconds, or has failed, the next is asked too; the first good
  // answer wins and the rest are cancelled. OVERPASS_URL, when set, leads.
  const endpoints = [...new Set([env.OVERPASS_URL, DEFAULT_OVERPASS, ...OVERPASS_MIRRORS].filter(Boolean))]
  const controllers = endpoints.map(() => new AbortController())
  const reasons = []
  const ask = async (endpoint, controller) => {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': env.PLACES_UA || 'LandQuotient/1.0 (https://landquotient.com; nearby businesses)',
      },
      body: `data=${encodeURIComponent(query)}`,
    })
    if (response.status === 401 || response.status === 403) {
      throw new PlacesUnavailable('This server is not allowed to reach the business directory. Check its outbound network access, or set OVERPASS_URL to an instance it can reach.')
    }
    if (response.status === 429) throw new PlacesUnavailable('The business directory is rate limiting us. Wait a moment and try again.')
    if (!response.ok) throw new PlacesUnavailable(`The business directory returned HTTP ${response.status}.`)
    const body = await response.json()
    // Overpass reports a query it gave up on (timeout, memory, too busy)
    // as a 200 with a remark and no elements. That is not "nothing here",
    // and an empty list would say exactly that to a broker.
    if (body?.remark && /error|timed out|timeout|too busy|rate_limited/i.test(body.remark) && !(body.elements || []).length) {
      throw new PlacesUnavailable(`The business directory did not finish the search (${String(body.remark).slice(0, 160)}).`)
    }
    return body
  }

  const body = await new Promise((resolve, reject) => {
    let settled = false
    let next = 0
    let failed = 0
    let hedge = null
    const deadline = setTimeout(() => finish(null, new PlacesUnavailable('The business search timed out. Try a smaller radius.')), timeout)
    function finish(value, error) {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      clearTimeout(hedge)
      for (const c of controllers) c.abort()
      if (error) reject(error)
      else resolve(value)
    }
    function launch() {
      if (settled || next >= endpoints.length) return
      const i = next++
      clearTimeout(hedge)
      if (next < endpoints.length) hedge = setTimeout(launch, hedgeMs)
      ask(endpoints[i], controllers[i]).then(
        (value) => finish(value),
        (error) => {
          if (settled) return
          reasons.push(error instanceof PlacesUnavailable ? error.message : error?.name === 'AbortError' ? 'The business search timed out.' : `The business directory could not be reached (${error?.message}).`)
          failed += 1
          if (failed >= endpoints.length) finish(null, new PlacesUnavailable(reasons[reasons.length - 1]))
          else launch()
        },
      )
    }
    launch()
  })

  const results = parseElements(body.elements, { lat, lng })
  return {
    results,
    rings: summarize(results),
    radiusMiles: radius,
    source: 'OpenStreetMap via Overpass',
  }
}
