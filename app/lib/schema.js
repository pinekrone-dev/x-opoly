/**
 * The schema, as a list of statements.
 *
 * Kept as data rather than one blob so it can be applied by either runtime:
 * `node:sqlite` executes it directly, and D1 takes one statement per call.
 * D1 is SQLite, so the same DDL serves both.
 */
export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS surveys (
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
  )`,
  `CREATE TABLE IF NOT EXISTS properties (
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
  )`,
  `CREATE TABLE IF NOT EXISTS stages (
    id         TEXT PRIMARY KEY,
    survey_id  TEXT NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    color      TEXT NOT NULL DEFAULT '#eab308',
    position   INTEGER NOT NULL DEFAULT 0,
    hidden     INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS property_fields (
    id          TEXT PRIMARY KEY,
    property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    label       TEXT NOT NULL,
    value       TEXT,
    position    INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS property_images (
    id          TEXT PRIMARY KEY,
    property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    path        TEXT NOT NULL,
    caption     TEXT,
    position    INTEGER NOT NULL DEFAULT 0,
    source      TEXT,
    created_at  TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id             TEXT PRIMARY KEY,
    email          TEXT NOT NULL UNIQUE,
    password_hash  TEXT NOT NULL,
    name           TEXT,
    phone          TEXT,
    sms_2fa        INTEGER NOT NULL DEFAULT 0,
    team_id        TEXT,
    verified       INTEGER NOT NULL DEFAULT 1,
    verify_digest  TEXT,
    verify_expires TEXT,
    failed_logins  INTEGER NOT NULL DEFAULT 0,
    locked_until   TEXT,
    created_at     TEXT NOT NULL,
    last_login_at  TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS login_challenges (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_salt  TEXT NOT NULL,
    code_hash  TEXT NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  // One Stripe subscription per team. The row is written from checkout
  // confirmation or the webhook, and lazily re-checked against Stripe when
  // the paid period lapses — so billing stays honest even with no webhook
  // configured at all.
  `CREATE TABLE IF NOT EXISTS billing (
    team_id            TEXT PRIMARY KEY,
    customer_id        TEXT,
    subscription_id    TEXT,
    status             TEXT NOT NULL DEFAULT 'none',
    current_period_end TEXT,
    updated_at         TEXT NOT NULL
  )`,

  // One-time signup links for collaborators. The token is stored as a digest,
  // like sessions: a leaked database must not mint working invitations.
  `CREATE TABLE IF NOT EXISTS invites (
    id           TEXT PRIMARY KEY,
    email        TEXT NOT NULL,
    token_digest TEXT NOT NULL,
    created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    used_at      TEXT
  )`,

  // Labelled radius circles — a non-compete around an anchor tenant, a
  // delivery boundary, a "client will not cross this road" line. Drawn on the
  // broker's map and the client's alike.
  /*
   * The CRM side of the workspace: who, where, and what is happening between
   * them. A survey is one deal's map; these are the records that outlive it.
   *
   * People and companies are separate tables rather than one "contact" with a
   * type flag. A person changes employer, a company outlives its people, and
   * a deal routinely needs both — collapsing them makes every one of those
   * cases an edit to the same row.
   */
  `CREATE TABLE IF NOT EXISTS companies (
    id         TEXT PRIMARY KEY,
    team_id    TEXT NOT NULL,
    name       TEXT NOT NULL,
    industry   TEXT,
    website    TEXT,
    phone      TEXT,
    address    TEXT,
    city       TEXT,
    state      TEXT,
    zip        TEXT,
    notes      TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS people (
    id         TEXT PRIMARY KEY,
    team_id    TEXT NOT NULL,
    company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
    first_name TEXT,
    last_name  TEXT,
    email      TEXT,
    phone      TEXT,
    title      TEXT,
    notes      TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  /*
   * A place is a building the team knows about, independent of any survey.
   * Sending one into a survey copies it to a property: the survey is a
   * snapshot the broker then annotates and shares, and editing that must not
   * rewrite the record the whole team relies on.
   */
  `CREATE TABLE IF NOT EXISTS places (
    id               TEXT PRIMARY KEY,
    team_id          TEXT NOT NULL,
    name             TEXT,
    address          TEXT,
    city             TEXT,
    state            TEXT,
    zip              TEXT,
    lat              REAL,
    lng              REAL,
    property_type    TEXT,
    size_sqft        INTEGER,
    acreage          REAL,
    availability     TEXT,
    asking_rate      REAL,
    rate_unit        TEXT,
    owner_company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
    notes            TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS deals (
    id         TEXT PRIMARY KEY,
    team_id    TEXT NOT NULL,
    name       TEXT NOT NULL,
    kind       TEXT,
    stage      TEXT NOT NULL DEFAULT 'prospect',
    value      REAL,
    close_date TEXT,
    survey_id  TEXT REFERENCES surveys(id) ON DELETE SET NULL,
    notes      TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  /*
   * What makes a deal a deal: people, companies and places brought together,
   * each in a named role. One row per participant rather than columns, so a
   * deal can hold three candidate sites and two decision makers without the
   * schema having an opinion about how many of each there may be.
   */
  `CREATE TABLE IF NOT EXISTS deal_parties (
    id         TEXT PRIMARY KEY,
    deal_id    TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    ref_id     TEXT NOT NULL,
    role       TEXT,
    created_at TEXT NOT NULL
  )`,
  /*
   * Custom profiles, in the shape `property_fields` already uses: a row per
   * field rather than a JSON blob, so a field can be renamed, reordered or
   * queried without rewriting every record that carries it.
   */
  `CREATE TABLE IF NOT EXISTS record_fields (
    id          TEXT PRIMARY KEY,
    record_type TEXT NOT NULL,
    record_id   TEXT NOT NULL,
    label       TEXT NOT NULL,
    value       TEXT,
    position    INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS zones (
    id           TEXT PRIMARY KEY,
    survey_id    TEXT NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    label        TEXT NOT NULL,
    lat          REAL NOT NULL,
    lng          REAL NOT NULL,
    radius_miles REAL NOT NULL,
    color        TEXT NOT NULL DEFAULT '#f59e0b',
    created_at   TEXT NOT NULL
  )`,
  /*
   * Sale comparables the team imported from what their own browser showed
   * them. `team_id` on every row is the whole security model: comps are one
   * broker's collected knowledge, never a shared database, and a listing
   * site's compiled data must not become one here.
   *
   * `placed` is three-valued on purpose. NULL means the address has not been
   * looked up yet and belongs in the geocoding queue; 'geocoded' and 'failed'
   * both mean it has been tried, which is what keeps an unreadable address
   * from costing a lookup on every subsequent pass.
   */
  `CREATE TABLE IF NOT EXISTS comps (
    id             TEXT PRIMARY KEY,
    team_id        TEXT NOT NULL,
    market         TEXT,
    source_key     TEXT NOT NULL,
    address        TEXT,
    name           TEXT,
    price_str      TEXT,
    price          REAL,
    sale_lease     TEXT,
    prop_type      TEXT,
    sqft           REAL,
    acres          REAL,
    units          REAL,
    cap_rate       REAL,
    year_built     REAL,
    price_per_sf   REAL,
    price_per_acre REAL,
    price_per_unit REAL,
    url            TEXT,
    source         TEXT,
    scraped_at     TEXT,
    lat            REAL,
    lng            REAL,
    placed         TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  )`,

  'CREATE INDEX IF NOT EXISTS idx_properties_survey ON properties(survey_id)',
  'CREATE INDEX IF NOT EXISTS idx_surveys_share ON surveys(share_token)',
  'CREATE INDEX IF NOT EXISTS idx_stages_survey ON stages(survey_id)',
  'CREATE INDEX IF NOT EXISTS idx_property_fields_property ON property_fields(property_id)',
  // Every CRM list is "this team's", so that is what the indexes serve.
  'CREATE INDEX IF NOT EXISTS idx_companies_team ON companies(team_id)',
  'CREATE INDEX IF NOT EXISTS idx_people_team ON people(team_id)',
  'CREATE INDEX IF NOT EXISTS idx_people_company ON people(company_id)',
  'CREATE INDEX IF NOT EXISTS idx_places_team ON places(team_id)',
  'CREATE INDEX IF NOT EXISTS idx_deals_team ON deals(team_id)',
  'CREATE INDEX IF NOT EXISTS idx_deal_parties_deal ON deal_parties(deal_id)',
  'CREATE INDEX IF NOT EXISTS idx_record_fields_record ON record_fields(record_type, record_id)',
  'CREATE INDEX IF NOT EXISTS idx_property_images_property ON property_images(property_id)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_invites_digest ON invites(token_digest)',
  'CREATE INDEX IF NOT EXISTS idx_zones_survey ON zones(survey_id)',
  'CREATE INDEX IF NOT EXISTS idx_challenges_user ON login_challenges(user_id)',
  // Re-importing the same page is the normal case, so the dedupe lookup —
  // "has this team seen this listing before" — is the one that must be fast.
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_comps_team_key ON comps(team_id, source_key)',
]

/**
 * Columns added after the first release.
 *
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, and the deployed D1 database
 * already holds rows, so these are applied by comparing against
 * `PRAGMA table_info` rather than by running blind. Adding to this list is the
 * supported way to extend an existing table; editing the CREATE statements
 * above only affects databases created from scratch.
 */
/**
 * Idempotent data repairs, run after the column additions so the columns they
 * touch exist. Each must be a no-op the second time.
 */
export const DATA_FIXES = [
  // Users who joined through an invitation belong to the inviter's team.
  `UPDATE users SET team_id = (
     SELECT COALESCE(u2.team_id, u2.id) FROM invites i JOIN users u2 ON u2.id = i.created_by
     WHERE i.email = users.email AND i.used_at IS NOT NULL LIMIT 1
   )
   WHERE team_id IS NULL AND EXISTS (
     SELECT 1 FROM invites i WHERE i.email = users.email AND i.used_at IS NOT NULL AND i.created_by IS NOT NULL
   )`,
  // Everyone else is their own team.
  'UPDATE users SET team_id = id WHERE team_id IS NULL',
  // Runs here, after the column exists on databases that predate it.
  'CREATE INDEX IF NOT EXISTS idx_users_team ON users(team_id)',
  // Same reason: the parcel columns are additions, so the index that makes
  // "is this parcel already in the CRM" a lookup rather than a scan has to be
  // created after them.
  'CREATE INDEX IF NOT EXISTS idx_places_parcel ON places(team_id, market, parcel_id)',
]

export const COLUMN_ADDITIONS = [
  // A site belongs to a stage by id now, so stages can be renamed and
  // recoloured without rewriting every property. NULL means unstaged.
  ['properties', 'stage_id', 'TEXT'],
  ['properties', 'broker_email', 'TEXT'],
  ['properties', 'broker_phone', 'TEXT'],
  // Minutes to spend at this stop, overriding the tour default.
  ['properties', 'tour_minutes', 'INTEGER'],
  // Which stored image is the hero shot in the tour book.
  ['properties', 'cover_image_id', 'TEXT'],
  // Kept off the client share link. The broker's own map still shows it,
  // dimmed — hiding is about what the client sees, not losing the site.
  ['properties', 'hidden', 'INTEGER NOT NULL DEFAULT 0'],

  // Who a survey belongs to. NULL means it predates accounts existing; the
  // first account to be created adopts those rather than orphaning them.
  ['surveys', 'owner_id', 'TEXT'],

  // An authenticator app as the second factor. Kept alongside SMS rather than
  // replacing it: TOTP needs no carrier and no third party, which is why it is
  // preferred, but a broker who wants a text should still get one.
  // Which team a user belongs to: the team owner's user id. A self-serve
  // account is its own team; redeeming an invite joins the inviter's.
  ['users', 'team_id', 'TEXT'],
  ['users', 'totp_secret', 'TEXT'],
  ['users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0'],

  // Email verification for self-serve signups. The DEFAULT 1 is the
  // grandfathering: every account that existed before this column did was
  // created by the operator or an invite, both of which prove the email.
  // Only a fresh self-serve signup is inserted unverified.
  ['users', 'verified', 'INTEGER NOT NULL DEFAULT 1'],
  ['users', 'verify_digest', 'TEXT'],
  ['users', 'verify_expires', 'TEXT'],

  /*
   * Where a place sits on the county roll.
   *
   * This is the join between the GIS layer and the CRM, and it is only two
   * columns because a parcel is already identified by exactly two things: the
   * market it belongs to and its id within that market. Parcel ids are unique
   * per county and nothing more, so `market` is not decoration — without it,
   * Austin parcel 114452 and Broward parcel 114452 are the same row.
   *
   * Kept on `places` rather than a join table: a parcel is a place, and a
   * place has at most one parcel. Deals, companies and people reach it the way
   * they already reach any place, through deal_parties.
   */
  ['places', 'market', 'TEXT'],
  ['places', 'parcel_id', 'TEXT'],

  // Which factor a pending challenge is waiting on.
  ['login_challenges', 'method', "TEXT NOT NULL DEFAULT 'sms'"],

  // What the shared report includes. Demographics shades the client's map;
  // QR puts a directions code on each tour book stop. Both broker choices.
  ['surveys', 'share_demographics', 'INTEGER NOT NULL DEFAULT 0'],
  ['surveys', 'share_qr', 'INTEGER NOT NULL DEFAULT 1'],

  // The last routed tour, as JSON: road geometry, legs, and the stop order.
  // Saved so repeat views (and the client's shared link) reuse the routed
  // path instead of calling the routing APIs again.
  ['surveys', 'tour_plan', 'TEXT'],

  // Tour configuration lives on the survey: one planned tour per survey.
  ['surveys', 'tour_start_time', 'TEXT'],
  ['surveys', 'tour_stop_minutes', 'INTEGER'],
  ['surveys', 'tour_start_address', 'TEXT'],
  ['surveys', 'tour_start_lat', 'REAL'],
  ['surveys', 'tour_start_lng', 'REAL'],
  ['surveys', 'tour_end_address', 'TEXT'],
  ['surveys', 'tour_end_lat', 'REAL'],
  ['surveys', 'tour_end_lng', 'REAL'],
]
