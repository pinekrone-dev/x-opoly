/**
 * HTTP entry point.
 *
 * In development Vite serves the UI on its own port and proxies `/api` here.
 * In production this process serves both the API and the built SPA.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import express from 'express'

import { CrawlJob, LIMITS, DEFAULT_OPTIONS, sanitizeOptions } from './lib/crawler.js'
import { JobStore } from './lib/store.js'
import { auditCrawl } from './lib/audit.js'
import { assertPublicUrl } from './lib/safety.js'
import { normalizeSeed } from './lib/urls.js'
import {
  DEFAULT_EXPORT_SETTINGS,
  buildCsv,
  buildHtmlSitemap,
  buildSitemapFiles,
  buildTxt,
  robotsLine,
  selectablePages,
} from './lib/exporters.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.join(__dirname, '..', 'dist')

export function createServer({ store = new JobStore() } = {}) {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '2mb' }))

  app.get('/api/health', (_request, response) => {
    response.json({ ok: true, activeJobs: store.activeCount(), limits: LIMITS, defaults: DEFAULT_OPTIONS })
  })

  app.post('/api/crawl', async (request, response) => {
    const seed = normalizeSeed(request.body?.url)
    if (!seed) {
      response.status(400).json({ error: 'Enter a valid website address, for example example.com.' })
      return
    }

    if (store.atCapacity()) {
      response.status(429).json({ error: 'Too many crawls are running right now. Try again in a moment.' })
      return
    }

    try {
      await assertPublicUrl(seed)
    } catch (error) {
      response.status(400).json({ error: error.message })
      return
    }

    const options = sanitizeOptions(request.body?.options)
    const job = new CrawlJob(seed, options, { id: store.newId() })
    store.add(job)
    job.run().catch(() => {
      /* failures are recorded on the job itself */
    })

    response.status(202).json({ id: job.id, rootUrl: seed, options })
  })

  app.get('/api/crawl/:id', (request, response) => {
    const job = store.get(request.params.id)
    if (!job) {
      response.status(404).json({ error: 'That crawl has expired or does not exist.' })
      return
    }
    response.json(job.summary())
  })

  app.get('/api/crawl/:id/result', (request, response) => {
    const job = store.get(request.params.id)
    if (!job) {
      response.status(404).json({ error: 'That crawl has expired or does not exist.' })
      return
    }
    const result = job.result()
    response.json({ ...result, audit: auditCrawl(result) })
  })

  app.get('/api/crawl/:id/stream', (request, response) => {
    const job = store.get(request.params.id)
    if (!job) {
      response.status(404).json({ error: 'That crawl has expired or does not exist.' })
      return
    }

    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })

    const send = (event, payload) => {
      response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
    }

    send('progress', job.summary())

    const onProgress = (summary) => send('progress', summary)
    const onDone = () => {
      send('done', job.summary())
      cleanup()
      response.end()
    }

    // A comment frame every 20s keeps proxies from closing an idle stream.
    const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 20000)

    function cleanup() {
      clearInterval(heartbeat)
      job.off('progress', onProgress)
      job.off('done', onDone)
    }

    job.on('progress', onProgress)
    job.once('done', onDone)
    request.on('close', cleanup)

    if (!job.isActive) onDone()
  })

  app.post('/api/crawl/:id/stop', (request, response) => {
    const job = store.get(request.params.id)
    if (!job) {
      response.status(404).json({ error: 'That crawl has expired or does not exist.' })
      return
    }
    job.stop()
    response.json(job.summary())
  })

  /**
   * Builds export files from a finished crawl.
   * `urls` lets the UI hand back exactly the selection the user ticked, and
   * `overrides` carries per-URL priority/changefreq edits.
   */
  app.post('/api/crawl/:id/export', (request, response) => {
    const job = store.get(request.params.id)
    if (!job) {
      response.status(404).json({ error: 'That crawl has expired or does not exist.' })
      return
    }

    const format = String(request.body?.format || 'xml').toLowerCase()
    const settings = { ...DEFAULT_EXPORT_SETTINGS, ...(request.body?.settings || {}) }
    const overrides = request.body?.overrides || {}
    const result = job.result()

    let pages = result.pages
    if (Array.isArray(request.body?.urls)) {
      const wanted = new Set(request.body.urls)
      pages = pages.filter((page) => wanted.has(page.url))
    } else {
      pages = selectablePages(pages, settings)
    }

    pages = pages.map((page) => ({ ...page, ...(overrides[page.url] || {}) }))

    let files
    switch (format) {
      case 'txt':
        files = [{ name: 'sitemap.txt', content: buildTxt(pages) }]
        break
      case 'csv':
        files = [{ name: 'crawl-report.csv', content: buildCsv(pages) }]
        break
      case 'html':
        files = [{ name: 'sitemap.html', content: buildHtmlSitemap(pages, job.rootUrl) }]
        break
      case 'xml':
        files = buildSitemapFiles(pages, settings, job.rootUrl)
        break
      default:
        response.status(400).json({ error: `Unknown export format "${format}".` })
        return
    }

    response.json({ format, count: pages.length, robotsLine: robotsLine(job.rootUrl), files })
  })

  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir, { index: false, maxAge: '1h' }))
    app.get('*', (request, response, next) => {
      if (request.path.startsWith('/api/')) {
        next()
        return
      }
      response.sendFile(path.join(distDir, 'index.html'))
    })
  }

  app.use('/api', (_request, response) => {
    response.status(404).json({ error: 'Unknown endpoint.' })
  })

  // eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
  app.use((error, _request, response, _next) => {
    response.status(500).json({ error: error?.message || 'Unexpected server error.' })
  })

  return app
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])

if (isDirectRun) {
  const port = Number(process.env.PORT) || 8080
  createServer().listen(port, '0.0.0.0', () => {
    console.log(`SitemapForge listening on http://0.0.0.0:${port}`)
  })
}
