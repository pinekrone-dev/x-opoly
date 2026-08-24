import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { describe } from 'node:test'

/**
 * Guards on wrangler.toml.
 *
 * A find-and-replace once mangled `database_name` into `database_# comment`,
 * which is invalid TOML. Wrangler rejected it, every deploy failed at the
 * config parse, and the running Worker silently stayed on an old build. These
 * checks fail here instead — no TOML parser needed, since the failure mode is
 * structural.
 */
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(root, 'wrangler.toml'), 'utf8')
const lines = source.split('\n')

describe('wrangler.toml', () => {
  test('every key is a key wrangler will accept', () => {
    lines.forEach((line, index) => {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[')) return

      const key = trimmed.split('=')[0].trim()
      assert.ok(
        /^[A-Za-z0-9_-]+$/.test(key),
        `wrangler.toml line ${index + 1}: "${key}" is not a valid TOML key — wrangler refuses the whole file`,
      )
      assert.ok(trimmed.includes('='), `wrangler.toml line ${index + 1} is neither a comment, a table, nor an assignment`)
    })
  })

  test('declares the bindings the Worker actually reads', () => {
    // worker/index.js uses env.DB, env.BUCKET and env.ASSETS; a deploy missing
    // any of them serves 500s on first use.
    assert.match(source, /^binding = "DB"$/m, 'the D1 binding must be named DB')
    assert.match(source, /^binding = "BUCKET"$/m, 'the R2 binding must be named BUCKET')
    assert.match(source, /^binding = "ASSETS"$/m, 'the assets binding must be named ASSETS')

    const worker = fs.readFileSync(path.join(root, 'worker', 'index.js'), 'utf8')
    for (const binding of ['env.DB', 'env.BUCKET', 'env.ASSETS']) {
      assert.ok(worker.includes(binding), `${binding} is declared in wrangler.toml but never used`)
    }
  })

  test('points at a real D1 database rather than a placeholder', () => {
    const id = source.match(/^database_id = "([^"]+)"$/m)
    assert.ok(id, 'database_id is missing')
    assert.match(id[1], /^[0-9a-f-]{36}$/, `database_id "${id[1]}" is not a UUID`)
  })

  test('deep links resolve to the app instead of 404ing', () => {
    assert.match(source, /not_found_handling = "single-page-application"/)
  })

  test('enables the Node compatibility the lazily loaded SDK needs', () => {
    assert.match(source, /compatibility_flags = \[.*"nodejs_compat".*\]/)
  })

  test('carries no secrets', () => {
    // Secrets belong in the dashboard or `wrangler secret put`, never in git.
    assert.ok(!/ANTHROPIC_API_KEY\s*=/.test(source), 'an API key must never be committed')
    assert.ok(!/^TILE_KEY\s*=/m.test(source), 'a tile key must never be committed')
  })
})

describe('the Worker entry point', () => {
  test('does not import the Anthropic SDK at module scope', () => {
    // A top-level import evaluates the SDK on every request, including serving
    // the home page, and makes the whole app depend on its Node shims loading.
    const flyer = fs.readFileSync(path.join(root, 'app', 'lib', 'flyer.js'), 'utf8')
    const topLevel = flyer.split('\n').filter((line) => /^import .*@anthropic-ai\/sdk/.test(line))
    assert.equal(topLevel.length, 0, `the SDK is still imported at module scope: ${topLevel.join(', ')}`)
    assert.match(flyer, /await Promise\.all\(\[\s*import\('@anthropic-ai\/sdk'\)/, 'it should be loaded on demand')
  })
})
