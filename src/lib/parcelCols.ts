/*
 * A market's filter columns, walked without the database.
 *
 * "Industrial parcels over five acres worth more than a million" is a
 * question about four columns of a county. A market outside the search store
 * could not answer it: the browser downloaded index.json whole to look, and
 * the connector refused. The pipeline now publishes those columns alone as
 * plain arrays in cols.bin (prospector's make_cols.py), 26 bytes a parcel,
 * rows in order of value. This reads the file and answers a filter by
 * walking the arrays: the count, the total, the acreage, the mix by asset
 * type and the most valuable matches, with no rows read or written.
 *
 * The tests here are the ones the store runs (app/lib/parcels.js `where`),
 * so a market answers the same question the same way wherever it lives.
 * What the columns cannot answer (zoning, flood, buildings, a named owner's
 * portfolio, text with filters) is named by `unanswerable`, never guessed.
 */

import { FREE_CLEAR_YEARS, HELD_YEARS } from './owners.ts'

export interface Cols {
  n: number
  built: number
  /** west, south, east, north of the parcels' centres. */
  box: [number, number, number, number]
  steps: number
  assets: string[]
  states: string[]
  id: Float64Array
  mv: Uint32Array | Float64Array
  ac: Float32Array
  x: Uint16Array
  y: Uint16Array
  sy: Uint16Array
  sh: Uint16Array
  at: Uint8Array
  ms: Uint8Array
  /** How many bytes the file was, for a cache that counts what it holds. */
  bytes: number
}

export interface ColFilters {
  query?: string
  assets?: string[]
  valueMin?: number | null
  valueMax?: number | null
  acresMin?: number | null
  acresMax?: number | null
  owners?: string[]
  owner?: { id: string } | null
  zoningCategories?: string[]
  zoningNot?: string[]
  zoningCodes?: string[]
  flood?: string | null
  buildings?: string | null
  coverageMax?: number | null
  nearGrids?: unknown[]
  box?: number[] | null
  circle?: { lat: number; lng: number; miles: number } | null
  match?: string
}

export interface ColAnswer {
  count: number
  total: number
  acreage: number
  /** [asset type, how many], most first; a blank type is 'Unclassified'. */
  byAsset: [string, number][]
  /** The matches' ids in order of value, up to `keep`. */
  ids: number[]
  truncated: boolean
}

const TYPES = {
  f64: Float64Array,
  u32: Uint32Array,
  f32: Float32Array,
  u16: Uint16Array,
  u8: Uint8Array,
} as const
const WANTED: Record<string, (keyof typeof TYPES)[]> = {
  id: ['f64'], mv: ['u32', 'f64'], ac: ['f32'], x: ['u16'], y: ['u16'], sy: ['u16'], sh: ['u16'], at: ['u8'], ms: ['u8'],
}

/** The file as arrays over its own bytes (nothing is copied), or null for anything that is not a sound cols.bin. */
export function readCols(buffer: ArrayBuffer): Cols | null {
  try {
    const bytes = new Uint8Array(buffer)
    if (bytes.length < 8 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'LQC1') return null
    const size = new DataView(buffer).getUint32(4, true)
    const base = 8 + size
    if (base > bytes.length || base % 8 !== 0) return null
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, base)))
    const n = Number(header.n)
    if (header.v !== 1 || !Number.isInteger(n) || n < 1) return null
    const out: Record<string, unknown> = {}
    for (const column of header.columns as { name: string; type: keyof typeof TYPES; offset: number }[]) {
      const allowed = WANTED[column.name]
      if (!allowed || !allowed.includes(column.type)) return null
      const Kind = TYPES[column.type]
      const at = base + column.offset
      if (at % Kind.BYTES_PER_ELEMENT !== 0 || at + n * Kind.BYTES_PER_ELEMENT > bytes.length) return null
      out[column.name] = new Kind(buffer, at, n)
    }
    if (Object.keys(WANTED).some((name) => !(name in out))) return null
    if (!Array.isArray(header.box) || header.box.length !== 4 || !Array.isArray(header.assets) || !Array.isArray(header.states)) return null
    return { n, built: Number(header.built) || 0, box: header.box, steps: Number(header.steps) || 65535, assets: header.assets, states: header.states, bytes: bytes.length, ...(out as object) } as Cols
  } catch {
    return null
  }
}

/** The filters these columns cannot answer, by the names a person would know them by: empty when the answer can be given. */
export function unanswerable(filters: ColFilters): string[] {
  const names: string[] = []
  if ((filters.query || '').trim()) names.push('text together with other filters')
  if (filters.owner && filters.owner.id) names.push("one owner's portfolio")
  if ((filters.zoningCategories || []).length || (filters.zoningNot || []).length || (filters.zoningCodes || []).length) names.push('zoning')
  if (filters.flood === 'in' || filters.flood === 'out') names.push('flood zone')
  if (filters.buildings === 'vacant' || filters.buildings === 'built') names.push('buildings')
  if (filters.coverageMax != null && Number.isFinite(filters.coverageMax)) names.push('lot coverage')
  if ((filters.nearGrids || []).length) names.push('distance to a layer')
  return names
}

