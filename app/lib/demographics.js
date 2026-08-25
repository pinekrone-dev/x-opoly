/**
 * Trade-area demographics.
 *
 * A broker puts these numbers in front of a client, so this never estimates,
 * interpolates, or fills a gap with a plausible-looking figure. When the data
 * cannot be retrieved the result says so.
 *
 * Both sources are free and keyless for light use:
 *   - TIGERweb, for the block-group polygons around a point
 *   - the ACS 5-year API, for the numbers attached to them (`CENSUS_API_KEY`
 *     raises the rate limit but is not required)
 *
 * Rings are computed from the same block-group pull: one geometry request at
 * the widest radius, one ACS request, then filtered by distance for each ring.
 * Two round trips answer all three rings rather than six.
 */

import { haversineMiles } from './tour.js'

const ACS_BASE = 'https://api.census.gov/data/2022/acs/acs5'
const ACS_VINTAGE = 'US Census ACS 5-year (2022)'

const TIGERWEB_SERVICE =
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_ACS2022/MapServer'

/**
 * Which MapServer layer holds block groups.
 *
 * Hardcoding a number was a guess, and a wrong one: layer ids shift between
 * TIGERweb vintages, and a query against the wrong layer returns zero features
 * rather than an error — which surfaced as "no census block groups cover that
 * point" over downtown Dallas.
 *
 * Discovering it by name was a better guess and still wrong: several layers
 * are called "Census Block Groups" — a group layer that holds the others, a
 * labels layer, and the polygons — and only one of them answers a query.
 * Rather than encode which, the candidates are tried in likelihood order and
 * the one that actually returns block groups is remembered.
 */
let blockGroupLayer = null

/** Clears the cached layer id. Exists so tests do not leak state between them. */
export function resetLayerCache() {
  blockGroupLayer = null
}

/**
 * Block group layer ids, most likely first.
 *
 * A group layer carries `subLayerIds` and holds no features of its own; a
 * labels layer draws text. Both are demoted rather than dropped, so a service
 * that names things differently still gets tried instead of failing outright.
 */
async function blockGroupLayers(fetchImpl, timeout) {
  const body = await withTimeout(fetchImpl, `${TIGERWEB_SERVICE}?f=json`, timeout, 'TIGERweb')
  const layers = Array.isArray(body?.layers) ? body.layers : []

  const named = layers.filter((layer) => /block\s*group/i.test(String(layer?.name ?? '')))
  if (named.length === 0) throw new Error('TIGERweb has no block group layer in this service')

  const rank = (layer) => {
    const isGroup = Array.isArray(layer?.subLayerIds) && layer.subLayerIds.length > 0
    const isLabel = /label/i.test(String(layer?.name ?? ''))
    return (isGroup ? 2 : 0) + (isLabel ? 1 : 0)
  }

  return named
    .slice()
    .sort((a, b) => rank(a) - rank(b))
    .map((layer) => layer.id)
}

/** Rings the panel offers, in miles. */
export const RADII = [1, 3, 5]

/**
 * ACS variables to pull, and what each is for.
 *
 * Medians are deliberately limited to what the ACS publishes directly. There
 * is no correct way to sum a median across block groups; where a ring covers
 * several, the value is a population-weighted mean and is labelled as an
 * approximation rather than presented as a census figure.
 */
const VARIABLES = {
  B01003_001E: 'population',
  B11001_001E: 'households',
  B19013_001E: 'medianHouseholdIncome',
  B25077_001E: 'medianHomeValue',
  B01002_001E: 'medianAge',
  B25003_001E: 'occupiedUnits',
  B25003_003E: 'renterOccupied',
  B15003_001E: 'educationUniverse',
  B15003_022E: 'bachelors',
  B15003_023E: 'masters',
  B15003_024E: 'professional',
  B15003_025E: 'doctorate',
}

/** Metrics that are counts, and so can legitimately be summed across a ring. */
const SUMMABLE = [
  'population',
  'households',
  'occupiedUnits',
  'renterOccupied',
  'educationUniverse',
  'bachelors',
  'masters',
  'professional',
  'doctorate',
]

/** Medians, which can only be weighted — never added. */
const WEIGHTED = ['medianHouseholdIncome', 'medianHomeValue', 'medianAge']

/** What the panel shows, in the order it shows it. */
export const METRICS = [
  { key: 'population', label: 'Population', format: 'count' },
  { key: 'medianHouseholdIncome', label: 'Med. Income', format: 'money', approximate: true },
  { key: 'households', label: 'Households', format: 'count' },
  { key: 'renterShare', label: 'Renters', format: 'percent' },
  { key: 'medianAge', label: 'Med. Age', format: 'decimal', approximate: true },
  { key: 'educationShare', label: 'Bachelor’s+', format: 'percent' },
  { key: 'medianHomeValue', label: 'Home Value', format: 'money', approximate: true },
]

