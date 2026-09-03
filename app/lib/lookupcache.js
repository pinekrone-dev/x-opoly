/**
 * A small time-bounded cache for answers from outside services.
 *
 * Census demographics, nearby businesses and geocoding are all keyed by a
 * coordinate or a query string, all slow, all free, and all stable for hours
 * or days. Before this, every open of the demographics panel — and every
 * anonymous view of a shared map with shading on — went back to the Census
 * for the same block groups.
 *
 * In-memory and per app instance: on Cloudflare that is per isolate, which
 * is the same trade-off the rate limiter makes and for the same reason —
 * there is no shared store to reach for without adding one, and a per-isolate
 * cache still removes the repeat calls that dominate. Failures are never
 * cached: an outage is reported every time, not remembered.
 */
export function createLookupCache({ ttlMs, max = 500 } = {}) {
  const entries = new Map()

  return {
    /**
     * The cached value for `key`, or the result of `produce()` stored under
     * it. A hit is moved to the end so the eviction order is least recently
     * used rather than least recently inserted.
     */
    async remember(key, produce) {
      const now = Date.now()
      const hit = entries.get(key)
      if (hit && hit.expires > now) {
        entries.delete(key)
        entries.set(key, hit)
        return hit.value
      }
      const value = await produce()
      entries.set(key, { value, expires: now + ttlMs })
      while (entries.size > max) entries.delete(entries.keys().next().value)
      return value
    },

    get size() {
      return entries.size
    },

    clear() {
      entries.clear()
    },
  }
}

/**
 * A coordinate as a cache key, rounded so that two clicks on the same pin
 * share an entry. Four decimals is about eleven metres — the same block
 * group, the same set of nearby businesses, and well inside geocoder error.
 */
export function coordinateKey(lat, lng, decimals = 4) {
  return `${Number(lat).toFixed(decimals)},${Number(lng).toFixed(decimals)}`
}

export const HOUR = 60 * 60 * 1000
export const DAY = 24 * HOUR
