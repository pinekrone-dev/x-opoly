/**
 * Tour planning.
 *
 * Brokers drive clients between candidate sites in one afternoon, so the order
 * matters. This runs entirely locally — no routing API, no key, no quota —
 * using straight-line distance, which is a good enough proxy for ordering
 * stops within a metro area.
 */

const EARTH_RADIUS_MILES = 3958.8

/** Above this many stops, trying every starting point stops being worth it. */
const MULTI_START_LIMIT = 60

/** Great-circle distance in miles. */
export function haversineMiles(a, b) {
  const toRadians = (degrees) => (degrees * Math.PI) / 180
  const dLat = toRadians(b.lat - a.lat)
  const dLng = toRadians(b.lng - a.lng)
  const lat1 = toRadians(a.lat)
  const lat2 = toRadians(b.lat)

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Total length of a route through `stops` in order. */
export function routeLength(stops) {
  let total = 0
  for (let index = 1; index < stops.length; index += 1) {
    total += haversineMiles(stops[index - 1], stops[index])
  }
  return total
}

/** Greedy nearest-neighbour ordering from a fixed starting point. */
function nearestNeighbour(stops, startIndex = 0) {
  const remaining = stops.map((_, index) => index)
  const order = [remaining.splice(startIndex, 1)[0]]

  while (remaining.length > 0) {
    const current = stops[order[order.length - 1]]
    let bestPosition = 0
    let bestDistance = Infinity
    remaining.forEach((candidate, position) => {
      const distance = haversineMiles(current, stops[candidate])
      if (distance < bestDistance) {
        bestDistance = distance
        bestPosition = position
      }
    })
    order.push(remaining.splice(bestPosition, 1)[0])
  }
  return order
}

/** Length of a route expressed as an index order. */
function orderLength(stops, order) {
  let total = 0
  for (let index = 1; index < order.length; index += 1) {
    total += haversineMiles(stops[order[index - 1]], stops[order[index]])
  }
  return total
}

/**
 * 2-opt improvement: repeatedly reverse a segment when doing so shortens the
 * route. Nearest-neighbour alone leaves obvious crossings; this removes them.
 *
 * Note this holds the first stop in place — on an open path a reversal cannot
 * relocate the start — so the caller is responsible for trying other starts.
 */
function twoOpt(stops, order, maxPasses = 40) {
  const distance = (a, b) => haversineMiles(stops[a], stops[b])
  let improved = true
  let passes = 0
  let best = [...order]

  while (improved && passes < maxPasses) {
    improved = false
    passes += 1
    for (let i = 0; i < best.length - 2; i += 1) {
      for (let k = i + 2; k < best.length; k += 1) {
        // Compare the two edges we would replace against the two we'd create.
        const before = distance(best[i], best[i + 1]) + distance(best[k - 1], best[k])
        const after = distance(best[i], best[k - 1]) + distance(best[i + 1], best[k])
        if (after + 1e-9 < before) {
          const segment = best.slice(i + 1, k).reverse()
          best = [...best.slice(0, i + 1), ...segment, ...best.slice(k)]
          improved = true
        }
      }
    }
  }
  return best
}

/**
 * Orders `properties` into a sensible driving sequence.
 *
 * @param {Array} properties  records with lat/lng; those without coordinates
 *                            keep their relative order at the end
 * @param {object} options    `startId` pins the first stop
 * @returns {{ stops: Array, unlocated: Array, miles: number, minutes: number }}
 */
export function planTour(properties, { startId = null, averageMph = 30, minutesPerStop = 20 } = {}) {
  const located = properties.filter((property) => property.lat != null && property.lng != null)
  const unlocated = properties.filter((property) => property.lat == null || property.lng == null)

  if (located.length <= 1) {
    return { stops: located, unlocated, miles: 0, minutes: located.length * minutesPerStop }
  }

  const pinned = located.findIndex((property) => property.id === startId)

  let order
  if (pinned >= 0) {
    // The broker chose where to begin, so honour it and only tidy the rest.
    order = twoOpt(located, nearestNeighbour(located, pinned))
  } else {
    // Nearest-neighbour is only as good as the stop it starts from, and 2-opt
    // cannot move that stop afterwards — so try every start and keep the best.
    // Surveys are tens of sites, not thousands, so this stays cheap.
    const candidates = located.length <= MULTI_START_LIMIT ? located.map((_, index) => index) : [0]
    let bestLength = Infinity
    for (const start of candidates) {
      const candidate = twoOpt(located, nearestNeighbour(located, start))
      const length = orderLength(located, candidate)
      if (length < bestLength) {
        bestLength = length
        order = candidate
      }
    }
  }

  const stops = order.map((index) => located[index])
  const miles = routeLength(stops)

  return {
    stops,
    unlocated,
    miles: Math.round(miles * 10) / 10,
    minutes: Math.round((miles / averageMph) * 60 + stops.length * minutesPerStop),
  }
}

/** Per-leg distances, for the itinerary list. */
export function legs(stops) {
  return stops.slice(1).map((stop, index) => ({
    fromId: stops[index].id,
    toId: stop.id,
    miles: Math.round(haversineMiles(stops[index], stop) * 10) / 10,
  }))
}
