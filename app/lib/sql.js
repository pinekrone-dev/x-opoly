/**
 * Database adapters.
 *
 * One narrow interface — `all`, `get`, `run`, `batch` — implemented over both
 * `node:sqlite` (local development, a single process, a file on disk) and
 * Cloudflare D1 (deployed). Everything above this line is written once and does
 * not know which one it is talking to.
 *
 * The interface is async even on the synchronous Node driver, because D1 is
 * async and the callers have to be written for the stricter of the two.
 */

import { COLUMN_ADDITIONS, DATA_FIXES, SCHEMA_STATEMENTS } from './schema.js'

/**
 * A fingerprint of the schema as code describes it.
 *
 * Stored in the database after a successful sweep so the next boot — on
 * Cloudflare, the next isolate cold start, which happens many times a day —
 * can read one row and know the sweep has nothing to do. Before this, every
 * cold start replayed all sixty-odd CREATE, PRAGMA and repair statements
 * against D1, each one a network round trip, before the first request ran.
 *
 * Any change to the schema lists changes the fingerprint, which makes the
 * next boot run the full sweep again. Deleting the `schema_meta` row (or the
 * table) has the same effect, so the marker is reversible by hand.
 */
export const SCHEMA_VERSION = fingerprint(
  [...SCHEMA_STATEMENTS, ...COLUMN_ADDITIONS.map((entry) => entry.join(' ')), ...DATA_FIXES].join('\n'),
)

function fingerprint(text) {
  // FNV-1a, 32-bit. Not cryptographic and does not need to be: it only has
  // to change when the schema text changes.
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `v1-${hash.toString(16).padStart(8, '0')}`
}

const META_TABLE = 'CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)'

/** Whether the stored fingerprint matches this code. One read, no writes. */
async function schemaIsCurrent(adapter) {
  try {
    const row = await adapter.get("SELECT value FROM schema_meta WHERE key = 'version'")
    return row?.value === SCHEMA_VERSION
  } catch {
    // No schema_meta table yet: a database from before the marker existed.
    return false
  }
}

/**
 * Apply the schema to whichever database is behind `adapter`.
 *
 * Creating tables is idempotent on its own. Adding a column to a table that
 * already exists is not — SQLite has no `ADD COLUMN IF NOT EXISTS` — so each
 * table is inspected first and only the genuinely missing columns are added.
 * That makes this safe to run on every boot against a database with live rows.
 *
 * The sweep is skipped entirely when the stored fingerprint already matches.
 */
async function applySchema(adapter, { force = false } = {}) {
  if (!force && (await schemaIsCurrent(adapter))) return { skipped: true }

  for (const statement of SCHEMA_STATEMENTS) {
    await adapter.run(statement)
  }

  const seen = new Map()
  for (const [table, column, definition] of COLUMN_ADDITIONS) {
    if (!seen.has(table)) {
      const info = await adapter.all(`PRAGMA table_info(${table})`)
      seen.set(table, new Set(info.map((row) => row.name)))
    }
    const columns = seen.get(table)
    if (columns.has(column)) continue
    await adapter.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    columns.add(column)
  }

  // Repairs run last, once every column they reference exists.
  for (const statement of DATA_FIXES) {
    await adapter.run(statement)
  }

  // Recorded only after everything above succeeded, so a sweep that failed
  // halfway is retried in full next time rather than remembered as done.
  await adapter.run(META_TABLE)
  await adapter.run("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?)", [SCHEMA_VERSION])
  return { skipped: false }
}

/**
 * @param {import('node:sqlite').DatabaseSync} database
 */
export function nodeAdapter(database) {
  return {
    kind: 'node',

    async all(sql, params = []) {
      return database.prepare(sql).all(...params)
    },

    async get(sql, params = []) {
      return database.prepare(sql).get(...params) ?? null
    },

    async run(sql, params = []) {
      const result = database.prepare(sql).run(...params)
      return { changes: Number(result.changes ?? 0) }
    },

    /** node:sqlite is synchronous, so a real transaction is available here. */
    async batch(statements) {
      database.exec('BEGIN')
      try {
        for (const [sql, params = []] of statements) {
          database.prepare(sql).run(...params)
        }
        database.exec('COMMIT')
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },

    async migrate(options) {
      return applySchema(this, options)
    },
  }
}

/**
 * @param {D1Database} d1 the binding from the Worker environment
 */
export function d1Adapter(d1) {
  return {
    kind: 'd1',

    async all(sql, params = []) {
      const { results } = await d1.prepare(sql).bind(...params).all()
      return results ?? []
    },

    async get(sql, params = []) {
      return (await d1.prepare(sql).bind(...params).first()) ?? null
    },

    async run(sql, params = []) {
      const result = await d1.prepare(sql).bind(...params).run()
      return { changes: result?.meta?.changes ?? 0 }
    },

    /**
     * D1 has no interactive transactions; `batch` is the supported way to send
     * statements atomically, so it is the primitive the callers are written
     * against rather than BEGIN/COMMIT.
     */
    async batch(statements) {
      if (statements.length === 0) return
      await d1.batch(statements.map(([sql, params = []]) => d1.prepare(sql).bind(...params)))
    },

    async migrate(options) {
      return applySchema(this, options)
    },
  }
}
