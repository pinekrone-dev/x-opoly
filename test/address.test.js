/**
 * The whole address on an export: street, city, state, ZIP, from what each
 * county publishes, and never the owner's ZIP passed off as the property's.
 */
import assert from 'node:assert/strict'
import test, { describe } from 'node:test'

import { fullAddress, postalCity, zip5 } from '../src/lib/address.ts'

const table = { '07008': 'Carteret|NJ', '78660': 'Pflugerville|TX', '85743': 'Tucson|AZ', '10001': 'New York|NY' }

describe('a full address', () => {
  test("North Jersey: the town from the record, and no ZIP rather than the owner's", () => {
    const row = { ad: '8 Germak Dr.', ct: 'Carteret Boro', zp: '11735' }
    assert.deepEqual(fullAddress(row, 'jersey-city-nj', table), {
      street: '8 Germak Dr.',
      city: 'Carteret',
      state: 'NJ',
      zip: '',
      full: '8 Germak Dr., Carteret, NJ',
    })
  })

  test('a market with no town field takes the ZIP\'s place', () => {
    const row = { ad: '100 Main St', zp: '78660' }
    assert.equal(fullAddress(row, 'austin-tx', table).full, '100 Main St, Pflugerville, TX 78660')
  })

  test('the ZIP\'s town wins over a jurisdiction or a borough', () => {
    assert.equal(fullAddress({ ad: '1 A St', ct: 'Unincorporated', zp: '85743' }, 'tucson-az', table).city, 'Tucson')
    assert.equal(fullAddress({ ad: '1 A St', ct: 'Manhattan', zp: '10001' }, 'new-york-ny', table).city, 'New York')
    assert.equal(fullAddress({ ad: '1 A St', ct: 'Pima County' }, 'tucson-az', table).city, '', 'never a county as a town')
  })

  test('leading zeros come back, and placeholder ZIPs go', () => {
    assert.equal(zip5('7008'), '07008')
    assert.equal(zip5('07008-1234'), '07008')
    assert.equal(zip5('0'), '')
    assert.equal(zip5('00000'), '')
    assert.equal(zip5(''), '')
  })

  test('municipal suffixes come off', () => {
    assert.equal(postalCity('Woodbridge Twp'), 'Woodbridge')
    assert.equal(postalCity('Jersey City'), 'Jersey City')
    assert.equal(postalCity('Carteret Borough'), 'Carteret')
  })

  test('with no street there is no address to write', () => {
    assert.equal(fullAddress({ zp: '78660' }, 'austin-tx', table).full, '')
  })
})
