/**
 * The provider store: NPPES mirrored into SQLite, NUCC as a lookup table,
 * practice points, and each point's parcel.
 *
 * A separate file from the app's database on purpose. NPPES is eight million
 * rows and gigabytes of text; the app's D1 holds a team's surveys and CRM,
 * measured in kilobytes. What the app needs from this store is a per-market
 * layer file, published through the same door the parcel pipeline uses.
 *
 * Rules kept here, not just in a document:
 *   - The mailing address of an individual (entity type 1) is never stored.
 *     It is frequently a home. Only the practice location is kept for people;
 *     organisations keep both.
 *   - Ownership is never taken from NPPES. The `provider_parcels` table holds
 *     what the county roll says about the parcel under a practice point, and
 *     a point with no parcel stays `unmatched`.
 */

import { DatabaseSync } from 'node:sqlite'
import { createReadStream } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { parseCsvRecords } from './csv.mjs'
import { ParcelIndex } from './geo.mjs'
import { geocodeBatch, BATCH_LIMIT } from './census-geocoder.mjs'

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS nucc_taxonomy (
     code TEXT PRIMARY KEY, grouping TEXT, classification TEXT, specialization TEXT,
     definition TEXT, effective_date TEXT, deactivation_date TEXT, last_modified TEXT,
     display_name TEXT, section TEXT, version TEXT, license TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS providers (
     npi TEXT PRIMARY KEY,
     entity_type INTEGER,
     org_name TEXT, org_other_name TEXT,
     last_name TEXT, first_name TEXT, credential TEXT,
     practice_address1 TEXT, practice_address2 TEXT, practice_city TEXT, practice_state TEXT,
     practice_zip TEXT, practice_country TEXT, practice_phone TEXT,
     mailing_address1 TEXT, mailing_address2 TEXT, mailing_city TEXT, mailing_state TEXT, mailing_zip TEXT,
     primary_taxonomy TEXT,
     enumeration_date TEXT, last_update TEXT, deactivation_date TEXT, reactivation_date TEXT,
     sole_proprietor TEXT, org_subpart TEXT, parent_org_lbn TEXT,
     address_key TEXT,
     source_file TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS provider_taxonomies (
     npi TEXT NOT NULL, code TEXT NOT NULL, is_primary INTEGER NOT NULL DEFAULT 0,
     license TEXT, license_state TEXT,
     PRIMARY KEY (npi, code)
   )`,
  `CREATE TABLE IF NOT EXISTS geocode_cache (
     address_key TEXT PRIMARY KEY, lat REAL, lng REAL, indicator TEXT, match_type TEXT,
     matched_address TEXT, tract TEXT, fetched_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS provider_parcels (
     npi TEXT NOT NULL, market TEXT NOT NULL,
     parcel_id TEXT, owner_name TEXT, owner_mailing TEXT, assessed_value REAL, asset_type TEXT,
     match TEXT NOT NULL, matched_at TEXT NOT NULL,
     PRIMARY KEY (npi, market)
   )`,
  `CREATE TABLE IF NOT EXISTS load_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, file TEXT NOT NULL,
     rows INTEGER NOT NULL, deactivated INTEGER NOT NULL DEFAULT 0, applied_at TEXT NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS idx_providers_state_zip ON providers(practice_state, practice_zip)',
  'CREATE INDEX IF NOT EXISTS idx_providers_address_key ON providers(address_key)',
  'CREATE INDEX IF NOT EXISTS idx_providers_primary ON providers(primary_taxonomy)',
  'CREATE INDEX IF NOT EXISTS idx_taxonomies_code ON provider_taxonomies(code)',
  'CREATE INDEX IF NOT EXISTS idx_cache_point ON geocode_cache(lat, lng)',
  'CREATE INDEX IF NOT EXISTS idx_parcels_market ON provider_parcels(market, match)',
]

export function openProviders(file) {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  for (const statement of SCHEMA) db.exec(statement)
  return db
}

const nowIso = () => new Date().toISOString()

/** Address, flattened for matching and for the geocode cache key. */
export function addressKey({ address1, city, state, zip }) {
  const zip5 = String(zip ?? '').replace(/\D/g, '').slice(0, 5)
  return [address1, city, state, zip5]
    .map((part) => String(part ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())
    .filter(Boolean)
    .join('|')
}

// --- NUCC -------------------------------------------------------------------

/**
 * Loads the taxonomy CSV. Columns are matched by name because NUCC has added
 * columns over the years (Display Name, Section) without renaming the rest.
 */
export async function loadNucc(db, source, { version = null, license = null, file = 'nucc' } = {}) {
  const pick = (record, ...names) => {
    for (const name of names) {
      const key = Object.keys(record).find((k) => k.toLowerCase() === name.toLowerCase())
      if (key != null && record[key] !== '') return record[key]
    }
    return null
  }
  const insert = db.prepare(
    `INSERT OR REPLACE INTO nucc_taxonomy
       (code, grouping, classification, specialization, definition, effective_date, deactivation_date, last_modified, display_name, section, version, license)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  let rows = 0
  db.exec('BEGIN')
  try {
    for await (const record of parseCsvRecords(source)) {
      const code = pick(record, 'Code')
      if (!code) continue
      insert.run(
        code,
        pick(record, 'Grouping'),
        pick(record, 'Classification'),
        pick(record, 'Specialization'),
        pick(record, 'Definition'),
        pick(record, 'Effective Date'),
        pick(record, 'Deactivation Date'),
        pick(record, 'Last Modified Date'),
        pick(record, 'Display Name'),
        pick(record, 'Section'),
        version,
        license,
      )
      rows += 1
    }
    db.prepare('INSERT INTO load_log (source, file, rows, applied_at) VALUES (?, ?, ?, ?)').run('nucc', file, rows, nowIso())
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return { rows }
}

// --- NPPES ------------------------------------------------------------------

const TAXONOMY_SLOTS = 15

/** Opens the data file inside an NPPES zip without extracting nine gigabytes. */
export function openNppesSource(file) {
  if (!file.toLowerCase().endsWith('.zip')) return createReadStream(file)
  // The archive holds npidata_pfile_<from>-<to>.csv plus a *_fileheader.csv
  // that is only the header line; the others (othername, pl, endpoint) are
  // separate tables and not read here.
  const child = spawn('unzip', ['-p', file, 'npidata_pfile_*.csv', '-x', '*fileheader*'], { stdio: ['ignore', 'pipe', 'inherit'] })
  child.on('error', (error) => child.stdout.destroy(error))
  return child.stdout
}

/**
 * Streams an NPPES data file into the store.
 *
 * The same code serves the monthly full replacement and the weekly
 * incrementals: every row is an upsert by NPI, and a row that carries only
 * a deactivation date is a deactivation. `replace: true` clears the provider
 * tables first, which is what a monthly file means.
 *
 * `states` restricts what is stored to practice locations in those states,
 * for a deployment that only ever serves a few markets.
 */
export async function loadNppes(db, source, { file = 'nppes', replace = false, states = null, onProgress = null } = {}) {
  const keep = states ? new Set(states.map((s) => s.toUpperCase())) : null

  const upsert = db.prepare(
    `INSERT OR REPLACE INTO providers (
       npi, entity_type, org_name, org_other_name, last_name, first_name, credential,
       practice_address1, practice_address2, practice_city, practice_state, practice_zip, practice_country, practice_phone,
       mailing_address1, mailing_address2, mailing_city, mailing_state, mailing_zip,
       primary_taxonomy, enumeration_date, last_update, deactivation_date, reactivation_date,
       sole_proprietor, org_subpart, parent_org_lbn, address_key, source_file
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const deactivate = db.prepare(
    'UPDATE providers SET deactivation_date = ?, last_update = ?, source_file = ? WHERE npi = ?',
  )
  const clearTaxonomies = db.prepare('DELETE FROM provider_taxonomies WHERE npi = ?')
  const insertTaxonomy = db.prepare(
    'INSERT OR REPLACE INTO provider_taxonomies (npi, code, is_primary, license, license_state) VALUES (?, ?, ?, ?, ?)',
  )
  const dropPoints = db.prepare('DELETE FROM provider_parcels WHERE npi = ?')

  let rows = 0
  let stored = 0
  let deactivated = 0
  let skipped = 0

  const blank = (value) => (value == null || value === '' ? null : value)

  db.exec('BEGIN')
  try {
    if (replace) {
      db.exec('DELETE FROM provider_taxonomies')
      db.exec('DELETE FROM providers')
    }
    for await (const r of parseCsvRecords(source)) {
      const npi = r['NPI']
      if (!npi) continue
      rows += 1

      const entityType = blank(r['Entity Type Code'])
      const deactivationDate = blank(r['NPI Deactivation Date'])
      if (!entityType) {
        // A deactivation-only row: no entity, no address, just the date.
        if (deactivationDate) {
          const result = deactivate.run(deactivationDate, blank(r['Last Update Date']), file, npi)
          if (result.changes > 0) {
            clearTaxonomies.run(npi)
            dropPoints.run(npi)
          }
          deactivated += 1
        }
        continue
      }

      const state = blank(r['Provider Business Practice Location Address State Name'])
      if (keep && !keep.has(String(state ?? '').toUpperCase())) {
        skipped += 1
        continue
      }

      const type = Number(entityType)
      const isOrg = type === 2
      const address1 = blank(r['Provider First Line Business Practice Location Address'])
      const city = blank(r['Provider Business Practice Location Address City Name'])
      const zip = blank(r['Provider Business Practice Location Address Postal Code'])

      let primary = null
      const taxonomies = []
      for (let n = 1; n <= TAXONOMY_SLOTS; n++) {
        const code = blank(r[`Healthcare Provider Taxonomy Code_${n}`])
        if (!code) continue
        const isPrimary = String(r[`Healthcare Provider Primary Taxonomy Switch_${n}`] ?? '').toUpperCase() === 'Y'
        if (isPrimary && !primary) primary = code
        taxonomies.push([code, isPrimary ? 1 : 0, blank(r[`Provider License Number_${n}`]), blank(r[`Provider License Number State Code_${n}`])])
      }
      if (!primary && taxonomies.length > 0) primary = taxonomies[0][0]

      upsert.run(
        npi,
        type,
        blank(r['Provider Organization Name (Legal Business Name)']),
        blank(r['Provider Other Organization Name']),
        blank(r['Provider Last Name (Legal Name)']),
        blank(r['Provider First Name']),
        blank(r['Provider Credential Text']),
        address1,
        blank(r['Provider Second Line Business Practice Location Address']),
        city,
        state,
        zip,
        blank(r['Provider Business Practice Location Address Country Code (If outside U.S.)']),
        blank(r['Provider Business Practice Location Address Telephone Number']),
        // Organisations keep a mailing address; people never do. A person's
        // mailing address is very often a home, and no table here may become
        // a list of where clinicians live.
        isOrg ? blank(r['Provider First Line Business Mailing Address']) : null,
        isOrg ? blank(r['Provider Second Line Business Mailing Address']) : null,
        isOrg ? blank(r['Provider Business Mailing Address City Name']) : null,
        isOrg ? blank(r['Provider Business Mailing Address State Name']) : null,
        isOrg ? blank(r['Provider Business Mailing Address Postal Code']) : null,
        primary,
        blank(r['Provider Enumeration Date']),
        blank(r['Last Update Date']),
        deactivationDate,
        blank(r['NPI Reactivation Date']),
        blank(r['Is Sole Proprietor']),
        blank(r['Is Organization Subpart']),
        blank(r['Parent Organization LBN']),
        addressKey({ address1, city, state, zip }),
        file,
      )
      clearTaxonomies.run(npi)
      for (const [code, isPrimary, license, licenseState] of taxonomies) {
        insertTaxonomy.run(npi, code, isPrimary, license, licenseState)
      }
      stored += 1

      if (onProgress && rows % 100000 === 0) onProgress({ rows, stored, deactivated, skipped })
    }
    db.prepare('INSERT INTO load_log (source, file, rows, deactivated, applied_at) VALUES (?, ?, ?, ?, ?)').run(
      replace ? 'nppes-monthly' : 'nppes-weekly',
      file,
      stored,
      deactivated,
      nowIso(),
    )
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return { rows, stored, deactivated, skipped }
}

export function alreadyLoaded(db, file) {
  return Boolean(db.prepare('SELECT 1 FROM load_log WHERE file = ? LIMIT 1').get(file))
}

// --- geocoding --------------------------------------------------------------

/**
 * Geocodes every active provider whose practice address is not yet in the
 * cache. Addresses are de-duplicated first — a medical office building holds
 * dozens of NPIs — so the geocoder is asked once per address, not per NPI.
 */
export async function geocodeProviders(db, { states = null, zips = null, limit = null, batch = 5000, fetchImpl = fetch, onProgress = null } = {}) {
  const clauses = ['p.deactivation_date IS NULL', 'p.address_key IS NOT NULL', "p.address_key <> ''", 'c.address_key IS NULL']
  const params = []
  if (states?.length) {
    clauses.push(`p.practice_state IN (${states.map(() => '?').join(', ')})`)
    params.push(...states.map((s) => s.toUpperCase()))
  }
  if (zips?.length) {
    clauses.push(`(${zips.map(() => 'p.practice_zip LIKE ?').join(' OR ')})`)
    params.push(...zips.map((z) => `${z}%`))
  }
  const rows = db
    .prepare(
      `SELECT p.address_key, MIN(p.practice_address1) AS street, MIN(p.practice_city) AS city,
              MIN(p.practice_state) AS state, MIN(substr(p.practice_zip, 1, 5)) AS zip
         FROM providers p LEFT JOIN geocode_cache c ON c.address_key = p.address_key
        WHERE ${clauses.join(' AND ')}
        GROUP BY p.address_key
        ${limit ? `LIMIT ${Number(limit)}` : ''}`,
    )
    .all(...params)

  const store = db.prepare(
    `INSERT OR REPLACE INTO geocode_cache (address_key, lat, lng, indicator, match_type, matched_address, tract, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const size = Math.min(Math.max(1, batch), BATCH_LIMIT)
  let sent = 0
  let matched = 0
  for (let at = 0; at < rows.length; at += size) {
    const slice = rows.slice(at, at + size)
    const results = await geocodeBatch(
      slice.map((row, index) => ({ id: String(index), street: row.street, city: row.city, state: row.state, zip: row.zip })),
      { fetchImpl },
    )
    db.exec('BEGIN')
    try {
      slice.forEach((row, index) => {
        const result = results.get(String(index))
        if (!result) return
        store.run(row.address_key, result.lat, result.lng, result.indicator, result.matchType, result.matched, result.tract, nowIso())
        if (result.lat != null) matched += 1
      })
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    sent += slice.length
    if (onProgress) onProgress({ sent, total: rows.length, matched })
  }
  return { addresses: rows.length, sent, matched }
}

// --- parcels ----------------------------------------------------------------

/** Which GeoJSON property holds what, per the pipeline's short keys. */
export const PARCEL_KEYS = {
  id: ['id', '_id', 'gid', 'apn', 'APN', 'parcel_id'],
  owner: ['ow', 'owner', 'owner_name'],
  mailing: ['ma', 'mailing', 'owner_mailing'],
  value: ['mv', 'as', 'fc', 'jv', 'tv', 'value'],
  assetType: ['at', 'asset_type', 'use'],
}

function firstOf(properties, keys) {
  for (const key of keys) if (properties?.[key] != null && properties[key] !== '') return properties[key]
  return null
}

/**
 * Joins every geocoded practice point inside the market's envelope to the
 * parcel under it. Points with no parcel are written as `unmatched`; points
 * outside the envelope belong to no market and are not written.
 */
export function joinParcels(db, market, features, { idKey = null } = {}) {
  const index = new ParcelIndex(features)
  const idKeys = idKey ? [idKey, ...PARCEL_KEYS.id] : PARCEL_KEYS.id
  const [minX, minY, maxX, maxY] = index.bbox

  const points = db
    .prepare(
      `SELECT p.npi, c.lat, c.lng
         FROM providers p JOIN geocode_cache c ON c.address_key = p.address_key
        WHERE p.deactivation_date IS NULL AND c.lat IS NOT NULL
          AND c.lng BETWEEN ? AND ? AND c.lat BETWEEN ? AND ?`,
    )
    .all(minX, maxX, minY, maxY)

  const write = db.prepare(
    `INSERT OR REPLACE INTO provider_parcels (npi, market, parcel_id, owner_name, owner_mailing, assessed_value, asset_type, match, matched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  let matched = 0
  let unmatched = 0
  const stamp = nowIso()
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM provider_parcels WHERE market = ?').run(market)
    for (const point of points) {
      const parcel = index.find(point.lng, point.lat)
      if (!parcel) {
        write.run(point.npi, market, null, null, null, null, null, 'unmatched', stamp)
        unmatched += 1
        continue
      }
      const props = parcel.properties ?? {}
      const value = Number(firstOf(props, PARCEL_KEYS.value))
      write.run(
        point.npi,
        market,
        String(firstOf(props, idKeys) ?? ''),
        firstOf(props, PARCEL_KEYS.owner),
        firstOf(props, PARCEL_KEYS.mailing),
        Number.isFinite(value) ? value : null,
        firstOf(props, PARCEL_KEYS.assetType),
        'point-in-parcel',
        stamp,
      )
      matched += 1
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return { parcels: index.size, points: points.length, matched, unmatched }
}

// --- export -----------------------------------------------------------------

/**
 * The lead layer for one market, in the shape the app's layer catalog reads.
 *
 * One feature per active provider with a point in the market. Properties are
 * labelled the way the catalog labels them, because the app shows the
 * catalog's `fields` by name. Ownership comes only from `provider_parcels`;
 * an unmatched practice shows an empty owner, never a guessed one.
 */
export function exportLayer(db, market) {
  const rows = db
    .prepare(
      `SELECT p.npi, p.entity_type, p.org_name, p.first_name, p.last_name, p.credential,
              p.practice_address1, p.practice_city, p.practice_state, substr(p.practice_zip, 1, 5) AS zip,
              p.practice_phone, p.primary_taxonomy, p.address_key,
              c.lat, c.lng,
              t.classification, t.specialization, t.grouping,
              j.parcel_id, j.owner_name, j.owner_mailing, j.assessed_value, j.asset_type, j.match,
              (SELECT COUNT(*) FROM providers q WHERE q.address_key = p.address_key AND q.deactivation_date IS NULL) AS clinicians
         FROM providers p
         JOIN geocode_cache c ON c.address_key = p.address_key
         JOIN provider_parcels j ON j.npi = p.npi AND j.market = ?
         LEFT JOIN nucc_taxonomy t ON t.code = p.primary_taxonomy
        WHERE p.deactivation_date IS NULL AND c.lat IS NOT NULL
        ORDER BY p.address_key, p.entity_type DESC, p.npi`,
    )
    .all(market)

  const features = rows.map((row) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [row.lng, row.lat] },
    properties: {
      NPI: row.npi,
      Practice: row.entity_type === 2 ? row.org_name : [row.first_name, row.last_name].filter(Boolean).join(' '),
      Kind: row.entity_type === 2 ? 'Organization' : 'Individual',
      Specialty: row.specialization || row.classification || row.primary_taxonomy || '',
      Classification: row.classification || '',
      Address: [row.practice_address1, row.practice_city, row.practice_state, row.zip].filter(Boolean).join(', '),
      Phone: row.practice_phone || '',
      Clinicians: row.clinicians,
      Parcel: row.parcel_id || '',
      'Owner of record': row.owner_name || '',
      'Owner mailing': row.owner_mailing || '',
      'Assessed value': row.assessed_value,
      'Parcel use': row.asset_type || '',
      Match: row.match,
    },
  }))

  const tally = (field) => {
    const counts = new Map()
    for (const feature of features) {
      const value = feature.properties[field]
      if (value == null || value === '') continue
      counts.set(value, (counts.get(value) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }

  const entry = {
    id: 'healthcare',
    label: 'Healthcare practices',
    note: 'NPPES practice locations joined to the parcel under each point',
    kind: 'point',
    color: '#0c8599',
    file: 'layer-healthcare.geojson',
    count: features.length,
    total: features.length,
    filter: 'active NPIs with a geocoded practice address in this market',
    attribution: 'CMS NPPES, NUCC taxonomy, county assessor roll',
    fields: ['Practice', 'Specialty', 'Clinicians', 'Address', 'Phone', 'Parcel', 'Owner of record', 'Owner mailing', 'Assessed value', 'Match'],
    categories: [
      { field: 'Match', values: tally('Match') },
      { field: 'Classification', values: tally('Classification').slice(0, 60) },
      { field: 'Kind', values: tally('Kind') },
    ],
  }

  return { collection: { type: 'FeatureCollection', features }, entry }
}

// --- status -----------------------------------------------------------------

export function status(db) {
  const one = (sql, ...params) => Number(db.prepare(sql).get(...params)?.n ?? 0)
  return {
    taxonomy: one('SELECT COUNT(*) AS n FROM nucc_taxonomy'),
    providers: one('SELECT COUNT(*) AS n FROM providers'),
    active: one('SELECT COUNT(*) AS n FROM providers WHERE deactivation_date IS NULL'),
    deactivated: one('SELECT COUNT(*) AS n FROM providers WHERE deactivation_date IS NOT NULL'),
    organisations: one('SELECT COUNT(*) AS n FROM providers WHERE entity_type = 2 AND deactivation_date IS NULL'),
    individualMailingAddresses: one('SELECT COUNT(*) AS n FROM providers WHERE entity_type = 1 AND mailing_address1 IS NOT NULL'),
    addresses: one("SELECT COUNT(DISTINCT address_key) AS n FROM providers WHERE deactivation_date IS NULL AND address_key <> ''"),
    geocoded: one('SELECT COUNT(*) AS n FROM geocode_cache WHERE lat IS NOT NULL'),
    geocodeMisses: one('SELECT COUNT(*) AS n FROM geocode_cache WHERE lat IS NULL'),
    markets: db.prepare(
      `SELECT market, SUM(match = 'point-in-parcel') AS matched, SUM(match = 'unmatched') AS unmatched
         FROM provider_parcels GROUP BY market ORDER BY market`,
    ).all(),
    loads: db.prepare('SELECT source, file, rows, deactivated, applied_at FROM load_log ORDER BY id').all(),
  }
}

export function defaultDbPath(cwd = process.cwd()) {
  return path.join(cwd, 'data', 'providers.db')
}
