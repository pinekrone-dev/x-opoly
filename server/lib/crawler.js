/**
 * The crawl engine.
 *
 * A `CrawlJob` walks a site breadth-first from a seed URL, records one page
 * record per unique URL, and emits progress events while it runs. It never
 * mutates global state, so several jobs can run side by side.
 */

import { EventEmitter } from 'node:events'
import { load } from 'cheerio'
import { fetchRobots } from './robots.js'
import { parseSitemap } from './sitemap-parser.js'
import {
  compilePatterns,
  depthOf,
  isAssetUrl,
  isDocumentUrl,
  isInternal,
  normalizeUrl,
} from './urls.js'

export const USER_AGENT =
  'Mozilla/5.0 (compatible; SitemapForgeBot/1.0; +https://github.com/pinekrone-dev/x-opoly)'

export const LIMITS = {
  maxPages: 2000,
  maxDepth: 20,
  concurrency: 12,
  delayMs: 5000,
  timeoutMs: 60000,
  maxBodyBytes: 5_000_000,
  maxLinksPerPage: 5000,
}

export const DEFAULT_OPTIONS = {
  maxPages: 250,
  maxDepth: 8,
  concurrency: 5,
  delayMs: 0,
  timeoutMs: 15000,
  respectRobots: true,
  includeSubdomains: false,
  includeDocuments: true,
  stripQuery: false,
  seedFromSitemap: true,
  checkExternalLinks: false,
  includePatterns: '',
  excludePatterns: '',
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

/** Validates and clamps raw options coming from the HTTP API. */
export function sanitizeOptions(raw = {}) {
  return {
    maxPages: clampNumber(raw.maxPages, DEFAULT_OPTIONS.maxPages, 1, LIMITS.maxPages),
    maxDepth: clampNumber(raw.maxDepth, DEFAULT_OPTIONS.maxDepth, 0, LIMITS.maxDepth),
    concurrency: clampNumber(raw.concurrency, DEFAULT_OPTIONS.concurrency, 1, LIMITS.concurrency),
    delayMs: clampNumber(raw.delayMs, DEFAULT_OPTIONS.delayMs, 0, LIMITS.delayMs),
    timeoutMs: clampNumber(raw.timeoutMs, DEFAULT_OPTIONS.timeoutMs, 1000, LIMITS.timeoutMs),
    respectRobots: raw.respectRobots !== false,
    includeSubdomains: raw.includeSubdomains === true,
    includeDocuments: raw.includeDocuments !== false,
    stripQuery: raw.stripQuery === true,
    seedFromSitemap: raw.seedFromSitemap !== false,
    checkExternalLinks: raw.checkExternalLinks === true,
    includePatterns: typeof raw.includePatterns === 'string' ? raw.includePatterns.slice(0, 2000) : '',
    excludePatterns: typeof raw.excludePatterns === 'string' ? raw.excludePatterns.slice(0, 2000) : '',
  }
}

function textOrNull(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.replace(/\s+/g, ' ').trim()
  return trimmed ? trimmed : null
}

function toIsoDate(value) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

export class CrawlJob extends EventEmitter {
  constructor(rootUrl, options = {}, deps = {}) {
    super()
    this.id = deps.id || Math.random().toString(36).slice(2, 10)
    this.rootUrl = rootUrl
    this.options = { ...DEFAULT_OPTIONS, ...options }
    this.fetchImpl = deps.fetchImpl || fetch
    this.userAgent = deps.userAgent || USER_AGENT

    this.status = 'queued'
    this.error = null
    this.startedAt = null
    this.finishedAt = null

    this.pages = new Map()
    this.externalLinks = new Map()
    this.redirects = []
    this.robotsInfo = { available: false, blocked: 0, crawlDelay: null, sitemaps: [] }

    this.queue = []
    this.seen = new Set()
    this.claimed = 0
    this.currentUrls = new Set()
    this.stopped = false

    this.includeRe = compilePatterns(this.options.includePatterns)
    this.excludeRe = compilePatterns(this.options.excludePatterns)
  }

  /** True while the job is still producing results. */
  get isActive() {
    return this.status === 'queued' || this.status === 'running'
  }

  stop() {
    if (!this.isActive) return
    this.stopped = true
    this.status = 'stopping'
    this.emitProgress()
  }

  emitProgress() {
    this.emit('progress', this.summary())
  }

  summary() {
    return {
      id: this.id,
      rootUrl: this.rootUrl,
      status: this.status,
      error: this.error,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      crawled: this.pages.size,
      queued: this.queue.length,
      active: this.currentUrls.size,
      maxPages: this.options.maxPages,
      current: [...this.currentUrls].slice(0, 5),
      robots: this.robotsInfo,
    }
  }

  result() {
    return {
      ...this.summary(),
      options: this.options,
      pages: [...this.pages.values()].sort((a, b) => a.depth - b.depth || a.url.localeCompare(b.url)),
      externalLinks: [...this.externalLinks.entries()]
        .map(([url, info]) => ({ url, count: info.count, status: info.status ?? null, from: [...info.from].slice(0, 5) }))
        .sort((a, b) => b.count - a.count),
      redirects: this.redirects,
    }
  }

  /** Decides whether a URL is in scope for this crawl. */
  shouldQueue(url) {
    if (this.seen.has(url)) return false
    if (!isInternal(url, this.rootUrl, this.options.includeSubdomains)) return false
    if (isAssetUrl(url)) return false
    if (!this.options.includeDocuments && isDocumentUrl(url)) return false
    if (this.excludeRe.some((re) => re.test(url))) return false
    if (this.includeRe.length > 0 && !this.includeRe.some((re) => re.test(url))) return false
    return true
  }

  enqueue(url, depth, parent, via = 'link') {
    if (depth > this.options.maxDepth) return false
    if (!this.shouldQueue(url)) return false
    if (this.options.respectRobots && this.robots && !this.robots.isAllowed(url)) {
      this.seen.add(url)
      this.robotsInfo.blocked += 1
      return false
    }
    this.seen.add(url)
    this.queue.push({ url, depth, parent, via })
    return true
  }

  async run() {
    this.status = 'running'
    this.startedAt = new Date().toISOString()
    this.emitProgress()

    try {
      this.robots = this.options.respectRobots
        ? await fetchRobots(this.rootUrl, { userAgent: this.userAgent, timeout: this.options.timeoutMs, fetchImpl: this.fetchImpl })
        : null

      if (this.robots) {
        this.robotsInfo = {
          available: this.robots.available,
          blocked: 0,
          crawlDelay: this.robots.crawlDelay,
          sitemaps: this.robots.sitemaps,
        }
        if (this.robots.crawlDelay && this.robots.crawlDelay * 1000 > this.options.delayMs) {
          this.options.delayMs = Math.min(LIMITS.delayMs, this.robots.crawlDelay * 1000)
        }
      }

      this.enqueue(this.rootUrl, 0, null, 'seed')
      if (this.options.seedFromSitemap) await this.seedFromSitemaps()

      const workers = Array.from({ length: this.options.concurrency }, () => this.worker())
      await Promise.all(workers)

      if (this.options.checkExternalLinks) await this.verifyExternalLinks()

      this.status = this.stopped ? 'stopped' : 'complete'
    } catch (error) {
      this.status = 'error'
      this.error = error instanceof Error ? error.message : String(error)
    } finally {
      this.finishedAt = new Date().toISOString()
      this.emitProgress()
      this.emit('done', this.result())
    }
    return this.result()
  }

  /** Adds URLs from robots.txt sitemaps and /sitemap.xml to the queue. */
  async seedFromSitemaps() {
    const candidates = new Set(this.robotsInfo.sitemaps || [])
    try {
      candidates.add(new URL('/sitemap.xml', this.rootUrl).toString())
    } catch {
      /* ignore */
    }

    let seeded = 0
    for (const sitemapUrl of [...candidates].slice(0, 5)) {
      if (this.stopped) break
      try {
        const urls = await parseSitemap(sitemapUrl, {
          fetchImpl: this.fetchImpl,
          userAgent: this.userAgent,
          timeout: this.options.timeoutMs,
          maxUrls: this.options.maxPages * 2,
        })
        for (const entry of urls) {
          const normalized = normalizeUrl(entry.loc, this.rootUrl, { stripQuery: this.options.stripQuery })
          if (!normalized) continue
          if (this.enqueue(normalized, depthOf(normalized), null, 'sitemap')) seeded += 1
          if (seeded >= this.options.maxPages) break
        }
      } catch {
        /* a missing or malformed sitemap is not an error for the crawl */
      }
      if (seeded >= this.options.maxPages) break
    }
    if (seeded > 0) this.emitProgress()
  }

  async worker() {
    while (!this.stopped) {
      // Claim the slot before fetching so parallel workers cannot together
      // overshoot maxPages.
      if (this.claimed >= this.options.maxPages) return
      const item = this.queue.shift()
      if (!item) {
        // Nothing queued right now, but another worker may still add links.
        if (this.currentUrls.size === 0) return
        await new Promise((resolve) => setTimeout(resolve, 25))
        continue
      }

      this.claimed += 1
      this.currentUrls.add(item.url)
      try {
        await this.visit(item)
      } catch (error) {
        this.pages.set(item.url, this.errorRecord(item, error))
      } finally {
        this.currentUrls.delete(item.url)
        this.emitProgress()
      }

      if (this.options.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.options.delayMs))
      }
    }
  }

  errorRecord(item, error) {
    return {
      url: item.url,
      depth: item.depth,
      parent: item.parent,
      discoveredVia: item.via,
      status: 0,
      ok: false,
      error: error?.name === 'AbortError' ? 'Request timed out' : String(error?.message || error),
      title: null,
      description: null,
      canonical: null,
      noindex: false,
      nofollow: false,
      contentType: null,
      lastModified: null,
      bytes: 0,
      responseMs: 0,
      wordCount: 0,
      h1: null,
      lang: null,
      alternates: [],
      internalLinks: 0,
      externalLinks: 0,
      isDocument: isDocumentUrl(item.url),
      redirectTo: null,
    }
  }

  /**
   * Fetches a URL without following redirects: a redirecting URL is a result in
   * its own right, and its destination is queued as a separate page.
   */
  async fetchOnce(url) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs)
    const startedAt = Date.now()
    try {
      const response = await this.fetchImpl(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': this.userAgent,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
        },
      })
      return { response, responseMs: Date.now() - startedAt }
    } finally {
      clearTimeout(timer)
    }
  }

  async visit(item) {
    const { response, responseMs } = await this.fetchOnce(item.url)

    const contentType = (response.headers.get('content-type') || '').toLowerCase()
    const xRobots = (response.headers.get('x-robots-tag') || '').toLowerCase()
    const contentLength = Number(response.headers.get('content-length') || 0)

    const record = {
      url: item.url,
      depth: item.depth,
      parent: item.parent,
      discoveredVia: item.via,
      status: response.status,
      ok: response.ok,
      error: null,
      redirectTo: null,
      title: null,
      description: null,
      canonical: null,
      noindex: xRobots.includes('noindex'),
      nofollow: xRobots.includes('nofollow'),
      contentType: contentType.split(';')[0] || null,
      lastModified: toIsoDate(response.headers.get('last-modified')),
      bytes: contentLength || 0,
      responseMs,
      wordCount: 0,
      h1: null,
      lang: null,
      alternates: [],
      internalLinks: 0,
      externalLinks: 0,
      isDocument: isDocumentUrl(item.url),
    }

    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location) {
      const target = normalizeUrl(location, item.url, { stripQuery: this.options.stripQuery })
      record.redirectTo = target
      record.ok = false
      await this.discardBody(response)
      this.pages.set(item.url, record)

      if (target && target !== item.url) {
        this.redirects.push({ from: item.url, to: target, status: response.status })
        // The destination is a page of its own, reached at the same depth.
        this.enqueue(target, item.depth, item.url, 'redirect')
      }
      return
    }

    const isHtml = contentType.includes('html') || (contentType === '' && !record.isDocument)
    if (!response.ok || !isHtml || contentLength > LIMITS.maxBodyBytes) {
      await this.discardBody(response)
      this.pages.set(item.url, record)
      return
    }

    const html = await response.text()
    record.bytes = record.bytes || Buffer.byteLength(html)
    this.parseHtml(html, item.url, record, item)
    this.pages.set(item.url, record)
  }

  async discardBody(response) {
    try {
      await response.body?.cancel()
    } catch {
      /* the body may already be consumed or absent */
    }
  }

  parseHtml(html, pageUrl, record, item) {
    const $ = load(html)

    record.title = textOrNull($('head > title').first().text())
    record.description = textOrNull($('meta[name="description"]').attr('content'))
    record.h1 = textOrNull($('h1').first().text())
    record.lang = textOrNull($('html').attr('lang'))

    const canonicalHref = $('link[rel="canonical"]').attr('href')
    if (canonicalHref) {
      record.canonical = normalizeUrl(canonicalHref, pageUrl, { stripQuery: this.options.stripQuery })
    }

    const metaRobots = ($('meta[name="robots"]').attr('content') || '').toLowerCase()
    if (metaRobots.includes('noindex')) record.noindex = true
    if (metaRobots.includes('nofollow')) record.nofollow = true

    $('link[rel="alternate"][hreflang]').each((_, element) => {
      const hreflang = $(element).attr('hreflang')
      const href = normalizeUrl($(element).attr('href'), pageUrl, { stripQuery: this.options.stripQuery })
      if (hreflang && href && record.alternates.length < 50) {
        record.alternates.push({ hreflang, href })
      }
    })

    const body = $('body').clone()
    body.find('script, style, noscript, template').remove()
    const text = body.text().replace(/\s+/g, ' ').trim()
    record.wordCount = text ? text.split(' ').length : 0

    const links = $('a[href]').slice(0, LIMITS.maxLinksPerPage)
    const followPage = !record.nofollow
    const seenOnPage = new Set()

    links.each((_, element) => {
      const anchor = $(element)
      const href = anchor.attr('href')
      const normalized = normalizeUrl(href, pageUrl, { stripQuery: this.options.stripQuery })
      if (!normalized || seenOnPage.has(normalized)) return
      seenOnPage.add(normalized)

      const rel = (anchor.attr('rel') || '').toLowerCase()
      const internal = isInternal(normalized, this.rootUrl, this.options.includeSubdomains)

      if (internal) {
        record.internalLinks += 1
        if (followPage && !rel.includes('nofollow')) {
          this.enqueue(normalized, item.depth + 1, item.url, 'link')
        }
      } else {
        record.externalLinks += 1
        const existing = this.externalLinks.get(normalized)
        if (existing) {
          existing.count += 1
          existing.from.add(pageUrl)
        } else {
          this.externalLinks.set(normalized, { count: 1, from: new Set([pageUrl]), status: null })
        }
      }
    })
  }

  /** Optional pass that HEADs every external link to find dead outbound links. */
  async verifyExternalLinks() {
    const entries = [...this.externalLinks.entries()].slice(0, 200)
    const queue = [...entries]

    const workers = Array.from({ length: Math.min(this.options.concurrency, 6) }, async () => {
      while (queue.length > 0 && !this.stopped) {
        const [url, info] = queue.shift()
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), Math.min(this.options.timeoutMs, 10000))
        try {
          const response = await this.fetchImpl(url, {
            method: 'HEAD',
            redirect: 'follow',
            signal: controller.signal,
            headers: { 'user-agent': this.userAgent },
          })
          info.status = response.status
        } catch {
          info.status = 0
        } finally {
          clearTimeout(timer)
        }
      }
    })

    await Promise.all(workers)
    this.emitProgress()
  }
}
