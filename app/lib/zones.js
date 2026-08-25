/**
 * Labelled radius circles on the survey map.
 *
 * The canonical use is a non-compete: an anchor tenant's exclusivity radius
 * that a candidate site must sit outside. Drawing it beats remembering it —
 * a circle on the map settles "is this site clear?" at a glance, for the
 * broker and for the client reading the shared link.
 */

import { newId, nowIso } from './ids.js'

const MAX_ZONES = 50
const COLOR = /^#[0-9a-f]{6}$/i

function mapZone(row) {
  if (!row) return null
  return {
    id: row.id,
    surveyId: row.survey_id,
    label: row.label,
    lat: row.lat,
    lng: row.lng,
    radiusMiles: row.radius_miles,
    color: row.color,
    createdAt: row.created_at,
  }
}

export async function listZones(db, surveyId) {
  const rows = await db.all('SELECT * FROM zones WHERE survey_id = ? ORDER BY created_at', [surveyId])
  return rows.map(mapZone)
}

export async function createZone(db, surveyId, input = {}) {
  const label = String(input.label ?? '').trim().slice(0, 120)
  const lat = Number(input.lat)
  const lng = Number(input.lng)
  const radius = Number(input.radiusMiles)

  if (!label) return { error: 'Give the zone a label — that is the point of drawing it.' }
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    return { error: 'The zone needs a spot on the map.' }
  }
  if (!Number.isFinite(radius) || radius <= 0 || radius > 50) {
    return { error: 'The radius must be between 0 and 50 miles.' }
  }
  if ((await db.all('SELECT id FROM zones WHERE survey_id = ?', [surveyId])).length >= MAX_ZONES) {
    return { error: `A survey holds at most ${MAX_ZONES} zones.` }
  }

  const zone = {
    id: newId(),
    survey_id: surveyId,
    label,
    lat,
    lng,
    radius_miles: radius,
    color: COLOR.test(String(input.color)) ? input.color : '#f59e0b',
    created_at: nowIso(),
  }
  await db.run(
    'INSERT INTO zones (id, survey_id, label, lat, lng, radius_miles, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [zone.id, zone.survey_id, zone.label, zone.lat, zone.lng, zone.radius_miles, zone.color, zone.created_at],
  )
  return { zone: mapZone(zone) }
}

/**
 * Renames or recolours a zone.
 *
 * Position and radius stay put: those are drawn on the map, and changing them
 * from a text field would be a worse way to say the same thing.
 */
export async function updateZone(db, id, patch = {}) {
  const columns = {}
  if (patch.label !== undefined) {
    const label = String(patch.label ?? '').trim().slice(0, 120)
    if (!label) return { error: 'Give the zone a label — that is the point of drawing it.' }
    columns.label = label
  }
  if (patch.color !== undefined) {
    if (!COLOR.test(String(patch.color))) return { error: 'That is not a colour.' }
    columns.color = patch.color
  }
  if (Object.keys(columns).length === 0) {
    return { zone: mapZone(await db.get('SELECT * FROM zones WHERE id = ?', [id])) }
  }
  const assignments = Object.keys(columns).map((column) => `${column} = ?`)
  await db.run(`UPDATE zones SET ${assignments.join(', ')} WHERE id = ?`, [...Object.values(columns), id])
  return { zone: mapZone(await db.get('SELECT * FROM zones WHERE id = ?', [id])) }
}

export async function deleteZone(db, id) {
  const { changes } = await db.run('DELETE FROM zones WHERE id = ?', [id])
  return changes > 0
}
