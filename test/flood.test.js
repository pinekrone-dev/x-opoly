import assert from 'node:assert/strict'
import test, { describe } from 'node:test'

import { floodAt, insideRings, samplePoints, tileCoords, zoneMeaning } from '../src/lib/flood.ts'

/*
 * The flood row on the parcel card. Every case here is a way the card could
 * tell a broker the wrong thing about a lot: dry when it floods, flooded when
 * it is dry, or dry because the network failed.
 */

const square = (x0, y0, x1, y1) => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
  { x: x0, y: y0 },
]

describe('the geometry', () => {
  test('a point inside a ring is in, outside is out, and a hole is out', () => {
    const outer = square(0, 0, 100, 100)
    const hole = square(40, 40, 60, 60)
    assert.equal(insideRings(10, 10, [outer]), true)
    assert.equal(insideRings(150, 10, [outer]), false)
    assert.equal(insideRings(50, 50, [outer, hole]), false, 'an island inside the floodplain is dry')
    assert.equal(insideRings(20, 50, [outer, hole]), true)
  })

  test('tile coordinates agree with the slippy-map scheme', () => {
    // Tampa's Davis Islands sits in z14 tile 4439/6867, worked out independently.
    const { tx, ty, px, py } = tileCoords(-82.4535, 27.9195, 14, 4096)
    assert.equal(tx, 4439)
    assert.equal(ty, 6867)
    assert.ok(px >= 0 && px < 4096 && py >= 0 && py < 4096)
  })

  test('the lot is sampled at its centre first, then inside the middle of its box', () => {
    const points = samplePoints([0, 0, 10, 10])
    assert.deepEqual(points[0], [5, 5])
    assert.equal(points.length, 9)
    for (const [x, y] of points) assert.ok(x >= 1.5 && x <= 8.5 && y >= 1.5 && y <= 8.5, 'never the box corners')
  })
})

/*
 * A one-tile world at zoom 0 with a 4096 extent, so longitude and latitude
 * map simply onto tile units and the test can place a lot precisely.
 */
const Z = 0
const at = (lng, lat) => tileCoords(lng, lat, Z, 4096)
function tileWith(features) {
  return async () => ({ extent: 4096, features })
}
function zoneOver(w, s, e, n, properties) {
  const a = at(w, n)
  const b = at(e, s)
  return { rings: [square(a.px, a.py, b.px, b.py)], properties }
}

describe('what the card says', () => {
  const lot = [10, 10, 12, 12]

  test('a lot whose centre is in the zone is in it, with the elevation', async () => {
    const read = tileWith([zoneOver(9, 9, 13, 13, { Zone: 'AE', Subtype: 'COASTAL FLOODPLAIN', 'Base flood elevation': 11 })])
    const answer = await floodAt(lot, Z, read)
    assert.equal(answer.status, 'in')
    assert.equal(answer.zone, 'AE')
    assert.equal(answer.bfe, 11)
  })

  test('a lot with a dry centre and a wet back edge is partly in, not clear', async () => {
    const read = tileWith([zoneOver(11.6, 9, 13, 13, { Zone: 'AE' })])
    const answer = await floodAt(lot, Z, read)
    assert.equal(answer.status, 'partly')
    assert.deepEqual(answer.zones, ['AE'])
  })

  test('a lot the zone only brushes at the box corner stays out', async () => {
    // The box is looser than the lot; its corners are often a neighbour's yard.
    const read = tileWith([zoneOver(11.9, 11.9, 13, 13, { Zone: 'AE' })])
    assert.equal((await floodAt(lot, Z, read)).status, 'out')
  })

  test('FEMA\'s -9999 means no published elevation, not a very deep flood', async () => {
    const read = tileWith([zoneOver(9, 9, 13, 13, { Zone: 'A', 'Base flood elevation': -9999 })])
    assert.equal((await floodAt(lot, Z, read)).bfe, null)
  })

  test('a lot straddling two zones names both', async () => {
    const read = tileWith([
      zoneOver(9, 9, 11.2, 13, { Zone: 'AE' }),
      zoneOver(11.2, 9, 13, 13, { Zone: 'VE' }),
    ])
    const answer = await floodAt(lot, Z, read)
    assert.equal(answer.status, 'in')
    assert.deepEqual(answer.zones.sort(), ['AE', 'VE'])
  })

  test('an unreadable tile is an error, never a dry lot', async () => {
    await assert.rejects(floodAt(lot, Z, async () => null), /could not be read/)
  })

  test('a missing tile is simply nothing mapped there', async () => {
    const answer = await floodAt(lot, Z, tileWith([]))
    assert.equal(answer.status, 'out')
  })

  test('zones read in plain words', () => {
    assert.match(zoneMeaning('AE'), /100-year/)
    assert.match(zoneMeaning('VE'), /wave action/)
    assert.match(zoneMeaning('AO'), /Shallow/)
    assert.equal(zoneMeaning('X'), null)
  })
})
