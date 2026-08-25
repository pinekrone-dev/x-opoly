/**
 * People, companies, places and deals — the records that outlive a survey.
 *
 * A survey is one deal's map: it gets shared, annotated, and eventually
 * archived. The broker's relationships and building knowledge are not
 * disposable in that way, so they live here, at the team, and a survey draws
 * from them.
 *
 * Everything is scoped by `team_id` at the query, never by filtering after the
 * read. A missing scope is then a syntax error rather than a leak between
 * tenants.
 */

import { newId, nowIso } from './ids.js'

/** The record types that can carry custom fields and join a deal. */
export const RECORD_TYPES = ['company', 'person', 'place', 'deal']

const TABLES = {
  company: 'companies',
  person: 'people',
  place: 'places',
  deal: 'deals',
}

/** Turns a snake_case row into the camelCase shape the client speaks. */
function camel(row) {
  if (!row) return null
  const out = {}
  for (const [key, value] of Object.entries(row)) {
    out[key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())] = value
  }
  return out
}

// --- custom profiles --------------------------------------------------------

export async function listFields(db, recordType, recordId) {
  const rows = await db.all(
    'SELECT id, label, value, position FROM record_fields WHERE record_type = ? AND record_id = ? ORDER BY position, rowid',
    [recordType, recordId],
  )
  return rows.map(camel)
}

/**
 * Replaces a record's custom fields wholesale.
 *
 * The client always sends the complete list, so a delete is simply a field
 * that stopped being sent — no separate endpoint, and no way for the two
 * halves of an edit to disagree.
 */
export async function setFields(db, recordType, recordId, fields) {
  if (!Array.isArray(fields)) return
  await db.run('DELETE FROM record_fields WHERE record_type = ? AND record_id = ?', [recordType, recordId])
  let position = 0
  for (const field of fields) {
    const label = String(field?.label ?? '').trim()
    if (!label) continue
    await db.run(
      'INSERT INTO record_fields (id, record_type, record_id, label, value, position) VALUES (?, ?, ?, ?, ?, ?)',
      [newId(), recordType, recordId, label, field?.value == null ? null : String(field.value), position++],
    )
  }
}

async function fieldsFor(db, recordType, ids) {
  if (ids.length === 0) return new Map()
  const rows = await db.all(
    `SELECT record_id, id, label, value, position FROM record_fields
      WHERE record_type = ? AND record_id IN (${ids.map(() => '?').join(', ')})
      ORDER BY position, rowid`,
    [recordType, ...ids],
  )
  const grouped = new Map()
  for (const row of rows) {
    const list = grouped.get(row.record_id) ?? []
    list.push({ id: row.id, label: row.label, value: row.value, position: row.position })
    grouped.set(row.record_id, list)
  }
  return grouped
}

// --- generic record access --------------------------------------------------

/** The columns a caller may set, per type. Anything else is ignored. */
const WRITABLE = {
  company: ['name', 'industry', 'website', 'phone', 'address', 'city', 'state', 'zip', 'notes'],
  person: ['company_id', 'first_name', 'last_name', 'email', 'phone', 'title', 'notes'],
  place: [
    'name', 'address', 'city', 'state', 'zip', 'lat', 'lng', 'property_type',
    'size_sqft', 'acreage', 'availability', 'asking_rate', 'rate_unit',
    'owner_company_id', 'notes',
  ],
  deal: ['name', 'kind', 'stage', 'value', 'close_date', 'survey_id', 'notes'],
}

const snake = (key) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)

/** Picks only the writable columns out of whatever the client sent. */
function writable(recordType, input = {}) {
  const allowed = new Set(WRITABLE[recordType])
  const columns = {}
  for (const [key, value] of Object.entries(input)) {
    const column = snake(key)
    if (allowed.has(column)) columns[column] = value === '' ? null : value
  }
  return columns
}

export async function listRecords(db, recordType, teamId, { search = '' } = {}) {
  const table = TABLES[recordType]
  if (!table) throw new Error(`Unknown record type: ${recordType}`)

  const rows = await db.all(`SELECT * FROM ${table} WHERE team_id = ? ORDER BY updated_at DESC`, [teamId])
  const needle = String(search).trim().toLowerCase()
  const matched = needle
    ? rows.filter((row) =>
        Object.values(row).some((value) => typeof value === 'string' && value.toLowerCase().includes(needle)),
      )
    : rows

  const fields = await fieldsFor(db, recordType, matched.map((row) => row.id))
  return matched.map((row) => ({ ...camel(row), fields: fields.get(row.id) ?? [] }))
}

export async function getRecord(db, recordType, teamId, id) {
  const table = TABLES[recordType]
  if (!table) throw new Error(`Unknown record type: ${recordType}`)
  const row = await db.get(`SELECT * FROM ${table} WHERE id = ? AND team_id = ?`, [id, teamId])
  if (!row) return null
  return { ...camel(row), fields: await listFields(db, recordType, id) }
}

