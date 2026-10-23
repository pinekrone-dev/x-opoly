/**
 * The month's budget for writes into the parcel stores.
 *
 * Cloudflare bills D1 by rows written, and an index entry an insert or an
 * update touches is a written row of its own: loading one parcel costs about
 * ten (the row, five indexes, the text index), tagging one about four. Two
 * days of re-tagging every market once wrote 91 million rows against a cap
 * of 30 million that nothing in the code knew about. This is that cap, in
 * the code, at the one door every pipeline write comes through
 * (/api/gis/ingest/parcels): each request is charged its estimated rows to a
 * ledger kept per calendar month (UTC), and a request that would carry the
 * month past the cap is refused before it writes anything.
 *
 * The estimates lean high on purpose. The ledger cannot see what Cloudflare
 * counts, only what this door sends, so it stops early rather than late.
 * The cap is PARCEL_WRITE_CAP rows a month, 27 million by default: the
 * owner's 30 million less room for the app's own writes (sessions, the CRM).
 */

export const DEFAULT_CAP = 27_000_000

/** Billed rows per item, by what the request does to the store. */
export const ROWS_PER = {
  insert: 10, // a parcel row, five secondary indexes, the text index
  drop: 8, // the same entries, deleted
  tag: 4, // a tag column and the indexes it touches
  reindex: 3, // the text index's entries for one parcel
}

// The ledger table lives in schema.js, created with the rest.

export const monthOf = (now = Date.now()) => new Date(now).toISOString().slice(0, 7)

export function capOf(env = {}) {
  const n = Number(env.PARCEL_WRITE_CAP)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CAP
}

/** Rows charged so far this month. */
export async function spent(db, month = monthOf()) {
  const row = await db.get('SELECT rows FROM parcel_write_ledger WHERE month = ?', [month])
  return Number(row?.rows ?? 0)
}

/** Adds what a request wrote. One small upsert: the ledger costs a row per request. */
export async function charge(db, rows, month = monthOf()) {
  const n = Math.max(0, Math.ceil(Number(rows) || 0))
  if (!n) return
  await db.run(
    `INSERT INTO parcel_write_ledger (month, rows, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(month) DO UPDATE SET rows = rows + excluded.rows, updated_at = excluded.updated_at`,
    [month, n, new Date().toISOString()],
  )
}

/**
 * Rows already spent in a month before the ledger existed, from
 * PARCEL_WRITES_SPENT ("2026-10=27000000,2026-11=0"). The ledger only sees
 * what passes this door from the day it was deployed; a month that was
 * already spent elsewhere is declared here so the door knows.
 */
export function declaredSpent(env = {}, month = monthOf()) {
  for (const pair of String(env.PARCEL_WRITES_SPENT ?? '').split(',')) {
    const [key, value] = pair.split('=').map((part) => part.trim())
    const n = Number(value)
    if (key === month && Number.isFinite(n) && n > 0) return n
  }
  return 0
}

/**
 * Whether `estimate` more rows fit this month. Answers the numbers either way,
 * so a refusal can say exactly where the month stands.
 */
export async function room(db, env, estimate, month = monthOf()) {
  const cap = capOf(env)
  const used = Math.max(await spent(db, month), declaredSpent(env, month))
  return { ok: used + Math.max(0, estimate) <= cap, used, cap, month, estimate }
}
