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
 *
 * Round trips are counted here, because on D1 each one crosses the network:
 * multi-statement writes go through `db.batch`, lists are bounded and
 * searched in SQL, and nothing is fetched one row at a time in a loop.
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

/**
 * The most rows one list answers. Every list in the UI is a team's own
 * records, which is hundreds at most; the bound exists so that a team with
 * tens of thousands cannot pull them all down on every page open.
 */
export const LIST_LIMIT = 1000

/** Turns a snake_case row into the camelCase shape the client speaks. */
export function camel(row) {
  if (!row) return null
  const out = {}
  for (const [key, value] of Object.entries(row)) {
    out[key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())] = value
  }
  return out
}

/** How many statements one batch may carry; D1 caps this well above it. */
const BATCH_CHUNK = 90

async function batched(db, statements) {
  for (let at = 0; at < statements.length; at += BATCH_CHUNK) {
    await db.batch(statements.slice(at, at + BATCH_CHUNK))
  }
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
 * The statements that replace a record's custom fields wholesale.
 *
 * The client always sends the complete list, so a delete is simply a field
 * that stopped being sent — no separate endpoint, and no way for the two
 * halves of an edit to disagree. Returned as statements so a caller can land
 * them in the same batch as the row they belong to.
 */
export function fieldStatements(recordType, recordId, fields) {
  const statements = [
    ['DELETE FROM record_fields WHERE record_type = ? AND record_id = ?', [recordType, recordId]],
  ]
  let position = 0
  for (const field of fields) {
    const label = String(field?.label ?? '').trim()
    if (!label) continue
    statements.push([
      'INSERT INTO record_fields (id, record_type, record_id, label, value, position) VALUES (?, ?, ?, ?, ?, ?)',
      [newId(), recordType, recordId, label, field?.value == null ? null : String(field.value), position++],
    ])
  }
  return statements
}

export async function setFields(db, recordType, recordId, fields) {
  if (!Array.isArray(fields)) return
  await batched(db, fieldStatements(recordType, recordId, fields))
}

/**
 * Custom fields for every record a list query matched, in one query.
 *
 * A JOIN against the same WHERE clause as the list, rather than an `IN (...)`
 * over the matched ids: the id list is unbounded and D1 caps bound
 * parameters, so a long list would have failed exactly when it mattered.
 */
async function fieldsMatching(db, recordType, where, params) {
  const table = TABLES[recordType]
  const rows = await db.all(
    `SELECT f.record_id, f.id, f.label, f.value, f.position
       FROM record_fields f JOIN ${table} r ON r.id = f.record_id
      WHERE f.record_type = ? AND ${where}
      ORDER BY f.position, f.rowid`,
    [recordType, ...params],
  )
  return groupFields(rows)
}

function groupFields(rows) {
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
    // Where this place is on the county roll, when it came from the parcel map.
    'market', 'parcel_id',
  ],
  deal: ['name', 'kind', 'stage', 'value', 'close_date', 'survey_id', 'notes'],
}

