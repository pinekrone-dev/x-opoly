import assert from 'node:assert/strict'
import test, { before, describe } from 'node:test'

import { DatabaseSync } from 'node:sqlite'

import {
  CLEAR_CHUNK,
  MAX_HIGHLIGHT_IDS,
  clearMarket,
  filtersActive,
  getParcel,
  hydrate,
  marketSummary,
  parcelRow,
  putParcels,
  readyMarkets,
  searchParcels,
  sealMarket,
} from '../app/lib/parcels.js'
import { nodeAdapter } from '../app/lib/sql.js'

let db

/** A county in miniature: enough shape to exercise every filter. */
const PARCELS = [
  { id: 101, ad: '1600 Main St', ow: 'Reyes Holdings', gid: 'R-1', at: 'Retail', sc: 'F1', mv: 900000, ac: 1.2, po: 'p1', bb: [-97.8, 30.2, -97.79, 30.21], zp: '78701' },
  { id: 102, ad: '1700 Main St', ow: 'Reyes Holdings', gid: 'R-2', at: 'Retail', sc: 'F1', mv: 400000, ac: 0.5, po: 'p1', bb: [-97.7, 30.3, -97.69, 30.31], zp: '78701' },
  { id: 103, ad: '9 Industrial Row', ow: 'Vance Logistics', gid: 'I-9', at: 'Industrial', sc: 'F2', mv: 2500000, ac: 12.4, bo: 'b7', bb: [-97.6, 30.4, -97.59, 30.41], zp: '78702' },
  { id: 104, ad: '22 Pasture Ln', ow: 'Okafor Family Trust', gid: 'L-22', at: '', sc: 'D1', mv: 75000, ac: 40, bb: [-97.5, 30.5, -97.49, 30.51], zp: '78703' },
]

before(async () => {
  db = nodeAdapter(new DatabaseSync(':memory:'))
  await db.migrate()
  await putParcels(db, 'austin-tx', PARCELS)
  await sealMarket(db, 'austin-tx', { keys: ['id', 'ad', 'ow', 'mv', 'ac', 'zp'] })
})

describe('parcel rows', () => {
  test('a parcel without an id is refused rather than stored blank', () => {
    assert.equal(parcelRow('austin-tx', { ad: 'nowhere' }), null)
    assert.equal(parcelRow('austin-tx', { id: '' }), null)
  })

  test('unknown columns ride along instead of needing a migration', async () => {
    const found = await getParcel(db, 'austin-tx', 101)
    assert.equal(found.zp, '78701')
    assert.equal(found.ad, '1600 Main St')
    assert.deepEqual(found.bb, [-97.8, 30.2, -97.79, 30.21])
  })

  test('a row with unreadable extras still answers with its own columns', () => {
    const out = hydrate({ pid: '7', ad: 'Somewhere', rest: '{not json', w: null, s: null, e: null, n: null })
    assert.equal(out.ad, 'Somewhere')
    assert.equal(out.bb, null)
  })
})

