/**
 * Does the listing's unit or bedroom count match the county's?
 *
 * A listing that says six units on a lot the assessor carries as a duplex is
 * either an unpermitted conversion or a typo, and either is worth knowing
 * before an offer. The county's side comes from the market's own panel spec,
 * found by label rather than by key, because the keys do not mean the same
 * thing everywhere: Detroit's `un` is a count of buildings, Jersey City's
 * `bd` is a building description, and Chicago's `bd` is bedrooms.
 */
import type { PanelGroup } from '../components/ParcelPanel'

export interface Counts {
  units: number | null
  bedrooms: number | null
}

export interface CountyCounts extends Counts {
  /** The county's own name for the unit count it carries ("Residential units"). */
  unitsLabel: string | null
}

export interface Mismatch {
  field: 'units' | 'bedrooms'
  listing: number
  county: number
}

// Most specific first: New York carries residential and total units, and a
// listing's unit count is the residential one.
const UNIT_LABELS = [/^residential units$/i, /^dwelling units$/i, /^units$/i, /^apartments$/i, /^total units$/i]
const BEDROOM_LABELS = [/^bedrooms?$/i, /^beds$/i]

/** A count read from what a person or a county wrote: "6", "6 units", "2BR". */
export function readCount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value) : null
  const match = /\d+(?:\.\d+)?/.exec(String(value ?? '').replace(/,/g, ''))
  if (!match) return null
  const n = Math.round(Number(match[0]))
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * The unit and bedroom counts the county record carries, by the market's
 * panel labels. Zero reads as unknown: rolls write 0 where nobody counted,
 * and a house carried as zero units has not been counted, not demolished.
 */
export function countyCounts(panel: PanelGroup[] | undefined, record: Record<string, unknown> | null | undefined): CountyCounts {
  const rows = (panel ?? []).flatMap((group) => group.rows)
  const find = (patterns: RegExp[]) => {
    for (const pattern of patterns) {
      const row = rows.find((r) => pattern.test(r.l.trim()))
      if (row) return row
    }
    return null
  }
  const unitsRow = find(UNIT_LABELS)
  const bedroomsRow = find(BEDROOM_LABELS)
  return {
    units: unitsRow && record ? readCount(record[unitsRow.k]) : null,
    unitsLabel: unitsRow?.l ?? null,
    bedrooms: bedroomsRow && record ? readCount(record[bedroomsRow.k]) : null,
  }
}

/** Whether a market's panel carries either count at all. */
export function countyCountsPublished(panel: PanelGroup[] | undefined): boolean {
  const labels = (panel ?? []).flatMap((group) => group.rows.map((r) => r.l.trim()))
  return labels.some((l) => [...UNIT_LABELS, ...BEDROOM_LABELS].some((pattern) => pattern.test(l)))
}

const LISTING_UNITS = /^(?:#\s*(?:of\s*)?units|units?|unit count|number of units|no\.? of units|apartments|doors)$/i
const LISTING_BEDS = /^(?:bed(?:room)?s?|br|bd|# of bedrooms|number of bedrooms|total bedrooms)$/i

/** The counts a listing's own fields carry, by label: "Units", "Beds", "# of Units". */
export function listingCounts(fields: { label: string; value?: string | null }[] | null | undefined): Counts {
  const out: Counts = { units: null, bedrooms: null }
  for (const field of fields ?? []) {
    const label = field.label.trim()
    if (out.units == null && LISTING_UNITS.test(label)) out.units = readCount(field.value)
    if (out.bedrooms == null && LISTING_BEDS.test(label)) out.bedrooms = readCount(field.value)
  }
  return out
}

/** Where the listing and the county disagree. Only counts both sides carry are compared. */
export function mismatches(listing: Counts, county: Counts): Mismatch[] {
  const out: Mismatch[] = []
  if (listing.units != null && county.units != null && listing.units !== county.units) {
    out.push({ field: 'units', listing: listing.units, county: county.units })
  }
  if (listing.bedrooms != null && county.bedrooms != null && listing.bedrooms !== county.bedrooms) {
    out.push({ field: 'bedrooms', listing: listing.bedrooms, county: county.bedrooms })
  }
  return out
}

/** One mismatch as a sentence. */
export function describeMismatch(m: Mismatch): string {
  const noun = (n: number) => (m.field === 'units' ? `unit${n === 1 ? '' : 's'}` : `bedroom${n === 1 ? '' : 's'}`)
  return `Listing says ${m.listing} ${noun(m.listing)}; county records ${m.county}.`
}
