/**
 * What the Library can make for a parcel, and the packages that pick a few.
 *
 * A piece is one exhibit: a map the server draws and keeps, or a table made
 * from the same sources the map reads. A package is a named pick of pieces,
 * set up once and then exported for any parcel as one download. A few are
 * built in; a team saves its own.
 */
import type { Demographics, Landmark, NearbyBusiness } from '../types'

export type PieceId = 'parcel-map' | 'location-map' | 'retail-map' | 'demographics' | 'employment' | 'chains'

export interface PieceSpec {
  id: PieceId
  label: string
  group: 'Maps' | 'Data'
  what: string
  /** The file it becomes in a package. */
  file: string
}

export const PIECE_SPECS: PieceSpec[] = [
  { id: 'parcel-map', label: 'Parcel map', group: 'Maps', what: 'The lot outlined on the street map, with its neighbours', file: 'maps/parcel-map.png' },
  { id: 'location-map', label: 'Location map', group: 'Maps', what: 'A three-mile ring with the landmarks inside it', file: 'maps/location-map.png' },
  { id: 'retail-map', label: 'Retail map', group: 'Maps', what: 'The national chains within a mile', file: 'maps/retail-map.png' },
  { id: 'demographics', label: 'Demographics', group: 'Data', what: 'Population, households, income, age and education at 1, 3 and 5 miles', file: 'data/demographics.csv' },
  { id: 'employment', label: 'Employment', group: 'Data', what: 'Residents in work and the unemployment rate by ring, and the major employers within five miles', file: 'data/employment.csv' },
  { id: 'chains', label: 'Chains nearby', group: 'Data', what: 'Every national chain within a mile, by sector', file: 'data/chains-within-1-mile.csv' },
]

export const MAP_PIECES = PIECE_SPECS.filter((p) => p.group === 'Maps').map((p) => p.id) as ('parcel-map' | 'location-map' | 'retail-map')[]

export interface Package {
  /** Its saved-view id when it is the team's own; absent for the built-in ones. */
  id?: string
  name: string
  pieces: PieceId[]
}

export const PACKAGES: Package[] = [
  { name: 'Site', pieces: ['parcel-map', 'location-map'] },
  { name: 'Retail', pieces: ['retail-map', 'chains', 'demographics'] },
  { name: 'Market', pieces: ['location-map', 'demographics', 'employment'] },
  { name: 'Everything', pieces: PIECE_SPECS.map((p) => p.id) },
]

/** The pseudo-market the team's own packages are saved under, as saved views. */
export const PACKAGE_MARKET = 'library-packages'

/** Built-in and the team's own together: the team's wins a shared name, and its extras follow. */
export function packages(own: Package[]): Package[] {
  const mine = new Map(own.map((p) => [p.name.trim().toLowerCase(), p]))
  const out = PACKAGES.map((p) => mine.get(p.name.toLowerCase()) ?? p)
  for (const p of own) if (!PACKAGES.some((b) => b.name.toLowerCase() === p.name.trim().toLowerCase())) out.push(p)
  return out
}

/** Only pieces the Library knows, each once, in the Library's own order. */
export function cleanPieces(ids: unknown): PieceId[] {
  const wanted = new Set(Array.isArray(ids) ? ids.map(String) : [])
  return PIECE_SPECS.filter((p) => wanted.has(p.id)).map((p) => p.id)
}

type Cell = string | number | null
const EMPLOYMENT_KEYS = ['laborForce', 'employed', 'unemployed', 'unemploymentRate']
const LABELS: Record<string, string> = {
  population: 'Population',
  households: 'Households',
  medianHouseholdIncome: 'Median household income ($, approximate)',
  medianHomeValue: 'Median home value ($, approximate)',
  medianAge: 'Median age (approximate)',
  renterShare: 'Renter households (%)',
  educationShare: 'Bachelor\'s degree or higher (%)',
  laborForce: 'Residents in the civilian labor force',
  employed: 'Residents employed',
  unemployed: 'Residents unemployed',
  unemploymentRate: 'Unemployment rate (%)',
}
const ringHead = (data: Demographics): Cell[] => ['Measure', ...data.radii.map((ring) => `${ring.miles} mile${ring.miles === 1 ? '' : 's'}`)]
const ringRows = (data: Demographics, keys: string[]): Cell[][] =>
  keys.map((key) => [LABELS[key] ?? key, ...data.radii.map((ring) => ring.metrics[key] ?? null)])

/** The demographics table: everything the rings carry except employment, which has its own piece. */
export function demographicsRows(data: Demographics): Cell[][] {
  const keys = [...new Set(data.radii.flatMap((ring) => Object.keys(ring.metrics)))].filter((key) => !EMPLOYMENT_KEYS.includes(key))
  return [ringHead(data), ...ringRows(data, keys), [], ['Source', data.source]]
}

/**
 * The employment table: who among the residents works, by ring, and the
 * major employers headquartered nearby. Residents, not jobs: it says who
 * lives here and works, not how many jobs are located here.
 */
export function employmentRows(data: Demographics | null, employers: Landmark[]): Cell[][] {
  const rows: Cell[][] = []
  if (data) {
    rows.push(['Residents (people who live in the ring)'], ringHead(data), ...ringRows(data, EMPLOYMENT_KEYS), ['Source', data.source], [])
  }
  rows.push(['Major employers headquartered within 5 miles'], ['Employer', 'Employees (company-wide)', 'Industries', 'Miles', 'Located by'])
  const listed = employers.filter((l) => l.kind === 'headquarters').sort((a, b) => (b.employees ?? 0) - (a.employees ?? 0))
  // Where only the city is known, the distance is to the city's centre, and the row says so.
  const located = (l: Landmark) => (!l.located || l.located === 'exact' ? 'headquarters address' : 'city only; distance is to the city centre')
  if (listed.length) for (const l of listed) rows.push([l.name, l.employees ?? null, (l.industries ?? []).join('; ') || null, Math.round(l.miles * 100) / 100, located(l)])
  else rows.push(['None listed within 5 miles'])
  rows.push(['Source', 'Wikidata: notable companies only; headcount is the whole company, as Wikidata records it'])
  return rows
}

export function chainsRows(chains: NearbyBusiness[]): Cell[][] {
  return [
    ['Name', 'Brand', 'Sector', 'Address', 'Miles'],
    ...chains.map((b): Cell[] => [b.name, b.brand, b.sector ?? null, b.address, Math.round(b.miles * 100) / 100]),
  ]
}

/** Rows as CSV text. */
export function csv(rows: Cell[][]): string {
  const cell = (v: Cell) => {
    const text = v == null ? '' : String(v)
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  return rows.map((row) => row.map(cell).join(',')).join('\n')
}
