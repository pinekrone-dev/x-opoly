/**
 * Derives the "issues" view from a finished crawl.
 *
 * Every check answers a question someone would otherwise ask by hand: which
 * URLs are broken, which ones will never be indexed, which ones duplicate each
 * other, and which ones are buried too deep to be found.
 */

const TITLE_MAX = 60
const TITLE_MIN = 25
const DESCRIPTION_MAX = 160
const DESCRIPTION_MIN = 70
const THIN_CONTENT_WORDS = 150
const DEEP_PAGE_DEPTH = 4
const SLOW_PAGE_MS = 2000

function duplicatesBy(pages, selector) {
  const groups = new Map()
  for (const page of pages) {
    const key = selector(page)
    if (!key) continue
    const normalized = key.toLowerCase().trim()
    if (!groups.has(normalized)) groups.set(normalized, [])
    groups.get(normalized).push(page)
  }
  return [...groups.values()].filter((group) => group.length > 1)
}

function issue(id, severity, label, description, urls, extra = {}) {
  return { id, severity, label, description, count: urls.length, urls: urls.slice(0, 200), ...extra }
}

/**
 * @param {object} result output of `CrawlJob#result()`
 * @returns {{ issues: object[], stats: object }}
 */
export function auditCrawl(result) {
  const pages = result.pages || []
  const html = pages.filter((page) => !page.isDocument)
  const issues = []

  const broken = pages.filter((page) => page.status === 0 || page.status >= 400)
  if (broken.length) {
    issues.push(
      issue(
        'broken-pages',
        'error',
        'Broken pages',
        'These URLs are linked from the site but did not return a page. Fix the link or the page before publishing a sitemap.',
        broken.map((page) => ({ url: page.url, detail: page.error || `HTTP ${page.status}`, from: page.parent })),
      ),
    )
  }

  const serverErrors = pages.filter((page) => page.status >= 500)
  if (serverErrors.length) {
    issues.push(
      issue(
        'server-errors',
        'error',
        'Server errors',
        'The server failed while rendering these URLs. They are excluded from the sitemap.',
        serverErrors.map((page) => ({ url: page.url, detail: `HTTP ${page.status}` })),
      ),
    )
  }

  const redirected = pages.filter((page) => page.redirectTo)
  if (redirected.length) {
    issues.push(
      issue(
        'redirects',
        'warning',
        'Redirected URLs',
        'Internal links point at a URL that redirects. Linking straight to the destination saves a round trip and keeps the sitemap clean.',
        redirected.map((page) => ({ url: page.url, detail: `${page.status} → ${page.redirectTo}`, from: page.parent })),
      ),
    )
  }

  const redirectTargets = new Set(pages.filter((page) => page.redirectTo).map((page) => page.url))
  const chains = pages.filter((page) => page.redirectTo && redirectTargets.has(page.redirectTo))
  if (chains.length) {
    issues.push(
      issue(
        'redirect-chains',
        'warning',
        'Redirect chains',
        'These URLs redirect more than once before landing on a page.',
        chains.map((page) => ({ url: page.url, detail: `${page.url} → ${page.redirectTo} → …` })),
      ),
    )
  }

  const noindex = html.filter((page) => page.noindex)
  if (noindex.length) {
    issues.push(
      issue(
        'noindex',
        'info',
        'Blocked from indexing',
        'A robots meta tag or X-Robots-Tag header keeps these pages out of search results, so they are left out of the sitemap.',
        noindex.map((page) => ({ url: page.url, detail: 'noindex' })),
      ),
    )
  }

  const canonicalized = html.filter((page) => page.canonical && page.canonical !== page.url)
  if (canonicalized.length) {
    issues.push(
      issue(
        'canonicalized',
        'info',
        'Points at a different canonical',
        'These URLs name another page as the canonical version. Sitemaps should list the canonical URL instead.',
        canonicalized.map((page) => ({ url: page.url, detail: `→ ${page.canonical}` })),
      ),
    )
  }

  const missingTitle = html.filter((page) => page.ok && !page.title)
  if (missingTitle.length) {
    issues.push(
      issue('missing-title', 'warning', 'Missing title', 'A page without a <title> gives search engines nothing to show in results.',
        missingTitle.map((page) => ({ url: page.url, detail: 'no <title>' }))),
    )
  }

  const longTitle = html.filter((page) => page.title && page.title.length > TITLE_MAX)
  if (longTitle.length) {
    issues.push(
      issue('long-title', 'info', `Title over ${TITLE_MAX} characters`, 'Long titles get cut off in search results.',
        longTitle.map((page) => ({ url: page.url, detail: `${page.title.length} chars` }))),
    )
  }

  const shortTitle = html.filter((page) => page.title && page.title.length < TITLE_MIN)
  if (shortTitle.length) {
    issues.push(
      issue('short-title', 'info', `Title under ${TITLE_MIN} characters`, 'Very short titles usually leave useful keywords on the table.',
        shortTitle.map((page) => ({ url: page.url, detail: `${page.title.length} chars` }))),
    )
  }

  for (const group of duplicatesBy(html, (page) => page.title)) {
    issues.push(
      issue('duplicate-title', 'warning', 'Duplicate title', `${group.length} pages share the title "${group[0].title}".`,
        group.map((page) => ({ url: page.url, detail: page.title }))),
    )
  }

  const missingDescription = html.filter((page) => page.ok && !page.description)
  if (missingDescription.length) {
    issues.push(
      issue('missing-description', 'info', 'Missing meta description', 'Without a description the search snippet is written for you.',
        missingDescription.map((page) => ({ url: page.url, detail: 'no meta description' }))),
    )
  }

  const badDescription = html.filter(
    (page) => page.description && (page.description.length > DESCRIPTION_MAX || page.description.length < DESCRIPTION_MIN),
  )
  if (badDescription.length) {
    issues.push(
      issue('description-length', 'info', 'Meta description length', `Aim for roughly ${DESCRIPTION_MIN}–${DESCRIPTION_MAX} characters.`,
        badDescription.map((page) => ({ url: page.url, detail: `${page.description.length} chars` }))),
    )
  }

  const missingH1 = html.filter((page) => page.ok && page.status < 300 && !page.h1)
  if (missingH1.length) {
    issues.push(
      issue('missing-h1', 'info', 'Missing H1', 'Each page should carry one clear top-level heading.',
        missingH1.map((page) => ({ url: page.url, detail: 'no <h1>' }))),
    )
  }

  const thin = html.filter((page) => page.ok && page.status < 300 && page.wordCount > 0 && page.wordCount < THIN_CONTENT_WORDS)
  if (thin.length) {
    issues.push(
      issue('thin-content', 'info', 'Thin content', `Fewer than ${THIN_CONTENT_WORDS} words of body copy.`,
        thin.map((page) => ({ url: page.url, detail: `${page.wordCount} words` }))),
    )
  }

  const deep = pages.filter((page) => page.depth > DEEP_PAGE_DEPTH)
  if (deep.length) {
    issues.push(
      issue('deep-pages', 'info', `More than ${DEEP_PAGE_DEPTH} levels deep`, 'Pages this far from the home page are crawled less often.',
        deep.map((page) => ({ url: page.url, detail: `depth ${page.depth}` }))),
    )
  }

  const slow = pages.filter((page) => page.responseMs > SLOW_PAGE_MS)
  if (slow.length) {
    issues.push(
      issue('slow-pages', 'info', 'Slow responses', `These URLs took over ${SLOW_PAGE_MS} ms to respond.`,
        slow.map((page) => ({ url: page.url, detail: `${page.responseMs} ms` }))),
    )
  }

  const sitemapOnly = pages.filter((page) => page.discoveredVia === 'sitemap' && !page.parent && page.depth > 0)
  if (sitemapOnly.length) {
    issues.push(
      issue(
        'orphan-pages',
        'warning',
        'Not linked from the site',
        'These URLs appear in the published sitemap but no crawled page links to them.',
        sitemapOnly.map((page) => ({ url: page.url, detail: 'sitemap only' })),
      ),
    )
  }

  const brokenExternal = (result.externalLinks || []).filter((link) => link.status != null && (link.status === 0 || link.status >= 400))
  if (brokenExternal.length) {
    issues.push(
      issue('broken-external', 'warning', 'Broken outbound links', 'Links to other sites that no longer resolve.',
        brokenExternal.map((link) => ({ url: link.url, detail: link.status === 0 ? 'unreachable' : `HTTP ${link.status}`, from: link.from?.[0] }))),
    )
  }

  const severityRank = { error: 0, warning: 1, info: 2 }
  issues.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || b.count - a.count)

  return { issues, stats: statsFor(result) }
}

export function statsFor(result) {
  const pages = result.pages || []
  const ok = pages.filter((page) => page.ok && page.status < 300)
  const totalWords = ok.reduce((sum, page) => sum + (page.wordCount || 0), 0)
  const totalMs = pages.reduce((sum, page) => sum + (page.responseMs || 0), 0)
  const depths = pages.map((page) => page.depth)

  return {
    total: pages.length,
    indexable: ok.filter((page) => !page.noindex && (!page.canonical || page.canonical === page.url)).length,
    ok: ok.length,
    redirects: pages.filter((page) => page.redirectTo).length,
    broken: pages.filter((page) => page.status === 0 || page.status >= 400).length,
    noindex: pages.filter((page) => page.noindex).length,
    documents: pages.filter((page) => page.isDocument).length,
    externalLinks: (result.externalLinks || []).length,
    maxDepth: depths.length ? Math.max(...depths) : 0,
    avgWords: ok.length ? Math.round(totalWords / ok.length) : 0,
    avgResponseMs: pages.length ? Math.round(totalMs / pages.length) : 0,
  }
}
