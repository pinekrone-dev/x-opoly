/**
 * Layer families: every traffic source a market publishes is one card.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { groupLayers, layerGroup, trafficLabel } from '../src/lib/layerGroups.ts'

test('traffic layers group, others stand alone, in panel order', () => {
  const layers = [{ id: 'zoning' }, { id: 'traffic' }, { id: 'permits' }, { id: 'traffic-scottsdale' }]
  assert.deepEqual(groupLayers(layers).map((g) => [g.key, g.members.map((m) => m.id)]), [
    ['zoning', ['zoning']],
    ['traffic', ['traffic', 'traffic-scottsdale']],
    ['permits', ['permits']],
  ])
  assert.equal(layerGroup('txdot'), 'txdot')
})

test('traffic layers read as Traffic', () => {
  assert.equal(trafficLabel({ id: 'traffic', label: 'Traffic counts' }), 'Traffic')
  assert.equal(trafficLabel({ id: 'traffic-scottsdale', label: 'Scottsdale traffic counts' }), 'Traffic (Scottsdale)')
})
