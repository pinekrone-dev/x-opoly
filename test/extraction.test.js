/**
 * Reading a flyer into an existing site profile.
 *
 * The model call is not exercised here — what matters is the rule applied to
 * whatever it returns: a value the broker already has is not overwritten
 * unless they ask for it. Getting that wrong silently destroys corrections.
 */

import assert from 'node:assert/strict'
import test, { describe } from 'node:test'

import { mergeExtraction, toCustomFields } from '../app/lib/flyer.js'

/** A plausible extraction result, as the model returns it. */
function extracted(overrides = {}) {
  return {
    name: 'Belterra Village Building S',
    address: '165 Hargraves Dr',
    city: 'Austin',
    state: 'TX',
    zip: '78737',
    sizeSqft: 9822,
    acreage: null,
    rentRate: 32,
    rentUnit: 'psf/yr',
    nnn: 12,
    parkingSpaces: null,
    zoning: 'Dripping Springs-ETJ',
    yearBuilt: 2019,
    availability: 'Immediate',
    listingBroker: 'Tristen Palori',
    notes: 'Medical office / retail.',
    confidence: 'high',
    uncertainFields: [],
    ...overrides,
  }
}

describe('flyer numbers as card rows', () => {
  test('reads the way a broker writes them', () => {
    const rows = toCustomFields(extracted())
    const byLabel = Object.fromEntries(rows.map((row) => [row.label, row.value]))

    assert.equal(byLabel['Available SF'], '9,822 SF')
    assert.equal(byLabel['Lease Rate'], '32/SF')
    assert.equal(byLabel.NNN, '12/SF')
    assert.equal(byLabel['Year Built'], '2019')
    assert.equal(byLabel.Zoning, 'Dripping Springs-ETJ')
  })

  test('a field the flyer never stated is left out, not written as zero', () => {
    // A zero would be a claim the document did not make.
    const rows = toCustomFields(extracted({ nnn: null, yearBuilt: null }))
    const labels = rows.map((row) => row.label)
    assert.ok(!labels.includes('NNN'))
    assert.ok(!labels.includes('Year Built'))
  })

  test('an unusual rate unit is kept as written', () => {
    const rows = toCustomFields(extracted({ rentRate: 4200, rentUnit: 'monthly' }))
    const rate = rows.find((row) => row.label === 'Lease Rate')
    assert.equal(rate.value, '4200/monthly')
  })
})

describe('merging into a site that already has values', () => {
  test('fills the blanks on a fresh pin', () => {
    const property = { name: 'New site', address: null, zoning: null, fields: [] }
    const { patch, filled, skipped } = mergeExtraction(property, extracted())

    assert.equal(patch.address, '165 Hargraves Dr')
    assert.equal(patch.zoning, 'Dripping Springs-ETJ')
    assert.ok(filled.includes('address'))
    assert.deepEqual(skipped, ['name'], 'the placeholder name is still a value')
  })

  test('does not overwrite a value the broker already corrected', () => {
    const property = {
      name: 'Belterra — corrected by hand',
      zoning: 'PUD',
      address: null,
      fields: [],
    }
    const { patch, filled, skipped } = mergeExtraction(property, extracted())

    assert.equal(patch.name, undefined)
    assert.equal(patch.zoning, undefined)
    assert.ok(skipped.includes('name'))
    assert.ok(skipped.includes('zoning'))
    assert.ok(filled.includes('address'), 'the empty field is still filled')
  })

  test('overwrites only when asked', () => {
    const property = { name: 'Old name', zoning: 'PUD', fields: [] }
    const { patch, filled, skipped } = mergeExtraction(property, extracted(), { overwrite: true })

    assert.equal(patch.name, 'Belterra Village Building S')
    assert.equal(patch.zoning, 'Dripping Springs-ETJ')
    assert.deepEqual(skipped, [])
    assert.ok(filled.includes('name'))
  })

  test('a row the broker added themselves survives a re-read', () => {
    const property = {
      fields: [
        { label: 'Suite Options', value: 'Suite 100: 3,500-7,045 SF' },
        { label: 'Zoning', value: 'PUD' },
      ],
    }
    const { fields } = mergeExtraction(property, extracted())
    const byLabel = Object.fromEntries(fields.map((field) => [field.label, field.value]))

    assert.equal(byLabel['Suite Options'], 'Suite 100: 3,500-7,045 SF', 'their own row is untouched')
    assert.equal(byLabel.Zoning, 'PUD', 'and so is their value')
    assert.equal(byLabel['Available SF'], '9,822 SF', 'while new rows are added')
  })

  test('a row left blank is filled rather than left blank', () => {
    const property = { fields: [{ label: 'NNN', value: null }] }
    const { fields } = mergeExtraction(property, extracted())
    const nnn = fields.find((field) => field.label === 'NNN')
    assert.equal(nnn.value, '12/SF')
  })

  test('labels match case-insensitively, so a row is not duplicated', () => {
    const property = { fields: [{ label: 'available sf', value: '9,000 SF' }] }
    const { fields } = mergeExtraction(property, extracted())

    const matching = fields.filter((field) => field.label.toLowerCase() === 'available sf')
    assert.equal(matching.length, 1, 'one row, not two spellings of the same thing')
    assert.equal(matching[0].value, '9,000 SF', 'and the broker’s value wins')
  })

  test('a null field in the extraction never clears an existing value', () => {
    const property = { zoning: 'PUD', yearBuilt: 1998, fields: [] }
    const { patch } = mergeExtraction(property, extracted({ zoning: null, yearBuilt: null }), {
      overwrite: true,
    })

    // Even overwriting, "the flyer did not say" is not "the answer is nothing".
    assert.equal('zoning' in patch, false)
    assert.equal('yearBuilt' in patch, false)
  })

  test('a property with no fields array is handled', () => {
    const { fields } = mergeExtraction({}, extracted())
    assert.ok(fields.length > 0)
  })
})
