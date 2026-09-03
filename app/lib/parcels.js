/**
 * The parcel search store.
 *
 * A county is too big to hand a browser. Austin's attribute index is 18.7 MB
 * compressed across 373,541 parcels, Harris holds 1,449,401, and every one of
 * them was downloaded, parsed and turned into a JavaScript object before the
 * first filter could run. That download is what people saw as "the map isn't
 * loading" — the map was fine, the county was still arriving.
 *
 * So the county lives here instead, as rows, and the browser asks questions.
 * The answers are small: a page of parcels, the ids to highlight, and the
 * totals underneath them.
 *
 * Two design notes worth keeping:
 *
 *   The well-known columns are the ones anyone filters on — value, acreage,
 *   asset type, owner, and the text people actually type. Everything else a
 *   county publishes rides along in `rest` as JSON, because the catalog is
 *   allowed to know things this file does not, and a market with an extra
 *   column should not need a migration.
 *
 *   This is deliberately not the CRM's database. Parcels outnumber every other
 *   row in the product by four orders of magnitude, and a table that large
 *   sharing a database with the surveys would make every migration slower and
 *   every backup heavier. When the separate binding is absent — the local rig,
 *   the tests — the same tables simply live alongside, which is harmless at
 *   local scale and keeps development to one file.
 */

