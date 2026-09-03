/**
 * The Census Bureau's batch geocoder.
 *
 * Free, keyless, and built for exactly this: up to 10,000 addresses per call
 * as a CSV, answered with a point and the census geography it falls in. Used
 * for practice addresses because there are millions of them and a per-address
 * geocoder — Nominatim, or a paid one — is the wrong tool at that scale.
 *
 *   https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.html
 */

import { csvLine, parseCsv } from './csv.mjs'

export const CENSUS_BATCH_URL = 'https://geocoding.geo.census.gov/geocoder/geographies/addressbatch'

/** The service's own ceiling per request. */
export const BATCH_LIMIT = 10000

/**
 * @param {{ id: string, street: string, city: string, state: string, zip: string }[]} rows
 * @returns {Promise<Map<string, GeocodeResult>>} keyed by the caller's id
 */
export async function geocodeBatch(rows, { fetchImpl = fetch, url = CENSUS_BATCH_URL } = {}) {
  if (rows.length === 0) return new Map()
  if (rows.length > BATCH_LIMIT) throw new Error(`a batch holds at most ${BATCH_LIMIT} addresses`)

  const body = rows.map((row) => csvLine([row.id, row.street, row.city, row.state, row.zip])).join('\n') + '\n'
  const form = new FormData()
  form.set('addressFile', new Blob([body], { type: 'text/csv' }), 'addresses.csv')
  form.set('benchmark', 'Public_AR_Current')
  form.set('vintage', 'Current_Current')

  const response = await fetchImpl(url, { method: 'POST', body: form })
  if (!response.ok) throw new Error(`Census geocoder answered HTTP ${response.status}`)
  return parseBatchResponse(await response.text())
}

/**
 * The response is a headerless CSV, one line per input row:
 * id, input address, match indicator, match type, matched address,
 * "lng,lat", tigerline id, side, state, county, tract, block.
 */
export async function parseBatchResponse(text) {
  const out = new Map()
  for await (const row of parseCsv([text])) {
    if (row.length < 3 || row[0] === '') continue
    const [id, input, indicator, matchType, matched, coordinates, , , state, county, tract, block] = row
    const result = { id, input, indicator, matchType: matchType || null, matched: matched || null, lat: null, lng: null, tract: null }
    if (indicator === 'Match' && coordinates) {
      const [lng, lat] = coordinates.split(',').map(Number)
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        result.lat = lat
        result.lng = lng
      }
      if (state && county && tract) result.tract = `${state}${county}${tract}`
      result.block = block || null
    }
    out.set(id, result)
  }
  return out
}
