/**
 * Zoning and flood as filters: the tags a tagging pass writes onto every
 * parcel, and the search that reads them.
 *
 * The geometry itself (which district a lot sits in, whether it is in the
 * flood zone) has its own tests in flood.test.js; here `check` answers from a
 * table, so what is pinned is the pass: every parcel checked once, only a
 * change written, the cursor surviving between requests, and "anything but
 * residential" meaning zoned, and zoned something else.
 */

import assert from 'node:assert/strict'
import test, { before, describe } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { marketSummary, putParcels, searchParcels, sealMarket, tagMarket, filtersActive } from '../app/lib/parcels.js'
import { heuristicPlan, passesOverlay } from '../app/lib/ask.js'
import { nodeAdapter } from '../app/lib/sql.js'

const PARCELS = [
  { id: 1, ad: '1 Bay St', at: 'Retail', mv: 900000, ac: 1, bb: [-82.5, 27.9, -82.49, 27.91] },
  { id: 2, ad: '2 Bay St', at: 'Single family', mv: 400000, ac: 0.2, bb: [-82.4, 27.9, -82.39, 27.91] },
  { id: 3, ad: '3 Dock Rd', at: 'Industrial', mv: 2500000, ac: 12, bb: [-82.3, 27.9, -82.29, 27.91] },
  { id: 4, ad: '4 Marsh Ln', at: '', mv: 75000, ac: 40, bb: [-82.2, 27.9, -82.19, 27.91] },
  { id: 5, ad: '5 Somewhere', at: 'Office', mv: 1200000, ac: 2, bb: [-82.1, 27.9, -82.09, 27.91] },
]

// What the map's layers say at each parcel, by its west edge.
const TRUTH = {
  '-82.5': { zoning: { code: 'C-2', category: 'Commercial' }, flood: { status: 'out' } },
  '-82.4': { zoning: { code: 'RS-60', category: 'Residential' }, flood: { status: 'out' } },
  '-82.3': { zoning: { code: 'M-1', category: 'Industrial' }, flood: { status: 'in', zones: ['AE'] } },
  '-82.2': { zoning: { code: null, category: null }, flood: { status: 'out' } },
  // An unreadable tile: neither answer is known.
  '-82.1': { zoning: null, flood: null },
}
let checked = 0
const check = async (parcels) =>
  parcels.map((p) => {
    checked += 1
    return TRUTH[String(p.bb[0])] ?? { zoning: null, flood: null }
  })

let db
before(async () => {
  db = nodeAdapter(new DatabaseSync(':memory:'))
  await db.migrate()
  await putParcels(db, 'tampa-fl', PARCELS)
  await sealMarket(db, 'tampa-fl', { keys: ['id', 'ad', 'mv', 'ac'] })
})

describe('tagging a market', () => {
  test('a pass walks the market in steps, keeping its place, and marks the market tagged at the end', async () => {
    assert.equal((await marketSummary(db, 'tampa-fl')).tagged, false)
    const first = await tagMarket(db, 'tampa-fl', { check, budget: 2 })
    assert.deepEqual([first.checked, first.done], [2, false])
    const second = await tagMarket(db, 'tampa-fl', { check, budget: 2 })
    assert.equal(second.checked, 2, 'the second step starts where the first stopped')
    const third = await tagMarket(db, 'tampa-fl', { check, budget: 2 })
    assert.deepEqual([third.checked, third.done], [1, true])
    assert.equal(checked, 5, 'every parcel checked exactly once')
    assert.equal((await marketSummary(db, 'tampa-fl')).tagged, true)
  })

  test('asking again without a fresh pass reads nothing', async () => {
    const before = checked
    const again = await tagMarket(db, 'tampa-fl', { check, budget: 100 })
    assert.equal(again.already, true)
    assert.equal(checked, before)
  })

  test('a second pass writes nothing that has not changed', async () => {
    const again = await tagMarket(db, 'tampa-fl', { check, budget: 100, reset: true })
    assert.equal(again.checked, 5)
    assert.equal(again.changed, 0, 'the layers did not move, so no parcel is rewritten')
  })

  test('a republish keeps the tags', async () => {
    await putParcels(db, 'tampa-fl', [{ ...PARCELS[0], mv: 950000 }])
    const [row] = (await searchParcels(db, 'tampa-fl', { query: '1 bay' })).rows
    assert.equal(row.zc, 'Commercial')
    assert.equal(row.mv, 950000)
  })
})