/** The searchable shape. Wide enough to filter, narrow enough to index. */
export const PARCEL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS parcels (
    market TEXT NOT NULL,
    pid    TEXT NOT NULL,
    ad     TEXT,
    ow     TEXT,
    gid    TEXT,
    at     TEXT,
    sc     TEXT,
    mv     INTEGER,
    ac     REAL,
    po     TEXT,
    bo     TEXT,
    w      REAL,
    s      REAL,
    e      REAL,
    n      REAL,
    hay    TEXT,
    rest   TEXT,
    h      TEXT,
    PRIMARY KEY (market, pid)
  )`,
  // A market's own summary: the counts and breaks the panel used to derive by
  // walking every row. Computed once at ingest, read as one row per market.
  `CREATE TABLE IF NOT EXISTS parcel_markets (
    market     TEXT PRIMARY KEY,
    n          INTEGER NOT NULL DEFAULT 0,
    total      REAL NOT NULL DEFAULT 0,
    acreage    REAL NOT NULL DEFAULT 0,
    keys       TEXT,
    assets     TEXT,
    breaks     TEXT,
    built_at   TEXT
  )`,
  // Every filter starts by naming a market, so every index leads with it.
  'CREATE INDEX IF NOT EXISTS idx_parcels_market_mv ON parcels(market, mv)',
  'CREATE INDEX IF NOT EXISTS idx_parcels_market_ac ON parcels(market, ac)',
  'CREATE INDEX IF NOT EXISTS idx_parcels_market_at ON parcels(market, at)',
  'CREATE INDEX IF NOT EXISTS idx_parcels_market_po ON parcels(market, po)',
  'CREATE INDEX IF NOT EXISTS idx_parcels_market_bo ON parcels(market, bo)',
]

/** The columns held in their own field rather than folded into `rest`. */
export const PARCEL_COLUMNS = ['ad', 'ow', 'gid', 'at', 'sc', 'mv', 'ac', 'po', 'bo']

const INSERT_COLUMNS = [
  'market', 'pid', 'ad', 'ow', 'gid', 'at', 'sc', 'mv', 'ac', 'po', 'bo',
  'w', 's', 'e', 'n', 'hay', 'rest', 'h',
]

/*
 * How many rows ride in one INSERT.
 *
 * Not bounded by the parameter limit any more, and that is the point. The
 * first version sent one placeholder per column per row — fifty rows was 850
 * bindings, which I reasoned was "comfortably inside" SQLite's 999. D1's limit
 * is 100, not 999, and every publish failed with "too many SQL variables".
 *
 * Tuning the number down to five rows would have obeyed the limit and made
 * Austin seventy-five thousand statements. So the rows travel as one JSON
 * parameter instead and SQLite unpacks them with json_each: two bindings per
 * statement regardless of how many rows it carries. What is left to size is
 * the JSON itself, which is bytes rather than an undocumented count, and 250
 * rows lands around 60 KB — well inside the 100 KB a statement may be.
 */
const ROWS_PER_STATEMENT = 250

/*
 * How much serialized JSON one statement carries, and one batch.
 *
 * Rows are not all the same size — a county of bare land parcels and a county
 * of long owner names differ by several times per row — so a fixed row count
 * is only a guess at how big a request gets. These are the real ceilings, and
 * they are measured rather than assumed: rows are accumulated until the next
 * one would cross the limit. ROWS_PER_STATEMENT stays as an upper bound so a
 * market of very small rows does not build one enormous statement.
 */
const JSON_BYTES_PER_STATEMENT = 40_000
const JSON_BYTES_PER_BATCH = 250_000

/** Statements per batch. D1 commits a batch as one transaction. */
const STATEMENTS_PER_BATCH = 10

/*
 * The most ids one search will hand back for the map to highlight.
 *
 * A filter matching a quarter of a county is not a filter anyone can read, and
 * the list itself becomes the download this whole change exists to avoid. Past
 * this the answer is honest rather than complete: the totals still describe
 * every match, and the response says the highlight was cut short.
 */
export const MAX_HIGHLIGHT_IDS = 25000

/** Rows returned in one page of the list. */
export const PAGE_SIZE = 200

let ensured = new WeakSet()

/**
 * Create the tables if they are missing.
 *
 * Cheap and idempotent, so it can guard any entry point rather than living in
 * a migration the parcel database would otherwise need on its own. Remembered
 * per adapter so the common path costs nothing.
 */
/*
 * Columns added after the table first shipped.
 *
 * `h` is the content hash of the row as the publisher sent it, and it is the
 * whole of what makes an incremental publish possible: the publisher reads
 * these back, compares, and sends only what actually changed. A database that
 * predates it answers NULL for every parcel, which reads as "changed" and
 * costs one baseline pass — correct, and self-correcting after that.
 */
const PARCEL_ADDED_COLUMNS = [['parcels', 'h', 'TEXT']]

export async function ensureParcelSchema(db) {
  if (ensured.has(db)) return
  for (const statement of PARCEL_SCHEMA) await db.run(statement)
  for (const [table, column, type] of PARCEL_ADDED_COLUMNS) {
    try {
      await db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
    } catch (cause) {
      // Already there. SQLite says so by message rather than by code, and
      // there is nothing else this statement can fail on that a later query
      // would not fail on more clearly.
      if (!/duplicate column/i.test(String(cause?.message ?? cause))) throw cause
    }
  }
  ensured.add(db)
}

/** Only for tests, which build and discard databases within one process. */
export function forgetParcelSchema() {
  ensured = new WeakSet()
}

const text = (v) => (v == null ? null : String(v))
const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * One published parcel, as the row that will be stored.
 *
 * `hay` is the haystack the text box searches: address, owner, the county's
 * own parcel number and ours, lowercased once here so no query has to do it
 * per row. It is the same four fields the browser used to concatenate on
 * every keystroke.
 */
export function parcelRow(market, raw) {
  const pid = text(raw.id)
  if (pid == null || pid === '') return null
  const rest = {}
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'id' || key === 'bb' || key === 'h') continue
    if (PARCEL_COLUMNS.includes(key)) continue
    rest[key] = value
  }
  const bb = Array.isArray(raw.bb) && raw.bb.length === 4 ? raw.bb.map(num) : [null, null, null, null]
  const hay = [raw.ad, raw.ow, raw.gid, pid]
    .map((part) => (part == null ? '' : String(part)))
    .join(' ')
    .toLowerCase()
    .trim()
  return [
    market,
    pid,
    text(raw.ad),
    text(raw.ow),
    text(raw.gid),
    text(raw.at),
    text(raw.sc),
    num(raw.mv) ?? 0,
    num(raw.ac) ?? 0,
    text(raw.po),
    text(raw.bo),
    bb[0], bb[1], bb[2], bb[3],
    hay,
    Object.keys(rest).length ? JSON.stringify(rest) : null,
    text(raw.h),
  ]
}

/*
 * Rows removed per statement, and per request.
 *
 * One `DELETE FROM parcels WHERE market = ?` is the obvious way to do this
 * and it does not survive a county. Orange County's rebuild had to remove
 * 971,160 rows, each carrying five secondary indexes, and D1 answered
 * "exceeded its CPU time limit and was reset" — three times, because the
 * retry re-sent exactly the same impossible statement.
 *
 * So the work is bounded twice: a statement deletes at most CLEAR_CHUNK
 * rows, and a request spends at most CLEAR_BUDGET before handing control
 * back. The caller repeats until it is told the market is empty, which
 * makes clearing a county a sequence of small, resumable steps instead of
 * one that no amount of retrying can complete.
 */
export const CLEAR_CHUNK = 2000
export const CLEAR_BUDGET = 50_000

/**
 * Drop part of what a market published, up to a budget.
 *
 * Returns how many rows went and whether the market is now empty. The seal
 * is dropped only on the pass that empties it, so a market half-cleared by
 * an interrupted run still reads as unsealed rather than as a market with
 * half a county in it.
 */
export async function clearMarket(db, market, budget = CLEAR_BUDGET) {
  await ensureParcelSchema(db)
  let removed = 0
  while (removed < budget) {
    const result = await db.run(
      'DELETE FROM parcels WHERE rowid IN ' +
        '(SELECT rowid FROM parcels WHERE market = ? LIMIT ?)',
      [market, CLEAR_CHUNK],
    )
    const gone = Number(result?.changes ?? 0)
    removed += gone
    // A short pass means the market held fewer rows than the chunk asked
    // for, which is how the end is recognised without a second count query.
    if (gone < CLEAR_CHUNK) {
      await db.run('DELETE FROM parcel_markets WHERE market = ?', [market])
      return { removed, done: true }
    }
  }
  return { removed, done: false }
}

/*
 * Rows of the hash list returned in one page.
 *
 * The list is what a publisher reads before it writes anything: a pid and a
 * sixteen-character hash for every parcel in the market, so it can work out
 * which rows actually changed. Orange County is nine hundred thousand of
 * them, so it pages — twenty thousand at a time is about eight hundred
 * kilobytes of JSON, small enough for a Worker response and few enough
 * requests that a county reads back in under a minute.
 *
 * The cursor is the pid itself rather than an offset. The primary key is
 * (market, pid), so `pid > ?` is an index seek and every page costs the same;
 * an OFFSET would make the last page of a county scan the whole county.
 */
export const HASH_PAGE = 20_000

/**
 * What this market currently holds, as pid and content hash.
 *
 * Reads, not writes. D1 includes twenty-five billion row reads a month and
 * fifty million row writes, so a publisher that reads a county to avoid
 * rewriting it is trading the scarce resource for the abundant one at a
 * ratio of five hundred to one.
 *
 * A row stored before the hash column existed answers null, which the
 * publisher reads as "changed" — one baseline pass, then cheap forever.
 */
export async function listHashes(db, market, { after = '', limit = HASH_PAGE } = {}) {
  await ensureParcelSchema(db)
  const page = Math.min(Math.max(Number(limit) || HASH_PAGE, 1), HASH_PAGE)
  const rows = await db.all(
    'SELECT pid, h FROM parcels WHERE market = ? AND pid > ? ORDER BY pid LIMIT ?',
    [market, String(after ?? ''), page],
  )
  return {
    hashes: rows.map((row) => [row.pid, row.h ?? null]),
    // The last pid of a full page is where the next one resumes. A short page
    // is the end of the market, and says so by returning no cursor.
    cursor: rows.length === page ? rows[rows.length - 1].pid : null,
  }
}

/*
 * Parcels removed per statement.
 *
 * Same reasoning as CLEAR_CHUNK, at a smaller scale: a county that has been
 * resurveyed drops a few thousand parcels, not a million, and the publisher
 * sends them in one call. Chunking keeps a bad day — a source that suddenly
 * omits half its rows — from being a statement D1 cannot finish.
 */
export const DROP_CHUNK = 500

/**
 * Remove parcels the source no longer carries.
 *
 * The other half of an incremental publish: without it a parcel that a county
 * splits or retires would sit in the market forever, since nothing sends a
 * row to say it is gone.
 */
export async function dropParcels(db, market, pids) {
  await ensureParcelSchema(db)
  const wanted = [...new Set((pids ?? []).map((pid) => String(pid)).filter(Boolean))]
  if (!wanted.length) return 0
  let removed = 0
  for (let i = 0; i < wanted.length; i += DROP_CHUNK) {
    const chunk = wanted.slice(i, i + DROP_CHUNK)
    // json_each again rather than a list of placeholders: D1 binds at most a
    // hundred parameters to a statement, and a drop list is not bounded by a
    // hundred.
    const result = await db.run(
      'DELETE FROM parcels WHERE market = ? AND pid IN (SELECT value FROM json_each(?))',
      [market, JSON.stringify(chunk)],
    )
    removed += Number(result?.changes ?? 0)
  }
  return removed
}

/**
 * Store a chunk of a market's parcels.
 *
 * Written as multi-row INSERTs inside a batch because the alternative — one
 * statement per parcel — turns a county into a million round trips. A rebuild
 * re-sends rows it has already sent when a run is retried, so the insert
 * replaces rather than conflicts.
 */
export async function putParcels(db, market, raws) {
  await ensureParcelSchema(db)
  const rows = raws.map((raw) => parcelRow(market, raw)).filter(Boolean)
  if (!rows.length) return 0

  /*
   * One statement, two bindings, any number of rows.
   *
   * `market` is the same for every row in the call, so it binds once; the rest
   * arrive as a JSON array of arrays and json_each walks it. The column list
   * and the json_extract list are generated from the same array, so they
   * cannot drift apart — which matters, because a silent off-by-one here would
   * file every owner name under the wrong column and nothing would complain.
   */
  const rest = INSERT_COLUMNS.slice(1)
  const extracts = rest.map((_, at) => `json_extract(value,'$[${at}]')`).join(',')
  /*
   * Upsert, not INSERT OR REPLACE.
   *
   * REPLACE resolves a conflict by deleting the existing row and inserting a
   * new one, and D1 bills a delete exactly like a write — so re-storing a
   * parcel cost twice what storing it did, across the table and all six of its
   * indexes. ON CONFLICT DO UPDATE writes the row in place, and only touches
   * an index whose column actually moved.
   *
   * `pid` is excluded from the SET list because it is half the key being
   * conflicted on; assigning it to itself is legal but pointless.
   *
   * The `WHERE true` is not filler. SQLite cannot tell whether the `ON` after
   * a SELECT opens the upsert or a join's ON clause, and documents a trailing
   * WHERE as the way to disambiguate. Without it the parser fails on `DO`.
   */
  const updates = rest
    .filter((column) => column !== 'pid')
    .map((column) => `${column}=excluded.${column}`)
    .join(',')
  const sql =
    `INSERT INTO parcels (${INSERT_COLUMNS.join(',')}) ` +
    `SELECT ?1,${extracts} FROM json_each(?2) WHERE true ` +
    `ON CONFLICT(market,pid) DO UPDATE SET ${updates}`

  // Each row as its own JSON fragment, so a statement can be filled to a byte
  // budget instead of a row count.
  const parts = rows.map((row) => JSON.stringify(row.slice(1)))

  const statements = []
  for (let i = 0; i < parts.length; ) {
    let bytes = 2                                   // the enclosing brackets
    let end = i
    while (end < parts.length && end - i < ROWS_PER_STATEMENT) {
      const next = parts[end].length + (end > i ? 1 : 0)
      if (end > i && bytes + next > JSON_BYTES_PER_STATEMENT) break
      bytes += next
      end += 1
    }
    statements.push({ bytes, call: [sql, [market, `[${parts.slice(i, end).join(',')}]`]] })
    i = end
  }

  // And batches filled the same way, since a batch is one request carrying all
  // of its statements' parameters.
  let batch = []
  let bytes = 0
  for (const statement of statements) {
    if (batch.length && (batch.length >= STATEMENTS_PER_BATCH ||
        bytes + statement.bytes > JSON_BYTES_PER_BATCH)) {
      await db.batch(batch)
      batch = []
      bytes = 0
    }
    batch.push(statement.call)
    bytes += statement.bytes
  }
  if (batch.length) await db.batch(batch)
  return rows.length
}

/**
 * Record what a market adds up to, once its rows are all in.
 *
 * These are the numbers the panel used to derive by walking the whole index in
 * the browser: how many parcels, what they are worth, how the asset types
 * divide, and the value breaks the choropleth shades by. Computing them here
 * means opening a market costs one small read instead of a county.
 */
/*
 * A lot's acreage, counted once however many assessments sit on it.
 *
 * Orange County publishes legal lots: 971,160 assessment records on 693,441
 * distinct outlines, because a condominium's units and any lot split between
 * several APNs each carry the whole lot's boundary. A plain SUM(ac) therefore
 * added the shared lots once per record and made the county 2,153,800 acres —
 * inside a real one of 606,707. Dividing by how many assessments share the
 * outline contributes each lot exactly once, which comes back to 417,973.
 *
 * `sh` rides in the rest blob and is absent on the ordinary case, so this
 * reads as 1 for every market whose parcels each own their geometry. MAX
 * guards a zero from ever becoming a division.
 */
const ACRES_PER_LOT = "ac / MAX(COALESCE(json_extract(rest,'$.sh'), 1), 1)"

export async function sealMarket(db, market, { keys = [], builtAt = null } = {}) {
  await ensureParcelSchema(db)
  const totals = await db.get(
    'SELECT COUNT(*) AS n, COALESCE(SUM(mv),0) AS total, ' +
      `COALESCE(SUM(${ACRES_PER_LOT}),0) AS acreage FROM parcels WHERE market = ?`,
    [market],
  )
  const assets = await db.all(
    `SELECT COALESCE(NULLIF(TRIM(at),''), '') AS value, COUNT(*) AS count
       FROM parcels WHERE market = ? GROUP BY value ORDER BY count DESC`,
    [market],
  )
  const named = assets.filter((row) => row.value !== '')

  // Quintile breaks, read off the sorted values rather than computed from the
  // mean: assessed value is a long tail, and an even split of the range would
  // put four fifths of a county in the first bucket.
  const n = Number(totals?.n ?? 0)
  const breaks = []
  if (n > 0) {
    for (const q of [0.2, 0.4, 0.6, 0.8]) {
      const at = Math.min(n - 1, Math.max(0, Math.floor(n * q)))
      const row = await db.get(
        'SELECT mv FROM parcels WHERE market = ? ORDER BY mv ASC LIMIT 1 OFFSET ?',
        [market, at],
      )
      breaks.push(Number(row?.mv ?? 0))
    }
  }

  await db.run(
    `INSERT OR REPLACE INTO parcel_markets (market, n, total, acreage, keys, assets, breaks, built_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      market,
      n,
      Number(totals?.total ?? 0),
      Number(totals?.acreage ?? 0),
      JSON.stringify(keys),
      JSON.stringify(named),
      JSON.stringify(breaks),
      builtAt || new Date().toISOString(),
    ],
  )
  return { n, total: Number(totals?.total ?? 0), acreage: Number(totals?.acreage ?? 0) }
}

