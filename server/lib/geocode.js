/**
 * Address lookup.
 *
 * Defaults to Nominatim (OpenStreetMap) because it needs no key and no billing
 * account. `GEOCODER_URL` swaps in a different provider — a self-hosted
 * Nominatim, or a Google Geocoding endpoint once someone wants that — and
 * every failure is reported rather than guessed at, because a pin in the wrong
 * place is worse than no pin.
 */

const DEFAULT_ENDPOINT = 'https://nominatim.openstreetmap.org/search'

export class GeocodeError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message)
    this.name = 'GeocodeError'
    this.retryable = retryable
  }
}

function parseNominatim(results) {
  return results
    .filter((result) => result.lat && result.lon)
    .slice(0, 8)
    .map((result) => ({
      label: result.display_name,
      lat: Number(result.lat),
      lng: Number(result.lon),
      address: result.address?.road
        ? [result.address.house_number, result.address.road].filter(Boolean).join(' ')
        : null,
      city: result.address?.city || result.address?.town || result.address?.village || null,
      state: result.address?.state || null,
      zip: result.address?.postcode || null,
    }))
}

/**
 * @param {string} query free-text address
 * @returns {Promise<Array>} candidate locations, best first
 */
export async function geocode(query, { fetchImpl = fetch, timeout = 10000, signal } = {}) {
  const search = String(query || '').trim()
  if (search.length < 3) throw new GeocodeError('Enter at least three characters to search.')

  const endpoint = process.env.GEOCODER_URL || DEFAULT_ENDPOINT
  const url = new URL(endpoint)
  url.searchParams.set('q', search)
  url.searchParams.set('format', 'jsonv2')
  url.searchParams.set('addressdetails', '1')
  url.searchParams.set('limit', '8')
  if (process.env.GEOCODER_KEY) url.searchParams.set('key', process.env.GEOCODER_KEY)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  if (signal) signal.addEventListener('abort', () => controller.abort())

  try {
    const response = await fetchImpl(url.toString(), {
      signal: controller.signal,
      headers: {
        // Nominatim's usage policy requires an identifying User-Agent.
        'user-agent': process.env.GEOCODER_UA || 'SiteSurveyCRE/1.0 (self-hosted deal mapping tool)',
        accept: 'application/json',
      },
    })

    if (response.status === 429) {
      throw new GeocodeError('The geocoder is rate limiting us. Wait a moment and try again.', { retryable: true })
    }
    if (response.status === 401 || response.status === 403) {
      // Our access is the problem, not the caller's query — usually an
      // outbound firewall or a missing GEOCODER_KEY.
      throw new GeocodeError(
        'This server is not allowed to reach the geocoder. Check its outbound network access or set GEOCODER_URL. You can still place the pin by hand.',
        { retryable: true },
      )
    }
    if (!response.ok) {
      throw new GeocodeError(`The geocoder returned HTTP ${response.status}.`, { retryable: response.status >= 500 })
    }

    const body = await response.json()
    return parseNominatim(Array.isArray(body) ? body : [])
  } catch (error) {
    if (error instanceof GeocodeError) throw error
    if (error?.name === 'AbortError') throw new GeocodeError('The address lookup timed out.', { retryable: true })
    throw new GeocodeError(
      `Address lookup is unreachable from this server (${error.message}). You can still drop a pin on the map by hand.`,
      { retryable: true },
    )
  } finally {
    clearTimeout(timer)
  }
}