describe('searching by zoning and flood', () => {
  const ids = async (filters) => (await searchParcels(db, 'tampa-fl', filters)).ids.slice().sort()

  test('outside the flood zone and zoned anything but residential', async () => {
    assert.deepEqual(await ids({ flood: 'out', zoningNot: ['Residential'] }), ['1'], 'unzoned and unread lots are not counted as passing')
  })

  test('only a category, or a district code', async () => {
    assert.deepEqual(await ids({ zoningCategories: ['Industrial'] }), ['3'])
    assert.deepEqual(await ids({ zoningCodes: ['RS-60'] }), ['2'])
    assert.deepEqual(await ids({ zoningCategories: ['Industrial'], zoningCodes: ['C-2'] }), ['1', '3'], 'a category or a code')
  })

  test('in the flood zone', async () => {
    assert.deepEqual(await ids({ flood: 'in' }), ['3'])
  })

  test('the tags count as a filter being set', () => {
    assert.equal(filtersActive({ flood: 'out' }), true)
    assert.equal(filtersActive({ zoningNot: ['Residential'] }), true)
    assert.equal(filtersActive({}), false)
  })
})

describe('reading "anything but"', () => {
  const vocab = {
    assetTypes: ['Retail', 'Single family', 'Industrial'],
    zoningCategories: ['Residential', 'Commercial', 'Industrial', 'Mixed use'],
    zoningCodes: ['C-2', 'M-1'],
    hasFlood: true,
  }

  test('the question as asked', () => {
    const { plan } = heuristicPlan('I need parcels that are out of flood plain and zoned anything but residential', vocab)
    assert.deepEqual(plan.zoningNot, ['Residential'])
    assert.deepEqual(plan.zoningCategories, [])
    assert.equal(plan.flood, 'out')
  })

  test('other ways of saying it', () => {
    assert.deepEqual(heuristicPlan('non-residential land', vocab).plan.zoningNot, ['Residential'])
    assert.deepEqual(heuristicPlan('lots not zoned industrial', vocab).plan.zoningNot, ['Industrial'])
    assert.deepEqual(heuristicPlan('zoned anything other than commercial', vocab).plan.zoningNot, ['Commercial'])
    const both = heuristicPlan('zoned commercial but not residential', vocab).plan
    assert.deepEqual([both.zoningCategories, both.zoningNot], [['Commercial'], ['Residential']])
  })

  test('a checked parcel is judged the same way', () => {
    const plan = { flood: null, zoningCategories: [], zoningCodes: [], zoningNot: ['Residential'] }
    assert.equal(passesOverlay({ zoning: { code: 'C-2', category: 'Commercial' } }, plan), null)
    assert.match(passesOverlay({ zoning: { code: 'RS-60', category: 'Residential' } }, plan), /Zoned RS-60/)
    assert.match(passesOverlay({ zoning: { code: null, category: null } }, plan), /No zoning district/)
  })
})

describe('the area a question may cover', () => {
  test('a map view is read strictly, and only a small one is small enough', async () => {
    const { readArea, areaSmallEnough } = await import('../app/lib/ask.js')
    assert.equal(readArea(null), null)
    assert.equal(readArea([1, 2, 3]), null)
    assert.equal(readArea([-97, 30, -98, 31]), null, 'east before west is not an area')
    assert.deepEqual(readArea(['-97.7', '30.2', '-97.6', '30.3']), [-97.7, 30.2, -97.6, 30.3])
    assert.equal(areaSmallEnough([-97.7, 30.2, -97.5, 30.4]), true)
    assert.equal(areaSmallEnough([-98.2, 30, -97.3, 30.7]), false, 'a county is not a small area')
  })
})
