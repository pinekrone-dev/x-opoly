/*
 * Reported crime round a site, walked from one packed file.
 *
 * "How much violent crime is there within a quarter mile of this lot" is a
 * question about a circle and a year. The pipeline packs each offense a
 * police agency publishes (where, when, the agency's category, and whether
 * the agency itself calls it violent or a crime against property) as plain
 * arrays in crime.bin (prospector's make_crime.py): eight bytes an offense,
 * latest first. This reads the file and counts the offenses inside each
 * circle over the last twelve months the file covers.
 *
 * Three things keep a count honest:
 *  - where the agency's figures hold is in the file, so a site another
 *    agency polices is told so by name and given no number, never a zero;
 *  - a circle that runs out of that area says how much of it is covered;
 *  - the file carries how the same circles count round the market's own
 *    parcels, so a number comes with where it stands among them.
 */

/** The markets with an agency's reported crime published: where the map's lot card asks. */
export const CRIME_MARKETS = new Set(['las-vegas-nv'])

export type Ring = [number, number][]

export interface CrimeAgency {
  name: string
  short: string
  page?: string | null
  definitions?: { violent?: string; property?: string }
  notes?: string[]
  rings: Ring[]
}

export interface CrimeBaseline {
  sample: number
  radii: number[]
  /** Per radius, the count at every 5% of the market's parcels, least to most (21 marks). */
  violent: number[][]
  property: number[][]
}

export interface Crime {
  n: number
  built: number
  from: string
  to: string
  firstDay: number
  lastDay: number
  windowDays: number
  radii: number[]
  /** west, south, east, north of the offenses. */
  box: [number, number, number, number]
  steps: number
  categories: string[]
  agencies: CrimeAgency[]
  elsewhere: { name: string; rings: Ring[] }[]
  baseline: CrimeBaseline | null
  epoch: string
  x: Uint16Array
  y: Uint16Array
  day: Uint16Array
  cat: Uint8Array
  kind: Uint8Array
  bytes: number
}

export interface CrimeRing {
  miles: number
  violent: number
  property: number
  /** Every other reported offense (drugs, weapons, the agency's lesser group). */
  other: number
  /** How much of the circle lies where the agency's figures hold, 0 to 1. */
  covered: number
  /** The share of the market's parcels with fewer violent offenses in the same circle, 0 to 100; null with nothing to compare. */
  violentAbove: number | null
  propertyAbove: number | null
}

export interface CrimeAnswer {
  /** Whether the site itself is where an agency in the file polices. */
  covered: boolean
  agency: string | null
  /** The named place the site is in when another agency polices it. */
  elsewhere: string | null
  /** The twelve months counted, as dates. */
  from: string
  to: string
  rings: CrimeRing[]
  /** The agency's categories inside the widest circle, most first: [category, 'violent' | 'property' | 'other', count per radius]. */
  categories: { category: string; kind: 'violent' | 'property' | 'other'; counts: number[] }[]
  definitions: { violent?: string; property?: string }
  notes: string[]
  source: { name: string; page: string | null } | null
  compared: { parcels: number } | null
}

const TYPES = { u16: Uint16Array, u8: Uint8Array } as const
const WANTED: Record<string, keyof typeof TYPES> = { x: 'u16', y: 'u16', day: 'u16', cat: 'u8', kind: 'u8' }

