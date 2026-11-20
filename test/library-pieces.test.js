/**
 * The Library's pieces and packages: what a package picks, and what the
 * data pieces say.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { PACKAGES, PIECE_SPECS, chainsRows, cleanPieces, crimeRows, csv, demographicsRows, employmentRows, feasibilityRows, htmlTable, packages, tsv } from '../src/lib/libraryPieces.ts'

const DATA = {
  source: 'US Census Bureau, ACS 5-year',
  areas: [],
  radii: [
    { miles: 1, blockGroups: 4, metrics: { population: 1200, medianAge: 34.1, laborForce: 800, employed: 760, unemployed: 40, unemploymentRate: 5 } },
    { miles: 3, blockGroups: 30, metrics: { population: 9000, medianAge: 36, laborForce: 6000, employed: 5700, unemployed: 300, unemploymentRate: 5 } },
  ],
}

test('every built-in package picks pieces the library makes', () => {
  const known = new Set(PIECE_SPECS.map((p) => p.id))
  for (const pack of PACKAGES) for (const id of pack.pieces) assert.ok(known.has(id), `${pack.name}: ${id}`)
  assert.deepEqual(cleanPieces(['chains', 'nonsense', 'parcel-map', 'chains']), ['parcel-map', 'chains'])
  assert.deepEqual(cleanPieces(null), [])
})

test('a team\'s own package takes a built-in one\'s place by name, and extras follow', () => {
  const all = packages([{ id: 'v1', name: 'retail', pieces: ['retail-map'] }, { id: 'v2', name: 'Investor', pieces: ['employment'] }])
  assert.equal(all.length, PACKAGES.length + 1)
  assert.equal(all.find((p) => p.name.toLowerCase() === 'retail').id, 'v1')
  assert.equal(all.at(-1).name, 'Investor')
})

test('demographics leave employment to its own piece', () => {
  const rows = demographicsRows(DATA)
  assert.deepEqual(rows[0], ['Measure', '1 mile', '3 miles'])
  assert.deepEqual(rows[1], ['Population', 1200, 9000])
  assert.ok(!rows.some((row) => /labor|employ/i.test(String(row[0]))))
  assert.deepEqual(rows.at(-1), ['Source', 'US Census Bureau, ACS 5-year'])
})

test('employment says who works by ring, and names the largest employers first', () => {
  const rows = employmentRows(DATA, [
    { kind: 'headquarters', name: 'Small Co', miles: 1.234, employees: 2000, industries: ['retail'], located: 'city: Austin' },
    { kind: 'colleges', name: 'A college', miles: 0.5 },
    { kind: 'headquarters', name: 'Big Co', miles: 3, employees: 90000 },
  ])
  assert.deepEqual(rows.find((row) => row[0] === 'Unemployment rate (%)'), ['Unemployment rate (%)', 5, 5])
  const big = rows.findIndex((row) => row[0] === 'Big Co')
  const small = rows.findIndex((row) => row[0] === 'Small Co')
  assert.ok(big > 0 && big < small)
  assert.deepEqual(rows[small], ['Small Co', 2000, 'retail', 1.23, 'city only; distance is to the city centre'])
  assert.equal(rows[big][4], 'headquarters address')
  assert.ok(!rows.some((row) => row[0] === 'A college'))
  assert.ok(employmentRows(null, []).some((row) => row[0] === 'None listed within 5 miles'))
})

test('a table becomes CSV with its commas and quotes kept', () => {
  assert.equal(csv([['Name', 'Miles'], ['Bob\'s "Best", LLC', 1.5], [null, 2]]), 'Name,Miles\n"Bob\'s ""Best"", LLC",1.5\n,2')
  assert.deepEqual(chainsRows([{ name: 'Target', brand: 'Target', sector: 'Big box', address: '1 Main', miles: 0.456 }])[1], ['Target', 'Target', 'Big box', '1 Main', 0.46])
})

test('the feasibility table: a line a finding, with how it was made and what it is not', () => {
  const screen = {
    acres: 9.88, cells: { count: 225, spacingFeet: 44 }, outline: 'parcel',
    slope: { available: true, meanPercent: 10, medianPercent: 10, maxPercent: 22.5, shareOverLimit: 0.133, limitPercent: 15, elevationMinFeet: 1643, elevationMaxFeet: 1704, reliefFeet: 61, resolutionMeters: 1 },
    flood: { available: true, mapped: true, shareInHazardArea: 0.467, zones: [{ zone: 'X', subtype: 'AREA OF MINIMAL FLOOD HAZARD', hazardArea: false, share: 0.533 }, { zone: 'AE', subtype: null, hazardArea: true, share: 0.467 }] },
    wetlands: { available: false, reason: 'The wetlands inventory did not answer in time.' },
    protectedLand: { available: true, share: 0.133, units: [{ name: 'Test Regional Park', manager: 'City Land', designation: 'Local Park', category: 'Fee', gapStatus: '4', access: 'OA', share: 0.133, counted: true }, { name: 'Test National Forest', manager: null, designation: null, category: 'Proclamation', gapStatus: '4', access: null, share: 1, counted: false }] },
    buildable: { share: 0.422, acres: 4.17, limitPercent: 15, screened: ['slope', 'flood', 'protected land'], notScreened: ['wetlands'], takenOut: { slope: 0.133, flood: 0.467, wetlands: 0, protectedLand: 0.133 } },
    map: { box: [0, 0, 1, 1], nx: 1, ny: 1, results: [0] },
    sources: [{ name: 'USGS 3D Elevation Program (3DEP)' }, { name: 'FEMA National Flood Hazard Layer' }],
  }
  const rows = feasibilityRows(screen)
  const line = (label) => rows.find((row) => row[0] === label)
  assert.deepEqual(rows[0], ['Measure', 'Value'])
  assert.deepEqual(line('Acres passing the screen'), ['Acres passing the screen', 4.17])
  assert.deepEqual(line('Share of the lot passing (%)'), ['Share of the lot passing (%)', 42.2])
  assert.deepEqual(line('Share steeper than 15% (%)'), ['Share steeper than 15% (%)', 13.3])
  assert.deepEqual(line('Flood zone X (area of minimal flood hazard) (%)'), ['Flood zone X (area of minimal flood hazard) (%)', 53.3])
  assert.deepEqual(line('Flood zone AE (%)'), ['Flood zone AE (%)', 46.7])
  assert.deepEqual(line('Wetlands'), ['Wetlands', 'Not screened: The wetlands inventory did not answer in time.'])
  assert.deepEqual(line('Test Regional Park, City Land (Local Park) (%)'), ['Test Regional Park, City Land (Local Park) (%)', 13.3])
  assert.ok(line('Inside the boundary of Test National Forest (%)'))
  assert.match(line('Method')[1], /225 cells about 44 ft apart over the lot;/)
  assert.match(line('Sources')[1], /USGS 3D Elevation Program \(3DEP\); FEMA National Flood Hazard Layer/)
  assert.match(line('Note')[1], /not a survey/)
  // On a lot FEMA has not mapped, the line says so and gives no figure.
  const unmapped = feasibilityRows({ ...screen, flood: { available: true, mapped: false, shareInHazardArea: 0, zones: [] }, outline: 'box' })
  assert.deepEqual(unmapped.find((row) => row[0] === 'Share in FEMA special flood hazard area (%)'), ['Share in FEMA special flood hazard area (%)', 'Not mapped by FEMA here'])
  assert.match(unmapped.find((row) => row[0] === 'Method')[1], /over the lot's bounding box;/)
})

test('the crime table: by radius, where it stands, what was reported, and what the words mean', () => {
  const answer = {
    covered: true, agency: 'Test Metropolitan Police', elsewhere: null, from: '2025-11-02', to: '2026-11-01',
    rings: [
      { miles: 0.25, violent: 1, property: 1, other: 0, covered: 1, violentAbove: 99, propertyAbove: 99 },
      { miles: 0.5, violent: 2, property: 2, other: 0, covered: 1, violentAbove: 99, propertyAbove: 99 },
      { miles: 1, violent: 2, property: 2, other: 1, covered: 0.9, violentAbove: 99, propertyAbove: 99 },
    ],
    categories: [{ category: 'ROBBERY', kind: 'violent', counts: [0, 1, 1] }],
    definitions: { violent: 'What the agency flags violent.', property: 'What the agency files against property.' },
    notes: ['Each row is one offense.'], source: { name: 'Test Metropolitan Police', page: null }, compared: { parcels: 400 },
  }
  const rows = crimeRows(answer)
  assert.deepEqual(rows[0], ['Reported, 2025-11-02 to 2026-11-01', '0.25 mile', '0.5 mile', '1 mile'])
  assert.deepEqual(rows[1], ['Violent crime', 1, 2, 2])
  assert.deepEqual(rows[2], ['Property crime', 1, 2, 2])
  assert.deepEqual(rows.find((row) => row[0] === 'Share of each circle the figures cover (%)'), ['Share of each circle the figures cover (%)', 100, 100, 90])
  assert.deepEqual(rows.find((row) => row[0] === 'ROBBERY (violent)'), ['ROBBERY (violent)', 0, 1, 1])
  assert.deepEqual(rows.find((row) => row[0] === 'Violent crime means'), ['Violent crime means', 'What the agency flags violent.'])
  assert.match(csv(rows), /^"Reported, 2025-11-02 to 2026-11-01",0\.25 mile,0\.5 mile,1 mile\n/)
  // A site another agency polices is one line saying so, never a row of zeros.
  const away = crimeRows({ ...answer, covered: false, agency: null, elsewhere: 'Henderson', rings: [] })
  assert.equal(away.length, 1)
  assert.match(away[0][0], /in Henderson, which has its own police.*not a count of zero/)
})

test('a table for the clipboard: a real table for a document, tabs for a spreadsheet, and no name on either', () => {
  const rows = [['Measure', '1 mile', '3 miles'], ['Population', 1200, 9800], ['R&D <labs>', null, 'a\tb'], ['Source', 'Census "ACS"']]
  assert.equal(
    htmlTable(rows),
    '<table><tr><th>Measure</th><th>1 mile</th><th>3 miles</th></tr><tr><td>Population</td><td>1200</td><td>9800</td></tr>'
      + '<tr><td>R&amp;D &lt;labs&gt;</td><td></td><td>a\tb</td></tr><tr><td>Source</td><td colspan="2">Census &quot;ACS&quot;</td></tr></table>',
  )
  assert.equal(tsv(rows), 'Measure\t1 mile\t3 miles\nPopulation\t1200\t9800\nR&D <labs>\t\ta b\nSource\tCensus "ACS"')
  assert.doesNotMatch(htmlTable(rows), /style=|class=|Land Quotient/i)
})

