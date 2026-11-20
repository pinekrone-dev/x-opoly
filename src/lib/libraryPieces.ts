/**
 * What the Library can make for a parcel, and the packages that pick a few.
 *
 * A piece is one exhibit: a map the server draws and keeps, or a table made
 * from the same sources the map reads. A package is a named pick of pieces,
 * set up once and then exported for any parcel as one download. A few are
 * built in; a team saves its own.
 */
import type { Demographics, Landmark, NearbyBusiness } from '../types'
import type { CrimeAnswer } from './crime'
import type { Feasibility } from './feasibility'

export type PieceId = 'parcel-map' | 'location-map' | 'retail-map' | 'feasibility-map' | 'feasibility' | 'crime' | 'demographics' | 'employment' | 'chains'

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
  { id: 'feasibility-map', label: 'Site feasibility map', group: 'Maps', what: 'The lot in cells, each coloured by what stands in the way: slope, flood hazard, wetland, protected land', file: 'maps/site-feasibility-map.png' },
  { id: 'feasibility', label: 'Site feasibility', group: 'Data', what: 'Slope, flood hazard, wetlands and protected land on the lot, and the acres that pass all four', file: 'data/site-feasibility.csv' },
  { id: 'crime', label: 'Crime nearby', group: 'Data', what: 'Violent and property crime reported within a quarter, a half and a mile in the last twelve months, where the police publish it', file: 'data/crime-nearby.csv' },
  { id: 'demographics', label: 'Demographics', group: 'Data', what: 'Population, households, income, age and education at 1, 3 and 5 miles', file: 'data/demographics.csv' },
  { id: 'employment', label: 'Employment', group: 'Data', what: 'Residents in work and the unemployment rate by ring, and the major employers within five miles', file: 'data/employment.csv' },
  { id: 'chains', label: 'Chains nearby', group: 'Data', what: 'Every national chain within a mile, by sector', file: 'data/chains-within-1-mile.csv' },
]

export const MAP_PIECES = PIECE_SPECS.filter((p) => p.group === 'Maps').map((p) => p.id) as ('parcel-map' | 'location-map' | 'retail-map' | 'feasibility-map')[]

export interface Package {
  /** Its saved-view id when it is the team's own; absent for the built-in ones. */
  id?: string
  name: string
  pieces: PieceId[]
}