/** The file as arrays over its own bytes, or null for anything that is not a sound crime.bin. */
export function readCrime(buffer: ArrayBuffer): Crime | null {
  try {
    const bytes = new Uint8Array(buffer)
    if (bytes.length < 8 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'LQX1') return null
    const size = new DataView(buffer).getUint32(4, true)
    const base = 8 + size
    if (base > bytes.length || base % 8 !== 0) return null
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, base)))
    const n = Number(header.n)
    if (header.v !== 1 || !Number.isInteger(n) || n < 1) return null
    const out: Record<string, unknown> = {}
    for (const column of header.columns as { name: string; type: keyof typeof TYPES; offset: number }[]) {
      if (WANTED[column.name] !== column.type) return null
      const Kind = TYPES[column.type]
      const at = base + column.offset
      if (at % Kind.BYTES_PER_ELEMENT !== 0 || at + n * Kind.BYTES_PER_ELEMENT > bytes.length) return null
      out[column.name] = new Kind(buffer, at, n)
    }
    if (Object.keys(WANTED).some((name) => !(name in out))) return null
    if (!Array.isArray(header.box) || header.box.length !== 4 || !Array.isArray(header.categories) || !Array.isArray(header.agencies)) return null
    if (!Number.isInteger(header.lastDay) || !Number.isInteger(header.firstDay)) return null
    return {
      n,
      built: Number(header.built) || 0,
      from: String(header.from || ''),
      to: String(header.to || ''),
      firstDay: header.firstDay,
      lastDay: header.lastDay,
      windowDays: Number(header.windowDays) || 365,
      radii: Array.isArray(header.radii) && header.radii.length ? header.radii.map(Number) : [0.25, 0.5, 1],
      box: header.box,
      steps: Number(header.steps) || 65535,
      categories: header.categories,
      agencies: header.agencies,
      elsewhere: Array.isArray(header.elsewhere) ? header.elsewhere : [],
      baseline: header.baseline && Array.isArray(header.baseline.violent) ? header.baseline : null,
      epoch: String(header.epoch || '2020-01-01'),
      bytes: bytes.length,
      ...(out as object),
    } as Crime
  } catch {
    return null
  }
}

// A ring's own box, worked out once: an agency's area is dozens of rings and
// a place is inside the box of one or two.
const boxes = new WeakMap<Ring, [number, number, number, number]>()
function boxOf(ring: Ring): [number, number, number, number] {
  let box = boxes.get(ring)
  if (!box) {
    box = [Infinity, Infinity, -Infinity, -Infinity]
    for (const [x, y] of ring) {
      if (x < box[0]) box[0] = x
      if (y < box[1]) box[1] = y
      if (x > box[2]) box[2] = x
      if (y > box[3]) box[3] = y
    }
    boxes.set(ring, box)
  }
  return box
}

/** Even-odd over every ring, so a hole is outside and a second polygon is inside. */
export function inRings(rings: Ring[], lng: number, lat: number): boolean {
  let hit = false
  for (const ring of rings) {
    const box = boxOf(ring)
    if (lng < box[0] || lng > box[2] || lat < box[1] || lat > box[3]) continue
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, yi] = ring[i]
      const [xj, yj] = ring[j]
      if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit
    }
  }
  return hit
}

const METERS_PER_MILE = 1609.344
const METERS_PER_DEGREE = 111320

const dateOf = (epoch: string, day: number) => new Date(Date.parse(`${epoch}T00:00:00Z`) + day * 86400000).toISOString().slice(0, 10)

/**
 * The share of the market's parcels with fewer offenses than `count` in the
 * same circle, from the 21 marks the file keeps (the count at every 5% of
 * them). A count no parcel in twenty falls under reads 0; one above them all
 * reads 99.
 */
export function shareBelow(marks: number[] | undefined, count: number): number | null {
  if (!marks || marks.length !== 21) return null
  if (count <= marks[0]) return 0
  // Above every parcel compared is still "more than 99%": the comparison is
  // a sample, and nothing is above all of anything.
  if (count > marks[20]) return 99
  // The last mark below the count, and how far the count is toward the next.
  let i = 0
  while (i < 20 && marks[i + 1] < count) i += 1
  const span = marks[i + 1] - marks[i]
  const part = span > 0 ? Math.min(1, (count - marks[i]) / span) : 0
  // A count the marks reach is not above every parcel: 99 at most.
  return Math.min(99, Math.round((i + part) * 5))
}

/** How much of a circle lies inside the rings, from a few dozen points spread across it. */
function coveredShare(rings: Ring[], lng: number, lat: number, radiusDeg: number, k: number): number {
  let inside = 0
  let total = 0
  // Three rounds of points at a third, two thirds and the edge, and the centre.
  for (const [share, points] of [[0, 1], [1 / 3, 8], [2 / 3, 16], [1, 24]] as const) {
    for (let p = 0; p < points; p += 1) {
      const angle = (p / points) * 2 * Math.PI
      const x = lng + (Math.cos(angle) * radiusDeg * share) / k
      const y = lat + Math.sin(angle) * radiusDeg * share
      total += 1
      if (inRings(rings, x, y)) inside += 1
    }
  }
  return inside / total
}