export class DemographicsUnavailable extends Error {
  constructor(message) {
    super(message)
    this.name = 'DemographicsUnavailable'
  }
}

/** Degrees of latitude per mile. Longitude is scaled by cos(latitude). */
const MILES_PER_DEGREE = 69

/**
 * One fetch with a deadline, plus a single retry.
 *
 * Both census services intermittently answer one request with an HTML error
 * page and the very next one normally — observed live, where the same check
 * failed on one domain and passed on the other seconds apart. One retry
 * absorbs that; more would just slow down a real outage.
 */
async function withTimeout(fetchImpl, url, timeout, label) {
  try {
    return await requestJson(fetchImpl, url, timeout, label)
  } catch (error) {
    // A rejection the service itself spelled out (an ArcGIS error object) is
    // deliberate and will repeat; only the transient shapes are worth retrying.
    if (!error?.transient) throw error
    return await requestJson(fetchImpl, url, timeout, label)
  }
}

async function requestJson(fetchImpl, url, timeout, label) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeout) : null
  try {
    const response = await fetchImpl(url, {
      signal: controller?.signal,
      headers: { accept: 'application/json' },
    })
    if (!response.ok) {
      throw transient(new Error(`${label} HTTP ${response.status}`))
    }

    let body
    try {
      body = await response.json()
    } catch {
      // An HTML error page with HTTP 200. Without this the raw parse error —
      // "Unexpected token '<'" — is what reached the panel.
      throw transient(new Error(`${label} answered with something other than JSON`))
    }

    // ArcGIS reports its own failures in the body with HTTP 200. Left
    // unchecked they arrive downstream as missing fields and get reported as
    // "no data for that area", which sends you looking in the wrong place.
    const failure = !Array.isArray(body) ? body?.error : null
    if (failure) {
      throw new Error(`${label}: ${failure.message ?? 'request rejected'}`)
    }
    return body
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function transient(error) {
  error.transient = true
  return error
}

/**
 * Block groups whose centre falls within `miles` of the point.
 *
 * Queried by bounding envelope — cheap for the service and easy to reason
 * about — then narrowed to a true circle by distance below.
 */
export async function fetchBlockGroups(lat, lng, miles, { fetchImpl = fetch, timeout = 12000 } = {}) {
  const latSpan = miles / MILES_PER_DEGREE
  const lngSpan = miles / (MILES_PER_DEGREE * Math.max(0.01, Math.cos((lat * Math.PI) / 180)))
  const envelope = `${lng - lngSpan},${lat - latSpan},${lng + lngSpan},${lat + latSpan}`

  const candidates =
    blockGroupLayer != null ? [blockGroupLayer] : await blockGroupLayers(fetchImpl, timeout)

  const tried = []
  let refusal = null
  for (const layer of candidates) {
    const { features, error } = await queryLayer(layer, envelope, fetchImpl, timeout)
    tried.push(layer)
    if (error) refusal = error
    if (features.length === 0) continue

    const groups = features.map((feature) => toGroup(feature, lat, lng)).filter(Boolean)
    if (groups.length === 0) {
      throw new Error(
        `TIGERweb returned ${features.length} block groups but none carried a usable location`,
      )
    }

    blockGroupLayer = layer
    return groups
  }

  // A layer that refused the query said something useful about why. Only fall
  // back to "nothing there" when every candidate answered and answered empty.
  if (refusal) throw refusal

  throw new Error(
    `TIGERweb returned no block groups for that area (tried layer${tried.length > 1 ? 's' : ''} ${tried.join(', ')})`,
  )
}

/**
 * One envelope query against one layer.
 *
 * Returns the features and, separately, a refusal. A group layer rejects a
 * query outright, which says something about the layer rather than the area,
 * so the caller moves on to the next candidate — but it keeps the refusal, in
 * case no candidate works and the reason turns out to be the only clue.
 */
async function queryLayer(layer, envelope, fetchImpl, timeout) {
  const url = new URL(`${TIGERWEB_SERVICE}/${layer}/query`)
  url.searchParams.set('geometry', envelope)
  url.searchParams.set('geometryType', 'esriGeometryEnvelope')
  url.searchParams.set('inSR', '4326')
  url.searchParams.set('outSR', '4326')
  url.searchParams.set('spatialRel', 'esriSpatialRelIntersects')
  url.searchParams.set('outFields', '*')
  url.searchParams.set('returnGeometry', 'true')
  // esriJSON, not GeoJSON. `f=geojson` is an optional output format that this
  // MapServer answers with an error object and HTTP 200, so the features array
  // simply came back missing — again indistinguishable from an empty area.
  // `f=json` is the format every ArcGIS server supports, and the parser below
  // already reads its `attributes` and `rings`.
  url.searchParams.set('f', 'json')

  try {
    const body = await withTimeout(fetchImpl, url.toString(), timeout, 'TIGERweb')
    return { features: Array.isArray(body?.features) ? body.features : [], error: null }
  } catch (error) {
    // `TIGERweb: …` is the service rejecting the request, which the next
    // candidate may not do. Anything else — a timeout, an HTTP failure — is
    // about the network and applies to every candidate equally.
    if (/^TIGERweb:/.test(error.message)) return { features: [], error }
    throw error
  }
}

/** One esriJSON or GeoJSON feature, as a block group. */
function toGroup(feature, lat, lng) {
  // ArcGIS answers GeoJSON as `properties` and esriJSON as `attributes`.
  // Reading only one of them drops every feature silently, which is
  // indistinguishable from an area genuinely having no block groups.
  const props = feature?.properties ?? feature?.attributes ?? {}

  const centroid = centroidOf(feature, props)
  if (!centroid) return null

  return {
    geoid: String(props.GEOID ?? props.geoid ?? ''),
    state: String(props.STATE ?? props.state ?? ''),
    county: String(props.COUNTY ?? props.county ?? ''),
    tract: String(props.TRACT ?? props.tract ?? ''),
    blockGroup: String(props.BLKGRP ?? props.blkgrp ?? ''),
    lat: centroid.lat,
    lng: centroid.lng,
    miles: haversineMiles({ lat, lng }, centroid),
    geometry: toGeoJson(feature.geometry),
  }
}

/**
 * Geometry as GeoJSON, whichever dialect the service answered in.
 *
 * The query asks for `f=json`, so what comes back is esriJSON — polygons as
 * `{rings}` — but the map draws with `L.geoJSON`. Shipping the rings through
 * unconverted would not error anywhere; Leaflet would simply draw nothing,
 * and the choropleth would look like it never loaded.
 */
function toGeoJson(geometry) {
  if (!geometry) return null
  if (geometry.type && geometry.coordinates) return geometry
  if (Array.isArray(geometry.rings) && geometry.rings.length > 0) {
    // Block groups are almost always one ring; when there are more, Leaflet
    // treats the first as the shell and the rest as holes, which matches how
    // TIGERweb orders them closely enough for a translucent overlay.
    return { type: 'Polygon', coordinates: geometry.rings }
  }
  return null
}

/**
 * Where a block group sits.
 *
 * Prefers the published centroid, and falls back to averaging the polygon's
 * vertices when the layer does not carry one — accurate enough to decide which
 * ring a block group falls in, and far better than discarding it.
 */
function centroidOf(feature, props) {
  const publishedLat = coordinate(props.CENTLAT ?? props.INTPTLAT ?? props.centlat)
  const publishedLng = coordinate(props.CENTLON ?? props.INTPTLON ?? props.centlon)
  if (publishedLat != null && publishedLng != null) {
    return { lat: publishedLat, lng: publishedLng }
  }

  // GeoJSON polygons nest as coordinates; esriJSON uses rings. Both bottom out
  // in [x, y] pairs, so flattening handles either.
  const rings = feature?.geometry?.coordinates ?? feature?.geometry?.rings ?? null
  if (!rings) return null

  let sumLat = 0
  let sumLng = 0
  let count = 0
  const walk = (node) => {
    if (!Array.isArray(node)) return
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      sumLng += node[0]
      sumLat += node[1]
      count += 1
      return
    }
    for (const child of node) walk(child)
  }
  walk(rings)

  if (count === 0) return null
  return { lat: sumLat / count, lng: sumLng / count }
}

