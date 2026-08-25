/**
 * Node entry point — local development and any plain Node host.
 *
 * Same routes as the Worker; only the database, file store and static handling
 * differ. See `worker/index.js` for the Cloudflare side.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'

import { createApp } from '../app/routes.js'
import { nodeAdapter } from '../app/lib/sql.js'
import { diskStorage } from '../app/lib/storage.js'
import { withPreviewOrigin } from '../app/lib/preview.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.join(here, '..', 'dist')

export async function createServer(env = process.env) {
  const dataDir = env.DATA_DIR || path.join(process.cwd(), 'data')
  fs.mkdirSync(dataDir, { recursive: true })

  const db = nodeAdapter(new DatabaseSync(env.DB_FILE || path.join(dataDir, 'sitemap.db')))
  await db.migrate()

  const storage = await diskStorage(path.join(dataDir, 'uploads'))
  const api = createApp({ db, storage, env })

  const app = new Hono()
  app.route('/', api)

  // The built UI, with a single-page-app fallback.
  if (fs.existsSync(distDir)) {
    const indexHtml = () => fs.readFileSync(path.join(distDir, 'index.html'), 'utf8')

    app.get('*', async (c) => {
      const requested = decodeURIComponent(new URL(c.req.url).pathname)
      const candidate = path.join(distDir, requested)

      if (requested !== '/' && candidate.startsWith(distDir) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return c.body(fs.readFileSync(candidate), 200, {
          'content-type': contentType(candidate),
          'cache-control': requested.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        })
      }
      return c.html(withPreviewOrigin(indexHtml(), new URL(c.req.url).origin))
    })
  }

  return app
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

function contentType(file) {
  return TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream'
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isDirectRun) {
  const port = Number(process.env.PORT) || 8080
  const app = await createServer()
  serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => {
    console.log(`Site survey server listening on http://0.0.0.0:${port}`)
  })
}
