import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'

import { CrawlJob, sanitizeOptions } from '../server/lib/crawler.js'
import { auditCrawl } from '../server/lib/audit.js'
import { buildSitemapFiles, selectablePages } from '../server/lib/exporters.js'
import { closeRenderer, getRenderer } from '../server/lib/renderer.js'
import { startFixtureSite } from './fixture-site.js'

let fixture

before(async () => {
  fixture = await startFixtureSite()
})

after(async () => {
  fixture.server.close()
  await closeRenderer()
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

describe('javascript rendering', () => {
  test('a link injected by script is invisible to a plain HTTP crawl', async () => {
    const result = await crawl({ seedFromSitemap: false })
    assert.ok(result.pages.some((page) => page.url.endsWith('/spa')), 'the app shell itself is crawled')
    assert.ok(!result.pages.some((page) => page.url.endsWith('/spa-child')), 'its script-injected link is not followed')
  })

  test('rendering the page in a browser finds it', async (t) => {
    const { renderer, reason } = await getRenderer()
    if (!renderer) {
      t.skip(`no browser available: ${reason}`)
      return
    }

    const result = await crawl({ renderJs: true, seedFromSitemap: false })
    const child = result.pages.find((page) => page.url.endsWith('/spa-child'))

    assert.ok(child, 'the script-injected link was followed')
    assert.equal(child.title, 'Page Behind The App Shell')
    assert.ok(result.pages.find((page) => page.url.endsWith('/spa'))?.rendered, 'pages are marked as rendered')
    assert.equal(result.warnings.length, 0)
  })

  test('a crawl still succeeds when rendering is unavailable', async () => {
    const job = new CrawlJob(`${fixture.origin}/`, sanitizeOptions({ renderJs: true }))
    // Simulate a deployment with no browser installed.
    job.renderer = null
    const original = job.run.bind(job)
    const result = await original()
    assert.ok(result.pages.length > 0)
  })
})

describe('image sitemaps', () => {
  test('collects images, including og:image and the first srcset candidate', async () => {
    const result = await crawl({ seedFromSitemap: false })
    const home = result.pages.find((page) => page.url === `${fixture.origin}/`)
    const locations = home.images.map((image) => image.loc)

    assert.ok(locations.includes(`${fixture.origin}/hero.png`), 'plain img src collected')
    assert.ok(locations.includes(`${fixture.origin}/social-card.png`), 'og:image collected')
    assert.ok(locations.includes(`${fixture.origin}/wide.png`), 'first srcset candidate collected')
    assert.equal(home.images.find((image) => image.loc.endsWith('/hero.png')).caption, 'The hero image')
    assert.ok(!result.pages.some((page) => page.url.endsWith('.png')), 'images are listed but never crawled')
  })

  test('image entries appear in the XML only when asked for', async () => {
    const result = await crawl({ seedFromSitemap: false })
    const pages = selectablePages(result.pages)

    const without = buildSitemapFiles(pages, { includeImages: false })[0].content
    assert.ok(!without.includes('sitemap-image/1.1'))

    const withImages = buildSitemapFiles(pages, { includeImages: true })[0].content
    assert.match(withImages, /xmlns:image="http:\/\/www\.google\.com\/schemas\/sitemap-image\/1\.1"/)
    assert.match(withImages, /<image:loc>.*hero\.png<\/image:loc>/)
    assert.match(withImages, /<image:caption>The hero image<\/image:caption>/)
  })
})
