/**
 * Saved map views: a market, configured, under a name.
 *
 * Getting a map to say something takes a dozen small decisions — which layers,
 * in what colours, at what opacity, coloured by which field, filtered to which
 * asset types and value band, looking at where. All of that lived in the
 * browser tab: gone on refresh, impossible to return to next week, and
 * impossible to hand to a colleague.
 *
 * A view is stored as an opaque JSON blob and applied whole. Nothing here
 * interprets it, which is the point — the set of things a view captures grows
 * every time the map gains a control, and a schema change per control would be
 * a tax on adding them. The server's job is to bound it and scope it, not to
 * understand it.
 */

import { newId, nowIso } from './ids.js'

/** As large as one saved view may be. A view is settings, not data. */
export const MAX_VIEW_BYTES = 64 * 1024

/** As many as one team may keep per market, so a list stays a list. */
export const MAX_VIEWS_PER_MARKET = 60

function name(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, 80) : null
}

export function camelView(row) {
  if (!row) return null
  let state = {}
  try {
    state = JSON.parse(row.state)
  } catch {
    // A view whose blob will not parse is a view that cannot be applied, but
    // it is still a row the owner can see and delete. Handing back an empty
    // configuration beats failing the whole list because of one bad record.
  }
  return {
    id: row.id,
    market: row.market,
    name: row.name,
    state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function listViews(db, teamId, market = null) {
  const rows = market
    ? await db.all(
        'SELECT * FROM map_views WHERE team_id = ? AND market = ? ORDER BY updated_at DESC',
        [teamId, market],
      )
    : await db.all('SELECT * FROM map_views WHERE team_id = ? ORDER BY updated_at DESC', [teamId])
  return rows.map(camelView)
}

/**
 * Saves a view, replacing one of the same name in the same market.
 *
 * Same name replaces rather than duplicates because that is what saving twice
 * means: a broker refining "Industrial over 5 acres" expects one view, not a
 * list of six nearly identical ones.
 */
export async function saveView(db, teamId, input, { userId = null } = {}) {
  const label = name(input?.name)
  if (!label) return { error: 'Give the view a name.' }
  const market = String(input?.market ?? '').trim()
  if (!market) return { error: 'A view belongs to a market.' }
  if (input?.state == null || typeof input.state !== 'object') {
    return { error: 'A view needs a configuration to save.' }
  }

  const state = JSON.stringify(input.state)
  if (state.length > MAX_VIEW_BYTES) {
    return { error: 'That view is too large to save. A view holds settings, not data.' }
  }

  const now = nowIso()
  const existing = await db.get(
    'SELECT id FROM map_views WHERE team_id = ? AND market = ? AND name = ?',
    [teamId, market, label],
  )
  if (existing) {
    await db.run('UPDATE map_views SET state = ?, updated_at = ? WHERE id = ?', [state, now, existing.id])
    return { view: camelView(await db.get('SELECT * FROM map_views WHERE id = ?', [existing.id])) }
  }

  const count = await db.get(
    'SELECT COUNT(*) AS n FROM map_views WHERE team_id = ? AND market = ?',
    [teamId, market],
  )
  if (Number(count?.n ?? 0) >= MAX_VIEWS_PER_MARKET) {
    return {
      error: `That market already has ${MAX_VIEWS_PER_MARKET} saved views. Delete one to save another.`,
    }
  }

  const id = newId()
  await db.run(
    `INSERT INTO map_views (id, team_id, created_by, market, name, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, teamId, userId, market, label, state, now, now],
  )
  return { view: camelView(await db.get('SELECT * FROM map_views WHERE id = ?', [id])) }
}

export async function renameView(db, teamId, id, next) {
  const label = name(next)
  if (!label) return { error: 'Give the view a name.' }
  const row = await db.get('SELECT * FROM map_views WHERE team_id = ? AND id = ?', [teamId, id])
  if (!row) return { error: null, missing: true }
  await db.run('UPDATE map_views SET name = ?, updated_at = ? WHERE id = ?', [label, nowIso(), id])
  return { view: camelView(await db.get('SELECT * FROM map_views WHERE id = ?', [id])) }
}

export async function deleteView(db, teamId, id) {
  const result = await db.run('DELETE FROM map_views WHERE team_id = ? AND id = ?', [teamId, id])
  return Number(result?.changes ?? 0) > 0
}
