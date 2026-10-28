/**
 * The usage counters, written in batches: a search costs no database write
 * of its own, and an allowance still refuses where it should.
 */
import assert from 'node:assert/strict'
import test, { describe } from 'node:test'

import { DatabaseSync } from 'node:sqlite'

import { overCount, spendCount, spendRows } from '../app/lib/aibudget.js'
import { nodeAdapter } from '../app/lib/sql.js'

async function counted() {
  const db = nodeAdapter(new DatabaseSync(':memory:'))
  await db.migrate()
  let writes = 0
  const get = db.get.bind(db)
  db.get = (sql, params) => {
    if (/^\s*INSERT INTO ai_usage/.test(sql)) writes += 1
    return get(sql, params)
  }
  return { db, writes: () => writes }
}

describe('counters written in batches', () => {
  test('a hundred searches in a minute write a handful of times, not a hundred', async () => {
    const { db, writes } = await counted()
    const now = Date.UTC(2026, 9, 28, 12)
    for (let i = 0; i < 100; i += 1) {
      const verdict = await spendRows(db, { teamId: 't1', amount: 50, env: {}, now: now + i * 100 })
      assert.equal(verdict.allowed, true)
    }
    assert.ok(writes() <= 6, `${writes()} writes for 100 searches`)
  })

  test('the tally reaches the database within the minute', async () => {
    const { db } = await counted()
    const now = Date.UTC(2026, 9, 28, 12)
    await spendRows(db, { teamId: 't2', amount: 10, env: {}, now })
    await spendRows(db, { teamId: 't2', amount: 10, env: {}, now: now + 61_000 })
    const row = await db.get("SELECT count FROM ai_usage WHERE team_id = 't2'")
    assert.equal(Number(row.count), 20)
  })

  test('near the allowance every spend is written, and the refusal lands on time', async () => {
    const { db } = await counted()
    const now = Date.UTC(2026, 9, 28, 12)
    const cap = 50000
    let refusedAt = null
    for (let i = 1; i <= 60 && refusedAt == null; i += 1) {
      const verdict = await spendRows(db, { teamId: 't3', amount: 1000, env: {}, now: now + i })
      if (!verdict.allowed) refusedAt = i
    }
    assert.equal(refusedAt, 51, 'the 51st thousand is the first past 50,000')
    const row = await db.get("SELECT count FROM ai_usage WHERE team_id = 't3'")
    assert.ok(Number(row.count) > cap, 'and the stored count says so, for every isolate to read')
    assert.equal(await overCount(db, { key: 't3', kind: 'rows', cap, now: now + 100 }), true)
  })

  test('small allowances are exact: every spend is written', async () => {
    const { db, writes } = await counted()
    const now = Date.UTC(2026, 9, 28, 12)
    const verdicts = []
    for (let i = 0; i < 4; i += 1) verdicts.push((await spendCount(db, { key: 'ip:1', kind: 'signups', cap: 3, now })).allowed)
    assert.deepEqual(verdicts, [true, true, true, false])
    assert.equal(writes(), 4)
  })
})

describe('a search says what it read', () => {
  test('the rows the store reports reading are summed across the search', async () => {
    const { putParcels, sealMarket, searchParcels } = await import('../app/lib/parcels.js')
    const db = nodeAdapter(new DatabaseSync(':memory:'))
    await db.migrate()
    const P = (id, at) => ({ id, ad: `${id} Main St`, at, mv: 1000 + id, ac: 1, bb: [-97.7, 30.2, -97.69, 30.21] })
    await putParcels(db, 'austin-tx', [P(1, 'Land'), P(2, 'Retail'), P(3, 'Land')])
    await sealMarket(db, 'austin-tx', { keys: ['id', 'ad', 'mv', 'ac'] })
    // As D1 answers: every statement carries the rows it read.
    let statements = 0
    db.allMeta = async (sql, params) => {
      statements += 1
      return { rows: await db.all(sql, params), read: 11 }
    }
    const tally = { read: 0, unknown: false }
    const found = await searchParcels(db, 'austin-tx', { assets: ['Land'] }, { tally })
    assert.equal(found.count, 2)
    assert.equal(tally.unknown, false)
    assert.equal(tally.read, 11 * statements)

    // Without the figure (Node's store), the caller is told so and estimates.
    const blind = { read: 0, unknown: false }
    delete db.allMeta
    await searchParcels(db, 'austin-tx', { assets: ['Land'] }, { tally: blind })
    assert.equal(blind.unknown, true)
  })
})
