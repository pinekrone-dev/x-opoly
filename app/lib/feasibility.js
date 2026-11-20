/**
 * The four public services a site's feasibility screen reads, and the screen
 * run over what they return (src/lib/feasibility.ts does the arithmetic).
 *
 *   USGS 3DEP            ground elevation, sampled at each cell of the grid
 *   FEMA NFHL            flood hazard zones and the special flood hazard area
 *   USFWS NWI            mapped wetlands
 *   USGS PAD-US          protected areas and land held by public bodies
 *
 * All four are federal, free and open to anyone, and answer for the whole
 * country, so the screen works in every market with nothing published for
 * it. Each is asked once a lot, for the lot's own box, with outlines thinned
 * to a few yards: tens of kilobytes. One that does not answer is reported as
 * not screened and the others still stand; nothing is guessed in its place.
 */
import { assess, boxOf, gridOver } from '../../src/lib/feasibility.ts'

export const SOURCES = {
  elevation: {
    name: 'USGS 3D Elevation Program (3DEP)',
    url: 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/getSamples',
    page: 'https://www.usgs.gov/3d-elevation-program',
  },
  flood: {
    name: 'FEMA National Flood Hazard Layer',
    url: 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query',
    page: 'https://www.fema.gov/flood-maps/national-flood-hazard-layer',
    fields: 'FLD_ZONE,ZONE_SUBTY,SFHA_TF',
  },
  wetlands: {
    name: 'U.S. Fish and Wildlife Service National Wetlands Inventory',
    url: 'https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/services/Wetlands/MapServer/0/query',
    page: 'https://www.fws.gov/program/national-wetlands-inventory',
    fields: 'WETLAND_TYPE,ATTRIBUTE,ACRES',
  },
  protectedLand: {
    name: 'USGS Protected Areas Database of the United States (PAD-US)',
    url: 'https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/PADUS_Protection_Status_by_GAP_Status_Code/FeatureServer/0/query',
    page: 'https://www.usgs.gov/programs/gap-analysis-project/science/pad-us-data-overview',
    fields: 'Unit_Nm,MngNm_Desc,DesTp_Desc,Category,GAP_Sts,Pub_Access',
  },
}

const AGENT = 'LandQuotient/1.0 (+https://landquotient.com)'
const WAIT_MS = 15000

async function json(fetcher, url, init = {}) {
  const response = await fetcher(url, { ...init, headers: { 'user-agent': AGENT, ...(init.headers || {}) }, signal: AbortSignal.timeout(WAIT_MS) })
  if (!response.ok) throw new Error(`answered ${response.status}`)
  const body = await response.json()
  if (body && body.error) throw new Error(String(body.error.message || 'refused the request').slice(0, 120))
  return body
}

/** Ground elevation in metres at each point, in the order given; NaN where the service has none. */
export async function elevations(points, fetcher = fetch) {
  const form = new URLSearchParams({
    geometry: JSON.stringify({ points, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryMultipoint',
    returnFirstValueOnly: 'true',
    f: 'json',
  })
  const body = await json(fetcher, SOURCES.elevation.url, { method: 'POST', body: form, headers: { 'content-type': 'application/x-www-form-urlencoded' } })
  const z = points.map(() => NaN)
  let finest = null
  for (const sample of body.samples || []) {
    const value = Number(sample.value)
    // The service marks water and gaps with a large negative number or "NoData".
    if (Number.isInteger(sample.locationId) && Number.isFinite(value) && value > -1000) z[sample.locationId] = value
    const resolution = Number(sample.resolution)
    if (Number.isFinite(resolution) && resolution > 0 && (finest == null || resolution < finest)) finest = resolution
  }
  if (!z.some(Number.isFinite)) throw new Error('has no ground elevation here')
  return { z, resolutionMeters: finest }
}

/** The outlines of one service's features that touch a box, thinned to about three metres. */
export async function outlines(source, box, fetcher = fetch) {
  const query = new URLSearchParams({
    geometry: box.join(','),
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: source.fields,
    returnGeometry: 'true',
    outSR: '4326',
    geometryPrecision: '6',
    maxAllowableOffset: '0.00003',
    resultRecordCount: '200',
    f: 'json',
  })
  const body = await json(fetcher, `${source.url}?${query}`)
  return (body.features || [])
    .map((feature) => ({ attributes: feature.attributes || {}, rings: (feature.geometry && feature.geometry.rings) || [] }))
    .filter((overlay) => overlay.rings.length)
}

const settled = async (name, work) => {
  try {
    return { available: true, data: await work() }
  } catch (cause) {
    return { available: false, reason: `${name} ${String(cause && cause.name === 'TimeoutError' ? 'did not answer in time' : cause?.message || 'did not answer').slice(0, 140)}.` }
  }
}

/**
 * The screen for one lot. `geometry` is its outline (GeoJSON Polygon or
 * MultiPolygon, longitude and latitude); `maxSlopePercent` the steepest
 * ground counted as buildable, fifteen unless said.
 */
export async function siteFeasibility({ geometry, maxSlopePercent = 15, fetcher = fetch }) {
  const grid = gridOver(geometry)
  const box = boxOf(geometry)
  const [elevation, flood, wetlands, protectedLand] = await Promise.all([
    settled(SOURCES.elevation.name, () => elevations(grid.points, fetcher)),
    settled(SOURCES.flood.name, () => outlines(SOURCES.flood, box, fetcher)),
    settled(SOURCES.wetlands.name, () => outlines(SOURCES.wetlands, box, fetcher)),
    settled(SOURCES.protectedLand.name, () => outlines(SOURCES.protectedLand, box, fetcher)),
  ])
  return {
    ...assess({ geometry, grid, elevation, flood, wetlands, protectedLand, maxSlopePercent }),
    sources: Object.values(SOURCES).map(({ name, page }) => ({ name, page })),
  }
}
