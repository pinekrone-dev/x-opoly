/**
 * Turns crawl results into the files people actually ship: sitemap.xml
 * (with an index when the URL count requires one), a plain URL list, a CSV
 * audit export, and a human-readable HTML sitemap page.
 */

import { gzipSync } from 'node:zlib'

const URLS_PER_SITEMAP = 50000

export const CHANGEFREQ_VALUES = ['always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never']

export const DEFAULT_EXPORT_SETTINGS = {
  priorityMode: 'depth', // 'depth' | 'fixed' | 'none'
  fixedPriority: 0.5,
  changefreqMode: 'depth', // 'depth' | 'fixed' | 'none'
  fixedChangefreq: 'weekly',
  includeLastmod: true,
  includeAlternates: false,
  includeImages: false,
  gzip: false,
  excludeNoindex: true,
  excludeNonCanonical: true,
  excludeErrors: true,
}

export function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Search engines accept a date or a full W3C timestamp; we emit YYYY-MM-DD. */
export function toSitemapDate(value) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString().slice(0, 10)
}

export function priorityForDepth(depth) {
  const value = 1 - depth * 0.2
  return Math.max(0.2, Math.min(1, Number(value.toFixed(1))))
}

export function changefreqForDepth(depth) {
  if (depth <= 0) return 'daily'
  if (depth <= 2) return 'weekly'
  return 'monthly'
}

/**
 * Applies the "should this URL be in a sitemap at all" rules.
 * A page explicitly selected in the UI wins over the automatic rules.
 */
export function selectablePages(pages, settings = DEFAULT_EXPORT_SETTINGS) {
  return pages.filter((page) => {
    if (settings.excludeErrors && (!page.ok || page.status >= 400 || page.status === 0)) return false
    if (page.status >= 300 && page.status < 400) return false
    if (settings.excludeNoindex && page.noindex) return false
    if (settings.excludeNonCanonical && page.canonical && page.canonical !== page.url) return false
    return true
  })
}

function urlEntry(page, settings) {
  const lines = [`  <url>`, `    <loc>${escapeXml(page.url)}</loc>`]

  if (settings.includeLastmod) {
    const lastmod = toSitemapDate(page.lastmod || page.lastModified)
    if (lastmod) lines.push(`    <lastmod>${lastmod}</lastmod>`)
  }

  if (settings.changefreqMode !== 'none') {
    const changefreq =
      page.changefreq ||
      (settings.changefreqMode === 'fixed' ? settings.fixedChangefreq : changefreqForDepth(page.depth))
    if (CHANGEFREQ_VALUES.includes(changefreq)) {
      lines.push(`    <changefreq>${changefreq}</changefreq>`)
    }
  }

  if (settings.priorityMode !== 'none') {
    const priority =
      page.priority != null
        ? Number(page.priority)
        : settings.priorityMode === 'fixed'
          ? Number(settings.fixedPriority)
          : priorityForDepth(page.depth)
    if (Number.isFinite(priority)) {
      lines.push(`    <priority>${Math.max(0, Math.min(1, priority)).toFixed(1)}</priority>`)
    }
  }

  if (settings.includeImages && Array.isArray(page.images)) {
    for (const image of page.images) {
      lines.push('    <image:image>', `      <image:loc>${escapeXml(image.loc)}</image:loc>`)
      if (image.caption) lines.push(`      <image:caption>${escapeXml(image.caption)}</image:caption>`)
      lines.push('    </image:image>')
    }
  }

  if (settings.includeAlternates && Array.isArray(page.alternates)) {
    for (const alternate of page.alternates) {
      lines.push(
        `    <xhtml:link rel="alternate" hreflang="${escapeXml(alternate.hreflang)}" href="${escapeXml(alternate.href)}"/>`,
      )
    }
  }

  lines.push('  </url>')
  return lines.join('\n')
}

function urlsetDocument(pages, settings) {
  const namespaces = ['xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"']

  if (settings.includeAlternates && pages.some((page) => page.alternates?.length > 0)) {
    namespaces.push('xmlns:xhtml="http://www.w3.org/1999/xhtml"')
  }
  if (settings.includeImages && pages.some((page) => page.images?.length > 0)) {
    namespaces.push('xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"')
  }

  const openTag = `<urlset ${namespaces.join(' ')}>`

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    openTag,
    ...pages.map((page) => urlEntry(page, settings)),
    '</urlset>',
    '',
  ].join('\n')
}

/**
 * Builds the sitemap file set for `pages`.
 * Returns `[{ name, content }]` — a single sitemap.xml, or an index plus parts
 * once the 50,000 URL limit is passed.
 */