export async function createRecord(db, recordType, teamId, input = {}) {
  const table = TABLES[recordType]
  if (!table) throw new Error(`Unknown record type: ${recordType}`)

  const columns = writable(recordType, input)
  if ((recordType === 'company' || recordType === 'deal') && !String(columns.name ?? '').trim()) {
    return { error: 'A name is required.' }
  }

  const id = newId()
  const now = nowIso()
  const names = ['id', 'team_id', ...Object.keys(columns), 'created_at', 'updated_at']
  const values = [id, teamId, ...Object.values(columns), now, now]
  await db.run(
    `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
    values,
  )
  await setFields(db, recordType, id, input.fields)
  return { record: await getRecord(db, recordType, teamId, id) }
}

export async function updateRecord(db, recordType, teamId, id, patch = {}) {
  const table = TABLES[recordType]
  if (!table) throw new Error(`Unknown record type: ${recordType}`)
  // Scoped read first: a record on another team must 404, not silently fail
  // to update, which would read to the caller as "saved".
  const existing = await db.get(`SELECT id FROM ${table} WHERE id = ? AND team_id = ?`, [id, teamId])
  if (!existing) return null

  const columns = writable(recordType, patch)
  if (Object.keys(columns).length > 0) {
    const assignments = Object.keys(columns).map((column) => `${column} = ?`)
    await db.run(
      `UPDATE ${table} SET ${assignments.join(', ')}, updated_at = ? WHERE id = ? AND team_id = ?`,
      [...Object.values(columns), nowIso(), id, teamId],
    )
  }
  if (patch.fields !== undefined) await setFields(db, recordType, id, patch.fields)
  return getRecord(db, recordType, teamId, id)
}

export async function deleteRecord(db, recordType, teamId, id) {
  const table = TABLES[recordType]
  if (!table) throw new Error(`Unknown record type: ${recordType}`)
  const existing = await db.get(`SELECT id FROM ${table} WHERE id = ? AND team_id = ?`, [id, teamId])
  if (!existing) return false
  await db.run(`DELETE FROM ${table} WHERE id = ? AND team_id = ?`, [id, teamId])
  await db.run('DELETE FROM record_fields WHERE record_type = ? AND record_id = ?', [recordType, id])
  // A party row pointing at a deleted record would render as a blank line.
  await db.run('DELETE FROM deal_parties WHERE kind = ? AND ref_id = ?', [recordType, id])
  return true
}

// --- deals ------------------------------------------------------------------

const PARTY_KINDS = new Set(['person', 'company', 'place'])

/** The deal, with each participant resolved to the record it points at. */
export async function dealWithParties(db, teamId, dealId) {
  const deal = await getRecord(db, 'deal', teamId, dealId)
  if (!deal) return null

  const rows = await db.all(
    'SELECT id, kind, ref_id, role FROM deal_parties WHERE deal_id = ? ORDER BY rowid',
    [dealId],
  )
  const parties = []
  for (const row of rows) {
    const record = await getRecord(db, row.kind, teamId, row.ref_id)
    // A party whose record was removed from another session is dropped rather
    // than rendered as an empty row.
    if (record) parties.push({ id: row.id, kind: row.kind, role: row.role, record })
  }
  return { ...deal, parties }
}

export async function addParty(db, teamId, dealId, { kind, refId, role = null }) {
  if (!PARTY_KINDS.has(kind)) return { error: 'A deal joins people, companies and places.' }

  const deal = await db.get('SELECT id FROM deals WHERE id = ? AND team_id = ?', [dealId, teamId])
  if (!deal) return { error: 'That deal could not be found.' }
  // Both ends are checked against the team, so a party cannot be used to
  // pull a record across a tenant boundary.
  const record = await getRecord(db, kind, teamId, refId)
  if (!record) return { error: 'That record could not be found.' }

  const already = await db.get(
    'SELECT id FROM deal_parties WHERE deal_id = ? AND kind = ? AND ref_id = ?',
    [dealId, kind, refId],
  )
  if (already) return { ok: true, id: already.id }

  const id = newId()
  await db.run(
    'INSERT INTO deal_parties (id, deal_id, kind, ref_id, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, dealId, kind, refId, role, nowIso()],
  )
  await db.run('UPDATE deals SET updated_at = ? WHERE id = ?', [nowIso(), dealId])
  return { ok: true, id }
}

export async function removeParty(db, teamId, dealId, partyId) {
  const deal = await db.get('SELECT id FROM deals WHERE id = ? AND team_id = ?', [dealId, teamId])
  if (!deal) return false
  await db.run('DELETE FROM deal_parties WHERE id = ? AND deal_id = ?', [partyId, dealId])
  return true
}

// --- places into surveys ----------------------------------------------------

/**
 * The columns a place hands to the property it becomes.
 *
 * A copy, not a reference: the survey is the version the client sees, and the
 * broker edits it freely — rates negotiated down, notes added, a site hidden.
 * None of that should reach back and rewrite what the team knows about the
 * building.
 */
export function propertyFromPlace(place) {
  return {
    name: place.name ?? place.address ?? 'Untitled site',
    address: place.address ?? null,
    city: place.city ?? null,
    state: place.state ?? null,
    zip: place.zip ?? null,
    lat: place.lat ?? null,
    lng: place.lng ?? null,
    sizeSqft: place.sizeSqft ?? null,
    acreage: place.acreage ?? null,
    availability: place.availability ?? null,
    rentRate: place.askingRate ?? null,
    rentUnit: place.rateUnit ?? null,
    notes: place.notes ?? null,
    fields: (place.fields ?? []).map(({ label, value }) => ({ label, value })),
  }
}
