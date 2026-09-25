/**
 * Link previews across more than one domain.
 *
 * Open Graph and Twitter cards demand absolute URLs — a crawler has no page
 * context to resolve a relative one against. But the same built `index.html`
 * is served from several hostnames (the custom domain, its `www.` variant,
 * the workers.dev address), so the right absolute URL is not knowable until
 * the request arrives.
 *
 * So the build ships a real, live origin as a placeholder and the server
 * swaps it for whichever host answered. Shipping a working URL rather than a
 * token means the worst case is a preview pointing at the other domain, not a
 * broken image.
 */

/** The origin baked into index.html at build time. */
export const PLACEHOLDER_ORIGIN = 'https://landquotient.com'

/** Rewrites preview URLs in `html` to `origin`. A no-op when they match. */
export function withPreviewOrigin(html, origin) {
  if (!origin || origin === PLACEHOLDER_ORIGIN) return html
  return html.split(PLACEHOLDER_ORIGIN).join(origin)
}

/** True for responses whose body is HTML worth rewriting. */
export function isHtml(response) {
  return (response.headers.get('content-type') || '').includes('text/html')
}

/*
 * A preview for every link, not only the public pages.
 *
 * The public pages each ship their own HTML entry with their own card. Every
 * other address (a client share link, a market's map, anything inside the
 * app) is answered with index.html, so without this a pasted share link
 * unfurled as the landing page: "Land Quotient — Real Estate Intelligence",
 * pointing at the home page, which is both the wrong card and, for the
 * services that follow og:url, the wrong link.
 *
 * The rewrite is plain string work on tags the build controls, so it runs
 * the same in the Worker and in the tests.
 */

const escapeAttr = (text) =>
  String(text).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch])

function setMeta(html, attr, name, value) {
  const pattern = new RegExp(`(<meta\\s+${attr}="${name.replace(/[.:]/g, '\\$&')}"\\s+content=")[^"]*(")`, 's')
  return html.replace(pattern, `$1${escapeAttr(value)}$2`)
}

/**
 * Writes a page's own preview into `html`. Any field left out keeps what the
 * page already says. `url` and `image` are absolute.
 */
export function rewritePreview(html, { title, description, url, image } = {}) {
  let out = html
  if (title) {
    out = out.replace(/<title>[^<]*<\/title>/, `<title>${escapeAttr(title)}</title>`)
    out = setMeta(out, 'property', 'og:title', title)
    out = setMeta(out, 'property', 'og:image:alt', title)
    out = setMeta(out, 'name', 'twitter:title', title)
  }
  if (description) {
    out = setMeta(out, 'name', 'description', description)
    out = setMeta(out, 'property', 'og:description', description)
    out = setMeta(out, 'name', 'twitter:description', description)
  }
  if (url) out = setMeta(out, 'property', 'og:url', url)
  if (image) {
    out = setMeta(out, 'property', 'og:image', image)
    out = setMeta(out, 'name', 'twitter:image', image)
  }
  return out
}

/** The card behind share links and market maps; versioned like the others. */
export const SHARE_CARD = '/og-share.png?v=20260925'
export const MAP_CARD = '/og-gis.png?v=20260911'

/** "north-jersey-nj" reads as "North Jersey, NJ". */
export function placeFromSlug(slug) {
  const words = String(slug || '').toLowerCase().split('-').filter(Boolean)
  if (!words.length) return null
  const state = words.length > 1 && words.at(-1).length === 2 ? words.pop().toUpperCase() : null
  const name = words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')
  return state ? `${name}, ${state}` : name
}

/**
 * What a client share link should say about itself: the survey's name and
 * who prepared it, as the page itself shows them to anyone holding the link.
 * The client's name is left out, since a preview can travel further than the
 * link it came from. A link that no longer opens says so, rather than
 * advertising a survey the reader cannot see.
 */
export async function sharePreview(db, token) {
  const row = await db.get(
    'SELECT name, broker_name, company_name, share_enabled, share_expires_at FROM surveys WHERE share_token = ?',
    [token],
  )
  const live =
    row &&
    Number(row.share_enabled) === 1 &&
    !(row.share_expires_at && new Date(row.share_expires_at).getTime() < Date.now())
  if (!live) {
    return {
      title: 'Market survey | Land Quotient',
      description: 'This link is no longer active. Ask the broker who sent it for a new one.',
    }
  }
  const by = [row.broker_name, row.company_name].filter(Boolean).join(', ')
  return {
    title: `${row.name || 'Market survey'} | Market survey`,
    description:
      `${by ? `Prepared by ${by}. ` : ''}` +
      'The shortlisted sites on a live map, with the numbers and the tour. Opens in the browser, no login.',
  }
}

/**
 * The preview for any path answered with index.html. `lookupShare` is
 * sharePreview bound to a database, or null where there is none. Returns
 * the fields to write, always including the page's own url.
 */
export async function previewForPath(pathname, origin, { lookupShare = null } = {}) {
  const path = pathname.replace(/\/+$/, '') || '/'
  const url = `${origin}${path === '/' ? '/' : path}`
  const shared = path.match(/^\/s\/([\w-]+)$/)
  if (shared) {
    const found = lookupShare ? await lookupShare(shared[1]).catch(() => null) : null
    return {
      url,
      image: `${origin}${SHARE_CARD}`,
      ...(found ?? {
        title: 'Market survey | Land Quotient',
        description: 'A live market survey: the shortlisted sites on one map. Opens in the browser, no login.',
      }),
    }
  }
  const market = path.match(/^\/gis\/([\w-]+)$/)
  if (market) {
    const place = placeFromSlug(market[1])
    return {
      url,
      image: `${origin}${MAP_CARD}`,
      title: `${place} parcel map | Land Quotient`,
      description: `Every parcel in ${place} on one map, with zoning, permits and the owner of record behind each one.`,
    }
  }
  return { url }
}