export function buildSitemapFiles(pages, settings = DEFAULT_EXPORT_SETTINGS, rootUrl = '') {
  const merged = { ...DEFAULT_EXPORT_SETTINGS, ...settings }
  const selected = pages

  if (selected.length <= URLS_PER_SITEMAP) {
    return [{ name: 'sitemap.xml', content: urlsetDocument(selected, merged) }]
  }

  const chunks = []
  for (let index = 0; index < selected.length; index += URLS_PER_SITEMAP) {
    chunks.push(selected.slice(index, index + URLS_PER_SITEMAP))
  }

  const today = new Date().toISOString().slice(0, 10)
  const files = chunks.map((chunk, index) => ({
    name: `sitemap-${index + 1}.xml`,
    content: urlsetDocument(chunk, merged),
  }))

  let base = ''
  try {
    base = new URL('/', rootUrl).toString()
  } catch {
    base = ''
  }

  const index = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...files.map((file) =>
      [
        '  <sitemap>',
        `    <loc>${escapeXml(base + file.name)}</loc>`,
        `    <lastmod>${today}</lastmod>`,
        '  </sitemap>',
      ].join('\n'),
    ),
    '</sitemapindex>',
    '',
  ].join('\n')

  return [{ name: 'sitemap.xml', content: index }, ...files]
}

/**
 * Gzips a file for upload. Search engines accept gzipped sitemaps, and the
 * saving matters once a sitemap runs to tens of thousands of URLs.
 * The content is returned base64-encoded so it survives the JSON response.
 */
export function gzipFile(file) {
  return {
    name: `${file.name}.gz`,
    content: gzipSync(Buffer.from(file.content, 'utf8')).toString('base64'),
    encoding: 'base64',
  }
}

export function buildTxt(pages) {
  return `${pages.map((page) => page.url).join('\n')}\n`
}

function csvCell(value) {
  if (value == null) return ''
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function buildCsv(pages) {
  const headers = [
    'url', 'status', 'depth', 'title', 'meta_description', 'h1', 'canonical',
    'noindex', 'word_count', 'internal_links', 'external_links', 'content_type',
    'last_modified', 'response_ms', 'bytes', 'discovered_via', 'parent',
  ]

  const rows = pages.map((page) =>
    [
      page.url, page.status, page.depth, page.title, page.description, page.h1, page.canonical,
      page.noindex ? 'yes' : 'no', page.wordCount, page.internalLinks, page.externalLinks,
      page.contentType, page.lastModified, page.responseMs, page.bytes, page.discoveredVia, page.parent,
    ]
      .map(csvCell)
      .join(','),
  )

  return `${[headers.join(','), ...rows].join('\n')}\n`
}

/** Groups pages by their first path segment for the HTML sitemap. */
function groupBySection(pages) {
  const groups = new Map()
  for (const page of pages) {
    let section = 'Home'
    try {
      const segments = new URL(page.url).pathname.split('/').filter(Boolean)
      if (segments.length > 0) section = segments[0].replace(/[-_]/g, ' ')
    } catch {
      /* keep default */
    }
    if (!groups.has(section)) groups.set(section, [])
    groups.get(section).push(page)
  }
  return [...groups.entries()].sort((a, b) => {
    if (a[0] === 'Home') return -1
    if (b[0] === 'Home') return 1
    return a[0].localeCompare(b[0])
  })
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** A standalone, dependency-free HTML sitemap page ready to publish. */
export function buildHtmlSitemap(pages, rootUrl) {
  let host = rootUrl
  try {
    host = new URL(rootUrl).hostname
  } catch {
    /* keep the raw value */
  }

  const sections = groupBySection(pages)
    .map(([section, items]) => {
      const links = items
        .map((page) => {
          const label = page.title || new URL(page.url).pathname
          return `      <li><a href="${escapeHtml(page.url)}">${escapeHtml(label)}</a></li>`
        })
        .join('\n')
      return `    <section>\n      <h2>${escapeHtml(section)}</h2>\n      <ul>\n${links}\n      </ul>\n    </section>`
    })
    .join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sitemap — ${escapeHtml(host)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0 auto; max-width: 60rem; padding: 3rem 1.5rem; }
  h1 { font-size: 1.75rem; margin-bottom: .25rem; }
  p.meta { color: #6b7280; margin-top: 0; }
  section { margin-top: 2rem; }
  h2 { font-size: 1.05rem; text-transform: capitalize; border-bottom: 1px solid #e5e7eb; padding-bottom: .4rem; }
  ul { list-style: none; padding: 0; display: grid; gap: .35rem; grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr)); }
  a { color: inherit; text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
  <h1>Sitemap</h1>
  <p class="meta">${pages.length} pages on ${escapeHtml(host)} — generated ${new Date().toISOString().slice(0, 10)}</p>
${sections}
</body>
</html>
`
}

/** The robots.txt line that points crawlers at the generated sitemap. */
export function robotsLine(rootUrl) {
  try {
    return `Sitemap: ${new URL('/sitemap.xml', rootUrl).toString()}`
  } catch {
    return 'Sitemap: /sitemap.xml'
  }
}
