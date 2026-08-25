/**
 * Survey and property records.
 *
 * A *survey* is one client's search — "Dental offices, North Austin" — and the
 * properties hanging off it are the candidate sites, each moving through the
 * deal stages as the broker works them.
 */

import { newId, newShareToken, nowIso, toBool } from './ids.js'
import { fieldsBySurvey, listPropertyFields, seedStages } from './stages.js'
import { imagesBySurvey, listImages } from './images.js'

export const STAGES = ['prospect', 'touring', 'loi', 'under_contract', 'passed']

export const STAGE_LABELS = {
  prospect: 'Prospect',
  touring: 'Touring',
  loi: 'LOI out',
  under_contract: 'Under contract',
  passed: 'Passed',
}

/** Columns a client is allowed to write, and how to coerce each one. */
const PROPERTY_FIELDS = {
  name: (v) => text(v, 200),
  address: (v) => text(v, 300),
  city: (v) => text(v, 120),
  state: (v) => text(v, 40),
  zip: (v) => text(v, 20),
  lat: (v) => number(v, -90, 90),
  lng: (v) => number(v, -180, 180),
  stage: (v) => (STAGES.includes(v) ? v : 'prospect'),
  rent_rate: (v) => number(v, 0, 1e7),
  rent_unit: (v) => text(v, 40),
  nnn: (v) => number(v, 0, 1e7),
  size_sqft: (v) => integer(v, 0, 1e9),
  acreage: (v) => number(v, 0, 1e6),
  parking_spaces: (v) => integer(v, 0, 1e6),
  zoning: (v) => text(v, 80),
  year_built: (v) => integer(v, 1600, 2100),
  availability: (v) => text(v, 120),
  listing_broker: (v) => text(v, 200),
  broker_email: (v) => text(v, 200),
  broker_phone: (v) => text(v, 60),
  stage_id: (v) => text(v, 40),
  cover_image_id: (v) => text(v, 40),
  tour_minutes: (v) => integer(v, 0, 600),
  notes: (v) => text(v, 5000),
  flyer_path: (v) => text(v, 500),
  flyer_name: (v) => text(v, 300),
  photo_path: (v) => text(v, 500),
  tour_order: (v) => integer(v, 0, 10000),
  hidden: (v) => (v ? 1 : 0),
}

