/**
 * Lists: named sets of places, filed by client and tags.
 *
 * A broker builds a list for a reason ("Industrial owners held 10 years,
 * for Acme"), and the reason is what they look for it by later: whose list
 * it is, and what kind. So a list carries a client and a few tags, and the
 * lists page filters on both. Members are the team's CRM places, so a
 * building on three lists is one record, and what is known about it is
 * kept once.
 *
 * Team-scoped like the rest of the CRM: a colleague sees the same lists.
 */

import { newId, nowIso } from './ids.js'

/** As many lists as a team keeps, and places on one list: lists, not tables. */
export const MAX_LISTS = 500
export const MAX_ITEMS = 2000

const text = (value, max) => {
  const out = String(value ?? '').replace(/\s+/g, ' ').trim()
  return out ? out.slice(0, max) : null
}

/** Tags as a clean, de-duplicated list: "Industrial, q3 , industrial" → ["Industrial", "q3"]. */
export function cleanTags(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(',')
  const seen = new Set()
  const out = []
  for (const tag of raw) {
    const t = text(tag, 40)
    if (!t || seen.has(t.toLowerCase())) continue
    seen.add(t.toLowerCase())
    out.push(t)
    if (out.length >= 12) break
  }
  return out
}

function camelList(row) {
  if (!row) return null
  let tags = []
  try {
    tags = JSON.parse(row.tags || '[]')
  } catch {
    tags = []
  }
  return {
    id: row.id,
    name: row.name,
    client: row.client ?? null,
    tags,
    count: Number(row.count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Every list the team keeps, with its size, newest first; `placeId` marks the ones that hold it. */
export async function listLists(db, teamId, { placeId = null } = {}) {
  const rows = await db.all(
    `SELECT l.*, (SELECT COUNT(*) FROM list_items i WHERE i.list_id = l.id) AS count
       FROM lists l WHERE l.team_id = ? ORDER BY l.updated_at DESC`,
    [teamId],
  )
  const holding = placeId
    ? new Set((await db.all('SELECT list_id FROM list_items WHERE team_id = ? AND place_id = ?', [teamId, placeId])).map((r) => r.list_id))
    : null
  return rows.map((row) => ({ ...camelList(row), ...(holding ? { has: holding.has(row.id) } : {}) }))
}

export async function getList(db, teamId, id) {
  const row = await db.get(
    `SELECT l.*, (SELECT COUNT(*) FROM list_items i WHERE i.list_id = l.id) AS count FROM lists l WHERE l.team_id = ? AND l.id = ?`,
    [teamId, id],
  )
  if (!row) return null
  const places = await db.all(
    `SELECT p.*, i.added_at AS added_at FROM list_items i JOIN places p ON p.id = i.place_id
      WHERE i.list_id = ? AND p.team_id = ? ORDER BY i.added_at DESC`,
    [id, teamId],
  )
  return { ...camelList(row), places }
}

export async function createList(db, teamId, input = {}, { userId = null } = {}) {
  const name = text(input.name, 120)
  if (!name) return { error: 'Give the list a name.' }
  const count = await db.get('SELECT COUNT(*) AS n FROM lists WHERE team_id = ?', [teamId])
  if (Number(count?.n ?? 0) >= MAX_LISTS) return { error: `A team keeps at most ${MAX_LISTS} lists. Delete one to make another.` }
  const now = nowIso()
  const id = newId()
  await db.run(
    'INSERT INTO lists (id, team_id, name, client, tags, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, teamId, name, text(input.client, 120), JSON.stringify(cleanTags(input.tags)), userId, now, now],
  )
  return { list: camelList(await db.get('SELECT l.*, 0 AS count FROM lists l WHERE id = ?', [id])) }
}

export async function updateList(db, teamId, id, patch = {}) {
  const found = await db.get('SELECT * FROM lists WHERE team_id = ? AND id = ?', [teamId, id])
  if (!found) return { noList: true }
  const name = patch.name !== undefined ? text(patch.name, 120) : found.name
  if (!name) return { error: 'A list needs a name.' }
  const client = patch.client !== undefined ? text(patch.client, 120) : found.client
  const tags = patch.tags !== undefined ? JSON.stringify(cleanTags(patch.tags)) : found.tags
  await db.run('UPDATE lists SET name = ?, client = ?, tags = ?, updated_at = ? WHERE id = ?', [name, client, tags, nowIso(), id])
  return { list: (await listLists(db, teamId)).find((l) => l.id === id) }
}

export async function deleteList(db, teamId, id) {
  const found = await db.get('SELECT id FROM lists WHERE team_id = ? AND id = ?', [teamId, id])
  if (!found) return false
  await db.run('DELETE FROM list_items WHERE list_id = ?', [id])
  await db.run('DELETE FROM lists WHERE id = ?', [id])
  return true
}

/** Adds places to a list; ones already on it, or not the team's, are skipped. */
export async function addToList(db, teamId, id, placeIds = []) {
  const found = await db.get('SELECT id FROM lists WHERE team_id = ? AND id = ?', [teamId, id])
  if (!found) return { noList: true }
  const ids = [...new Set((Array.isArray(placeIds) ? placeIds : []).map(String))].slice(0, 500)
  if (!ids.length) return { error: 'Choose at least one place.' }
  const size = Number((await db.get('SELECT COUNT(*) AS n FROM list_items WHERE list_id = ?', [id]))?.n ?? 0)
  const now = nowIso()
  let added = 0
  const missing = []
  for (const placeId of ids) {
    if (size + added >= MAX_ITEMS) break
    const place = await db.get('SELECT id FROM places WHERE team_id = ? AND id = ?', [teamId, placeId])
    if (!place) {
      missing.push(placeId)
      continue
    }
    const done = await db.run(
      'INSERT OR IGNORE INTO list_items (list_id, team_id, place_id, added_at) VALUES (?, ?, ?, ?)',
      [id, teamId, placeId, now],
    )
    if (Number(done?.changes ?? done?.meta?.changes ?? 1) > 0) added += 1
  }
  await db.run('UPDATE lists SET updated_at = ? WHERE id = ?', [now, id])
  return { added, missing }
}

export async function removeFromList(db, teamId, id, placeId) {
  const found = await db.get('SELECT id FROM lists WHERE team_id = ? AND id = ?', [teamId, id])
  if (!found) return { noList: true }
  await db.run('DELETE FROM list_items WHERE list_id = ? AND place_id = ?', [id, String(placeId)])
  await db.run('UPDATE lists SET updated_at = ? WHERE id = ?', [nowIso(), id])
  return { ok: true }
}

/** When a place is deleted from the CRM, it leaves every list. */
export async function forgetPlace(db, teamId, placeId) {
  await db.run('DELETE FROM list_items WHERE team_id = ? AND place_id = ?', [teamId, String(placeId)])
}