/**
 * What a market says about itself, or null when it has published nothing here.
 *
 * The null is load-bearing: it is how the app knows to fall back to the old
 * whole-index download for a market whose rebuild has not run yet.
 */
export async function marketSummary(db, market) {
  await ensureParcelSchema(db)
  const row = await db.get('SELECT * FROM parcel_markets WHERE market = ?', [market])
  if (!row || Number(row.n) === 0) return null
  const parse = (value, fallback) => {
    try {
      return JSON.parse(value) ?? fallback
    } catch {
      return fallback
    }
  }
  return {
    market,
    count: Number(row.n),
    total: Number(row.total),
    acreage: Number(row.acreage),
    keys: parse(row.keys, []),
    assets: parse(row.assets, []),
    breaks: parse(row.breaks, []),
    builtAt: row.built_at || null,
  }
}

/** Turn a stored row back into the flat parcel the panel reads. */
export function hydrate(row) {
  const out = { id: row.pid }
  for (const key of PARCEL_COLUMNS) out[key] = row[key] ?? null
  if (row.rest) {
    try {
      Object.assign(out, JSON.parse(row.rest))
    } catch {
      /* a row that cannot be parsed still has its own columns */
    }
  }
  out.bb = [row.w, row.s, row.e, row.n].every((v) => v == null)
    ? null
    : [row.w, row.s, row.e, row.n]
  return out
}

