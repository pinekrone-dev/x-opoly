/**
 * Brand logos for nearby businesses.
 *
 * OpenStreetMap tags most chain stores with `brand:wikidata` (the Name
 * Suggestion Index adds it), and Wikidata holds the brand's logo image
 * (P154, a file on Wikimedia Commons) and its official website (P856).
 * So a logo is two free lookups, both batched fifty at a time: the claims
 * for the brands, then the Commons thumbnails for their logo files.
 *
 * A store with no brand tag but a website gets its site's favicon instead,
 * marked as such: a favicon is the business's own icon, not a logo anyone
 * vetted. A store with neither gets no logo, never a guessed one.
 *
 * Wikimedia rate limits clients that do not identify themselves, so every
 * request carries a descriptive User-Agent. A refusal leaves the logos
 * blank and the businesses as they were; it never fails the search.
 */

const WIKIDATA = 'https://www.wikidata.org/w/api.php'
const COMMONS = 'https://commons.wikimedia.org/w/api.php'
const UA = 'LandQuotient/1.0 (https://landquotient.com; brand logos for nearby businesses)'
const BATCH = 50
const QID = /^Q\d{1,12}$/

/** Hosts a pin's logo may load from. Anything else is dropped, on save and on draw. */
export const LOGO_HOSTS = ['upload.wikimedia.org', 'thumb.wikimedia.org', 'icons.duckduckgo.com']

/** A logo URL the map may load, or null. */
export function safeLogo(url) {
  try {
    const parsed = new URL(String(url))
    return parsed.protocol === 'https:' && LOGO_HOSTS.includes(parsed.hostname) ? parsed.toString() : null
  } catch {
    return null
  }
}

/** The site's favicon, through DuckDuckGo's icon service (no key, cached by them). */
export function faviconFor(website) {
  try {
    const host = new URL(/^https?:\/\//i.test(String(website)) ? String(website) : `https://${website}`).hostname
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) return null
    return `https://icons.duckduckgo.com/ip3/${host.replace(/^www\./i, '')}.ico`
  } catch {
    return null
  }
}

/** The claim's value Wikidata ranks first: preferred over normal, deprecated never. */
function claimValue(claims = []) {
  const usable = claims.filter((c) => c?.rank !== 'deprecated' && c?.mainsnak?.datavalue?.value)
  const pick = usable.find((c) => c.rank === 'preferred') ?? usable[0]
  return pick ? pick.mainsnak.datavalue.value : null
}

async function getJson(fetchImpl, url, timeout) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetchImpl(url, { headers: { 'user-agent': UA, 'api-user-agent': UA }, signal: controller.signal })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function chunks(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

// Brands seen by this isolate, so a busy corridor does not ask twice.
const memo = new Map()
const MEMO_MAX = 2000

/**
 * Logos for Wikidata brand ids. Returns Map(qid → { logo, website, file }),
 * with logo null where the brand has no logo on Commons.
 */
export async function brandLogos(qids, { fetchImpl = fetch, timeout = 8000, width = 128 } = {}) {
  const wanted = [...new Set((qids || []).map(String).filter((q) => QID.test(q)))]
  const out = new Map()
  const missing = []
  for (const q of wanted) {
    if (memo.has(q)) out.set(q, memo.get(q))
    else missing.push(q)
  }
  if (!missing.length) return out

  // The brands' logo files and websites.
  const facts = new Map()
  const groups = chunks(missing, BATCH)
  const answers = await Promise.all(groups.map((group) =>
    getJson(fetchImpl, `${WIKIDATA}?action=wbgetentities&props=claims&format=json&ids=${encodeURIComponent(group.join('|'))}`, timeout)))
  for (const [i, group] of groups.entries()) {
    const body = answers[i]
    if (!body?.entities) continue
    for (const q of group) {
      const claims = body.entities[q]?.claims
      if (!claims) continue
      facts.set(q, { file: claimValue(claims.P154), website: claimValue(claims.P856) })
    }
  }

  // The logo files' thumbnails, from Commons.
  const files = [...new Set([...facts.values()].map((f) => f.file).filter(Boolean))]
  const thumbs = new Map()
  const pages = await Promise.all(chunks(files, BATCH).map((group) => {
    const titles = group.map((f) => `File:${f}`).join('|')
    return getJson(fetchImpl, `${COMMONS}?action=query&prop=imageinfo&iiprop=url&iiurlwidth=${width}&format=json&titles=${encodeURIComponent(titles)}`, timeout)
  }))
  for (const body of pages) {
    if (!body?.query?.pages) continue
    // Commons answers under its own spelling of each title (spaces, not
    // underscores; a capital first letter), and says which it changed.
    const spelled = new Map((body.query.normalized || []).map((n) => [n.to, n.from]))
    for (const page of Object.values(body.query.pages)) {
      const info = page?.imageinfo?.[0]
      const asked = spelled.get(page.title) ?? page.title
      const src = safeLogo(stripTracking(info?.thumburl || info?.url))
      if (src) thumbs.set(String(asked).replace(/^File:/, ''), src)
    }
  }

  for (const q of missing) {
    const f = facts.get(q)
    // A brand Wikidata did not answer for is not remembered, so a refusal
    // under load is asked again next time rather than cached as "no logo".
    if (!f) continue
    const entry = { logo: f.file ? thumbs.get(f.file) ?? null : null, website: f.website ?? null, file: f.file ?? null }
    out.set(q, entry)
    if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value)
    memo.set(q, entry)
  }
  return out
}

/** Commons adds campaign parameters to thumbnail links; they are not part of the image. */
function stripTracking(url) {
  if (!url) return null
  try {
    const parsed = new URL(url)
    for (const key of [...parsed.searchParams.keys()]) if (key.startsWith('utm_')) parsed.searchParams.delete(key)
    return parsed.toString()
  } catch {
    return null
  }
}

/**
 * Adds `logo` and `logoSource` to each business: the brand's logo where
 * OpenStreetMap names the brand on Wikidata, else the website's favicon,
 * else nothing.
 */
export async function withLogos(results, options = {}) {
  const logos = await brandLogos(results.map((r) => r.brandWikidata).filter(Boolean), options)
  return results.map((r) => {
    const brand = r.brandWikidata ? logos.get(r.brandWikidata) : null
    if (brand?.logo) return { ...r, logo: brand.logo, logoSource: 'brand' }
    const site = r.website || brand?.website
    const icon = site ? faviconFor(site) : null
    return icon ? { ...r, logo: icon, logoSource: 'favicon' } : { ...r, logo: null, logoSource: null }
  })
}

/** For tests: forget what this isolate has seen. */
export function clearLogoMemo() {
  memo.clear()
}
