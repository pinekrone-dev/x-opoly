/**
 * Sale comparables the broker collected themselves.
 *
 * A listing site's compiled database is that site's property, and building a
 * shared one here by scraping theirs is how a small company acquires a large
 * lawsuit. So nothing in this file fetches anything from anywhere. It takes
 * what a broker's own browser already showed them — captured by their own
 * bookmarklet, on pages they were licensed to view — and keeps it in their
 * own workspace, visible to nobody else. One team's comps never become
 * another team's, and no comp ever leaves the team that collected it.
 *
 * That constraint decides the shape: an import endpoint rather than a
 * crawler, `team_id` on every row and every query, and a `source` column so a
 * broker can tell later where a number came from.
 */

import { newId, nowIso } from './ids.js'

/** As many as one import may carry. Beyond this it is a database, not a paste. */
export const MAX_COMPS_PER_IMPORT = 2000

/** How many addresses one geocoding pass will resolve. */
export const PLACE_BATCH = 25

/*
 * The columns, and how to read each one off an imported record.
 *
 * Named for what a broker calls them rather than what the source called them,
 * but every reader accepts both: the bookmarklet writes `propType` and `year`,
 * a CSV export writes `Property Type` and `Year Built`, and a comp is a comp
 * either way.
 */
const NUMBER = (value) => {
  if (value == null || value === '') return null
  // "$4,250,000", "12,500 SF", "6.25%" — the strings a listing page shows.
  const cleaned = String(value).replace(/[^0-9.\-]/g, '')
  if (!cleaned || cleaned === '-' || cleaned === '.') return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

const TEXT = (value) => {
  if (value == null) return null
  const s = String(value).replace(/\s+/g, ' ').trim()
  return s ? s.slice(0, 400) : null
}

const FIELDS = [
  ['address', ['address', 'Address'], TEXT],
  ['name', ['name', 'Name', 'title'], TEXT],
  ['price_str', ['priceStr', 'Price', 'price_str'], TEXT],
  ['price', ['price', 'Price'], NUMBER],
  ['sale_lease', ['saleLease', 'saleOrLease', 'Sale/Lease'], TEXT],
  ['prop_type', ['propType', 'propertyType', 'Property Type'], TEXT],
  ['sqft', ['sqft', 'SF', 'squareFeet'], NUMBER],
  ['acres', ['acres', 'Acres'], NUMBER],
  ['units', ['units', 'Units'], NUMBER],
  ['cap_rate', ['cap', 'capRate', 'Cap Rate'], NUMBER],
  ['year_built', ['year', 'yearBuilt', 'Year Built'], NUMBER],
  ['price_per_sf', ['pps', 'pricePerSf', 'Price/SF'], NUMBER],
  ['price_per_acre', ['ppa', 'pricePerAcre', 'Price/Acre'], NUMBER],
  ['price_per_unit', ['ppu', 'pricePerUnit', 'Price/Unit'], NUMBER],
  ['url', ['url', 'URL', 'link'], TEXT],
  ['source', ['source', 'Source'], TEXT],
  ['scraped_at', ['scrapedAt', 'collectedAt'], TEXT],
]

function readOne(raw) {
  if (!raw || typeof raw !== 'object') return null
  const row = {}
  for (const [column, aliases, read] of FIELDS) {
    let value = null
    for (const alias of aliases) {
      if (raw[alias] != null && raw[alias] !== '') {
        value = read(raw[alias])
        if (value != null) break
      }
    }
    row[column] = value
  }
  // A comp with neither an address nor a name is not a comp — it is a blank
  // placard the page had not finished rendering. Those are dropped and
  // counted rather than stored, because a list padded with empties reads as
  // coverage that is not there.
  if (!row.address && !row.name) return null

  /*
   * The dedupe key. The source's own key when it gave one, because that is
   * stable across re-imports of the same page; otherwise the address, which
   * is what a person would use. Lowercased so a re-import that capitalises
   * differently updates the row rather than doubling it.
   */
  const key = TEXT(raw.key) || row.url || row.address || row.name
  row.source_key = key.toLowerCase().slice(0, 300)
  return row
}

/**
 * Turns whatever was pasted into rows worth storing.
 *
 * Accepts a bare array, or the object shapes a bookmarklet's localStorage
 * dump takes — `{listings: [...]}` and `{loopnetListings_v1: [...]}` — because
 * the broker copying the value out of devtools should not have to know which
 * of those they grabbed.
 */
export function readComps(payload, { source = null } = {}) {
  let list = payload
  if (list && !Array.isArray(list) && typeof list === 'object') {
    list =
      list.listings ??
      list.comps ??
      list.rows ??
      list.loopnetListings_v1 ??
      Object.values(list).find(Array.isArray) ??
      null
  }
  if (!Array.isArray(list)) return { rows: [], read: 0, dropped: 0, error: 'That did not contain a list of listings.' }

  const seen = new Set()
  const rows = []
  let dropped = 0
  for (const raw of list.slice(0, MAX_COMPS_PER_IMPORT)) {
    const row = readOne(raw)
    if (!row) {
      dropped += 1
      continue
    }
    // Within one import too: a page scrolled twice shows the same placard
    // twice, and the second is not a second sale.
    if (seen.has(row.source_key)) continue
    seen.add(row.source_key)
    if (source && !row.source) row.source = source
    rows.push(row)
  }
  return { rows, read: list.length, dropped }
}

/*
 * A delimited export, read into the same records `readComps` takes.
 *
 * This exists because a broker's listings almost never arrive as JSON. They
 * arrive as a CSV out of a spreadsheet, an email attachment, or somebody
 * else's export — and telling a person to convert their file first is telling
 * them not to bother.
 *
 * Quoting is handled properly rather than by splitting on commas, because a
 * listing export is full of addresses like "123 Main St, Suite 400" and a
 * naive split turns every one of those into two broken columns.
 */
export function readDelimited(text) {
  const body = String(text ?? '').replace(/^\uFEFF/, '')
  if (!body.trim()) return []

  // Whichever of the two the header row has more of. A tab-separated export
  // pasted out of a spreadsheet is as common as a comma-separated one.
  const firstLine = body.slice(0, body.indexOf('\n') + 1 || undefined)
  const delimiter = (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? '\t' : ','

  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (quoted) {
      if (ch === '"') {
        // A doubled quote inside a quoted field is one literal quote.
        if (body[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"' && field === '') {
      quoted = true
    } else if (ch === delimiter) {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      // A newline inside quotes was consumed above, so any that reaches here
      // genuinely ends the row. \r\n is one ending, not two.
      if (ch === '\r' && body[i + 1] === '\n') i += 1
      row.push(field)
      field = ''
      rows.push(row)
      row = []
    } else {
      field += ch
    }
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }

  const header = (rows.shift() || []).map((h) => h.replace(/\s+/g, ' ').trim())
  if (!header.length) return []
  const out = []
  for (const cells of rows) {
    // A trailing blank line is not a listing.
    if (!cells.some((cell) => cell.trim())) continue
    const record = {}
    header.forEach((key, at) => {
      if (key) record[key] = cells[at] ?? ''
    })
    out.push(record)
  }
  return out
}

const COLUMNS = FIELDS.map(([column]) => column)

/**
 * Writes an import into a team's comps, updating rows it has seen before.
 *
 * Coordinates are deliberately not touched on update: an address that was
 * geocoded once, or moved by hand, keeps its position when the same listing
 * is imported again with a new price.
 */
export async function saveComps(db, teamId, rows, { market = null } = {}) {
  if (!rows.length) return { added: 0, updated: 0 }
  const now = nowIso()

  /*
   * One read for the whole batch, then one write per row, sent together.
   *
   * The first version asked "have I seen this key" once per row and then wrote
   * once per row: four thousand round trips for a two-thousand-row import,
   * which on a Worker talking to D1 over the network is a request that ends in
   * a timeout rather than an import. Now the keys are looked up in one IN
   * query and the writes go as a single batch.
   */
  const keys = rows.map((row) => row.source_key)
  const seen = new Map()
  // Chunked because SQLite has a bound-parameter ceiling and a caller may hand
  // over more keys than one statement can carry.
  for (let at = 0; at < keys.length; at += 200) {
    const slice = keys.slice(at, at + 200)
    const found = await db.all(
      `SELECT id, source_key FROM comps WHERE team_id = ? AND source_key IN (${slice
        .map(() => '?')
        .join(', ')})`,
      [teamId, ...slice],
    )
    for (const row of found) seen.set(row.source_key, row.id)
  }

  const statements = []
  let added = 0
  let updated = 0
  for (const row of rows) {
    const existing = seen.get(row.source_key)
    if (existing) {
      statements.push([
        `UPDATE comps SET ${COLUMNS.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
        [...COLUMNS.map((c) => row[c]), now, existing],
      ])
      updated += 1
    } else {
      statements.push([
        `INSERT INTO comps (id, team_id, market, source_key, ${COLUMNS.join(', ')}, created_at, updated_at)
         VALUES (?, ?, ?, ?, ${COLUMNS.map(() => '?').join(', ')}, ?, ?)`,
        [newId(), teamId, market, row.source_key, ...COLUMNS.map((c) => row[c]), now, now],
      ])
      added += 1
    }
  }
  await db.batch(statements)
  return { added, updated }
}

export async function listComps(db, teamId, { market = null } = {}) {
  // A comp imported before markets were a thing, or imported while looking at
  // a different market, is still this team's comp. Market only narrows when
  // one was recorded, so nothing a broker collected can go missing from the
  // list because of where they happened to be standing.
  const rows = market
    ? await db.all(
        'SELECT * FROM comps WHERE team_id = ? AND (market IS NULL OR market = ?) ORDER BY created_at DESC',
        [teamId, market],
      )
    : await db.all('SELECT * FROM comps WHERE team_id = ? ORDER BY created_at DESC', [teamId])
  return rows.map(camelComp)
}

export function camelComp(row) {
  if (!row) return null
  const out = {}
  for (const [key, value] of Object.entries(row)) {
    out[key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())] = value
  }
  return out
}

/**
 * Puts a batch of comps on the map.
 *
 * Geocoding is one network call per address, so it runs in bounded batches the
 * client repeats rather than one request that holds a connection open for
 * four hundred lookups and times out at the edge. A failure is recorded as an
 * attempt, not retried forever: `placed = 'failed'` keeps the row in the list
 * and out of the queue, so an address the geocoder cannot read stops costing
 * a lookup on every pass.
 */
export async function placeComps(db, teamId, geocode, { env, limit = PLACE_BATCH } = {}) {
  const pending = await db.all(
    "SELECT id, address, name FROM comps WHERE team_id = ? AND placed IS NULL ORDER BY created_at LIMIT ?",
    [teamId, limit],
  )
  let placed = 0
  let failed = 0
  for (const row of pending) {
    const search = row.address || row.name
    let found = null
    try {
      const results = await geocode(search, { env })
      if (results?.length) found = results[0]
    } catch {
      // Treated the same as no match. A geocoder outage should leave the
      // import usable rather than failing the whole pass.
    }
    if (found && Number.isFinite(found.lat) && Number.isFinite(found.lng)) {
      await db.run("UPDATE comps SET lat = ?, lng = ?, placed = 'geocoded', updated_at = ? WHERE id = ?", [
        found.lat,
        found.lng,
        nowIso(),
        row.id,
      ])
      placed += 1
    } else {
      await db.run("UPDATE comps SET placed = 'failed', updated_at = ? WHERE id = ?", [nowIso(), row.id])
      failed += 1
    }
  }
  const rest = await db.get('SELECT COUNT(*) AS n FROM comps WHERE team_id = ? AND placed IS NULL', [teamId])
  return { placed, failed, remaining: Number(rest?.n ?? 0) }
}

export async function deleteComp(db, teamId, id) {
  const result = await db.run('DELETE FROM comps WHERE team_id = ? AND id = ?', [teamId, id])
  return Number(result?.changes ?? 0) > 0
}

export async function clearComps(db, teamId) {
  const result = await db.run('DELETE FROM comps WHERE team_id = ?', [teamId])
  return Number(result?.changes ?? 0)
}
