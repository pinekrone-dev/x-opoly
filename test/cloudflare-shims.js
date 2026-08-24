/**
 * Stand-ins for the Cloudflare bindings, so the Worker entry point can be
 * exercised without deploying.
 *
 * D1 is SQLite, so the shim is the real `node:sqlite` driver behind D1's
 * prepare/bind/all/first/run/batch surface. That means these tests run the same
 * SQL the deployed Worker will run, through the same adapter.
 */

import { DatabaseSync } from 'node:sqlite'

class D1Statement {
  constructor(database, sql) {
    this.database = database
    this.sql = sql
    this.params = []
  }

  bind(...params) {
    this.params = params
    return this
  }

  async all() {
    return { results: this.database.prepare(this.sql).all(...this.params) }
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.params) ?? null
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.params)
    return { meta: { changes: Number(result.changes ?? 0) } }
  }
}

export class D1Shim {
  constructor(file = ':memory:') {
    this.database = new DatabaseSync(file)
    this.database.exec('PRAGMA foreign_keys = ON;')
  }

  prepare(sql) {
    return new D1Statement(this.database, sql)
  }

  /** D1 batches are atomic, which is what the callers rely on. */
  async batch(statements) {
    this.database.exec('BEGIN')
    try {
      const results = []
      for (const statement of statements) results.push(await statement.run())
      this.database.exec('COMMIT')
      return results
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }
}

export class R2Shim {
  constructor() {
    this.objects = new Map()
  }

  async put(key, bytes, options = {}) {
    this.objects.set(key, { bytes: new Uint8Array(bytes), contentType: options.httpMetadata?.contentType })
  }

  async get(key) {
    const object = this.objects.get(key)
    if (!object) return null
    return {
      httpMetadata: { contentType: object.contentType },
      async arrayBuffer() {
        return object.bytes.buffer.slice(object.bytes.byteOffset, object.bytes.byteOffset + object.bytes.byteLength)
      },
    }
  }

  async delete(key) {
    this.objects.delete(key)
  }
}

/** Cloudflare's static asset binding. */
export const assetsShim = {
  async fetch(request) {
    const url = new URL(request.url)
    // not_found_handling = "single-page-application": unknown paths get index.html.
    const body = url.pathname.startsWith('/assets/') ? '/* asset */' : '<!doctype html><title>App</title>'
    return new Response(body, { headers: { 'content-type': url.pathname.startsWith('/assets/') ? 'text/javascript' : 'text/html' } })
  },
}

/** A worker environment wired to the shims. */
/**
 * @param {object} overrides  replace or add bindings
 * @param {object} options
 * @param {boolean} options.migrated  pre-apply the schema, as a long-running
 *   deployment would already have it. Pass false to hand the Worker a bare
 *   database and check it migrates itself — the case that broke production
 *   while every test here passed, because this helper was hiding it.
 */
export async function workerEnv(overrides = {}, { migrated = true } = {}) {
  const { d1Adapter } = await import('../app/lib/sql.js')
  const DB = new D1Shim()
  if (migrated) await d1Adapter(DB).migrate()
  return { DB, BUCKET: new R2Shim(), ASSETS: assetsShim, ...overrides }
}
