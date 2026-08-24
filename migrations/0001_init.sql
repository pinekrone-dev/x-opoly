-- Generated from app/lib/schema.js — edit that file, then re-run: npm run migrations

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