/** The columns a search box looks in: what a person would type, not ids. */
const SEARCHABLE = {
  company: ['name', 'industry', 'website', 'phone', 'address', 'city', 'state', 'zip', 'notes'],
  person: ['first_name', 'last_name', 'email', 'phone', 'title', 'notes'],
  place: ['name', 'address', 'city', 'state', 'zip', 'property_type', 'availability', 'rate_unit', 'notes', 'market', 'parcel_id'],
  deal: ['name', 'kind', 'stage', 'close_date', 'notes'],
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

/** Address, flattened for comparison: case, spacing and punctuation dropped. */
export function addressKey(input = {}) {
  return [input.address, input.city, input.state]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Keeps `places.address_key` in step with the address columns.
 *
 * Computed from the row as it will be after the write: the incoming columns
 * over whatever the row already holds. An empty key is stored as '' rather
 * than NULL so the row is never mistaken for one that predates the column.
 */
function withAddressKey(recordType, columns, existing = {}) {
  if (recordType !== 'place') return columns
  if (!('address' in columns) && !('city' in columns) && !('state' in columns) && existing.address_key != null) {
    return columns
  }
  return { ...columns, address_key: addressKey({ ...existing, ...columns }) }
}

function tableFor(recordType) {
  const table = TABLES[recordType]
  if (!table) throw new Error(`Unknown record type: ${recordType}`)
  return table
}

/**
 * A team's records, newest first, optionally filtered by a search string.
 *
 * The search runs in SQL over the human-typed columns, and the list is
 * bounded: `truncated` tells the caller that more exist past the limit.
 */
export async function listRecords(db, recordType, teamId, { search = '', limit = LIST_LIMIT, offset = 0 } = {}) {
  const table = tableFor(recordType)

  const clauses = ['r.team_id = ?']
  const params = [teamId]
  const needle = String(search).trim()
  if (needle) {
    const pattern = `%${needle.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
    const columns = SEARCHABLE[recordType]
    clauses.push(`(${columns.map((column) => `r.${column} LIKE ? ESCAPE '\\'`).join(' OR ')})`)
    for (const _ of columns) params.push(pattern)
  }
  const where = clauses.join(' AND ')

  const bound = Math.min(Math.max(1, Number(limit) || LIST_LIMIT), LIST_LIMIT)
  const skip = Math.max(0, Number(offset) || 0)
  const rows = await db.all(
    `SELECT r.* FROM ${table} r WHERE ${where} ORDER BY r.updated_at DESC LIMIT ? OFFSET ?`,
    [...params, bound + 1, skip],
  )
  const truncated = rows.length > bound
  if (truncated) rows.pop()

  const fields = rows.length > 0 ? await fieldsMatching(db, recordType, where, params) : new Map()
  return {
    records: rows.map((row) => ({ ...camel(row), fields: fields.get(row.id) ?? [] })),
    truncated,
  }
}

/** How many of each record type the team holds, plus its surveys. One query. */
export async function countRecords(db, teamId) {
  const row = await db.get(
    `SELECT (SELECT COUNT(*) FROM companies WHERE team_id = ?) AS companies,
            (SELECT COUNT(*) FROM people    WHERE team_id = ?) AS people,
            (SELECT COUNT(*) FROM places    WHERE team_id = ?) AS places,
            (SELECT COUNT(*) FROM deals     WHERE team_id = ?) AS deals,
            (SELECT COUNT(*) FROM surveys   WHERE owner_id = ?) AS surveys`,
    [teamId, teamId, teamId, teamId, teamId],
  )
  return {
    companies: Number(row?.companies ?? 0),
    people: Number(row?.people ?? 0),
    places: Number(row?.places ?? 0),
    deals: Number(row?.deals ?? 0),
    surveys: Number(row?.surveys ?? 0),
  }
}

export async function getRecord(db, recordType, teamId, id) {
  const table = tableFor(recordType)
  const row = await db.get(`SELECT * FROM ${table} WHERE id = ? AND team_id = ?`, [id, teamId])
  if (!row) return null
  return { ...camel(row), fields: await listFields(db, recordType, id) }
}

/**
 * Inserts a record and returns its id without reading it back.
 *
 * The row, and its custom fields when supplied, go in one batch. Callers that
 * need the stored shape call `getRecord`; callers that only need the id — a
 * survey filing a building into the team's places — do not pay for the read.
 */
export async function insertRecord(db, recordType, teamId, input = {}) {
  const table = tableFor(recordType)

  const columns = withAddressKey(recordType, writable(recordType, input))
  if ((recordType === 'company' || recordType === 'deal') && !String(columns.name ?? '').trim()) {
    return { error: 'A name is required.' }
  }

  const id = newId()
  const now = nowIso()
  const names = ['id', 'team_id', ...Object.keys(columns), 'created_at', 'updated_at']
  const values = [id, teamId, ...Object.values(columns), now, now]
  await batched(db, [
    [`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, values],
    ...(Array.isArray(input.fields) ? fieldStatements(recordType, id, input.fields) : []),
  ])
  return { id }
}

export async function createRecord(db, recordType, teamId, input = {}) {
  const result = await insertRecord(db, recordType, teamId, input)
  if (result.error) return result
  return { record: await getRecord(db, recordType, teamId, result.id) }
}

