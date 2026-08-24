/**
 * Storage.
 *
 * A survey is a set of candidate properties a broker is walking a client
 * through, so the whole dataset is small and relational — SQLite through the
 * built-in `node:sqlite` module, no dependency and no server to run.
 */

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID, randomBytes } from 'node:crypto'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS surveys (
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

CREATE TABLE IF NOT EXISTS properties (
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

CREATE INDEX IF NOT EXISTS idx_properties_survey ON properties(survey_id);
CREATE INDEX IF NOT EXISTS idx_surveys_share ON surveys(share_token);
`

let database = null

export function dataDir() {
  return process.env.DATA_DIR || path.join(process.cwd(), 'data')
}

export function uploadsDir() {
  const directory = path.join(dataDir(), 'uploads')
  fs.mkdirSync(directory, { recursive: true })
  return directory
}

export function db() {
  if (database) return database
  fs.mkdirSync(dataDir(), { recursive: true })
  const file = process.env.DB_FILE || path.join(dataDir(), 'sitemap.db')
  database = new DatabaseSync(file)
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec('PRAGMA foreign_keys = ON;')
  database.exec(SCHEMA)
  return database
}

/** Used by tests to run against a throwaway file. */
export function resetDb() {
  if (database) database.close()
  database = null
}

export function newId() {
  return randomUUID().slice(0, 12)
}

export function newShareToken() {
  return randomBytes(16).toString('hex')
}

export function nowIso() {
  return new Date().toISOString()
}

/** SQLite has no booleans; normalize on the way out. */
export function toBool(value) {
  return value === 1 || value === true
}
