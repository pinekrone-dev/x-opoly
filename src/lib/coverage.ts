/**
 * Where a place falls on the picture of the country the home page draws.
 *
 * Kept apart from the component so it can be tested: a market dot that lands
 * in the wrong state is a wrong claim about coverage.
 */

const RAD = Math.PI / 180

/** Albers equal-area conic: the projection the country is usually drawn in. */
function albers(lon0: number, lat0: number, lat1: number, lat2: number) {
  const n = (Math.sin(lat1 * RAD) + Math.sin(lat2 * RAD)) / 2
  const c = Math.cos(lat1 * RAD) ** 2 + 2 * n * Math.sin(lat1 * RAD)
  const r0 = Math.sqrt(c - 2 * n * Math.sin(lat0 * RAD)) / n
  return (lon: number, lat: number): [number, number] => {
    const r = Math.sqrt(c - 2 * n * Math.sin(lat * RAD)) / n
    const t = n * (lon - lon0) * RAD
    return [r * Math.sin(t), r0 - r * Math.cos(t)]
  }
}

const LOWER = albers(-96, 37.5, 29.5, 45.5)
const ALASKA = albers(-154, 64, 55, 65)
const HAWAII = albers(-157, 20.5, 8, 18)

export const MAP_W = 960
export const MAP_H = 620

/**
 * A place on the picture. Alaska and Hawaii sit in the lower left at their
 * own scale, as they do on any map of the country drawn to fit a page.
 */
export function place(abbr: string, lon: number, lat: number): [number, number] {
  if (abbr === 'AK') {
    // The Aleutians cross the date line; keep them west of the mainland.
    const [x, y] = ALASKA(lon > 0 ? lon - 360 : lon, lat)
    return [135 + x * 330, 540 - y * 330]
  }
  if (abbr === 'HI') {
    const [x, y] = HAWAII(lon, lat)
    return [285 + x * 1250, 560 - y * 1250]
  }
  const [x, y] = LOWER(lon, lat)
  return [480 + x * 1250, 310 - y * 1250]
}

/** The state a market is in, read off its slug: austin-tx is Texas. */
export const stateOf = (slug: string): string => /-([a-z]{2})$/.exec(slug)?.[1].toUpperCase() ?? ''
