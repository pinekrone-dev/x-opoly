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

import { SCHEMA_STATEMENTS } from './schema.js'

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

    async migrate() {
      for (const statement of SCHEMA_STATEMENTS) database.exec(statement)
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

    async migrate() {
      for (const statement of SCHEMA_STATEMENTS) {
        await d1.prepare(statement).run()
      }
    },
  }
}
