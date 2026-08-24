import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'

import { CrawlJob, sanitizeOptions } from '../server/lib/crawler.js'
import { auditCrawl } from '../server/lib/audit.js'
import { buildSitemapFiles, selectablePages } from '../server/lib/exporters.js'
import { startFixtureSite } from './fixture-site.js'

let fixture

before(async () => {
  fixture = await startFixtureSite()
})

after(() => {
  fixture.server.close()
})

async function crawl(options = {}) {
  const job = new CrawlJob(`${fixture.origin}/`, sanitizeOptions({ concurrency: 3, ...options }))
  return job.run()
}

describe('crawler', () => {
  test('discovers linked pages and records their metadata', async () => {
    const result = await crawl()
    const byUrl = new Map(result.pages.map((page) => [page.url, page]))

    assert.equal(result.status, 'complete')
    assert.ok(byUrl.has(`${fixture.origin}/`), 'home page crawled')
    assert.ok(byUrl.has(`${fixture.origin}/about`), 'about page crawled')
    assert.ok(byUrl.has(`${fixture.origin}/about/team`), 'nested page crawled')

    const home = byUrl.get(`${fixture.origin}/`)
    assert.equal(home.title, 'Fixture Home Page For Tests')
    assert.equal(home.status, 200)
    assert.equal(home.depth, 0)
    assert.ok(home.wordCount > 100)
    assert.ok(home.lastModified)
  })

  test('skips assets, other protocols and off-site links', async () => {
    const result = await crawl()
    const urls = result.pages.map((page) => page.url)

    assert.ok(!urls.some((url) => url.endsWith('.css')), 'stylesheets are not crawled')
    assert.ok(!urls.some((url) => url.startsWith('mailto:')), 'mailto links are skipped')
    assert.ok(!urls.some((url) => url.includes('example.org')), 'external links are not crawled')
    assert.ok(result.externalLinks.some((link) => link.url.includes('example.org')), 'external links are recorded')
  })

  test('honours robots.txt disallow rules', async () => {
    const result = await crawl()
    assert.ok(!result.pages.some((page) => page.url.includes('/private/')), 'disallowed path stayed out')
    assert.equal(result.robots.available, true)
    assert.ok(result.robots.blocked >= 1)
  })

  test('crawls a disallowed path when robots is switched off', async () => {
    const result = await crawl({ respectRobots: false })
    assert.ok(result.pages.some((page) => page.url.includes('/private/secret')))
  })

  test('records redirects and broken pages', async () => {
    const result = await crawl()
    const redirected = result.pages.find((page) => page.url.endsWith('/old'))
    assert.ok(redirected, 'redirecting URL is recorded')
    assert.equal(redirected.status, 301)
    assert.ok(redirected.redirectTo.endsWith("/about"))

    const missing = result.pages.find((page) => page.url.endsWith('/missing'))
    assert.equal(missing.status, 404)
  })

  test('seeds URLs from the published sitemap', async () => {
    const result = await crawl()
    const orphan = result.pages.find((page) => page.url.endsWith('/orphan'))
    assert.ok(orphan, 'sitemap-only URL was crawled')
    assert.equal(orphan.discoveredVia, 'sitemap')
  })

  test('respects maxPages and maxDepth', async () => {
    const limited = await crawl({ maxPages: 2 })
    assert.ok(limited.pages.length <= 2, `expected at most 2 pages, got ${limited.pages.length}`)

    const shallow = await crawl({ maxDepth: 0, seedFromSitemap: false })
    assert.equal(shallow.pages.length, 1)
  })

  test('exclude patterns keep URLs out of the crawl', async () => {
    const result = await crawl({ excludePatterns: '/about' })
    assert.ok(!result.pages.some((page) => page.url.includes('/about')))
  })
})

describe('audit and export', () => {
  test('flags broken pages, noindex and orphans', async () => {
    const result = await crawl()
    const { issues, stats } = auditCrawl(result)
    const ids = issues.map((issue) => issue.id)

    assert.ok(ids.includes('broken-pages'))
    assert.ok(ids.includes('redirects'))
    assert.ok(ids.includes('noindex'))
    assert.ok(ids.includes('orphan-pages'))
    assert.ok(stats.total >= 5)
    assert.ok(stats.indexable >= 1)
  })

  test('the generated sitemap only contains indexable URLs', async () => {
    const result = await crawl()
    const pages = selectablePages(result.pages)
    const [sitemap] = buildSitemapFiles(pages, undefined, `${fixture.origin}/`)

    assert.match(sitemap.content, /^<\?xml version="1\.0" encoding="UTF-8"\?>/)
    assert.match(sitemap.content, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/)
    assert.ok(sitemap.content.includes(`<loc>${fixture.origin}/</loc>`))
    assert.ok(!sitemap.content.includes('/missing'), '404s are excluded')
    assert.ok(!sitemap.content.includes('/blog'), 'noindex pages are excluded')
    assert.ok(!sitemap.content.includes('/old'), 'redirects are excluded')
  })

  test('splits into a sitemap index past 50,000 URLs', () => {
    const pages = Array.from({ length: 50001 }, (_, index) => ({
      url: `https://example.com/p/${index}`,
      depth: 2,
      ok: true,
      status: 200,
    }))
    const files = buildSitemapFiles(pages, undefined, 'https://example.com/')

    assert.equal(files.length, 3)
    assert.match(files[0].content, /<sitemapindex/)
    assert.equal(files[1].name, 'sitemap-1.xml')
    assert.equal(files[2].name, 'sitemap-2.xml')
  })
})
