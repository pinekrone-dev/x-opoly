/**
 * The daily AI budget.
 *
 * The burst limiter beside it stops a hammering; this stops a sustained
 * spend. The tests that matter are the ones proving the difference: that the
 * budget counts per workspace rather than per address, that it survives the
 * process restart an in-memory counter would not, and that it charges only
 * calls that actually reach a model.
 */

import assert from 'node:assert/strict'
import test, { before, describe } from 'node:test'

import { DatabaseSync } from 'node:sqlite'

import { nodeAdapter } from '../app/lib/sql.js'
import { DEFAULT_BUDGETS, budgetFor, spend, sweepUsage, usageToday } from '../app/lib/aibudget.js'

let db
const DAY = 24 * 60 * 60 * 1000

before(async () => {
  db = nodeAdapter(new DatabaseSync(':memory:'))
  await db.migrate()
})

describe('the daily AI budget', () => {
  test('counts per workspace, so two colleagues share one budget', async () => {
    // The case an address-keyed limit gets wrong in both directions: an
    // office behind one NAT would share a bucket by accident, and one person
    // on two devices would get two. The workspace is who is billed.
    for (let i = 0; i < 5; i += 1) {
      await spend(db, { teamId: 'team-a', kind: 'scout', env: {} })
    }
    await spend(db, { teamId: 'team-b', kind: 'scout', env: {} })

    const a = await usageToday(db, 'team-a', {})
    const b = await usageToday(db, 'team-b', {})
    assert.equal(a.scout.used, 5)
    assert.equal(b.scout.used, 1, "one workspace's spending is not another's")
  })

  test('kinds have separate budgets', async () => {
    await spend(db, { teamId: 'team-c', kind: 'scout', env: {} })
    await spend(db, { teamId: 'team-c', kind: 'read', env: {} })
    await spend(db, { teamId: 'team-c', kind: 'read', env: {} })
    const used = await usageToday(db, 'team-c', {})
    assert.equal(used.scout.used, 1)
    assert.equal(used.read.used, 2, 'reading a flyer is a heavier call and is budgeted apart')
  })

  test('refuses past the cap and says when it resets', async () => {
    const env = { AI_DAILY_SCOUT: '3' }
    const results = []
    for (let i = 0; i < 5; i += 1) {
      results.push(await spend(db, { teamId: 'team-d', kind: 'scout', env }))
    }
    assert.deepEqual(
      results.map((r) => r.allowed),
      [true, true, true, false, false],
      'the fourth call is the first refusal when the cap is three',
    )
    const refused = results[3]
    assert.equal(refused.cap, 3)
    assert.ok(refused.retryAfterSeconds > 0, 'a refusal carries a Retry-After a client can act on')
    assert.ok(refused.retryAfterSeconds <= 24 * 60 * 60)
  })

  test('a refused attempt is still counted', async () => {
    // Deliberate: a counter that records only the allowed calls tells you
    // nothing about what was tried, which is exactly what you want when
    // deciding whether a cap is set right.
    const used = await usageToday(db, 'team-d', { AI_DAILY_SCOUT: '3' })
    assert.equal(used.scout.used, 5)
  })

  test('the budget is a day, not a window — tomorrow is clear', async () => {
    const env = { AI_DAILY_SCOUT: '2' }
    const now = Date.parse('2026-08-28T12:00:00Z')
    await spend(db, { teamId: 'team-e', kind: 'scout', env, now })
    await spend(db, { teamId: 'team-e', kind: 'scout', env, now })
    const blocked = await spend(db, { teamId: 'team-e', kind: 'scout', env, now })
    assert.equal(blocked.allowed, false)

    const tomorrow = await spend(db, { teamId: 'team-e', kind: 'scout', env, now: now + DAY })
    assert.equal(tomorrow.allowed, true, 'a new day is a new budget')
    assert.equal(tomorrow.used, 1)
  })

  test('survives a restart, which an in-memory counter would not', async () => {
    // The whole reason this lives in the database: Worker isolates recycle
    // often, and a daily cap that resets with them is decorative.
    const env = { AI_DAILY_SCOUT: '2' }
    await spend(db, { teamId: 'team-f', kind: 'scout', env })
    await spend(db, { teamId: 'team-f', kind: 'scout', env })

    // A second adapter over the same database is what a fresh isolate sees.
    const again = await usageToday(db, 'team-f', env)
    assert.equal(again.scout.used, 2)
    const blocked = await spend(db, { teamId: 'team-f', kind: 'scout', env })
    assert.equal(blocked.allowed, false, 'the count was read back, not remembered')
  })

  test('signed out, the burst limiter does the work alone', async () => {
    // Counting by address here would recreate the shared-NAT problem the
    // workspace budget exists to avoid.
    const verdict = await spend(db, { teamId: null, kind: 'scout', env: { AI_DAILY_SCOUT: '1' } })
    assert.equal(verdict.allowed, true)
    assert.equal(await usageToday(db, null, {}), null)
  })

  test('caps are configurable, and fall back when the setting is nonsense', async () => {
    assert.equal(budgetFor({ AI_DAILY_SCOUT: '42' }, 'scout'), 42)
    assert.equal(budgetFor({ AI_DAILY_READ: '7' }, 'read'), 7)
    for (const bad of [{}, { AI_DAILY_SCOUT: 'lots' }, { AI_DAILY_SCOUT: '0' }, { AI_DAILY_SCOUT: '-5' }]) {
      assert.equal(budgetFor(bad, 'scout'), DEFAULT_BUDGETS.scout)
    }
  })

  test('old days are swept, recent ones kept', async () => {
    const now = Date.parse('2026-08-28T12:00:00Z')
    await spend(db, { teamId: 'team-g', kind: 'scout', env: {}, now: now - 30 * DAY })
    await spend(db, { teamId: 'team-g', kind: 'scout', env: {}, now })

    await sweepUsage(db, { now })
    const rows = await db.all('SELECT day FROM ai_usage WHERE team_id = ?', ['team-g'])
    assert.equal(rows.length, 1, 'a month-old counter is gone')
    assert.equal(rows[0].day, '2026-08-28', 'today is kept')
  })
})

describe('the scout endpoint', () => {
  test('a hunt the rules can read costs nothing', async () => {
    // The important one. Most hunts are formulaic and never reach a model, so
    // charging them would lock somebody out of the AI over three hundred
    // requests that cost nothing.
    const { createServer } = await import('../server/index.js')
    const { useTempData } = await import('./helpers.js')
    const temp = useTempData()
    const app = await createServer({
      DATA_DIR: temp.directory,
      DB_FILE: `${temp.directory}/scout.db`,
      AI_DAILY_SCOUT: '1',
    })
    const call = async (prompt) => {
      const response = await app.fetch(
        new Request('http://localhost/api/gis/scout', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt, assetTypes: ['Land', 'Commercial'] }),
        }),
      )
      return { status: response.status, body: await response.json() }
    }

    // A phrasing the rule parser handles, run well past the cap of one.
    for (let i = 0; i < 4; i += 1) {
      const answer = await call('vacant land over 5 acres under $2M')
      assert.equal(answer.status, 200, 'a rule-parsed hunt is never refused')
      assert.equal(answer.body.source, 'rules')
    }
    temp.cleanup()
  })
})