/** The offenses reported inside each circle round a place, over the last twelve months the file covers. */
export function crimeNear(crime: Crime, place: { lat: number; lng: number }): CrimeAnswer {
  const { lat, lng } = place
  const agency = crime.agencies.find((a) => inRings(a.rings, lng, lat)) ?? null
  const fromDay = crime.lastDay - crime.windowDays + 1
  const answer: CrimeAnswer = {
    covered: Boolean(agency),
    agency: agency?.name ?? null,
    elsewhere: null,
    from: dateOf(crime.epoch, Math.max(fromDay, crime.firstDay)),
    to: dateOf(crime.epoch, crime.lastDay),
    rings: [],
    categories: [],
    definitions: agency?.definitions ?? {},
    notes: agency?.notes ?? [],
    source: agency ? { name: agency.name, page: agency.page ?? null } : null,
    compared: null,
  }
  if (!agency) {
    answer.elsewhere = crime.elsewhere.find((e) => inRings(e.rings, lng, lat))?.name ?? null
    return answer
  }

  const { n, x, y, day, cat, kind } = crime
  const [west, south, east, north] = crime.box
  const wide = east - west || 1e-9
  const tall = north - south || 1e-9
  const k = Math.cos((lat * Math.PI) / 180)
  const radii = crime.radii
  const limits = radii.map((miles) => ((miles * METERS_PER_MILE) / METERS_PER_DEGREE) ** 2)
  const widest = Math.sqrt(limits[limits.length - 1])
  // Rows of the box outside the widest circle are skipped on two integer compares.
  const xLo = ((lng - widest / k - west) / wide) * crime.steps
  const xHi = ((lng + widest / k - west) / wide) * crime.steps
  const yLo = ((lat - widest - south) / tall) * crime.steps
  const yHi = ((lat + widest - south) / tall) * crime.steps

  const counts = radii.map(() => [0, 0, 0])
  const byCategory = new Map<number, number[]>()
  for (let i = 0; i < n; i += 1) {
    // Latest first: the first row older than the twelve months ends the walk.
    if (day[i] < fromDay) break
    if (x[i] < xLo || x[i] > xHi || y[i] < yLo || y[i] > yHi) continue
    const dx = (west + (x[i] / crime.steps) * wide - lng) * k
    const dy = south + (y[i] / crime.steps) * tall - lat
    const d = dx * dx + dy * dy
    if (d > limits[limits.length - 1]) continue
    const key = cat[i] * 4 + kind[i]
    let row = byCategory.get(key)
    if (!row) byCategory.set(key, (row = radii.map(() => 0)))
    for (let r = 0; r < limits.length; r += 1) {
      if (d <= limits[r]) {
        counts[r][kind[i]] += 1
        row[r] += 1
      }
    }
  }

  const base = crime.baseline
  answer.rings = radii.map((miles, r) => {
    const at = base ? base.radii.indexOf(miles) : -1
    return {
      miles,
      violent: counts[r][1],
      property: counts[r][2],
      other: counts[r][0],
      covered: Math.round(coveredShare(agency.rings, lng, lat, Math.sqrt(limits[r]), k) * 100) / 100,
      violentAbove: at >= 0 ? shareBelow(base!.violent[at], counts[r][1]) : null,
      propertyAbove: at >= 0 ? shareBelow(base!.property[at], counts[r][2]) : null,
    }
  })
  const kinds = ['other', 'violent', 'property'] as const
  const last = radii.length - 1
  answer.categories = [...byCategory.entries()]
    .map(([key, row]) => ({ category: crime.categories[key >> 2] || 'Not categorised', kind: kinds[key & 3] ?? 'other', counts: row }))
    .sort((a, b) => b.counts[last] - a.counts[last] || a.category.localeCompare(b.category))
  answer.compared = base ? { parcels: base.sample } : null
  return answer
}
