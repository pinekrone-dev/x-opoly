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

/*
 * Parcel rows a workspace may be served in a day.
 *
 * The other half of keeping the county data from being carried off whole. A
 * person working a market reads a few pages, opens a few dozen cards and
 * exports a list or two; a script pages the search to the end of the county.
 * Counting rows served per workspace per day (not requests per address, which
 * a script holds itself under) is what tells the two apart. Fifty thousand
 * is ten full exports; Los Angeles alone is two and a half million.
 */
export const DEFAULT_ROW_BUDGET = 50000

export function rowBudget(env = {}) {
  const n = Number(env.PARCEL_ROW_BUDGET)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_ROW_BUDGET
}

/**
 * Adds `amount` rows to the workspace's count for today and says whether it
 * is still within the day's allowance. One statement: the counter is bumped
 * and read back together.
 */
export async function spendRows(db, { teamId, amount, env, now = Date.now() }) {
  const cap = rowBudget(env)
  if (!teamId || !(amount > 0)) return { allowed: true, cap, used: 0 }
  return metered(db, { key: teamId, kind: 'rows', amount, cap, now })
}

/**
 * A durable daily counter for anything: rows served to an address, whole
 * county files to an account. Kept in ai_usage beside the AI and row
 * budgets, keyed by whatever `key` names ("ip:203.0.113.4", a team id), so
 * a limit holds across every isolate and data centre rather than per
 * isolate the way the burst limiter does.
 */
export async function spendCount(db, { key, kind, amount = 1, cap, now = Date.now() }) {
  if (!key || !(amount > 0) || !(cap > 0)) return { allowed: true, cap, used: 0 }
  return metered(db, { key: String(key), kind, amount, cap, now })
}

/*
 * The counters, written in batches.
 *
 * Every search used to write its counters straight away: the workspace's
 * rows, the address's rows, and for a filtered search the rows it read,
 * three times over. Five database writes for one look at the map, which is
 * more than the search itself costs, and writes are what the database bills
 * for. So each isolate keeps a running tally and writes it every minute, or
 * every twentieth of the allowance, whichever comes first; it reads the
 * stored count once a minute to see what other isolates have added.
 *
 * Two places still write every time. Near an allowance, where isolates have
 * to agree on the count for the refusal to land where it should; and for
 * small allowances (three signups an address, a dozen county files), where
 * a minute's slack would be most of the limit. An isolate recycled with a
 * tally unwritten loses at most a minute or a twentieth of an allowance,
 * which is the price of not paying a write per click.
 */
const TALLY_MS = 60 * 1000
const tallies = new WeakMap()

function tallyFor(db) {
  let held = tallies.get(db)
  if (!held) {
    held = new Map()
    tallies.set(db, held)
  }
  return held
}

async function addStored(db, key, day, kind, amount) {
  const row = await db.get(
    `INSERT INTO ai_usage (team_id, day, kind, count) VALUES (?, ?, ?, ?)
     ON CONFLICT(team_id, day, kind) DO UPDATE SET count = count + excluded.count
     RETURNING count`,
    [key, day, kind, Math.ceil(amount)],
  )
  return Number(row?.count ?? amount)
}

async function metered(db, { key, kind, amount, cap, now }) {
  const day = today(now)
  const verdict = (used) => {
    if (used <= cap) return { allowed: true, cap, used }
    const resets = Math.ceil((new Date(day).getTime() + DAY_MS - now) / 1000)
    return { allowed: false, cap, used, retryAfterSeconds: Math.max(60, resets) }
  }
  const held = tallyFor(db)
  if (held.size > 20000) held.clear()
  const id = `${key}|${day}|${kind}`
  let entry = held.get(id)
  if (cap < 1000) {
    // Written every time, with anything this isolate was still holding.
    const used = await addStored(db, key, day, kind, amount + (entry?.pending ?? 0))
    held.set(id, { stored: used, pending: 0, readAt: now, writtenAt: now })
    return verdict(used)
  }
  if (!entry || now - entry.readAt > TALLY_MS) {
    const row = await db.get('SELECT count FROM ai_usage WHERE team_id = ? AND day = ? AND kind = ?', [key, day, kind])
    entry = { stored: Number(row?.count ?? 0), pending: entry?.pending ?? 0, readAt: now, writtenAt: entry?.writtenAt ?? now }
    held.set(id, entry)
  }
  const after = entry.stored + entry.pending + amount
  const near = after > cap * 0.8
  entry.pending += amount
  if (near || entry.pending >= cap / 20 || now - entry.writtenAt > TALLY_MS) {
    entry.stored = await addStored(db, key, day, kind, entry.pending)
    entry.pending = 0
    entry.readAt = now
    entry.writtenAt = now
  }
  return verdict(entry.stored + entry.pending)
}

/** Whether a counter is already past its cap, without adding to it: a read. */
export async function overCount(db, { key, kind, cap, now = Date.now() }) {
  if (!key || !(cap > 0)) return false
  const day = today(now)
  const entry = tallyFor(db).get(`${key}|${day}|${kind}`)
  if (entry && now - entry.readAt <= TALLY_MS) return entry.stored + entry.pending > cap
  const row = await db.get('SELECT count FROM ai_usage WHERE team_id = ? AND day = ? AND kind = ?', [String(key), day, kind])
  return Number(row?.count ?? 0) > cap
}

/** The scraping limits, each overridable by an env var of the same name. */
export const SCRAPE_LIMITS = {
  // Whole county files (index, details, the full archive) per account per
  // day. A broker opens a market once a session; a county is two files.
  COUNTY_FILES_PER_ACCOUNT: 12,
  // And in any one hour, so a day's allowance is not spent in a minute.
  COUNTY_FILES_PER_HOUR: 6,
  // And per network address, which is what makes a stack of free accounts
  // on one machine no faster than one.
  COUNTY_FILES_PER_ADDRESS: 30,
  // Parcel records served per address per day, across every workspace
  // signed in from it. An office on one NAT is several workspaces' worth.
  ROWS_PER_ADDRESS: 150000,
  // New accounts per address per day.
  SIGNUPS_PER_ADDRESS: 3,
  /*
   * Parcel rows a filtered search reads, per day: what D1 bills by. The
   * plan includes 25 billion a month and charges $0.001 a million after,
   * so the site's ceiling holds a month to about 60 billion even if every
   * day were spent — some $35 over at the very worst. An account's is
   * about two hundred filtered searches in Los Angeles, the largest county.
   */
  SCAN_ROWS_PER_ACCOUNT: 1_000_000_000,
  SCAN_ROWS_PER_ADDRESS: 2_000_000_000,
  SCAN_ROWS_PER_DAY: 2_000_000_000,
}

export function scrapeLimit(env = {}, name) {
  const n = Number(env[name])
  return Number.isFinite(n) && n > 0 ? n : SCRAPE_LIMITS[name]
}