describe('parcel search', () => {
  test('no filter returns the page but no highlight list', async () => {
    const res = await searchParcels(db, 'austin-tx', {})
    assert.equal(res.count, 4)
    assert.equal(res.ids, null, 'an unfiltered map draws everything; ids would be the old download')
    assert.equal(res.rows[0].mv, 2500000, 'the most valuable parcel leads')
  })

  test('text search reaches address, owner and both parcel numbers', async () => {
    assert.equal((await searchParcels(db, 'austin-tx', { query: 'main st' })).count, 2)
    assert.equal((await searchParcels(db, 'austin-tx', { query: 'vance' })).count, 1)
    assert.equal((await searchParcels(db, 'austin-tx', { query: 'L-22' })).count, 1)
    assert.equal((await searchParcels(db, 'austin-tx', { query: '103' })).count, 1)
  })

  test('a literal wildcard finds that character, not the whole county', async () => {
    const res = await searchParcels(db, 'austin-tx', { query: '%' })
    assert.equal(res.count, 0)
  })

  test('value and acreage bound the set from either end', async () => {
    assert.equal((await searchParcels(db, 'austin-tx', { valueMin: 500000 })).count, 2)
    assert.equal((await searchParcels(db, 'austin-tx', { valueMax: 500000 })).count, 2)
    assert.equal((await searchParcels(db, 'austin-tx', { acresMin: 10 })).count, 2)
    assert.equal(
      (await searchParcels(db, 'austin-tx', { valueMin: 100000, valueMax: 1000000, acresMax: 2 })).count,
      2,
    )
  })

  test('an owner narrows to their holdings, by portfolio or back office', async () => {
    const portfolio = await searchParcels(db, 'austin-tx', { owner: { kind: 'p', id: 'p1' } })
    assert.equal(portfolio.count, 2)
    assert.deepEqual(portfolio.ids.sort(), ['101', '102'])
    const office = await searchParcels(db, 'austin-tx', { owner: { kind: 'b', id: 'b7' } })
    assert.equal(office.count, 1)
  })

  test('asset types filter, and the unclassified stay reachable', async () => {
    assert.equal((await searchParcels(db, 'austin-tx', { assets: ['Retail'] })).count, 2)
    assert.equal((await searchParcels(db, 'austin-tx', { assets: ['Retail', 'Industrial'] })).count, 3)
  })

  test('the totals describe the whole match, not the page', async () => {
    const res = await searchParcels(db, 'austin-tx', { assets: ['Retail'] }, { limit: 1 })
    assert.equal(res.rows.length, 1, 'one row asked for')
    assert.equal(res.count, 2, 'two matched')
    assert.equal(res.total, 1300000)
    assert.equal(res.acreage, 1.7)
  })

  test('the breakdown labels the blank asset type rather than dropping it', async () => {
    const res = await searchParcels(db, 'austin-tx', {})
    assert.deepEqual(new Map(res.byAsset).get('Unclassified'), 1)
  })

  test('paging walks the set without repeating', async () => {
    const first = await searchParcels(db, 'austin-tx', {}, { limit: 2, offset: 0 })
    const second = await searchParcels(db, 'austin-tx', {}, { limit: 2, offset: 2 })
    const ids = [...first.rows, ...second.rows].map((row) => row.id)
    assert.equal(new Set(ids).size, 4)
  })

  test('one market cannot see another', async () => {
    await putParcels(db, 'houston-tx', [{ id: 900, ad: '1 Bayou', mv: 1, ac: 1 }])
    assert.equal((await searchParcels(db, 'austin-tx', { query: 'bayou' })).count, 0)
    assert.equal((await searchParcels(db, 'houston-tx', { query: 'bayou' })).count, 1)
  })

  test('an empty form is not a filter', () => {
    assert.equal(filtersActive({}), false)
    assert.equal(filtersActive({ query: '   ', assets: [''] }), false)
    assert.equal(filtersActive({ acresMin: 5 }), true)
  })

  test('the highlight cap is high enough to be a real map and low enough to send', () => {
    assert.ok(MAX_HIGHLIGHT_IDS >= 10000 && MAX_HIGHLIGHT_IDS <= 100000)
  })
})

describe('market summary', () => {
  test('a sealed market reports its totals, assets and value breaks', async () => {
    const summary = await marketSummary(db, 'austin-tx')
    assert.equal(summary.count, 4)
    assert.equal(summary.total, 3875000)
    assert.equal(summary.acreage, 54.1)
    assert.deepEqual(
      summary.assets.map((a) => a.value).sort(),
      ['Industrial', 'Retail'],
      'the blank asset type is not offered as a filter',
    )
    assert.equal(summary.breaks.length, 4)
    assert.ok(summary.breaks[0] <= summary.breaks[3], 'breaks climb')
  })

  test('a market that has published nothing here answers null, so the app can fall back', async () => {
    assert.equal(await marketSummary(db, 'nowhere-zz'), null)
  })

  test('rebuilding replaces a market rather than doubling it', async () => {
    await putParcels(db, 'austin-tx', PARCELS)
    await sealMarket(db, 'austin-tx', { keys: [] })
    assert.equal((await marketSummary(db, 'austin-tx')).count, 4)
  })

  test('the ready list is what the app checks before downloading an index', async () => {
    const ready = await readyMarkets(db)
    assert.ok(ready.includes('austin-tx'))
    assert.ok(!ready.includes('nowhere-zz'))
  })

  test('clearing a market removes both its rows and its summary', async () => {
    await putParcels(db, 'gone-xx', [{ id: 1, ad: 'x', mv: 1, ac: 1 }])
    await sealMarket(db, 'gone-xx', {})
    const answer = await clearMarket(db, 'gone-xx')
    assert.equal(answer.done, true)
    assert.equal(answer.removed, 1)
    assert.equal(await marketSummary(db, 'gone-xx'), null)
    assert.equal((await searchParcels(db, 'gone-xx', {})).count, 0)
  })

  /*
   * A county does not clear in one statement.
   *
   * `DELETE FROM parcels WHERE market = ?` met Orange County's 971,160 rows
   * with "D1 DB exceeded its CPU time limit and was reset", and the retry
   * re-sent exactly the same impossible statement three more times. The work
   * is bounded now, and the caller is told whether to come back.
   */
  test('a market larger than one pass clears across several, and says so', async () => {
    const many = []
    for (let i = 0; i < CLEAR_CHUNK + 40; i += 1) {
      many.push({ id: i, ad: `${i} Wide St`, mv: 1, ac: 1 })
    }
    for (let i = 0; i < many.length; i += 500) {
      await putParcels(db, 'big-xx', many.slice(i, i + 500))
    }
    await sealMarket(db, 'big-xx', {})
    assert.equal((await searchParcels(db, 'big-xx', {})).count, many.length)

    // A budget below the row count cannot finish, and must not pretend to.
    const first = await clearMarket(db, 'big-xx', CLEAR_CHUNK)
    assert.equal(first.done, false)
    assert.equal(first.removed, CLEAR_CHUNK)
    // The seal outlives a partial clear: a half-emptied market must not read
    // as a market that still holds a county.
    assert.notEqual(await marketSummary(db, 'big-xx'), null)

    const second = await clearMarket(db, 'big-xx', CLEAR_CHUNK)
    assert.equal(second.done, true)
    assert.equal(second.removed, 40)
    assert.equal(await marketSummary(db, 'big-xx'), null)
    assert.equal((await searchParcels(db, 'big-xx', {})).count, 0)
  })

  test('clearing a market that was never published is done immediately', async () => {
    const answer = await clearMarket(db, 'never-xx')
    assert.equal(answer.done, true)
    assert.equal(answer.removed, 0)
  })

  test('clearing one market leaves its neighbours alone', async () => {
    await putParcels(db, 'keep-xx', [{ id: 1, ad: 'stays', mv: 1, ac: 1 }])
    await putParcels(db, 'drop-xx', [{ id: 1, ad: 'goes', mv: 1, ac: 1 }])
    await clearMarket(db, 'drop-xx')
    assert.equal((await searchParcels(db, 'keep-xx', {})).count, 1)
    assert.equal((await searchParcels(db, 'drop-xx', {})).count, 0)
  })
})

