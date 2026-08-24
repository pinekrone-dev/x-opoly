/**
 * Reads existing sitemaps so a crawl can be seeded from URLs the site already
 * publishes. Handles both `<urlset>` documents and `<sitemapindex>` documents,
 * following index entries one level deep.
 */

import { load } from 'cheerio'

const MAX_SITEMAP_BYTES = 20_000_000

async function fetchXml(url, { fetchImpl, userAgent, timeout }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetchImpl(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': userAgent, accept: 'application/xml,text/xml,*/*' },
    })
    if (!response.ok) return null
    const type = (response.headers.get('content-type') || '').toLowerCase()
    if (type && !/(xml|text)/.test(type)) return null
    const text = await response.text()
    if (text.length > MAX_SITEMAP_BYTES) return null
    return text
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Parses sitemap XML into `{ urls, sitemaps }` without any network access. */
export function parseSitemapXml(xml) {
  const urls = []
  const sitemaps = []
  if (!xml || !xml.includes('<')) return { urls, sitemaps }

  const $ = load(xml, { xmlMode: true })

  $('urlset > url').each((_, element) => {
    const node = $(element)
    const loc = node.find('loc').first().text().trim()
    if (!loc) return
    urls.push({
      loc,
      lastmod: node.find('lastmod').first().text().trim() || null,
      changefreq: node.find('changefreq').first().text().trim() || null,
      priority: node.find('priority').first().text().trim() || null,
    })
  })

  $('sitemapindex > sitemap > loc').each((_, element) => {
    const loc = $(element).text().trim()
    if (loc) sitemaps.push(loc)
  })

  return { urls, sitemaps }
}

/**
 * Fetches `sitemapUrl` and returns a flat list of URL entries, expanding a
 * sitemap index into its children.
 */
export async function parseSitemap(sitemapUrl, options = {}) {
  const {
    fetchImpl = fetch,
    userAgent = 'SitemapForge',
    timeout = 15000,
    maxUrls = 5000,
    maxChildren = 10,
  } = options

  const xml = await fetchXml(sitemapUrl, { fetchImpl, userAgent, timeout })
  if (!xml) return []

  const { urls, sitemaps } = parseSitemapXml(xml)
  const collected = urls.slice(0, maxUrls)

  for (const child of sitemaps.slice(0, maxChildren)) {
    if (collected.length >= maxUrls) break
    const childXml = await fetchXml(child, { fetchImpl, userAgent, timeout })
    if (!childXml) continue
    const parsed = parseSitemapXml(childXml)
    for (const entry of parsed.urls) {
      collected.push(entry)
      if (collected.length >= maxUrls) break
    }
  }

  return collected
}