/**
 * Applies a patch, writing only the columns that differ.
 *
 * The scoped read comes first so a record on another team 404s rather than
 * silently failing to update, which would read to the caller as "saved". It
 * also supplies the current values, so an edit that changes nothing writes
 * nothing — and keeps its timestamp.
 */
export async function updateRecord(db, recordType, teamId, id, patch = {}) {
  const table = tableFor(recordType)
  const existing = await db.get(`SELECT * FROM ${table} WHERE id = ? AND team_id = ?`, [id, teamId])
  if (!existing) return null

  const requested = withAddressKey(recordType, writable(recordType, patch), existing)
  const columns = {}
  for (const [column, value] of Object.entries(requested)) {
    if (!same(existing[column], value)) columns[column] = value
  }

  const statements = []
  if (Object.keys(columns).length > 0) {
    const assignments = Object.keys(columns).map((column) => `${column} = ?`)
    statements.push([
      `UPDATE ${table} SET ${assignments.join(', ')}, updated_at = ? WHERE id = ? AND team_id = ?`,
      [...Object.values(columns), nowIso(), id, teamId],
    ])
  }
  if (Array.isArray(patch.fields)) statements.push(...fieldStatements(recordType, id, patch.fields))
  if (statements.length > 0) await batched(db, statements)
  return getRecord(db, recordType, teamId, id)
}

function same(stored, incoming) {
  if (stored == null && incoming == null) return true
  if (typeof stored === 'number' || typeof incoming === 'number') return Number(stored) === Number(incoming)
  return stored === incoming
}

/** Removes a record, its fields and its deal memberships, atomically. */
export async function deleteRecord(db, recordType, teamId, id) {
  const table = tableFor(recordType)
  const existing = await db.get(`SELECT id FROM ${table} WHERE id = ? AND team_id = ?`, [id, teamId])
  if (!existing) return false
  await db.batch([
    [`DELETE FROM ${table} WHERE id = ? AND team_id = ?`, [id, teamId]],
    ['DELETE FROM record_fields WHERE record_type = ? AND record_id = ?', [recordType, id]],
    // A party row pointing at a deleted record would render as a blank line.
    ['DELETE FROM deal_parties WHERE kind = ? AND ref_id = ?', [recordType, id]],
  ])
  return true
}

// --- deals ------------------------------------------------------------------

const PARTY_KINDS = new Set(['person', 'company', 'place'])

/** Splits a list into slices D1 can bind in one statement. */
function chunks(list, size = 50) {
  const out = []
  for (let at = 0; at < list.length; at += size) out.push(list.slice(at, at + size))
  return out
}

/**
 * The deal, with each participant resolved to the record it points at.
 *
 * One query per kind of party present, plus one for all their custom fields,
 * however many parties the deal has. It used to be two queries per party.
 */
export async function dealWithParties(db, teamId, dealId) {
  const deal = await getRecord(db, 'deal', teamId, dealId)
  if (!deal) return null

  const rows = await db.all(
    'SELECT id, kind, ref_id, role FROM deal_parties WHERE deal_id = ? ORDER BY rowid',
    [dealId],
  )
  if (rows.length === 0) return { ...deal, parties: [] }

  const byKind = new Map()
  for (const row of rows) {
    if (!PARTY_KINDS.has(row.kind)) continue
    if (!byKind.has(row.kind)) byKind.set(row.kind, new Set())
    byKind.get(row.kind).add(row.ref_id)
  }

  const records = new Map()
  const allIds = []
  for (const [kind, ids] of byKind) {
    for (const slice of chunks([...ids])) {
      const found = await db.all(
        `SELECT * FROM ${TABLES[kind]} WHERE team_id = ? AND id IN (${slice.map(() => '?').join(', ')})`,
        [teamId, ...slice],
      )
      for (const record of found) {
        records.set(`${kind}:${record.id}`, camel(record))
        allIds.push(record.id)
      }
    }
  }

  const fields = new Map()
  for (const slice of chunks(allIds)) {
    const found = await db.all(
      `SELECT record_id, id, label, value, position FROM record_fields
        WHERE record_id IN (${slice.map(() => '?').join(', ')})
        ORDER BY position, rowid`,
      slice,
    )
    for (const [id, list] of groupFields(found)) fields.set(id, list)
  }

  const parties = []
  for (const row of rows) {
    const record = records.get(`${row.kind}:${row.ref_id}`)
    // A party whose record was removed from another session is dropped rather
    // than rendered as an empty row.
    if (!record) continue
    parties.push({ id: row.id, kind: row.kind, role: row.role, record: { ...record, fields: fields.get(record.id) ?? [] } })
  }
  return { ...deal, parties }
}

