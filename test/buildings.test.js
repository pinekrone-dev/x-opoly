/**
 * Buildings from Overture's footprints: the per-lot answer the parcel card
 * shows and the tagging pass writes, the store's side of that pass, and the
 * filters and questions that read it.
 *
 * Tiles are built by hand here, so what is pinned is the arithmetic: which
 * lot a building belongs to, its footprint in square metres, a building
 * clipped across two tiles counted once, and an unread tile meaning
 * "unknown" rather than "vacant".
 */

import assert from 'node:assert/strict'
import test, { before, describe } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { BUILDING_ZOOM, buildingsFor, coverage, describeBuildings } from '../src/lib/buildings.ts'
import { filtersActive, listBoxes, marketSummary, putBuildingTags, putParcels, searchParcels, sealMarket } from '../app/lib/parcels.js'
import { UNDERBUILT, describePlan, heuristicPlan, normalizePlan, passesAttributes } from '../app/lib/ask.js'
import { parcelState } from '../app/lib/jev.js'
import { nodeAdapter } from '../app/lib/sql.js'

const Z = BUILDING_ZOOM
const N = 2 ** Z
const EXTENT = 4096
const tileX = (lng) => Math.floor(((lng + 180) / 360) * N)
const tileY = (lat) => {
  const rad = (lat * Math.PI) / 180
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * N)
}
const lngOf = (x) => (x / N) * 360 - 180
const latOf = (y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / N))) * 180) / Math.PI

// One tile in downtown Los Angeles, and its corners in degrees.
const TX = tileX(-118.2437)
const TY = tileY(34.0522)
const west = lngOf(TX)
const east = lngOf(TX + 1)
const north = latOf(TY)
const south = latOf(TY + 1)
const at = (fx, fy) => [west + (east - west) * fx, north - (north - south) * fy]

/** A square footprint centred at tile units (cx, cy), `side` units across. */
function square(cx, cy, side, properties) {
  const h = side / 2
  const ring = [
    { x: cx - h, y: cy - h },
    { x: cx + h, y: cy - h },
    { x: cx + h, y: cy + h },
    { x: cx - h, y: cy + h },
    { x: cx - h, y: cy - h },
  ]
  return { rings: [ring], properties, bbox: [cx - h, cy - h, cx + h, cy + h] }
}

const metresPerUnit = (40075016.686 * Math.cos((((north + south) / 2) * Math.PI) / 180)) / N / EXTENT

describe('buildings on a lot', () => {
  // Two lots side by side across the tile's middle, and a big one around both.
  const [lw, ls] = at(0.1, 0.9)
  const [mid] = at(0.5, 0.5)
  const [le, ln] = at(0.9, 0.1)
  const leftLot = [lw, ls, mid, ln]
  const rightLot = [mid, ls, le, ln]
  const [bw, bs] = at(0.02, 0.98)
  const [be, bn] = at(0.98, 0.02)
  const bigLot = [bw, bs, be, bn]

  const tile = {
    extent: EXTENT,
    features: [
      square(1000, 2048, 100, { id: 'a', height: 12 }),
      square(1400, 2048, 50, { id: 'b', num_floors: 5 }),
      square(3000, 2048, 200, { id: 'c' }),
      // A neighbour's building clipped into this tile's buffer: its centre is
      // outside the tile, so this tile does not count it.
      square(-40, 2048, 100, { id: 'z' }),
    ],
  }
  const reads = []
  const readTile = async (z, x, y) => {
    reads.push(`${z}/${x}/${y}`)
    return x === TX && y === TY ? tile : null
  }

  test('each building goes to the smallest lot holding its centre, with its footprint and height', async () => {
    const [left, right, big] = await buildingsFor([leftLot, rightLot, bigLot], readTile)
    assert.equal(left.count, 2)
    assert.equal(right.count, 1)
    assert.equal(big.count, 0, 'the big lot overlaps both, and the smaller lots win')
    const expected = (100 * 100 + 50 * 50) * metresPerUnit * metresPerUnit
    assert.ok(Math.abs(left.area - expected) / expected < 0.01, `left footprint ${left.area} ≈ ${expected}`)
    assert.equal(left.tallest, 16, 'five floors at 3.2 m beats a 12 m height')
    assert.equal(right.tallest, null, 'no height known is null, not zero')
    assert.equal(new Set(reads).size, 1, 'the one tile is read once for all three lots')
  })

  test('condominium units drawn as one outline all stand under the same tower', async () => {
    const [a, b, other] = await buildingsFor([leftLot, [...leftLot], rightLot], readTile)
    assert.equal(a.count, 2)
    assert.deepEqual(b, a, 'an identical box gets the same buildings, not none')
    assert.equal(other.count, 1)
  })

  test('an unread tile is unknown, and an empty one is vacant', async () => {
    const [far] = await buildingsFor([[lngOf(TX + 5), latOf(TY + 6), lngOf(TX + 5) + 0.0001, latOf(TY + 6) + 0.0001]], readTile)
    assert.equal(far, null)
    const [empty] = await buildingsFor([leftLot], async () => ({ extent: EXTENT, features: [] }))
    assert.deepEqual(empty, { count: 0, area: 0, tallest: null })
    const [none] = await buildingsFor([null], readTile)
    assert.equal(none, null)
  })

  test('the card line and the coverage share', () => {
    const summary = { count: 2, area: 780, tallest: 11.6 }
    assert.equal(Math.round(coverage(summary, 0.5) * 100), 39)
    assert.equal(
      describeBuildings(summary, 0.5),
      '2 buildings, about 8,396 sq ft of footprint, tallest about 38 ft, covering about 39% of the lot',
    )
    assert.equal(describeBuildings({ count: 0, area: 0, tallest: null }, 1), 'No building footprint mapped on this lot')
    assert.equal(describeBuildings(null), null)
  })
})

