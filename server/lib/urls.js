/**
 * URL normalization and scope rules for the crawler.
 *
 * Everything the crawler stores or compares goes through `normalizeUrl` first so
 * that `/about`, `/about/`, `/about#team` and `/About/?utm_source=x` collapse to
 * a single record instead of being crawled four times.
 */

const SKIP_PROTOCOLS = new Set([
  'mailto:', 'tel:', 'sms:', 'javascript:', 'data:', 'blob:', 'ftp:', 'file:',
])

/** Query parameters that never change the page that is returned. */
const TRACKING_PARAMS = [
  /^utm_/i, /^fbclid$/i, /^gclid$/i, /^gbraid$/i, /^wbraid$/i, /^msclkid$/i,
  /^mc_(cid|eid)$/i, /^_ga$/i, /^ref$/i, /^ref_src$/i, /^igshid$/i, /^yclid$/i,
]

/** File extensions that are pages worth crawling for links. */
const PAGE_EXTENSIONS = new Set(['', '.html', '.htm', '.php', '.asp', '.aspx', '.jsp', '.shtml', '.xhtml'])

/** Non-page documents that are still worth listing in a sitemap. */
export const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.txt', '.rtf'])

/** Assets we never want in a sitemap and never want to fetch. */
const ASSET_EXTENSIONS = new Set([
  '.css', '.js', '.mjs', '.map', '.json', '.xml', '.rss', '.atom',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif', '.ico', '.bmp', '.tiff',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.webm', '.ogg', '.wav', '.mov', '.avi', '.mkv', '.m4a',
  '.zip', '.gz', '.tar', '.rar', '.7z', '.dmg', '.exe', '.apk', '.iso',
])

/** Returns the lowercased extension of a URL path, including the dot. */
export function extensionOf(pathname) {
  const last = pathname.slice(pathname.lastIndexOf('/') + 1)
  const dot = last.lastIndexOf('.')
  return dot === -1 ? '' : last.slice(dot).toLowerCase()
}

export function isAssetUrl(url) {
  try {
    return ASSET_EXTENSIONS.has(extensionOf(new URL(url).pathname))
  } catch {
    return false
  }
}

export function isDocumentUrl(url) {
  try {
    return DOCUMENT_EXTENSIONS.has(extensionOf(new URL(url).pathname))
  } catch {
    return false
  }
}

/** True when the URL looks like an HTML page rather than a document or asset. */
export function isPageUrl(url) {
  try {
    return PAGE_EXTENSIONS.has(extensionOf(new URL(url).pathname))
  } catch {
    return false
  }
}

/**
 * Resolve `href` against `base` and canonicalize it.
 * Returns null for anything that should never enter the queue.
 *
 * @param {string} href    raw href from the page (may be relative)
 * @param {string} base    absolute URL of the page the href was found on
 * @param {object} options
 */
export function normalizeUrl(href, base, options = {}) {
  const {
    stripQuery = false,
    stripTrackingParams = true,
    stripTrailingSlash = true,
    sortQueryParams = true,
  } = options

  if (typeof href !== 'string') return null
  const raw = href.trim()
  if (!raw || raw.startsWith('#')) return null

  let url
  try {
    url = base ? new URL(raw, base) : new URL(raw)
  } catch {
    return null
  }

  if (SKIP_PROTOCOLS.has(url.protocol)) return null
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null

  url.hash = ''
  url.hostname = url.hostname.toLowerCase()
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
    url.port = ''
  }

  if (stripQuery) {
    url.search = ''
  } else if (url.search) {
    const params = url.searchParams
    if (stripTrackingParams) {
      for (const key of [...params.keys()]) {
        if (TRACKING_PARAMS.some((re) => re.test(key))) params.delete(key)
      }
    }
    if (sortQueryParams) params.sort()
    url.search = params.toString() ? `?${params.toString()}` : ''
  }

  if (stripTrailingSlash && url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  }
  // Collapse accidental double slashes inside the path.
  url.pathname = url.pathname.replace(/\/{2,}/g, '/')

  return url.toString()
}

/** Normalizes user input like "example.com" into "https://example.com/". */
export function normalizeSeed(input) {
  if (typeof input !== 'string') return null
  let value = input.trim()
  if (!value) return null
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`
  try {
    const url = new URL(value)
    if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

/** Strips a leading "www." so that www and apex hosts count as the same site. */
export function baseHost(hostname) {
  return hostname.replace(/^www\./i, '').toLowerCase()
}

/** True when `url` belongs to the same site as `rootUrl`. */
export function isInternal(url, rootUrl, includeSubdomains = false) {
  try {
    const a = new URL(url)
    const b = new URL(rootUrl)
    if (includeSubdomains) {
      const root = baseHost(b.hostname)
      const host = a.hostname.toLowerCase()
      return host === root || host.endsWith(`.${root}`)
    }
    return baseHost(a.hostname) === baseHost(b.hostname)
  } catch {
    return false
  }
}

/** Path depth relative to the site root: "/" is 0, "/a" is 1, "/a/b" is 2. */
export function depthOf(url) {
  try {
    const { pathname } = new URL(url)
    const segments = pathname.split('/').filter(Boolean)
    return segments.length
  } catch {
    return 0
  }
}

/** Compiles a newline/comma separated list of patterns into RegExps. */
export function compilePatterns(input) {
  if (!input) return []
  const list = Array.isArray(input) ? input : String(input).split(/[\n,]/)
  const out = []
  for (const entry of list) {
    const pattern = entry.trim()
    if (!pattern) continue
    try {
      out.push(new RegExp(pattern, 'i'))
    } catch {
      // Not valid regex — fall back to a literal substring match.
      out.push(new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
    }
  }
  return out
}
