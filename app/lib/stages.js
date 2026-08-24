/**
 * Deal stages and per-site custom fields.
 *
 * Stages are the pipeline columns in the sidebar — "Unqualified",
 * "Qualified/Touring", "LOI" — and they belong to the survey rather than being
 * a fixed list, because every broker names them differently. A site with no
 * stage is *unstaged*: still on the map, not yet sorted.
 *
 * Custom fields are the arbitrary rows on a site card ("Available SF",
 * "Lease Rate", "NNN"). CRE listings do not share a schema, so rather than
 * guessing at columns the broker names their own.
 */

import { newId, nowIso, toBool } from './ids.js'

/** A new survey starts with a usable pipeline rather than an empty sidebar. */
export const DEFAULT_STAGES = [
  { name: 'Unqualified', color: '#eab308' },
  { name: 'Qualified/Touring', color: '#10b981' },
  { name: 'LOI', color: '#3b82f6' },
  { name: 'Under Contract', color: '#8b5cf6' },
  { name: 'Passed', color: '#ef4444' },
]

/** Matches what the card UI can show without scrolling forever. */
export const MAX_CUSTOM_FIELDS = 15

const HEX = /^#[0-9a-f]{6}$/i

function stageName(value) {
  const name = String(value ?? '').trim()
  return name ? name.slice(0, 60) : null
}

function stageColor(value) {
  return HEX.test(String(value ?? '')) ? String(value) : '#eab308'
}

function mapStage(row) {
  return {
    id: row.id,
    surveyId: row.survey_id,
    name: row.name,
    color: row.color,
    position: row.position,
    hidden: toBool(row.hidden),
  }
}

export async function listStages(db, surveyId) {
  const rows = await db.all(
    'SELECT * FROM stages WHERE survey_id = ? ORDER BY position, created_at',
    [surveyId],
  )
  return rows.map(mapStage)
}

export async function seedStages(db, surveyId) {
  const timestamp = nowIso()
  await db.batch(
    DEFAULT_STAGES.map((stage, index) => [
      'INSERT INTO stages (id, survey_id, name, color, position, hidden, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
      [newId(), surveyId, stage.name, stage.color, index, timestamp],
    ]),
  )
  return listStages(db, surveyId)
}

export async function createStage(db, surveyId, input = {}) {
  const name = stageName(input.name)
  if (!name) return { error: 'Give the stage a name.' }

  const existing = await listStages(db, surveyId)
  const position = existing.length
  const id = newId()
  await db.run(
    'INSERT INTO stages (id, survey_id, name, color, position, hidden, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
    [id, surveyId, name, stageColor(input.color), position, nowIso()],
  )
  return { stage: mapStage(await db.get('SELECT * FROM stages WHERE id = ?', [id])) }
}

export async function updateStage(db, stageId, input = {}) {
  const updates = []
  const values = []

  if ('name' in input) {
    const name = stageName(input.name)
    if (!name) return { error: 'Give the stage a name.' }
    updates.push('name = ?')
    values.push(name)
  }
  if ('color' in input) {
    updates.push('color = ?')
    values.push(stageColor(input.color))
  }
  // Hiding a stage hides its pins on the map without deleting anything.
  if ('hidden' in input) {
    updates.push('hidden = ?')
    values.push(input.hidden ? 1 : 0)
  }

  if (updates.length > 0) {
    await db.run(`UPDATE stages SET ${updates.join(', ')} WHERE id = ?`, [...values, stageId])
  }
  const row = await db.get('SELECT * FROM stages WHERE id = ?', [stageId])
  return row ? { stage: mapStage(row) } : { error: 'That stage no longer exists.' }
}

/**
 * Deleting a stage unstages its sites rather than deleting them. Losing a
 * column should never lose the properties filed under it.
 */
export async function deleteStage(db, stageId) {
  const row = await db.get('SELECT * FROM stages WHERE id = ?', [stageId])
  if (!row) return false
  await db.batch([
    ['UPDATE properties SET stage_id = NULL WHERE stage_id = ?', [stageId]],
    ['DELETE FROM stages WHERE id = ?', [stageId]],
  ])
  return true
}

/** Writes the whole order atomically so a partial reorder cannot stick. */
export async function reorderStages(db, surveyId, orderedIds) {
  await db.batch(
    orderedIds.map((id, index) => [
      'UPDATE stages SET position = ? WHERE id = ? AND survey_id = ?',
      [index, id, surveyId],
    ]),
  )
  return listStages(db, surveyId)
}

/**
 * Replaces a site's custom fields wholesale.
 *
 * The editor sends the full list on save — including the order the broker
 * dragged them into — so replacing is both simpler and correct, where merging
 * would leave deleted rows behind.
 */
export async function setPropertyFields(db, propertyId, fields) {
  if (!Array.isArray(fields)) return listPropertyFields(db, propertyId)

  const cleaned = []
  for (const field of fields) {
    const label = String(field?.label ?? '').trim().slice(0, 60)
    if (!label) continue
    const value = field?.value == null ? null : String(field.value).trim().slice(0, 500) || null
    cleaned.push({ label, value })
    if (cleaned.length >= MAX_CUSTOM_FIELDS) break
  }

  await db.batch([
    ['DELETE FROM property_fields WHERE property_id = ?', [propertyId]],
    ...cleaned.map((field, index) => [
      'INSERT INTO property_fields (id, property_id, label, value, position) VALUES (?, ?, ?, ?, ?)',
      [newId(), propertyId, field.label, field.value, index],
    ]),
  ])

  return listPropertyFields(db, propertyId)
}

export async function listPropertyFields(db, propertyId) {
  const rows = await db.all(
    'SELECT label, value FROM property_fields WHERE property_id = ? ORDER BY position',
    [propertyId],
  )
  return rows.map((row) => ({ label: row.label, value: row.value }))
}

/**
 * Fields for every site in a survey, grouped by property id.
 *
 * One query rather than one per property, so listing a survey with fifty sites
 * stays a constant number of round trips — which matters on D1, where each one
 * crosses the network.
 */
export async function fieldsBySurvey(db, surveyId) {
  const rows = await db.all(
    `SELECT f.property_id, f.label, f.value
     FROM property_fields f
     JOIN properties p ON p.id = f.property_id
     WHERE p.survey_id = ?
     ORDER BY f.position`,
    [surveyId],
  )
  const grouped = new Map()
  for (const row of rows) {
    if (!grouped.has(row.property_id)) grouped.set(row.property_id, [])
    grouped.get(row.property_id).push({ label: row.label, value: row.value })
  }
  return grouped
}
