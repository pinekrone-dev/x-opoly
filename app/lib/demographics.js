/**
 * Trade-area demographics.
 *
 * Uses the US Census ACS 5-year API, which is free and needs no key for light
 * use (`CENSUS_API_KEY` raises the limit). When the API cannot be reached the
 * result says so — this never estimates or interpolates, because a broker will
 * put these numbers in front of a client.
 */

const ACS_BASE = 'https://api.census.gov/data/2022/acs/acs5'

// ACS variable codes → the fields we show.
const VARIABLES = {
  B01003_001E: 'population',
  B19013_001E: 'medianHouseholdIncome',
  B25077_001E: 'medianHomeValue',
  B01002_001E: 'medianAge',
  B23025_005E: 'unemployed',
  B15003_022E: 'bachelorsDegrees',
}

export class DemographicsUnavailable extends Error {
  constructor(message) {
    super(message)
    this.name = 'DemographicsUnavailable'
  }
}

/** Finds the census tract containing a point, via the Census geocoder. */
async function locateTract(lat, lng, fetchImpl, timeout) {
  const url = new URL('https://geocoding.geo.census.gov/geocoder/geographies/coordinates')
  url.searchParams.set('x', String(lng))
  url.searchParams.set('y', String(lat))
  url.searchParams.set('benchmark', 'Public_AR_Current')
  url.searchParams.set('vintage', 'Current_Current')
  url.searchParams.set('layers', 'Census Tracts')
  url.searchParams.set('format', 'json')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetchImpl(url.toString(), { signal: controller.signal })
    if (!response.ok) throw new Error(`geocoder HTTP ${response.status}`)
    const body = await response.json()
    const tract = body?.result?.geographies?.['Census Tracts']?.[0]
    if (!tract) throw new Error('no census tract covers that point')
    return { state: tract.STATE, county: tract.COUNTY, tract: tract.TRACT, name: tract.NAME }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * @returns {Promise<{ source: string, area: string, metrics: object }>}
 * @throws {DemographicsUnavailable} when the upstream API cannot be reached
 */
export async function demographicsFor(lat, lng, { env = {}, fetchImpl = fetch, timeout = 12000 } = {}) {
  if (lat == null || lng == null) throw new DemographicsUnavailable('This property has no location yet.')

  try {
    const tract = await locateTract(lat, lng, fetchImpl, timeout)

    const url = new URL(ACS_BASE)
    url.searchParams.set('get', `NAME,${Object.keys(VARIABLES).join(',')}`)
    url.searchParams.set('for', `tract:${tract.tract}`)
    url.searchParams.set('in', `state:${tract.state} county:${tract.county}`)
    if (env.CENSUS_API_KEY) url.searchParams.set('key', env.CENSUS_API_KEY)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    let rows
    try {
      const response = await fetchImpl(url.toString(), { signal: controller.signal })
      if (!response.ok) throw new Error(`ACS HTTP ${response.status}`)
      rows = await response.json()
    } finally {
      clearTimeout(timer)
    }

    const [header, values] = rows
    const metrics = {}
    header.forEach((column, index) => {
      const field = VARIABLES[column]
      if (!field) return
      const parsed = Number(values[index])
      // The ACS uses large negative sentinels for suppressed values.
      metrics[field] = Number.isFinite(parsed) && parsed > -1e6 ? parsed : null
    })

    return { source: 'US Census ACS 5-year (2022)', area: values[0], metrics }
  } catch (error) {
    throw new DemographicsUnavailable(
      `Census data could not be retrieved (${error.message}). Set CENSUS_API_KEY or check this server's outbound network access.`,
    )
  }
}
