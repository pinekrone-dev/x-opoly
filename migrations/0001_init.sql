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

CREATE TABLE IF NOT EXISTS stages (
    id         TEXT PRIMARY KEY,
    survey_id  TEXT NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    color      TEXT NOT NULL DEFAULT '#eab308',
    position   INTEGER NOT NULL DEFAULT 0,
    hidden     INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

CREATE TABLE IF NOT EXISTS property_fields (
    id          TEXT PRIMARY KEY,
    property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    label       TEXT NOT NULL,
    value       TEXT,
    position    INTEGER NOT NULL DEFAULT 0
  );

CREATE TABLE IF NOT EXISTS property_images (
    id          TEXT PRIMARY KEY,
    property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    path        TEXT NOT NULL,
    caption     TEXT,
    position    INTEGER NOT NULL DEFAULT 0,
    source      TEXT,
    created_at  TEXT NOT NULL
  );

CREATE TABLE IF NOT EXISTS users (
    id             TEXT PRIMARY KEY,
    email          TEXT NOT NULL UNIQUE,
    password_hash  TEXT NOT NULL,
    name           TEXT,
    phone          TEXT,
    sms_2fa        INTEGER NOT NULL DEFAULT 0,
    failed_logins  INTEGER NOT NULL DEFAULT 0,
    locked_until   TEXT,
    created_at     TEXT NOT NULL,
    last_login_at  TEXT
  );

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

CREATE TABLE IF NOT EXISTS login_challenges (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_salt  TEXT NOT NULL,
    code_hash  TEXT NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

CREATE TABLE IF NOT EXISTS invites (
    id           TEXT PRIMARY KEY,
    email        TEXT NOT NULL,
    token_digest TEXT NOT NULL,
    created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    used_at      TEXT
  );

CREATE INDEX IF NOT EXISTS idx_properties_survey ON properties(survey_id);

CREATE INDEX IF NOT EXISTS idx_surveys_share ON surveys(share_token);

CREATE INDEX IF NOT EXISTS idx_stages_survey ON stages(survey_id);

CREATE INDEX IF NOT EXISTS idx_property_fields_property ON property_fields(property_id);

CREATE INDEX IF NOT EXISTS idx_property_images_property ON property_images(property_id);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE INDEX IF NOT EXISTS idx_invites_digest ON invites(token_digest);

CREATE INDEX IF NOT EXISTS idx_challenges_user ON login_challenges(user_id);
