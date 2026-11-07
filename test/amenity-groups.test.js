/**
 * The amenity map's markers: stores that share a spot are one marker, the
 * numbers run outward from the site, and no marker covers another.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { amenityGroups, numberAmenities, placeMarkers, tenantMix } from '../src/lib/amenityGroups.ts'

const at = (name, lat, lng, miles, extra = {}) => ({ id: name, name, brand: name, category: null, address: null, website: null, lat, lng, miles, ring: 1, ...extra })

test('a centre’s tenants share one marker, numbered together, nearest centre first', () => {
  const list = numberAmenities([
    at('Far Shop', 33.43, -111.92, 0.9),
    at('Starbucks', 33.4200, -111.9400, 0.3, { sector: 'Coffee' }),
    at('Chipotle', 33.4201, -111.9401, 0.31, { sector: 'Quick service' }), // same corner
    at('Target', 33.4250, -111.9300, 0.5, { sector: 'Department & big box' }),
    at('Starbucks', 33.44, -111.95, 0.95), // a farther store of a brand already kept
    at('Beyond', 33.5, -111.9, 3), // outside a mile
  ])
  assert.deepEqual(list.map((a) => [a.n, a.name, a.group]), [
    [1, 'Starbucks', 0],
    [2, 'Chipotle', 0],
    [3, 'Target', 1],
    [4, 'Far Shop', 2],
  ])
  const groups = amenityGroups(list)
  assert.deepEqual(groups.map((g) => [g.first, g.last, g.members.length]), [[1, 2, 2], [3, 3, 1], [4, 4, 1]])
  assert.equal(tenantMix(list), 'Coffee 1 · Quick service 1 · Department & big box 1 · Other 1')
})

test('markers are placed where they stand when free, and never over another', () => {
  const wants = [
    { x: 100, y: 100, w: 15, h: 15 },
    { x: 101, y: 101, w: 15, h: 15 }, // on top of the first
    { x: 102, y: 99, w: 30, h: 15 }, // a range pill, same spot
    { x: 300, y: 300, w: 15, h: 15 }, // alone
  ]
  const spots = placeMarkers(wants, { width: 400, height: 500 }, [{ x: 50, y: 50, w: 20, h: 30 }])
  assert.deepEqual(spots[0], { x: 100, y: 100 })
  assert.deepEqual(spots[3], { x: 300, y: 300 })
  for (let i = 0; i < spots.length; i += 1) {
    for (let j = i + 1; j < spots.length; j += 1) {
      const apartX = Math.abs(spots[i].x - spots[j].x) * 2 >= wants[i].w + wants[j].w
      const apartY = Math.abs(spots[i].y - spots[j].y) * 2 >= wants[i].h + wants[j].h
      assert.ok(apartX || apartY, `markers ${i} and ${j} overlap`)
    }
  }
})

test('a marker at the edge stays inside the map', () => {
  const [spot] = placeMarkers([{ x: -5, y: 505, w: 15, h: 15 }], { width: 400, height: 500 })
  assert.ok(spot.x >= 7.5 && spot.y <= 492.5)
})