describe('building tags in the store', () => {
  let db
  const LOTS = [
    { id: 1, ad: '1 Empty Lot Rd', at: 'Vacant', mv: 50000, ac: 1, bb: [-118.3, 34.0, -118.29, 34.01] },
    { id: 2, ad: '2 Shed Way', at: 'Industrial', mv: 800000, ac: 2, bb: [-118.28, 34.0, -118.27, 34.01] },
    { id: 3, ad: '3 Tower Pl', at: 'Office', mv: 9000000, ac: 0.5, bb: [-118.26, 34.0, -118.25, 34.01] },
    { id: 4, ad: '4 Unread St', at: 'Retail', mv: 300000, ac: 0.3, bb: [-118.24, 34.0, -118.23, 34.01] },
  ]
  before(async () => {
    db = nodeAdapter(new DatabaseSync(':memory:'))
    await db.migrate()
    await putParcels(db, 'los-angeles', LOTS)
    await sealMarket(db, 'los-angeles', { keys: ['id', 'ad', 'mv', 'ac'] })
  })

  test('the boxes come back in pages, with a cursor while there are more', async () => {
    const first = await listBoxes(db, 'los-angeles', { limit: 3 })
    assert.equal(first.boxes.length, 3)
    assert.deepEqual(first.boxes[0].slice(1), [-118.3, 34.0, -118.29, 34.01])
    const second = await listBoxes(db, 'los-angeles', { after: first.cursor, limit: 3 })
    assert.equal(second.boxes.length, 1)
    assert.equal(second.cursor, null)
  })

  test('tags are written, the market marked when the pass is done, and the filters read them', async () => {
    const { boxes } = await listBoxes(db, 'los-angeles')
    const rowid = Object.fromEntries(boxes.map((b, i) => [LOTS[i].id, b[0]]))
    assert.equal((await marketSummary(db, 'los-angeles')).btagged, false)
    // Lot 4's tile was unreadable, so the pass sends nothing for it.
    const answer = await putBuildingTags(
      db,
      'los-angeles',
      [
        [rowid[1], 0, 0, null],
        [rowid[2], 1, 400, 6],
        [rowid[3], 1, 1800, 120.44],
        ['nonsense'],
      ],
      { done: true },
    )
    assert.equal(answer.received, 3)
    assert.equal((await marketSummary(db, 'los-angeles')).btagged, true)

    const ids = async (filters) => (await searchParcels(db, 'los-angeles', filters, { limit: 50 })).rows.map((r) => String(r.id)).sort()
    assert.deepEqual(await ids({ buildings: 'vacant' }), ['1'])
    assert.deepEqual(await ids({ buildings: 'built' }), ['2', '3'])
    // 400 m² on two acres is 5%; 1,800 m² on half an acre is 89%.
    assert.deepEqual(await ids({ coverageMax: 0.15 }), ['1', '2'], 'an untagged lot is never called under-built')
    assert.ok(filtersActive({ buildings: 'vacant' }))
    assert.ok(filtersActive({ coverageMax: 0.2 }))

    const [tower] = (await searchParcels(db, 'los-angeles', { query: '3 tower' })).rows
    assert.deepEqual([tower.bn, tower.ba, tower.bh], [1, 1800, 120.4])
  })

  test('a republish keeps the building tags', async () => {
    await putParcels(db, 'los-angeles', [{ ...LOTS[2], mv: 9500000 }])
    const [tower] = (await searchParcels(db, 'los-angeles', { query: '3 tower' })).rows
    assert.equal(tower.bn, 1)
  })
})

