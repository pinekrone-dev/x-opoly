/**
 * A small, self-contained robots.txt parser.
 *
 * Implements the parts of the Robots Exclusion Protocol that matter for a
 * crawler of this kind: user-agent group selection, Allow/Disallow with `*` and
 * `$` wildcards, longest-match-wins precedence, Crawl-delay, and Sitemap
 * discovery.
 */

function parseGroups(text) {
  const groups = []
  const sitemaps = []
  let current = null
  let lastLineWasAgent = false

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue
    const colon = line.indexOf(':')
    if (colon === -1) continue

    const field = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (!value && field !== 'disallow') continue

    if (field === 'user-agent') {
      if (!current || !lastLineWasAgent) {
        current = { agents: [], rules: [], crawlDelay: null }
        groups.push(current)
      }
      current.agents.push(value.toLowerCase())
      lastLineWasAgent = true
      continue
    }

    lastLineWasAgent = false
    if (field === 'sitemap') {
      sitemaps.push(value)
      continue
    }
    if (!current) continue

    if (field === 'allow' || field === 'disallow') {
      // An empty Disallow means "allow everything" and carries no path.
      if (field === 'disallow' && value === '') continue
      current.rules.push({ allow: field === 'allow', path: value })
    } else if (field === 'crawl-delay') {
      const delay = Number.parseFloat(value)
      if (Number.isFinite(delay)) current.crawlDelay = delay
    }
  }

  return { groups, sitemaps }
}

/** Turns a robots.txt path pattern into an anchored RegExp. */
function patternToRegExp(pattern) {
  let source = ''
  for (const char of pattern) {
    if (char === '*') source += '.*'
    else if (char === '$') source += '$'
    else source += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}`)
}

/** Picks the most specific matching group for our user-agent. */
function selectGroup(groups, userAgent) {
  const ua = userAgent.toLowerCase()
  let best = null
  let bestScore = -1
  for (const group of groups) {
    for (const agent of group.agents) {
      let score = -1
      if (agent === '*') score = 0
      else if (ua.includes(agent)) score = agent.length
      if (score > bestScore) {
        bestScore = score
        best = group
      }
    }
  }
  return best
}

export class Robots {
  constructor({ rules = [], crawlDelay = null, sitemaps = [], available = false } = {}) {
    this.rules = rules
    this.crawlDelay = crawlDelay
    this.sitemaps = sitemaps
    this.available = available
  }

  /** True when the crawler is permitted to fetch this URL. */
  isAllowed(url) {
    if (!this.available || this.rules.length === 0) return true
    let path
    try {
      const parsed = new URL(url)
      path = `${parsed.pathname}${parsed.search}`
    } catch {
      return true
    }

    let decision = true
    let winningLength = -1
    for (const rule of this.rules) {
      if (!rule.regexp) rule.regexp = patternToRegExp(rule.path)
      if (!rule.regexp.test(path)) continue
      // Longest matching pattern wins; Allow beats Disallow on a tie.
      const length = rule.path.length
      if (length > winningLength || (length === winningLength && rule.allow)) {
        winningLength = length
        decision = rule.allow
      }
    }
    return decision
  }

  static parse(text, userAgent) {
    const { groups, sitemaps } = parseGroups(text)
    const group = selectGroup(groups, userAgent)
    return new Robots({
      rules: group ? group.rules : [],
      crawlDelay: group ? group.crawlDelay : null,
      sitemaps,
      available: true,
    })
  }

  /** Empty ruleset used when robots.txt is missing, blocked or unparseable. */
  static permissive() {
    return new Robots({ available: false })
  }
}

/** Fetches and parses the robots.txt for the origin of `rootUrl`. */
export async function fetchRobots(rootUrl, { userAgent, timeout = 10000, fetchImpl = fetch } = {}) {
  let robotsUrl
  try {
    robotsUrl = new URL('/robots.txt', rootUrl).toString()
  } catch {
    return Robots.permissive()
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    const response = await fetchImpl(robotsUrl, {
      headers: { 'user-agent': userAgent, accept: 'text/plain,*/*' },
      redirect: 'follow',
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!response.ok) return Robots.permissive()
    const text = await response.text()
    if (text.length > 2_000_000) return Robots.permissive()
    return Robots.parse(text, userAgent)
  } catch {
    return Robots.permissive()
  }
}
