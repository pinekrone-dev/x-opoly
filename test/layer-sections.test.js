/**
 * The map panel's sections, and the starting points that switch a handful
 * of layers on at once.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { SECTIONS, STARTING_POINTS, bySection, cardKey, cardsToSwitch, layerName, sectionOf, startingPoints } from '../src/lib/layerSections.ts'

test('every layer a market publishes today has a section that is not More', () => {
  const published = ['opportunity-zones', 'transmission', 'substations', 'power-plants', 'schools', 'private-schools', 'flood-zones',
    'school-districts', 'ust', 'lust', 'opportunity-zones-2027', 'zoning', 'permits', 'traffic', 'plan-review', 'landmarks', 'land-use',
    'redevelopment', 'overlays', 'txdot', 'tirz', 'lara', 'permits-sf', 'permits-mf', 'super-neighborhoods', 'street-counts', 'uez',
    'rail-stations', 'demolitions', 'nez', 'city-land', 'traffic-scottsdale', 'parks-rec', 'occupancy', 'permits-bis', 'built-form', 'plans',
    'code-cases', 'business-licenses']
  for (const id of published) assert.notEqual(sectionOf(`x:${id}`), 'more', id)
  assert.equal(sectionOf('g:traffic'), 'market')
  assert.equal(sectionOf('x:flood-zones'), 'risk')
  assert.equal(sectionOf('parcels'), 'property')
  assert.equal(sectionOf('lists'), 'workspace')
  assert.equal(sectionOf('x:buildings'), 'property')
  assert.equal(sectionOf('x:comps'), 'market')
})

test('a layer nobody has heard of lands under More, and the catalogue can say otherwise', () => {
  assert.equal(sectionOf('x:something-new'), 'more')
  assert.equal(sectionOf('x:something-new', 'risk'), 'risk')
  assert.equal(sectionOf('x:something-new', 'not-a-section'), 'more')
  assert.equal(cardKey('x:zoning'), 'zoning')
  assert.equal(cardKey('Market surveys'), 'Market surveys')
})

test('cards gather under their sections in section order, empty sections left out', () => {
  const cards = [{ id: 'x:lust' }, { id: 'parcels' }, { id: 'x:permits' }, { id: 'x:flood-zones' }]
  const grouped = bySection(cards)
  assert.deepEqual(grouped.map((g) => [g.section.id, g.cards.map((c) => c.id)]), [
    ['property', ['parcels']],
    ['development', ['x:permits']],
    ['risk', ['x:lust', 'x:flood-zones']],
  ])
  assert.equal(new Set(SECTIONS.map((s) => s.id)).size, SECTIONS.length)
})

test('a starting point switches on what it names and off what it does not, leaving My map alone', () => {
  const cards = [
    { id: 'x:flood-zones', state: 'off' },
    { id: 'x:ust', state: 'on' },
    { id: 'x:permits', state: 'on' },
    { id: 'lists', state: 'on' },
    { id: 'Market surveys', state: 'soon' },
    { id: 'x:lust', state: 'off' },
  ]
  const risk = STARTING_POINTS.find((p) => p.name === 'Risk check')
  assert.deepEqual(cardsToSwitch(cards, risk.layers).sort(), ['x:flood-zones', 'x:lust', 'x:permits'])
})

test('a team\'s own starting point takes a built-in one\'s place by name, and extras follow', () => {
  const own = [{ id: 'v1', name: 'risk check', layers: ['flood-zones'] }, { id: 'v2', name: 'Retail pads', layers: ['traffic'] }]
  const all = startingPoints(own)
  assert.equal(all.length, STARTING_POINTS.length + 1)
  assert.equal(all.find((p) => p.name.toLowerCase() === 'risk check').id, 'v1')
  assert.equal(all[all.length - 1].name, 'Retail pads')
})

test('a development layer is named for what it is, never for the city that publishes it', () => {
  assert.equal(layerName('permits', 'Anaheim permits'), 'Building permits')
  assert.equal(layerName('permits', 'Development pipeline'), 'Building permits')
  assert.equal(layerName('plan-review', 'Entitlements'), 'Submitted and approved plans')
  assert.equal(layerName('entitlements', 'Anaheim entitlements'), 'Submitted and approved plans')
  assert.equal(layerName('code-cases', 'Anaheim code cases'), 'Code cases')
  assert.equal(layerName('business-licenses', 'Anaheim businesses'), 'Business licenses')
  // Everything else keeps the catalogue's own name.
  assert.equal(layerName('zoning', 'Zoning'), 'Zoning')
  assert.equal(layerName('permits-bis', 'Permits, legacy jobs'), 'Permits, legacy jobs')
  // And all three sit under Development activity, with the cards that stand in for them where a market has none.
  for (const id of ['permits', 'plan-review', 'entitlements', 'code-cases', 'Building permits', 'Submitted and approved plans', 'Code cases']) {
    assert.equal(sectionOf(id), 'development', id)
  }
  assert.match(SECTIONS.find((s) => s.id === 'development').hint, /Building permits, submitted and approved plans, code cases/)
  assert.deepEqual(SECTIONS.slice(0, 2).map((s) => s.label), ['My map', 'Property & ownership'])
})

