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
export const PLACEHOLDER_ORIGIN = 'https://survey.realestateaistudio.com'

/** Rewrites preview URLs in `html` to `origin`. A no-op when they match. */
export function withPreviewOrigin(html, origin) {
  if (!origin || origin === PLACEHOLDER_ORIGIN) return html
  return html.split(PLACEHOLDER_ORIGIN).join(origin)
}

/** True for responses whose body is HTML worth rewriting. */
export function isHtml(response) {
  return (response.headers.get('content-type') || '').includes('text/html')
}