export async function addParty(db, teamId, dealId, { kind, refId, role = null }) {
  if (!PARTY_KINDS.has(kind)) return { error: 'A deal joins people, companies and places.' }

  const deal = await db.get('SELECT id FROM deals WHERE id = ? AND team_id = ?', [dealId, teamId])
  if (!deal) return { error: 'That deal could not be found.' }
  // Both ends are checked against the team, so a party cannot be used to
  // pull a record across a tenant boundary.
  const record = await db.get(`SELECT id FROM ${TABLES[kind]} WHERE id = ? AND team_id = ?`, [refId, teamId])
  if (!record) return { error: 'That record could not be found.' }

  const already = await db.get(
    'SELECT id FROM deal_parties WHERE deal_id = ? AND kind = ? AND ref_id = ?',
    [dealId, kind, refId],
  )
  if (already) return { ok: true, id: already.id }

  const id = newId()
  const now = nowIso()
  await db.batch([
    [
      'INSERT INTO deal_parties (id, deal_id, kind, ref_id, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, dealId, kind, refId, role, now],
    ],
    ['UPDATE deals SET updated_at = ? WHERE id = ?', [now, dealId]],
  ])
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

/**
 * Files a building worked on a survey into the team's places.
 *
 * The survey is where a broker discovers buildings; the CRM is where the team
 * remembers them. Without this, everything learned on a survey dies with it.
 *
 * Creates only. An address the team already has is left exactly as it is —
 * that record may have been curated over months, and a half-filled site from
 * a flyer must not overwrite it. Never throws: failing to file a place is not
 * a reason to fail the upload that produced it.
 *
 * The match is an indexed lookup on `address_key`. Rows written before that
 * column existed are keyed the first time a team's lookup misses, so the
 * one-time scan happens once per team rather than on every site added.
 */
/** Teams whose places all carry an address key, so the legacy scan is skipped. */
const keyedTeams = new Set()

/** For tests that build fresh databases inside one process. */
export function forgetKeyedTeams() {
  keyedTeams.clear()
}

export async function rememberPlace(db, teamId, property) {
  try {
    if (!teamId) return null
    const key = addressKey(property)
    // Nothing to match on, and nothing worth remembering.
    if (!key) return null

    const hit = await db.get('SELECT id FROM places WHERE team_id = ? AND address_key = ?', [teamId, key])
    if (hit) return hit.id

    if (!keyedTeams.has(teamId)) {
      const unkeyed = await db.all('SELECT id, address, city, state FROM places WHERE team_id = ? AND address_key IS NULL', [teamId])
      if (unkeyed.length > 0) {
        await batched(
          db,
          unkeyed.map((row) => ['UPDATE places SET address_key = ? WHERE id = ?', [addressKey(row), row.id]]),
        )
      }
      // Every place this code writes carries a key, so once the scan comes
      // back empty it stays empty for the life of this instance.
      keyedTeams.add(teamId)
      const match = unkeyed.find((row) => addressKey(row) === key)
      if (match) return match.id
    }

    const result = await insertRecord(db, 'place', teamId, {
      name: property.name ?? null,
      address: property.address ?? null,
      city: property.city ?? null,
      state: property.state ?? null,
      zip: property.zip ?? null,
      lat: property.lat ?? null,
      lng: property.lng ?? null,
      sizeSqft: property.sizeSqft ?? null,
      acreage: property.acreage ?? null,
      availability: property.availability ?? null,
      askingRate: property.rentRate ?? null,
      rateUnit: property.rentUnit ?? null,
    })
    return result.id ?? null
  } catch {
    return null
  }
}
