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
  // The data centre answering, so that two reads that disagree about the
  // edge can be told apart from two data centres: the edge is one place.
  const colo = c.req.raw?.cf?.colo || null
  // A reader who asks to see the store's answer waits for it, and is told
  // whether the copy was kept — the probe, not the browser.
  const debug = Boolean(typeof c.req.header === 'function' && c.req.header('x-edge-debug'))
  try {
    const held = await cache.match(key)
    if (held) {
      /*
       * A byte range comes back as the 200 it was stored as and is turned
       * back into the 206 it was: the edge refuses to keep a partial
       * response, so the range's bytes are kept whole under a key that
       * names the range, with the content-range set aside in a header of
       * our own.
       */
      const span = held.headers.get('x-edge-range')
      const headers = new Headers(held.headers)
      headers.delete('x-edge-range')
      if (span) headers.set('content-range', span)
      const answer = new Response(held.body, { status: span ? 206 : held.status, headers })
      answer.headers.set('x-edge-cache', 'hit')
      if (colo) answer.headers.set('x-edge-colo', colo)
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
  const stored = new Response(toCache, { status: 200, headers: new Headers(fresh.headers) })
  stored.headers.set('cache-control', cacheControl(ttl))
  stored.headers.delete('set-cookie')
  if (status === 206) {
    const span = fresh.headers.get('content-range')
    if (span) stored.headers.set('x-edge-range', span)
    stored.headers.delete('content-range')
  }
  const answer = new Response(toUser, { status, headers: new Headers(fresh.headers) })
  answer.headers.set('x-edge-cache', 'miss')
  if (colo) answer.headers.set('x-edge-colo', colo)
  const put = cache.put(key, stored).then(
    () => 'stored',
    (error) => `refused: ${error && error.message ? error.message : error}`,
  )
  if (debug) {
    // Waited for, then asked back: a put resolves whether or not the edge
    // kept the copy, so only a match says what happened.
    let outcome = await put
    if (outcome === 'stored') {
      try {
        outcome = (await cache.match(key)) ? 'stored' : 'missing'
      } catch {
        outcome = 'unreadable'
      }
    }
    answer.headers.set('x-edge-store', outcome)
    return answer
  }
  // Handed to the runtime to finish after the answer is sent, where that is
  // possible; awaited otherwise, since a write nobody waits for is a write
  // the runtime may drop when the request ends.
  let handed = false
  try {
    const ctx = c.executionCtx
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(put)
      handed = true
    }
  } catch {
    /* no execution context here */
  }
  if (!handed) await put
  return answer
}
