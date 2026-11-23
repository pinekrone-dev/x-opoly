/**
 * The counties the map shades between the country view and the parcels.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'

import { countyFeatures, statesOf } from '../src/lib/dataCounties.ts'

const state = (code) => JSON.parse(fs.readFileSync(`public/geo/counties/${code}.json`, 'utf8'))

test('a file of counties for every state, each county with its code', () => {
  const files = fs.readdirSync('public/geo/counties')
  assert.equal(files.length, 51)
  const texas = state('48')
  assert.equal(texas.features.length, 254)
  assert.ok(fs.statSync('public/geo/counties/48.json').size < 150_000, 'small enough to fetch as the map reaches a state')
  assert.deepEqual(texas.features.find((f) => f.properties.fips === '48453').properties, { fips: '48453', name: 'Travis' })
  for (const f of texas.features) assert.match(f.properties.fips, /^48\d{3}$/)
})

test('a market says which states it needs, from its codes or from its name', () => {
  assert.deepEqual(statesOf({ slug: 'austin-tx', name: 'Austin', counties: ['48453'], center: [-97.74, 30.27] }), ['48'])
  assert.deepEqual(statesOf({ slug: 'washington-dc', name: 'Washington', counties: [], center: [-77, 38.9] }), ['11'])
  assert.deepEqual(statesOf({ slug: 'kansas-city', name: 'Two states', counties: ['29095', '20209'], center: [-94.6, 39.1] }), ['29', '20'])
  assert.deepEqual(statesOf({ slug: 'nowhere', name: 'No state', counties: ['x'], center: [0, 0] }), [])
})

test('each market gets the counties it names, tagged with the market to open', () => {
  const markets = [
    { slug: 'austin-tx', name: 'Austin', counties: ['48453'], center: [-97.74, 30.27] },
    { slug: 'round-rock-tx', name: 'Round Rock', counties: ['48491'], center: [-97.68, 30.51] },
    // Two markets naming one county: the first has it.
    { slug: 'late-tx', name: 'Late', counties: ['48453'], center: [-97.7, 30.3] },
    { slug: 'las-vegas-nv', name: 'Las Vegas', counties: ['32003'], center: [-115.14, 36.17] },
  ]
  const drawn = countyFeatures(markets, { 48: state('48') })
  assert.deepEqual(drawn.features.map((f) => [f.properties.fips, f.properties.slug]), [['48453', 'austin-tx'], ['48491', 'round-rock-tx']])
  assert.equal(drawn.features[0].properties.county, 'Travis')
  assert.equal(drawn.features[0].properties.market, 'Austin')
  assert.equal(drawn.features[0].geometry.type, 'Polygon')
  // Nevada arrives later, and its county with it.
  const more = countyFeatures(markets, { 48: state('48'), 32: state('32') })
  assert.ok(more.features.some((f) => f.properties.slug === 'las-vegas-nv' && f.properties.county === 'Clark'))
})

test('a market whose codes are not in the shapes is given the county its centre stands in', () => {
  // Connecticut: filed under planning region 09110, drawn here as old Hartford County.
  const hartford = { slug: 'hartford-ct', name: 'Hartford', counties: ['09110'], center: [-72.68, 41.76] }
  const drawn = countyFeatures([hartford], { '09': state('09') })
  assert.deepEqual(drawn.features.map((f) => [f.properties.county, f.properties.slug]), [['Hartford', 'hartford-ct']])
  // A market with no codes at all, placed by its centre; one whose centre is in no county here is left out.
  const loose = { slug: 'austin-tx', name: 'Austin', counties: [], center: [-97.74, 30.27] }
  assert.equal(countyFeatures([loose], { 48: state('48') }).features[0].properties.fips, '48453')
  assert.deepEqual(countyFeatures([{ ...loose, center: [-150, 10] }], { 48: state('48') }).features, [])
})