/**
 * Build the WHERE clause shared by every part of one search.
 *
 * The page, the highlight ids and the totals all have to describe the same set
 * — a report that disagrees with the map it sits beside is worse than no
 * report — so they are three readings of this one predicate rather than three
 * queries that happen to look alike.
 */
function where(market, filters = {}) {
  const clauses = ['market = ?']
  const params = [market]

  const assets = (filters.assets || []).filter((a) => a !== '')
  if (assets.length) {
    clauses.push(`at IN (${assets.map(() => '?').join(',')})`)
    params.push(...assets)
  }
  const range = (column, min, max) => {
    if (min != null && Number.isFinite(min)) {
      clauses.push(`${column} >= ?`)
      params.push(min)
    }
    if (max != null && Number.isFinite(max)) {
      clauses.push(`${column} <= ?`)
      params.push(max)
    }
  }
  range('mv', filters.valueMin, filters.valueMax)
  range('ac', filters.acresMin, filters.acresMax)

  if (filters.owner && filters.owner.id) {
    clauses.push(filters.owner.kind === 'b' ? 'bo = ?' : 'po = ?')
    params.push(String(filters.owner.id))
  }
  const q = (filters.query || '').trim().toLowerCase()
  if (q) {
    // Escaped so a broker searching for a literal % or _ finds that, rather
    // than matching the whole county.
    clauses.push("hay LIKE ? ESCAPE '\\'")
    params.push(`%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`)
  }
  return { sql: clauses.join(' AND '), params }
}

