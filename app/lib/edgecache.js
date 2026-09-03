/**
 * Answers kept at the edge, so the store is asked once per question rather
 * than once per visitor.
 *
 * Cloudflare's Cache API holds a response in the data centre that produced
 * it, keyed by a URL of our choosing. Two things make it the right place for
 * the parcel catalogue and the parcel search:
 *
 *   - The answers are the same for everyone. A market's totals, a page of a
 *     search, a tile out of an archive — none of it depends on who asked.
 *     Only the right to ask does, and that is checked before the cache is.
 *   - The store bills by rows read and the bucket by objects read, and both
 *     are consulted for the same handful of questions all day: opening a
 *     market, the tiles under a city centre, the layer catalogue. Serving the
 *     second and every later visitor from the edge costs nothing at all.
 *
 * Outside Workers — the Node rig, the tests — there is no cache and every
 * call produces its answer directly, which is the same behaviour minus the
 * saving. That is deliberate: this must never be a correctness dependency.
 *
 * The key is a synthetic URL on the request's own origin, so it cannot
 * collide with a real route, is purgeable through the zone, and carries the
 * question's parameters sorted so that the same filters in another order are
 * the same question.
 */

/** Shared caches only. Browsers ignore s-maxage, so a stale copy cannot outlive us in a browser. */
const cacheControl = (ttl) => `public, s-maxage=${Math.max(1, Math.floor(ttl))}`

/** The Cache API, when this runtime has one. */
function store() {
  const caches = globalThis.caches
  return caches && caches.default && typeof caches.default.match === 'function' ? caches.default : null
}

/** A request that names one question. */
export function edgeKey(requestUrl, name, params = {}) {
  const origin = new URL(requestUrl).origin
  const query = new URLSearchParams()
  for (const key of Object.keys(params).sort()) {
    const value = params[key]
    if (value == null || value === '') continue
    query.set(key, String(value))
  }
  const suffix = query.toString()
  return new Request(`${origin}/__edge/${name}${suffix ? `?${suffix}` : ''}`, { method: 'GET' })
}

/** The request's own query, as the parameters of the question it asks. */
export function queryParams(requestUrl) {
  const out = {}
  for (const [key, value] of new URL(requestUrl).searchParams) out[key] = value
  return out
}

/**
 * Answer from the edge, or produce and remember.
 *
 * Only a 200 (or a 206 for a byte range) is kept: an error is a moment, not
 * an answer. `ttl` is seconds. The remembered copy carries the header that
 * tells the edge how long to keep it; the copy handed back is the one that
 * was produced, headers untouched.
 */
export async function edgeCached(c, name, ttl, produce, { params = null, cacheable = null } = {}) {
  const cache = store()
  if (!cache) return produce()
  const key = edgeKey(c.req.url, name, params ?? queryParams(c.req.url))
  try {
    const held = await cache.match(key)
    if (held) {
      const answer = new Response(held.body, held)
      answer.headers.set('x-edge-cache', 'hit')
      return answer
    }
  } catch {
    /* a cache that cannot be read is a cache that is not there */
  }
  const fresh = await produce()
  const status = fresh.status
  const keep = cacheable ? cacheable(fresh) : status === 200 || status === 206
  if (!keep) return fresh
  const [toUser, toCache] = fresh.body ? fresh.body.tee() : [null, null]
  const stored = new Response(toCache, { status, headers: new Headers(fresh.headers) })
  stored.headers.set('cache-control', cacheControl(ttl))
  stored.headers.delete('set-cookie')
  const answer = new Response(toUser, { status, headers: new Headers(fresh.headers) })
  answer.headers.set('x-edge-cache', 'miss')
  const put = cache.put(key, stored).catch(() => {})
  try {
    c.executionCtx?.waitUntil?.(put)
  } catch {
    /* no execution context to hand the write to; it still completes on its own */
  }
  return answer
}