const SURVEY_FIELDS = {
  name: (v) => text(v, 200),
  client_name: (v) => text(v, 200),
  broker_name: (v) => text(v, 200),
  company_name: (v) => text(v, 200),
  brand_color: (v) => (/^#[0-9a-f]{6}$/i.test(String(v)) ? String(v) : null),
  center_lat: (v) => number(v, -90, 90),
  center_lng: (v) => number(v, -180, 180),
  zoom: (v) => integer(v, 1, 20),
  tour_start_time: (v) => text(v, 20),
  tour_stop_minutes: (v) => integer(v, 0, 600),
  tour_start_address: (v) => text(v, 300),
  tour_start_lat: (v) => number(v, -90, 90),
  tour_start_lng: (v) => number(v, -180, 180),
  tour_end_address: (v) => text(v, 300),
  tour_end_lat: (v) => number(v, -90, 90),
  tour_end_lng: (v) => number(v, -180, 180),
}

function text(value, max) {
  if (value == null) return null
  const string = String(value).trim()
  return string ? string.slice(0, max) : null
}

function number(value, min, max) {
  if (value == null || value === '') return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null
  return parsed
}

function integer(value, min, max) {
  const parsed = number(value, min, max)
  return parsed == null ? null : Math.round(parsed)
}

/** snake_case row → camelCase JSON, with the shape the UI expects. */
function mapProperty(row) {
  if (!row) return null
  return {
    id: row.id,
    surveyId: row.survey_id,
    name: row.name,
    address: row.address,
    city: row.city,
    state: row.state,
    zip: row.zip,
    lat: row.lat,
    lng: row.lng,
    stage: row.stage,
    rentRate: row.rent_rate,
    rentUnit: row.rent_unit,
    nnn: row.nnn,
    sizeSqft: row.size_sqft,
    acreage: row.acreage,
    parkingSpaces: row.parking_spaces,
    zoning: row.zoning,
    yearBuilt: row.year_built,
    availability: row.availability,
    listingBroker: row.listing_broker,
    brokerEmail: row.broker_email,
    brokerPhone: row.broker_phone,
    stageId: row.stage_id,
    coverImageId: row.cover_image_id,
    tourMinutes: row.tour_minutes,
    notes: row.notes,
    flyerUrl: row.flyer_path ? `/api/files/${row.flyer_path}` : null,
    flyerName: row.flyer_name,
    photoUrl: row.photo_path ? `/api/files/${row.photo_path}` : null,
    tourOrder: row.tour_order,
    hidden: toBool(row.hidden),
    fields: [],
    images: [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapSurvey(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    clientName: row.client_name,
    brokerName: row.broker_name,
    companyName: row.company_name,
    brandColor: row.brand_color,
    center: row.center_lat != null && row.center_lng != null ? { lat: row.center_lat, lng: row.center_lng } : null,
    zoom: row.zoom,
    share: {
      token: row.share_token,
      enabled: toBool(row.share_enabled),
      expiresAt: row.share_expires_at,
      url: row.share_token ? `/s/${row.share_token}` : null,
    },
    tour: {
      startTime: row.tour_start_time || '10:00',
      stopMinutes: row.tour_stop_minutes ?? 20,
      start:
        row.tour_start_lat != null && row.tour_start_lng != null
          ? { address: row.tour_start_address, lat: row.tour_start_lat, lng: row.tour_start_lng }
          : null,
      end:
        row.tour_end_lat != null && row.tour_end_lng != null
          ? { address: row.tour_end_address, lat: row.tour_end_lat, lng: row.tour_end_lng }
          : null,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Builds a parameterised UPDATE from whichever fields were supplied. */
function buildPatch(input, allowed) {
  const columns = []
  const values = []
  for (const [column, coerce] of Object.entries(allowed)) {
    const camel = column.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
    if (!(column in input) && !(camel in input)) continue
    const raw = column in input ? input[column] : input[camel]
    columns.push(`${column} = ?`)
    values.push(coerce(raw))
  }
  return { columns, values }
}

export async function listSurveys(db) {
  const rows = await db.all(
    `SELECT s.*, (SELECT COUNT(*) FROM properties p WHERE p.survey_id = s.id) AS pin_count
     FROM surveys s ORDER BY s.updated_at DESC`,
  )
  return rows.map((row) => ({ ...mapSurvey(row), pinCount: row.pin_count }))
}

export async function createSurvey(db, input = {}) {
  const id = newId()
  const timestamp = nowIso()
  await db.run(
    `INSERT INTO surveys (id, name, client_name, broker_name, company_name, brand_color, center_lat, center_lng, zoom, share_token, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      text(input.name, 200) || 'Untitled survey',
      text(input.clientName, 200),
      text(input.brokerName, 200),
      text(input.companyName, 200),
      SURVEY_FIELDS.brand_color(input.brandColor) || '#14b8a6',
      number(input.centerLat, -90, 90),
      number(input.centerLng, -180, 180),
      integer(input.zoom, 1, 20) ?? 11,
      newShareToken(),
      timestamp,
      timestamp,
    ],
  )
  await seedStages(db, id)
  return getSurvey(db, id)
}

export async function getSurvey(db, id) {
  return mapSurvey(await db.get('SELECT * FROM surveys WHERE id = ?', [id]))
}

export async function updateSurvey(db, id, input) {
  const { columns, values } = buildPatch(input, SURVEY_FIELDS)
  if (columns.length > 0) {
    await db.run(`UPDATE surveys SET ${columns.join(', ')}, updated_at = ? WHERE id = ?`, [...values, nowIso(), id])
  }
  return getSurvey(db, id)
}

export async function deleteSurvey(db, id) {
  const { changes } = await db.run('DELETE FROM surveys WHERE id = ?', [id])
  return changes > 0
}

/** Bumps the survey's timestamp so the dashboard sorts by real activity. */
async function touchSurvey(db, surveyId) {
  await db.run('UPDATE surveys SET updated_at = ? WHERE id = ?', [nowIso(), surveyId])
}

export async function listProperties(db, surveyId) {
  const rows = await db.all(
    `SELECT * FROM properties WHERE survey_id = ?
     ORDER BY CASE WHEN tour_order IS NULL THEN 1 ELSE 0 END, tour_order, created_at`,
    [surveyId],
  )
  const [fields, images] = await Promise.all([
    fieldsBySurvey(db, surveyId),
    imagesBySurvey(db, surveyId),
  ])
  return rows.map((row) => ({
    ...mapProperty(row),
    fields: fields.get(row.id) ?? [],
    images: images.get(row.id) ?? [],
  }))
}

export async function getProperty(db, id) {
  const property = mapProperty(await db.get('SELECT * FROM properties WHERE id = ?', [id]))
  if (!property) return null
  const [fields, images] = await Promise.all([listPropertyFields(db, id), listImages(db, id)])
  return { ...property, fields, images }
}

export async function createProperty(db, surveyId, input = {}) {
  const id = newId()
  const timestamp = nowIso()
  const columns = Object.keys(PROPERTY_FIELDS)
  const values = columns.map((column) => {
    const camel = column.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
    const raw = column in input ? input[column] : input[camel]
    return PROPERTY_FIELDS[column](raw)
  })

  await db.run(
    `INSERT INTO properties (id, survey_id, ${columns.join(', ')}, created_at, updated_at)
     VALUES (?, ?, ${columns.map(() => '?').join(', ')}, ?, ?)`,
    [id, surveyId, ...values, timestamp, timestamp],
  )

  await touchSurvey(db, surveyId)
  return getProperty(db, id)
}

export async function updateProperty(db, id, input) {
  const { columns, values } = buildPatch(input, PROPERTY_FIELDS)
  if (columns.length > 0) {
    await db.run(`UPDATE properties SET ${columns.join(', ')}, updated_at = ? WHERE id = ?`, [...values, nowIso(), id])
  }
  const property = await getProperty(db, id)
  if (property) await touchSurvey(db, property.surveyId)
  return property
}

export async function deleteProperty(db, id) {
  const property = await getProperty(db, id)
  const { changes } = await db.run('DELETE FROM properties WHERE id = ?', [id])
  if (changes > 0 && property) await touchSurvey(db, property.surveyId)
  return changes > 0
}

/** Writes the tour order atomically so a partial reorder cannot stick. */
export async function setTourOrder(db, surveyId, orderedIds) {
  await db.batch([
    ['UPDATE properties SET tour_order = NULL WHERE survey_id = ?', [surveyId]],
    ...orderedIds.map((id, index) => [
      'UPDATE properties SET tour_order = ? WHERE id = ? AND survey_id = ?',
      [index, id, surveyId],
    ]),
  ])
  return listProperties(db, surveyId)
}

/**
 * Turns sharing on or off, and optionally mints a fresh token so an old link
 * a client still has stops working.
 */
export async function updateShare(db, surveyId, { enabled, expiresAt, regenerate } = {}) {
  const updates = []
  const values = []

  if (typeof enabled === 'boolean') {
    updates.push('share_enabled = ?')
    values.push(enabled ? 1 : 0)
  }
  if (regenerate) {
    updates.push('share_token = ?')
    values.push(newShareToken())
  }
  if (expiresAt !== undefined) {
    const parsed = expiresAt ? new Date(expiresAt) : null
    updates.push('share_expires_at = ?')
    values.push(parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null)
  }

  if (updates.length > 0) {
    await db.run(`UPDATE surveys SET ${updates.join(', ')}, updated_at = ? WHERE id = ?`, [...values, nowIso(), surveyId])
  }
  return getSurvey(db, surveyId)
}

/**
 * Resolves a public share link.
 * Returns a reason rather than throwing, so the client view can explain itself.
 */
export async function resolveShare(db, token) {
  const row = await db.get('SELECT * FROM surveys WHERE share_token = ?', [token])
  if (!row) return { ok: false, reason: 'not_found' }
  if (!toBool(row.share_enabled)) return { ok: false, reason: 'disabled' }
  if (row.share_expires_at && new Date(row.share_expires_at).getTime() < Date.now()) {
    return { ok: false, reason: 'expired' }
  }

  const survey = mapSurvey(row)
  return {
    ok: true,
    // A client link must never leak the token or the internal survey id.
    survey: {
      name: survey.name,
      clientName: survey.clientName,
      brokerName: survey.brokerName,
      companyName: survey.companyName,
      brandColor: survey.brandColor,
      center: survey.center,
      zoom: survey.zoom,
      expiresAt: survey.share.expiresAt,
    },
    properties: (await listProperties(db, row.id))
      // What the broker hid, the client never receives — filtered here rather
      // than in the client view, so it is not merely invisible but absent.
      .filter((property) => !property.hidden)
      .map(({ surveyId, notes, hidden, ...rest }) => rest),
  }
}
