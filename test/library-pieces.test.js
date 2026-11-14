/**
 * The Library's pieces and packages: what a package picks, and what the
 * data pieces say.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { PACKAGES, PIECE_SPECS, chainsRows, cleanPieces, csv, demographicsRows, employmentRows, packages } from '../src/lib/libraryPieces.ts'

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
