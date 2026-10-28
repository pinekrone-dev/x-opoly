/**
 * The listing against the county's unit and bedroom counts: the county side
 * found by the market's panel labels, never by key, because the keys do not
 * mean the same thing in every market.
 */
import assert from 'node:assert/strict'
import test, { describe } from 'node:test'

import { countyCounts, countyCountsPublished, describeMismatch, listingCounts, mismatches, readCount } from '../src/lib/listingCheck.ts'

const panel = (...rows) => [{ group: 'Building', rows: rows.map(([k, l]) => ({ k, l })) }]

describe('the county side', () => {
  test('Chicago: apartments and bedrooms', () => {
    const counts = countyCounts(panel(['un', 'Apartments'], ['bd', 'Bedrooms'], ['ba', 'Baths']), { un: 2, bd: 5 })
    assert.deepEqual(counts, { units: 2, unitsLabel: 'Apartments', bedrooms: 5 })
  })

  test("Detroit's un is buildings and Jersey City's bd a description: neither is read", () => {
    assert.deepEqual(countyCounts(panel(['un', 'Buildings']), { un: 3 }), { units: null, unitsLabel: null, bedrooms: null })
    const jersey = countyCounts(panel(['bd', 'Building'], ['du', 'Dwelling units']), { bd: '2 STY FR', du: 4 })
    assert.equal(jersey.units, 4, 'dwelling units is the count')
    assert.equal(jersey.bedrooms, null)
  })

  test('New York: residential units before total units', () => {
    assert.equal(countyCounts(panel(['ut', 'Total units'], ['un', 'Residential units']), { un: 6, ut: 7 }).units, 6)
  })

  test('zero is not a count', () => {
    assert.equal(countyCounts(panel(['un', 'Units']), { un: 0 }).units, null)
    assert.equal(countyCountsPublished(panel(['un', 'Units'])), true)
    assert.equal(countyCountsPublished(panel(['un', 'Buildings'])), false)
  })
})

describe('the listing side', () => {
  test('counts read from what people write', () => {
    assert.equal(readCount('6 units'), 6)
    assert.equal(readCount('2BR'), 2)
    assert.equal(readCount('1,200'), 1200)
    assert.equal(readCount('n/a'), null)
  })

  test('fields found by label', () => {
    assert.deepEqual(listingCounts([{ label: '# of Units', value: '8' }, { label: 'Beds', value: '12' }]), { units: 8, bedrooms: 12 })
    assert.deepEqual(listingCounts([{ label: 'Unit mix', value: '4x 2BR' }]), { units: null, bedrooms: null })
  })
})

describe('the comparison', () => {
  test('only counts both sides carry are compared', () => {
    assert.deepEqual(mismatches({ units: 6, bedrooms: null }, { units: 4, bedrooms: 8 }), [{ field: 'units', listing: 6, county: 4 }])
    assert.deepEqual(mismatches({ units: 4, bedrooms: 8 }, { units: 4, bedrooms: 8 }), [])
    assert.equal(describeMismatch({ field: 'bedrooms', listing: 1, county: 3 }), 'Listing says 1 bedroom; county records 3.')
  })
})
