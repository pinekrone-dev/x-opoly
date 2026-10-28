/*
 * A parcel's whole street address: street, city, state, ZIP.
 *
 * The county records carry the street on every parcel, but the town and ZIP
 * unevenly: some publish the property's city, some only a municipality
 * ("Carteret Boro"), some neither; most publish the property's ZIP. So the
 * city is the ZIP's place name (GeoNames, CC BY 4.0) where there is a ZIP,
 * and the record's own town, tidied, where there is not. The state is the
 * ZIP's, or the market's.
 *
 * One market's ZIP field is the owner's mailing ZIP rather than the
 * property's: New Jersey's statewide parcel data has no property ZIP, and
 * the column there is the owner's. Shown as the parcel's, it put Carteret
 * warehouses in Farmingdale, New York. There the ZIP is left out rather than
 * guessed.
 */

/** A market's state from its slug (austin-tx is TX). Kept here, without an
 *  import, because the server loads this file too. */
function marketState(slug: string): string {
  const match = /-([a-z]{2})$/.exec(slug)
  return match ? match[1].toUpperCase() : ''
}

/** Markets whose `zp` is the owner's ZIP, not the property's. */
const OWNER_ZIP_MARKETS = new Set(['jersey-city-nj'])

let places: Promise<Record<string, string>> | null = null

/** The ZIP-to-place table, fetched once, the first time an export needs it. */
export function zipPlaces(): Promise<Record<string, string>> {
  if (!places) {
    places = fetch('/geo/zip-places.json')
      .then((r) => (r.ok ? r.json() : { zips: {} }))
      .then((d: { zips?: Record<string, string> }) => d.zips ?? {})
      .catch(() => {
        places = null
        return {}
      })
  }
  return places
}

/** A five-digit ZIP, zero-padded where a source dropped the leading zero; else ''. */
export function zip5(raw: unknown): string {
  const digits = String(raw ?? '').trim().split(/[-\s]/)[0].replace(/\D/g, '')
  if (!digits || /^0+$/.test(digits) || digits.length > 5) return ''
  return digits.padStart(5, '0')
}

/** A municipality as a postal city: "Carteret Boro" is Carteret, "Woodbridge Twp" Woodbridge. */
export function postalCity(raw: unknown): string {
  const text = String(raw ?? '').trim().replace(/\s+/g, ' ')
  if (!text) return ''
  return text.replace(/\s+(boro|borough|twp|township|town|village|vlg|cdp)\.?$/i, '').trim()
}

export interface FullAddress {
  street: string
  city: string
  state: string
  zip: string
  full: string
}

export function fullAddress(
  row: Record<string, unknown>,
  slug: string,
  table: Record<string, string> = {},
): FullAddress {
  const street = String(row.ad ?? '').trim()
  const zip = OWNER_ZIP_MARKETS.has(slug) ? '' : zip5(row.zp)
  const [zipCity, zipState] = (zip && table[zip] ? table[zip] : '|').split('|')
  // The ZIP's place first: it is the town the post office uses. The county's
  // own field is sometimes a jurisdiction ("Unincorporated", "Pima County")
  // or a borough ("Manhattan") rather than a town, so it is the fallback,
  // and never one of those.
  const recorded = [row.ct, row.tn].map(postalCity).find((c) => c && !/unincorporated|county/i.test(c)) ?? ''
  const city = zipCity || recorded
  const state = zipState || marketState(slug) || ''
  const tail = [state, zip].filter(Boolean).join(' ')
  const full = street ? [street, city, tail].filter(Boolean).join(', ') : ''
  return { street, city, state, zip, full }
}
