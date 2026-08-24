/**
 * Migrating a database that already holds rows.
 *
 * The deployed D1 database was created before stages and custom fields
 * existed. Applying the schema to it must add the missing columns without
 * touching the properties already stored — a blind `ALTER TABLE` would throw
 * on the second boot, and a `DROP`/recreate would lose real work.
 */

import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test, { describe } from 'node:test'

import { nodeAdapter } from '../app/lib/sql.js'
import { COLUMN_ADDITIONS } from '../app/lib/schema.js'

/** The schema exactly as it shipped before stages existed. */
const ORIGINAL_SCHEMA = `
  CREATE TABLE surveys (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    client_name      TEXT,
    broker_name      TEXT,
    company_name     TEXT,
    brand_color      TEXT NOT NULL DEFAULT '#14b8a6',
    center_lat       REAL,
    center_lng       REAL,
    zoom             INTEGER NOT NULL DEFAULT 11,
    share_token      TEXT UNIQUE,
    share_enabled    INTEGER NOT NULL DEFAULT 0,
    share_expires_at TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  );
  CREATE TABLE properties (
    id             TEXT PRIMARY KEY,
    survey_id      TEXT NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    name           TEXT,
    address        TEXT,
    city           TEXT,
    state          TEXT,
    zip            TEXT,
    lat            REAL,
    lng            REAL,
    stage          TEXT NOT NULL DEFAULT 'prospect',
    rent_rate      REAL,
    rent_unit      TEXT,
    nnn            REAL,
    size_sqft      INTEGER,
    acreage        REAL,
    parking_spaces INTEGER,
    zoning         TEXT,
    year_built     INTEGER,
    availability   TEXT,
    listing_broker TEXT,
    notes          TEXT,
    flyer_path     TEXT,
    flyer_name     TEXT,
    photo_path     TEXT,
    tour_order     INTEGER,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );
`

function legacyDatabase() {
  const database = new DatabaseSync(':memory:')
  database.exec(ORIGINAL_SCHEMA)
  database
    .prepare(
      `INSERT INTO surveys (id, name, brand_color, zoom, created_at, updated_at)
       VALUES ('s1', 'Existing survey', '#14b8a6', 11, '2026-01-01', '2026-01-01')`,
    )
    .run()
  database
    .prepare(
      `INSERT INTO properties (id, survey_id, name, address, lat, lng, stage, created_at, updated_at)
       VALUES ('p1', 's1', 'Existing site', '1 Main St', 32.78, -96.79, 'touring', '2026-01-01', '2026-01-01')`,
    )
    .run()
  return database
}

function columnsOf(database, table) {
  return new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name))
}

describe('migrating an existing database', () => {
  test('adds every new column to a database created before they existed', async () => {
    const database = legacyDatabase()
    await nodeAdapter(database).migrate()

    for (const [table, column] of COLUMN_ADDITIONS) {
      assert.ok(
        columnsOf(database, table).has(column),
        `${table}.${column} should have been added`,
      )
    }
  })

  test('keeps the rows that were already there', async () => {
    const database = legacyDatabase()
    await nodeAdapter(database).migrate()

    const property = database.prepare('SELECT * FROM properties WHERE id = ?').get('p1')
    assert.equal(property.name, 'Existing site')
    assert.equal(property.address, '1 Main St')
    assert.equal(property.stage, 'touring')
    // Pre-existing sites are unstaged until the broker files them.
    assert.equal(property.stage_id, null)

    const survey = database.prepare('SELECT * FROM surveys WHERE id = ?').get('s1')
    assert.equal(survey.name, 'Existing survey')
  })

  test('creates the tables that did not exist at all', async () => {
    const database = legacyDatabase()
    await nodeAdapter(database).migrate()

    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name)
    assert.ok(tables.includes('stages'))
    assert.ok(tables.includes('property_fields'))
  })

  test('is safe to run repeatedly, as it is on every boot', async () => {
    const database = legacyDatabase()
    const adapter = nodeAdapter(database)
    await adapter.migrate()
    await adapter.migrate()
    await adapter.migrate()

    // Still one column each, and the row survived all three passes.
    assert.equal(columnsOf(database, 'properties').has('stage_id'), true)
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM properties').get().n, 1)
  })
})
