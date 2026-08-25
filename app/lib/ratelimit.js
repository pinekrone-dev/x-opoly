/**
 * A sliding-window rate limiter, in memory.
 *
 * Per isolate on Workers and per process on Node, which is the honest scope
 * of what memory can offer: a determined distributed attacker needs edge
 * rules, but the common abuse — one script hammering login, signup, or the
 * AI endpoints — comes from few addresses and lands on few isolates, and
 * this stops it without a datastore round trip on every request.
 */

const buckets = new Map()

/** How many timestamps the map may hold before old windows are swept. */
const SWEEP_AT = 10_000

function sweep(now) {
  for (const [key, entry] of buckets) {
    if (entry.stamps.length === 0 || entry.stamps[entry.stamps.length - 1] + entry.windowMs < now) {
      buckets.delete(key)
    }
  }
}

/**
 * Records a hit and answers whether it is allowed.
 *
 * `key` should combine the bucket's name with who is asking (usually the
 * client address): 'login:203.0.113.9'.
 */
export function rateLimit(key, { limit, windowMs, now = Date.now() } = {}) {
  if (buckets.size > SWEEP_AT) sweep(now)

  let entry = buckets.get(key)
  if (!entry) {
    entry = { stamps: [], windowMs }
    buckets.set(key, entry)
  }
  entry.windowMs = windowMs
  entry.stamps = entry.stamps.filter((stamp) => stamp > now - windowMs)

  if (entry.stamps.length >= limit) {
    const retryAfterMs = entry.stamps[0] + windowMs - now
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) }
  }

  entry.stamps.push(now)
  return { allowed: true, remaining: limit - entry.stamps.length }
}

/** Test hook: a limiter with state is a limiter tests must be able to reset. */
export function resetRateLimits() {
  buckets.clear()
}

/** The client's address, as well as a proxy chain can tell it. */
export function clientAddress(c) {
  return (
    c.req.header('cf-connecting-ip') ||
    (c.req.header('x-forwarded-for') || '').split(',')[0].trim() ||
    'unknown'
  )
}
