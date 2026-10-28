/**
 * Near a published layer: within so many miles of a transmission line or a
 * substation, or inside an opportunity zone — a grid of cells kept by
 * lib/nearby, tested the same way in the browser and in the parcel store.
 */
import assert from 'node:assert/strict'
import test, { before, describe } from 'node:test'

import { DatabaseSync } from 'node:sqlite'

import { putParcels, sealMarket, searchParcels } from '../app/lib/parcels.js'
import { nodeAdapter } from '../app/lib/sql.js'
import { cellOf, nearGrid, readNear, writeNear } from '../src/lib/nearby.ts'

// A degree of longitude at 33.5° is about 57.7 miles.
const MILE = 1 / 57.7
const line = { geometry: { type: 'LineString', coordinates: [[-112, 33.3], [-112, 33.7]] } }
const point = { geometry: { type: 'Point', coordinates: [-112, 33.5] } }
const zone = {
  geometry: {
    type: 'Polygon',
    coordinates: [[[-112.02, 33.48], [-111.98, 33.48], [-111.98, 33.52], [-112.02, 33.52], [-112.02, 33.48]]],
  },
}
const passes = (grid, lng, lat) => new Set(grid.cells).has(cellOf(lng, lat, grid.dx, grid.dy))

describe('the grid', () => {
  test('within a mile of a line: near it in, two miles out', () => {
    const grid = nearGrid([line], 1)
    assert.ok(passes(grid, -112 + 0.5 * MILE, 33.5))
    assert.ok(passes(grid, -112 - 0.7 * MILE, 33.4))
    assert.ok(!passes(grid, -112 + 2 * MILE, 33.5))
    assert.ok(!passes(grid, -112, 33.8), 'past the end of the line by more than a mile')
  })

  test('within a mile of a point is a disc, not a square', () => {
    const grid = nearGrid([point], 1)
    assert.ok(passes(grid, -112 + 0.8 * MILE, 33.5))
    assert.ok(!passes(grid, -112 + 0.85 * MILE, 33.5 + 0.85 / 69), 'the corner of the square is 1.2 miles out')
  })

  test('inside an area, and within a distance of its edge', () => {
    const inside = nearGrid([zone], 0)
    assert.ok(passes(inside, -112, 33.5))
    assert.ok(!passes(inside, -111.95, 33.5))
    const near = nearGrid([zone], 2)
    assert.ok(passes(near, -111.95, 33.5), 'a mile and a half east of the edge')
  })

  test('bounds keep a long line from filling cells outside the county', () => {
    const long = { geometry: { type: 'LineString', coordinates: [[-112, 30], [-112, 37]] } }
    const all = nearGrid([long], 1)
    const held = nearGrid([long], 1, [-112.1, 33.4, -111.9, 33.6])
    assert.ok(held.cells.length < all.cells.length / 10)
    assert.ok(passes(held, -112, 33.5))
  })

  test('a layer with nothing to be near gives no grid', () => {
    assert.equal(nearGrid([{ geometry: null }], 1), null)
  })

  test('the filter reads and writes as layer:miles, distances from the list only', () => {
    assert.deepEqual(readNear('transmission:1,opportunity-zones:0'), [
      { layer: 'transmission', miles: 1 },
      { layer: 'opportunity-zones', miles: 0 },
    ])
    assert.deepEqual(readNear('transmission:3,../x:1,substations:0.5'), [{ layer: 'substations', miles: 0.5 }])
    assert.equal(writeNear([{ layer: 'transmission', miles: 2 }]), 'transmission:2')
    assert.equal(readNear('a:1,b:1,c:1,d:1,e:1').length, 4, 'four layers at most')
  })
})

describe('in the parcel store', () => {
  let db
  const at = (id, lng, at = 'Land') => ({ id, ad: `${id} Main St`, at, mv: 1000 + id, ac: 1, bb: [lng - 0.0002, 33.4998, lng + 0.0002, 33.5002] })
  before(async () => {
    db = nodeAdapter(new DatabaseSync(':memory:'))
    await db.migrate()
    await putParcels(db, 'phoenix-az', [at(1, -112 + 0.3 * MILE), at(2, -112 + 3 * MILE), at(3, -112 + 8 * MILE, 'Retail')])
    await sealMarket(db, 'phoenix-az', { keys: ['id', 'ad', 'mv', 'ac'] })
  })
  const ids = async (filters) => (await searchParcels(db, 'phoenix-az', filters)).ids.map(Number).sort()

  test('within so many miles of a transmission line', async () => {
    assert.deepEqual(await ids({ nearGrids: [nearGrid([line], 1)] }), [1])
    assert.deepEqual(await ids({ nearGrids: [nearGrid([line], 5)] }), [1, 2])
  })

  test('near is a criterion: some joins it with the rest', async () => {
    const grids = [nearGrid([line], 1)]
    assert.deepEqual(await ids({ nearGrids: grids, assets: ['Retail'] }), [])
    assert.deepEqual(await ids({ nearGrids: grids, assets: ['Retail'], match: 'any' }), [1, 3])
  })

  test('a layer the county does not publish is near nothing', async () => {
    assert.equal((await searchParcels(db, 'phoenix-az', { nearGrids: [{ dx: 1, dy: 1, cells: [] }] })).count, 0)
  })
})