const METERS_PER_MILE = 1609.344
const METERS_PER_DEGREE = 111320

/**
 * Walk the columns once. The criteria (asset type, value, acres, the owner
 * readings) are met all together, or any one with match 'any'; the area (a
 * box, a circle) always bounds the set. `home` is the market's state, for
 * mail that goes out of it; `year` is this year, for how long a lot has been
 * held; `keep` is how many ids to list.
 */
export function scanCols(
  cols: Cols,
  filters: ColFilters,
  { home = null, year = new Date().getUTCFullYear(), keep = 25000 }: { home?: string | null; year?: number; keep?: number } = {},
): ColAnswer {
  const { n, mv, ac, x, y, sy, sh, at, ms, id } = cols
  const finite = (v: unknown): v is number => v != null && Number.isFinite(v as number)

  // Each criterion as a test of row i, in the order the store lists them.
  const tests: ((i: number) => boolean)[] = []
  const wantedAssets = (filters.assets || []).filter((a) => a !== '')
  if (wantedAssets.length) {
    const picked = new Uint8Array(256)
    for (const name of wantedAssets) {
      const index = cols.assets.indexOf(name)
      if (index > 0) picked[index] = 1
    }
    tests.push((i) => picked[at[i]] === 1)
  }
  const range = (column: ArrayLike<number>, min: unknown, max: unknown) => {
    const lo = finite(min)
    const hi = finite(max)
    if (lo && hi) tests.push((i) => column[i] >= (min as number) && column[i] <= (max as number))
    else if (lo) tests.push((i) => column[i] >= (min as number))
    else if (hi) tests.push((i) => column[i] <= (max as number))
  }
  range(mv, filters.valueMin, filters.valueMax)
  range(ac, filters.acresMin, filters.acresMax)
  const owners = new Set(filters.owners || [])
  if (owners.has('held10') || owners.has('freeClear')) {
    const last = year - (owners.has('freeClear') ? FREE_CLEAR_YEARS : HELD_YEARS)
    // A lot with no sale on record is left out, not counted as long held.
    tests.push((i) => sy[i] !== 0 && sy[i] <= last)
  }
  if (owners.has('outOfState')) {
    const here = home ? cols.states.indexOf(home) : -1
    // Mail with no state to read is left out; a market whose own state is
    // unknown matches nothing rather than everything.
    tests.push(home ? (i) => ms[i] !== 0 && ms[i] !== here : () => false)
  }
  const any = filters.match === 'any' && tests.length > 1

  // The area, as steps across the market's box so the walk compares integers.
  const [west, south, east, north] = cols.box
  const wide = east - west || 1e-9
  const tall = north - south || 1e-9
  const lngOf = (i: number) => west + (x[i] / cols.steps) * wide
  const latOf = (i: number) => south + (y[i] / cols.steps) * tall
  const box = Array.isArray(filters.box) && filters.box.length === 4 && filters.box.every(Number.isFinite) ? filters.box : null
  const circle = filters.circle && [filters.circle.lat, filters.circle.lng, filters.circle.miles].every(Number.isFinite) && filters.circle.miles > 0 ? filters.circle : null
  const k = circle ? Math.cos((circle.lat * Math.PI) / 180) : 1
  const r2 = circle ? ((circle.miles * METERS_PER_MILE) / METERS_PER_DEGREE) ** 2 : 0

  const counts = new Float64Array(cols.assets.length)
  const ids: number[] = []
  let count = 0
  let total = 0
  let acreage = 0
  for (let i = 0; i < n; i += 1) {
    if (box || circle) {
      const lng = lngOf(i)
      const lat = latOf(i)
      if (box && (lng < box[0] || lng > box[2] || lat < box[1] || lat > box[3])) continue
      if (circle) {
        const dx = (lng - circle.lng) * k
        const dy = lat - circle.lat
        if (dx * dx + dy * dy > r2) continue
      }
    }
    if (tests.length) {
      let met = !any
      for (let t = 0; t < tests.length; t += 1) {
        const ok = tests[t](i)
        if (any) {
          if (ok) {
            met = true
            break
          }
        } else if (!ok) {
          met = false
          break
        }
      }
      if (!met) continue
    }
    count += 1
    total += mv[i]
    // A condominium's units each carry the whole lot's acres: counted once a lot.
    acreage += ac[i] / (sh[i] || 1)
    counts[at[i]] += 1
    // Rows are in order of value, so the first met are the most valuable.
    if (ids.length < keep) ids.push(id[i])
  }
  const byAsset: [string, number][] = []
  for (let a = 0; a < counts.length; a += 1) if (counts[a]) byAsset.push([cols.assets[a] || 'Unclassified', counts[a]])
  byAsset.sort((p, q) => q[1] - p[1])
  return { count, total, acreage, byAsset, ids, truncated: count > ids.length }
}