describe('asking about buildings', () => {
  const vocab = { assetTypes: ['Vacant', 'Industrial', 'Office'], hasBuildings: true }

  test('the words for vacant, built and under-built', () => {
    assert.equal(heuristicPlan('lots with no building on them over 2 acres', vocab).plan.buildings, 'vacant')
    assert.equal(heuristicPlan('empty lots near the port', vocab).plan.buildings, 'vacant')
    assert.equal(heuristicPlan('parcels with a building, export', vocab).plan.buildings, 'built')
    assert.equal(heuristicPlan('underutilized industrial sites', vocab).plan.coverageMax, UNDERBUILT)
    assert.equal(heuristicPlan('under-built parcels', vocab).plan.coverageMax, UNDERBUILT)
  })

  test('a market whose parcels are not tagged drops them', () => {
    const plan = normalizePlan({ buildings: 'vacant', coverageMax: 0.2 }, { hasBuildings: false })
    assert.equal(plan.buildings, null)
    assert.equal(plan.coverageMax, null)
  })

  test('a parcel is judged by its tags, and an untagged one is not guessed at', () => {
    const plan = normalizePlan({ buildings: 'vacant' }, vocab)
    assert.equal(passesAttributes({ at: 'Vacant', bn: 0, ba: 0, ac: 1 }, plan), null)
    assert.match(passesAttributes({ at: 'Vacant', bn: 2, ba: 90, ac: 1 }, plan), /2 buildings/)
    assert.match(passesAttributes({ at: 'Vacant', ac: 1 }, plan), /not yet mapped/)
    const under = normalizePlan({ coverageMax: 0.15 }, vocab)
    assert.equal(passesAttributes({ bn: 1, ba: 400, ac: 2 }, under), null)
    assert.match(passesAttributes({ bn: 1, ba: 1800, ac: 0.5 }, under), /cover 89%/)
    assert.match(describePlan(plan), /no building on the lot/)
    assert.match(describePlan(under), /15% of the lot or less/)
  })

  test('a Jev rating is told what stands on the lot', () => {
    assert.match(parcelState({ ad: '2 Shed Way', bn: 1, ba: 400 }), /Buildings on the lot \(mapped footprints\): 1, about 4,306 sq ft/)
    assert.match(parcelState({ ad: '1 Empty Lot Rd', bn: 0 }), /No building footprint mapped/)
    assert.doesNotMatch(parcelState({ ad: '9 Unknown' }), /[Bb]uilding/)
  })
})

describe('the zoomed-out summary grid', () => {
  test('a market summed into cells once per version, with flood and vacancy shares', async () => {
    const { parcelGrid, GRID_CELL, tagMarket } = await import('../app/lib/parcels.js')
    const { gridFeatures } = await import('../src/lib/grid.ts')
    const db = nodeAdapter(new DatabaseSync(':memory:'))
    await db.migrate()
    await putParcels(db, 'grid-test', [
      // Two lots in one cell, one in the next cell east.
      { id: 1, ad: 'a', mv: 1000000, ac: 1, bb: [-100.0049, 40.0021, -100.0041, 40.0029] },
      { id: 2, ad: 'b', mv: 3000000, ac: 1, bb: [-100.0039, 40.0031, -100.0031, 40.0039] },
      { id: 3, ad: 'c', mv: 200000, ac: 4, bb: [-99.9949, 40.0021, -99.9941, 40.0029] },
    ])
    await sealMarket(db, 'grid-test', { keys: ['id', 'ad', 'mv', 'ac'] })
    let reads = 0
    const counted = { ...db, get: db.get.bind(db), run: db.run.bind(db), batch: db.batch.bind(db), all: (sql, args) => ((reads += /GROUP BY gx/.test(sql) ? 1 : 0), db.all(sql, args)) }

    const grid = await parcelGrid(counted, 'grid-test')
    assert.equal(grid.cell, GRID_CELL)
    assert.equal(grid.cells.length, 2)
    const west = grid.cells.find((c) => c[2] === 2)
    assert.deepEqual(west.slice(2, 5), [2, 4000000, 2])
    assert.deepEqual(west.slice(5), [0, 0, 0, 0], 'nothing tagged yet, so no shares')
    await parcelGrid(counted, 'grid-test')
    assert.equal(reads, 1, 'the second ask reads the kept row, not the market')

    // Tagging makes a new version, and the shares appear.
    const { boxes } = await listBoxes(db, 'grid-test')
    await putBuildingTags(db, 'grid-test', boxes.map((b, i) => [b[0], i === 0 ? 0 : 1, 100, null]), { done: true })
    await tagMarket(db, 'grid-test', { check: async (ps) => ps.map((_, i) => ({ zoning: null, flood: { status: i === 1 ? 'in' : 'out', zones: ['AE'] } })), budget: 10 })
    const tagged = await parcelGrid(counted, 'grid-test')
    assert.equal(reads, 2)
    const again = tagged.cells.find((c) => c[2] === 2)
    assert.deepEqual(again.slice(5), [1, 2, 1, 2], 'one of two in the flood zone, one of two vacant')

    const value = gridFeatures(tagged, 'value')
    assert.equal(value.geo.features.length, 2)
    const bands = Object.keys(value.colors)
    assert.equal(bands.length, 2, 'two cells, two bands')
    assert.deepEqual(bands, ['up to $50k / acre', '$50k–$2M / acre'])
    const cellProps = value.geo.features.find((f) => f.properties.Parcels === '2').properties
    assert.equal(cellProps['In flood zone'], '50%')
    assert.equal(cellProps['No building'], '50%')
    const [ring] = value.geo.features[0].geometry.coordinates
    assert.ok(Math.abs(ring[1][0] - ring[0][0] - GRID_CELL) < 1e-9)
    assert.equal(gridFeatures({ ...tagged, cells: [] }, 'value'), null)
  })
})