/** ACS rows for the given block groups, one request per state/county pair. */
export async function fetchAcs(groups, { fetchImpl = fetch, timeout = 12000, env = {} } = {}) {
  const counties = new Map()
  for (const group of groups) {
    const key = `${group.state}:${group.county}:${group.tract}`
    if (!counties.has(key)) counties.set(key, group)
  }

  // One request per county covers every tract in it, so collapse to counties.
  const byCounty = new Map()
  for (const group of counties.values()) {
    const key = `${group.state}:${group.county}`
    if (!byCounty.has(key)) byCounty.set(key, group)
  }

  const rows = new Map()
  for (const group of byCounty.values()) {
    const url = new URL(ACS_BASE)
    url.searchParams.set('get', `NAME,${Object.keys(VARIABLES).join(',')}`)
    url.searchParams.set('for', 'block group:*')
    url.searchParams.set('in', `state:${group.state} county:${group.county} tract:*`)
    if (env.CENSUS_API_KEY) url.searchParams.set('key', env.CENSUS_API_KEY)

    const table = await withTimeout(fetchImpl, url.toString(), timeout, 'ACS')
    if (!Array.isArray(table) || table.length < 2) continue

    const [header, ...body] = table
    for (const values of body) {
      const record = {}
      header.forEach((column, index) => {
        const field = VARIABLES[column]
        if (field) record[field] = toNumber(values[index])
      })
      const state = values[header.indexOf('state')]
      const county = values[header.indexOf('county')]
      const tract = values[header.indexOf('tract')]
      const blockGroup = values[header.indexOf('block group')]
      rows.set(`${state}${county}${tract}${blockGroup}`, { ...record, name: values[0] })
    }
  }
  return rows
}