/** Whether any filter is actually set, as opposed to an empty form. */
export function filtersActive(filters = {}) {
  if ((filters.query || '').trim()) return true
  if ((filters.assets || []).filter((a) => a !== '').length) return true
  if (filters.owner && filters.owner.id) return true
  return [filters.valueMin, filters.valueMax, filters.acresMin, filters.acresMax].some(
    (v) => v != null && Number.isFinite(v),
  )
}

/**
 * Run one search.
 *
 * Returns a page of parcels for the list, the ids the map should highlight,
 * and what the whole matching set adds up to — the three things the panel
 * needs, from one predicate, in one round trip from the browser's side.
 */
export async function searchParcels(db, market, filters = {}, { limit = PAGE_SIZE, offset = 0 } = {}) {
  await ensureParcelSchema(db)
  const { sql, params } = where(market, filters)
  const page = Math.min(Math.max(Number(limit) || PAGE_SIZE, 1), 1000)
  const from = Math.max(Number(offset) || 0, 0)

  const totals = await db.get(
    `SELECT COUNT(*) AS n, COALESCE(SUM(mv),0) AS total, COALESCE(SUM(${ACRES_PER_LOT}),0) AS acreage
       FROM parcels WHERE ${sql}`,
    params,
  )
  const count = Number(totals?.n ?? 0)

  const byAsset = await db.all(
    `SELECT COALESCE(NULLIF(TRIM(at),''), 'Unclassified') AS value, COUNT(*) AS count
       FROM parcels WHERE ${sql} GROUP BY value ORDER BY count DESC`,
    params,
  )

  const rows = await db.all(
    `SELECT pid, ad, ow, gid, at, sc, mv, ac, po, bo, w, s, e, n, rest
       FROM parcels WHERE ${sql} ORDER BY mv DESC LIMIT ? OFFSET ?`,
    [...params, page, from],
  )

  // The highlight list is only fetched when a filter is actually set. With no
  // filter the map draws every parcel anyway, and shipping a county's worth of
  // ids to say "all of them" would rebuild the problem this replaced.
  let ids = null
  let truncated = false
  if (filtersActive(filters)) {
    const held = await db.all(
      `SELECT pid FROM parcels WHERE ${sql} ORDER BY mv DESC LIMIT ?`,
      [...params, MAX_HIGHLIGHT_IDS + 1],
    )
    truncated = held.length > MAX_HIGHLIGHT_IDS
    ids = held.slice(0, MAX_HIGHLIGHT_IDS).map((row) => row.pid)
  }

  return {
    count,
    total: Number(totals?.total ?? 0),
    acreage: Number(totals?.acreage ?? 0),
    byAsset: byAsset.map((row) => [row.value, Number(row.count)]),
    rows: rows.map(hydrate),
    ids,
    truncated,
    offset: from,
    limit: page,
  }
}

/** One parcel, for the card. Null when this market does not publish it. */
export async function getParcel(db, market, id) {
  await ensureParcelSchema(db)
  const row = await db.get(
    `SELECT pid, ad, ow, gid, at, sc, mv, ac, po, bo, w, s, e, n, rest
       FROM parcels WHERE market = ? AND pid = ?`,
    [market, String(id)],
  )
  return row ? hydrate(row) : null
}

/** Every market that has rows here, so the app knows which can skip the download. */
export async function readyMarkets(db) {
  await ensureParcelSchema(db)
  const rows = await db.all('SELECT market FROM parcel_markets WHERE n > 0 ORDER BY market')
  return rows.map((row) => row.market)
}
