/**
 * Filters answered from a market's packed columns (cols.bin), the file the
 * pipeline's make_cols.py writes. The fixture is one make_cols.py wrote, so
 * the layout read here is the layout written there.
 *
 * Seven parcels: 5 Industrial $5.2M 8.5 ac sold 1990 mail PA; 2 Retail $2.5M
 * 3.1 ac 2019 NY; 1 Residential $410k 0.2 ac 2001 DE; 6 and 7 Residential
 * $300k each, two units sharing one 2-acre lot four ways, 2015 and 2016 DE;
 * 3 Land $90k 12 ac, no sale and no mailing state; 4 unclassified $0 40 ac
 * 1985 DE.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test, { describe } from 'node:test'

import { readCols, scanCols, unanswerable } from '../src/lib/parcelCols.ts'

const file = fs.readFileSync(new URL('./fixtures/cols.bin', import.meta.url))
const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength)
const cols = readCols(buffer)
const scan = (filters, options) => scanCols(cols, filters, { home: 'DE', year: 2026, ...options })

describe('packed filter columns', () => {
  test('the file reads back as the pipeline wrote it', () => {
    assert.ok(cols)
    assert.equal(cols.n, 7)
    assert.deepEqual([...cols.id], [5, 2, 1, 6, 7, 3, 4], 'rows are in order of value')
    assert.deepEqual(cols.assets, ['', 'Residential', 'Industrial', 'Land', 'Retail'])
    assert.equal(cols.mv[0], 5200000)
  })

  test('anything that is not a sound file is refused, not half read', () => {
    assert.equal(readCols(new ArrayBuffer(4)), null)
    assert.equal(readCols(new TextEncoder().encode('LQC1 and then nonsense').buffer), null)
    assert.equal(readCols(buffer.slice(0, buffer.byteLength - 3)), null, 'a file cut short')
    const wrong = new Uint8Array(buffer.slice(0))
    wrong[0] = 88
    assert.equal(readCols(wrong.buffer), null)
  })

  test('no filter is the whole market, with a shared lot counted once', () => {
    const all = scan({})
    assert.equal(all.count, 7)
    assert.equal(all.total, 5200000 + 2500000 + 410000 + 300000 + 300000 + 90000)
    // 8.5 + 3.1 + 0.2 + 12 + 40, and the two units' 2 acres as a quarter each.
    assert.ok(Math.abs(all.acreage - 64.8) < 1e-3)
    assert.deepEqual(all.byAsset[0], ['Residential', 3])
    assert.ok(all.byAsset.some(([name, count]) => name === 'Unclassified' && count === 1))
    assert.deepEqual(all.ids, [5, 2, 1, 6, 7, 3, 4])
    assert.equal(all.truncated, false)
  })

  test('asset type, value and acres bound the set', () => {
    assert.deepEqual(scan({ assets: ['Residential'] }).ids, [1, 6, 7])
    assert.deepEqual(scan({ assets: ['Industrial', 'Retail'] }).ids, [5, 2])
    assert.deepEqual(scan({ assets: ['No Such Type'] }).ids, [])
    assert.deepEqual(scan({ valueMin: 1000000 }).ids, [5, 2])
    assert.deepEqual(scan({ valueMin: 300000, valueMax: 410000 }).ids, [1, 6, 7])
    assert.deepEqual(scan({ acresMin: 5 }).ids, [5, 3, 4])
    assert.deepEqual(scan({ acresMin: 5, valueMin: 1000000 }).ids, [5])
    assert.deepEqual(scan({ acresMax: 0.5 }).ids, [1])
  })

  test('any one criterion, or all of them', () => {
    assert.deepEqual(scan({ assets: ['Land'], valueMin: 1000000 }).ids, [])
    assert.deepEqual(scan({ assets: ['Land'], valueMin: 1000000, match: 'any' }).ids, [5, 2, 3])
  })

  test('how long it has been held and where the mail goes', () => {
    // Ten years before 2026 is 2016: a lot with no sale on record is left out.
    assert.deepEqual(scan({ owners: ['held10'] }).ids, [5, 1, 6, 7, 4])
    assert.deepEqual(scan({ owners: ['freeClear'] }).ids, [5, 4])
    assert.deepEqual(scan({ owners: ['held10', 'freeClear'] }).ids, [5, 4])
    assert.deepEqual(scan({ owners: ['outOfState'] }).ids, [5, 2], 'mail with no state is left out')
    assert.deepEqual(scan({ owners: ['outOfState'] }, { home: null }).ids, [], 'a market whose state is unknown matches nothing')
    assert.deepEqual(scan({ owners: ['outOfState', 'held10'] }).ids, [5])
  })

  test('a circle and a box keep the parcels whose centre is inside', () => {
    // Parcel 2's centre is -75.395, 39.205; 6 and 7 are about half a mile off.
    assert.deepEqual(scan({ circle: { lat: 39.205, lng: -75.395, miles: 0.2 } }).ids, [2])
    assert.deepEqual(scan({ circle: { lat: 39.205, lng: -75.395, miles: 1.5 } }).ids, [2, 6, 7])
    assert.deepEqual(scan({ circle: { lat: 39.205, lng: -75.395, miles: 1.5 }, assets: ['Residential'] }).ids, [6, 7])
    assert.deepEqual(scan({ box: [-75.46, 39.14, -75.38, 39.22] }).ids, [5, 2, 6, 7])
    // The area bounds the set even when any one criterion is enough.
    assert.deepEqual(scan({ box: [-75.46, 39.14, -75.38, 39.22], assets: ['Land'], valueMin: 1000000, match: 'any' }).ids, [5, 2])
  })

  test('the list stops at what was asked for and says so', () => {
    const few = scan({}, { keep: 3 })
    assert.deepEqual(few.ids, [5, 2, 1])
    assert.equal(few.count, 7)
    assert.equal(few.truncated, true)
  })

  test('what the columns cannot answer is named', () => {
    assert.deepEqual(unanswerable({ assets: ['Land'], valueMin: 1 }), [])
    assert.deepEqual(unanswerable({ zoningCategories: ['Industrial'], flood: 'in', buildings: 'vacant' }), ['zoning', 'flood zone', 'buildings'])
    assert.deepEqual(unanswerable({ query: 'main', valueMin: 1 }), ['text together with other filters'])
    assert.deepEqual(unanswerable({ owner: { id: 'p1' } }), ["one owner's portfolio"])
  })
})