/*
 * What a publish actually puts on the wire.
 *
 * The first version of the insert sent one placeholder per column per row, and
 * every publish failed: fifty rows was 850 bindings, and D1 allows a hundred.
 * The cure was to stop counting rows and send them as one JSON parameter, so
 * these check the two ceilings that replaced the old one — bindings per
 * statement, and bytes per request — against rows wide enough to breach a
 * fixed row count.
 */
describe('what a publish sends', () => {
  /** Records every call instead of running it. */
  function recorder() {
    const calls = []
    return {
      calls,
      db: {
        run: async () => {},
        batch: async (statements) => { calls.push(statements) },
      },
    }
  }

  // A county whose rows are long: real owner names and addresses, not the
  // three-word placeholders the rest of this file uses.
  const wide = Array.from({ length: 4000 }, (_, i) => ({
    id: 900000 + i,
    ad: `${1000 + i} Northwest Bartholomew Ridge Parkway Building ${i} Suite 1400`,
    ow: `Bartholomew Ridge Capital Partners Holdings ${i} Limited Liability Company`,
    gid: `PARCEL-IDENTIFIER-${i}-A`,
    at: 'Industrial',
    mv: 1000 + i,
    ac: 1,
    bb: [-97.5, 30.5, -97.49, 30.51],
  }))

  test('no statement carries more bindings than D1 accepts', async () => {
    const { db, calls } = recorder()
    await putParcels(db, 'wide-zz', wide)
    const most = Math.max(...calls.flat().map(([, binds]) => binds.length))
    // D1's limit is 100. The point of the JSON parameter is that this is a
    // constant: two, however many rows the statement holds.
    assert.equal(most, 2)
  })

  test('no statement carries more bytes than the budget, however wide the rows', async () => {
    const { db, calls } = recorder()
    await putParcels(db, 'wide-zz', wide)
    const statements = calls.flat()
    assert.ok(statements.length > 1, 'four thousand wide rows is more than one statement')
    for (const [, binds] of statements) {
      assert.ok(binds[1].length <= 40_000, `a statement carried ${binds[1].length} bytes`)
    }
  })

  test('no batch carries more bytes than the budget', async () => {
    const { db, calls } = recorder()
    await putParcels(db, 'wide-zz', wide)
    for (const batch of calls) {
      const bytes = batch.reduce((sum, [, binds]) => sum + binds[1].length, 0)
      assert.ok(bytes <= 250_000, `a batch carried ${bytes} bytes`)
    }
  })

  test('every row still arrives, and in its own place', async () => {
    const { db, calls } = recorder()
    const sent = await putParcels(db, 'wide-zz', wide)
    assert.equal(sent, wide.length)
    const rows = calls.flat().flatMap(([, binds]) => JSON.parse(binds[1]))
    assert.equal(rows.length, wide.length)
    // Position 0 of the JSON tuple is the parcel id — the column after market.
    assert.deepEqual(rows.map((row) => row[0]).slice(0, 3), ['900000', '900001', '900002'])
  })
})