/** A coordinate from TIGERweb, rejecting blanks rather than reading them as 0. */
function coordinate(value) {
  if (value == null) return null
  const text = String(value).trim()
  if (text === '') return null
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : null
}

/** The ACS marks suppressed values with large negative sentinels. */
function toNumber(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= -1e6) return null
  return parsed
}

/**
 * Combines block-group records into one set of ring figures.
 *
 * Counts add. Medians cannot, so they are weighted by population and reported
 * as approximate. Shares are computed from the summed counts rather than by
 * averaging percentages, which would over-weight small block groups.
 */
export function aggregate(records) {
  const totals = Object.fromEntries(SUMMABLE.map((key) => [key, 0]))
  const weighted = Object.fromEntries(WEIGHTED.map((key) => [key, { sum: 0, weight: 0 }]))
  let counted = 0

  for (const record of records) {
    if (!record) continue
    counted += 1
    for (const key of SUMMABLE) {
      if (Number.isFinite(record[key])) totals[key] += record[key]
    }
    const weight = Number.isFinite(record.population) ? record.population : 0
    for (const key of WEIGHTED) {
      if (Number.isFinite(record[key]) && weight > 0) {
        weighted[key].sum += record[key] * weight
        weighted[key].weight += weight
      }
    }
  }

  const metrics = {
    population: totals.population,
    households: totals.households,
  }

  for (const key of WEIGHTED) {
    const { sum, weight } = weighted[key]
    metrics[key] = weight > 0 ? Math.round((sum / weight) * 10) / 10 : null
  }

  metrics.renterShare = share(totals.renterOccupied, totals.occupiedUnits)
  metrics.educationShare = share(
    totals.bachelors + totals.masters + totals.professional + totals.doctorate,
    totals.educationUniverse,
  )

  return { metrics, blockGroups: counted }
}

function share(part, whole) {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null
  return Math.round((part / whole) * 1000) / 10
}

/**
 * Ring figures for a point, plus the block groups behind them.
 *
 * @returns {Promise<{source: string, radii: Array, areas: Array}>}
 * @throws {DemographicsUnavailable} when the upstream services cannot be reached
 */
export async function demographicsFor(
  lat,
  lng,
  { env = {}, fetchImpl = fetch, timeout = 12000, radii = RADII, includeGeometry = true } = {},
) {
  if (lat == null || lng == null) throw new DemographicsUnavailable('This property has no location yet.')

  const widest = Math.max(...radii)

  try {
    const groups = await fetchBlockGroups(lat, lng, widest, { fetchImpl, timeout })
    if (groups.length === 0) {
      throw new Error('no census block groups cover that point')
    }

    const acs = await fetchAcs(groups, { fetchImpl, timeout, env })

    const areas = groups.map((group) => ({
      geoid: group.geoid,
      lat: group.lat,
      lng: group.lng,
      miles: Math.round(group.miles * 100) / 100,
      metrics: acs.get(group.geoid) ?? null,
      geometry: includeGeometry ? group.geometry : null,
    }))

    const rings = radii.map((miles) => {
      const inside = areas.filter((area) => area.miles <= miles && area.metrics)
      const { metrics, blockGroups } = aggregate(inside.map((area) => area.metrics))
      return { miles, metrics, blockGroups }
    })

    return { source: ACS_VINTAGE, radii: rings, areas }
  } catch (error) {
    throw new DemographicsUnavailable(
      `Census data could not be retrieved (${error.message}). Set CENSUS_API_KEY or check this server's outbound network access.`,
    )
  }
}
