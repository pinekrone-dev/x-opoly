/**
 * What a workspace may spend on the AI in a day.
 *
 * The sliding-window limiter beside this one stops a burst, and that is a
 * different problem from this one. A script held just under a burst limit —
 * a hundred and twenty calls every ten minutes — runs seventeen thousand
 * model calls a day and never trips it once. Cost is a daily quantity, so it
 * needs a daily counter.
 *
 * Two things follow from that, and both are departures from how the burst
 * limiter works.
 *
 * It counts per workspace rather than per address. An address is the wrong
 * unit for a paid product in both directions: a brokerage behind one office
 * NAT shares a single bucket, so one colleague's afternoon throttles
 * everybody; and one person with a laptop and a phone gets two buckets, so
 * the limit does not bind on the case it was written for. The workspace is
 * who is billed, so the workspace is what has a budget.
 *
 * And it lives in the database rather than in memory. Worker isolates recycle
 * often — that is the point of them — so an in-memory daily counter resets
 * several times a day and a daily cap enforced that way is decorative.
 *
 * None of this is a security boundary. It is a cost control, and it is worth
 * being clear about what it does not do: the parcel catalog is published as
 * static files and is public by design, so nothing here makes county data
 * harder to obtain. It makes somebody else's model bill harder to run up.
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** How long a day's counters are kept before being swept. */
const KEEP_DAYS = 8

/**
 * The default budgets, per workspace per day.
 *
 * Set against what a person actually does rather than what a machine could:
 * a broker working a market hard might run a few dozen hunts and read a
 * handful of flyers in a day. These sit well above that and far below what a
 * script would want.
 */
export const DEFAULT_BUDGETS = {
  // Translating a sentence into filters. Cheap per call, and the one a
  // curious person clicks most.
  scout: 300,
  // Reading a flyer or a pasted listing. A much heavier call.
  read: 150,
}

function today(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10)
}

/** The configured cap for a kind, or its default. Env wins so it can be tuned. */
export function budgetFor(env, kind) {
  const named = kind === 'scout' ? env?.AI_DAILY_SCOUT : env?.AI_DAILY_READ
  const parsed = Number(named)
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed)
  return DEFAULT_BUDGETS[kind] ?? DEFAULT_BUDGETS.read
}

/**
 * Records one AI call and says whether it was within budget.
 *
 * The call is counted before it is judged, deliberately. A refused attempt is
 * still an attempt somebody made, and a counter that only records the allowed
 * ones tells you nothing about what was tried — which is exactly what you
 * want to see when deciding whether a cap is set right.
 */
export async function spend(db, { teamId, kind, env, now = Date.now() }) {
  const cap = budgetFor(env, kind)
  // Signed out, there is no workspace to bill and the burst limiter is doing
  // the work. Counting by address here would recreate the shared-NAT problem
  // this module exists to avoid.
  if (!teamId) return { allowed: true, cap, used: 0, remaining: cap }

  const day = today(now)
  await db.run(
    `INSERT INTO ai_usage (team_id, day, kind, count) VALUES (?, ?, ?, 1)
     ON CONFLICT(team_id, day, kind) DO UPDATE SET count = count + 1`,
    [teamId, day, kind],
  )
  const row = await db.get(
    'SELECT count FROM ai_usage WHERE team_id = ? AND day = ? AND kind = ?',
    [teamId, day, kind],
  )
  const used = Number(row?.count ?? 1)

  if (used > cap) {
    // Midnight UTC, which is when the day string rolls over. Told to the
    // caller in seconds so the answer can carry a Retry-After a client can
    // act on rather than a shrug.
    const resets = Math.ceil((new Date(day).getTime() + DAY_MS - now) / 1000)
    return { allowed: false, cap, used, remaining: 0, retryAfterSeconds: Math.max(60, resets) }
  }
  return { allowed: true, cap, used, remaining: cap - used }
}

/**
 * Drops counters for days nobody will ask about again.
 *
 * Called opportunistically rather than on a schedule: this app has no cron,
 * and a table that grows by one row per workspace per kind per day is not
 * urgent, but it should not grow forever either.
 */
export async function sweepUsage(db, { now = Date.now() } = {}) {
  const cutoff = today(now - KEEP_DAYS * DAY_MS)
  await db.run('DELETE FROM ai_usage WHERE day < ?', [cutoff])
}

/** What a workspace has spent today, for showing someone their own budget. */
export async function usageToday(db, teamId, env, { now = Date.now() } = {}) {
  if (!teamId) return null
  const rows = await db.all(
    'SELECT kind, count FROM ai_usage WHERE team_id = ? AND day = ?',
    [teamId, today(now)],
  )
  const used = Object.fromEntries(rows.map((row) => [row.kind, Number(row.count)]))
  return {
    scout: { used: used.scout ?? 0, cap: budgetFor(env, 'scout') },
    read: { used: used.read ?? 0, cap: budgetFor(env, 'read') },
  }
}