export const PACKAGES: Package[] = [
  { name: 'Site', pieces: ['parcel-map', 'location-map'] },
  { name: 'Feasibility', pieces: ['parcel-map', 'feasibility-map', 'feasibility'] },
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

export type Cell = string | number | null
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

const percent = (share: number) => Math.round(share * 1000) / 10

/**
 * The feasibility table: what the screen found, a line a finding, with how
 * it was made and what it is not. A service that did not answer is a line
 * saying so, never a blank read as none.
 */
export function feasibilityRows(screen: Feasibility & { outline?: string; sources?: { name: string }[] }): Cell[][] {
  const rows: Cell[][] = [
    ['Measure', 'Value'],
    ['Lot area (acres, from its outline)', screen.acres],
    ['Acres passing the screen', screen.buildable.acres],
    ['Share of the lot passing (%)', percent(screen.buildable.share)],
    [],
  ]
  if (screen.slope.available) {
    rows.push(
      ['Mean slope (%)', screen.slope.meanPercent],
      ['Steepest slope (%)', screen.slope.maxPercent],
      [`Share steeper than ${screen.slope.limitPercent}% (%)`, percent(screen.slope.shareOverLimit)],
      ['Lowest ground (ft)', screen.slope.elevationMinFeet],
      ['Highest ground (ft)', screen.slope.elevationMaxFeet],
    )
  } else rows.push(['Slope', `Not screened: ${screen.slope.reason}`])
  if (screen.flood.available) {
    rows.push(['Share in FEMA special flood hazard area (%)', screen.flood.mapped ? percent(screen.flood.shareInHazardArea) : 'Not mapped by FEMA here'])
    for (const zone of screen.flood.zones) rows.push([`Flood zone ${zone.zone}${zone.subtype ? ` (${zone.subtype.toLowerCase()})` : ''} (%)`, percent(zone.share)])
  } else rows.push(['Flood hazard', `Not screened: ${screen.flood.reason}`])
  if (screen.wetlands.available) {
    rows.push(['Share mapped wetland (%)', percent(screen.wetlands.share)])
    for (const type of screen.wetlands.types) rows.push([`${type.type}${type.code ? ` (${type.code})` : ''} (%)`, percent(type.share)])
  } else rows.push(['Wetlands', `Not screened: ${screen.wetlands.reason}`])
  if (screen.protectedLand.available) {
    rows.push(['Share protected or publicly held land (%)', percent(screen.protectedLand.share)])
    for (const unit of screen.protectedLand.units) {
      rows.push([`${unit.counted ? '' : 'Inside the boundary of '}${unit.name}${unit.manager ? `, ${unit.manager}` : ''}${unit.designation ? ` (${unit.designation})` : ''} (%)`, percent(unit.share)])
    }
  } else rows.push(['Protected land', `Not screened: ${screen.protectedLand.reason}`])
  rows.push(
    [],
    ['Method', `${screen.cells.count} cells about ${screen.cells.spacingFeet} ft apart over the lot${screen.outline === 'box' ? "'s bounding box" : ''}; each given its elevation and tested against the flood, wetland and protected-area outlines.`],
    ['Sources', (screen.sources ?? []).map((source) => source.name).join('; ') || 'USGS 3DEP; FEMA National Flood Hazard Layer; National Wetlands Inventory; PAD-US'],
    ['Note', 'A screen from public maps, not a survey, an elevation certificate or a wetland delineation. Zoning, access, utilities and soils are not part of it.'],
  )
  return rows
}

/** The crime table: reported violent and property offenses by radius, where they stand, and what was reported. */
export function crimeRows(answer: CrimeAnswer): Cell[][] {
  if (!answer.covered) {
    return [[answer.elsewhere
      ? `This site is in ${answer.elsewhere}, which has its own police; their reported crime is not published here. This is not a count of zero.`
      : 'This site is outside the area of the police agency whose reported crime is published here. This is not a count of zero.']]
  }
  const head = (first: string): Cell[] => [first, ...answer.rings.map((ring) => `${ring.miles} mile`)]
  const rows: Cell[][] = [
    head(`Reported, ${answer.from} to ${answer.to}`),
    ['Violent crime', ...answer.rings.map((ring) => ring.violent)],
    ['Property crime', ...answer.rings.map((ring) => ring.property)],
    ['Other reported offenses', ...answer.rings.map((ring) => ring.other)],
  ]
  if (answer.compared) {
    rows.push(
      ["Share of the market's parcels with fewer violent offenses (%)", ...answer.rings.map((ring) => ring.violentAbove)],
      ["Share of the market's parcels with fewer property offenses (%)", ...answer.rings.map((ring) => ring.propertyAbove)],
    )
  }
  if (answer.rings.some((ring) => ring.covered < 0.98)) rows.push(['Share of each circle the figures cover (%)', ...answer.rings.map((ring) => Math.round(ring.covered * 100))])
  rows.push([], head('What was reported'))
  for (const category of answer.categories.slice(0, 20)) rows.push([`${category.category} (${category.kind})`, ...category.counts])
  rows.push([], ['Agency', answer.agency])
  if (answer.definitions.violent) rows.push(['Violent crime means', answer.definitions.violent])
  if (answer.definitions.property) rows.push(['Property crime means', answer.definitions.property])
  for (const note of answer.notes) rows.push(['Note', note])
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

/** The same rows with tabs between cells: what a spreadsheet takes from the clipboard. */
export function tsv(rows: Cell[][]): string {
  return rows.map((row) => row.map((v) => (v == null ? '' : String(v).replace(/[\t\n\r]+/g, ' '))).join('\t')).join('\n')
}

/**
 * The rows as an HTML table, for the clipboard: pasted into Word, Google Docs,
 * PowerPoint or an email it lands as a real table, which then takes the
 * styles of whatever document it is pasted into. The first row is the
 * heading; a short row's last cell runs to the table's edge. No styling and
 * no name on it: it is going under somebody else's letterhead.
 */
export function htmlTable(rows: Cell[][]): string {
  const width = Math.max(1, ...rows.map((row) => row.length))
  const clean = (v: Cell) => (v == null ? '' : String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'))
  const line = (row: Cell[], tag: 'th' | 'td') =>
    `<tr>${row.map((v, i) => `<${tag}${i === row.length - 1 && row.length < width ? ` colspan="${width - row.length + 1}"` : ''}>${clean(v)}</${tag}>`).join('')}</tr>`
  return `<table>${rows.map((row, i) => line(row, i === 0 ? 'th' : 'td')).join('')}</table>`
}
