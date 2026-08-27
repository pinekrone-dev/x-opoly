/**
 * The one place geospatial constants live on the frontend.
 *
 * Every circle drawn on the map converts miles to metres with this exact
 * figure — the international mile — so a 5-mile non-compete ring on screen
 * is the same 5 miles the backend measures with its haversine.
 */
export const METERS_PER_MILE = 1609.344

/**
 * A circle of a given radius, as a polygon.
 *
 * Leaflet drew geographic circles itself; MapLibre has no such primitive, so a
 * radius has to become a ring of points before it can be a layer. The
 * longitude step is divided by cos(latitude) because a degree of longitude
 * narrows towards the poles — without it a non-compete circle in Miami and one
 * in Seattle would be drawn the same width and only one of them would be right.
 */
export function circlePolygon(
  lat: number,
  lng: number,
  radiusMeters: number,
  steps = 72,
): [number, number][] {
  const latRadius = radiusMeters / 111_320
  const lngRadius = latRadius / Math.max(Math.cos((lat * Math.PI) / 180), 1e-6)
  const ring: [number, number][] = []
  for (let i = 0; i <= steps; i += 1) {
    const angle = (i / steps) * Math.PI * 2
    ring.push([lng + lngRadius * Math.cos(angle), lat + latRadius * Math.sin(angle)])
  }
  return ring
}

/**
 * Expands a raster tile template into what MapLibre wants.
 *
 * Leaflet understands `{s}` (a subdomain to spread requests across) and `{r}`
 * (the "@2x" retina suffix). MapLibre understands neither: it takes a list of
 * fully-formed URLs. So `{s}` becomes one URL per subdomain, and `{r}` is
 * resolved once from the display this browser is actually on.
 */
export function tileUrls(template: string): string[] {
  const retina = typeof window !== 'undefined' && window.devicePixelRatio > 1.25 ? '@2x' : ''
  const resolved = template.replace('{r}', retina)
  if (!resolved.includes('{s}')) return [resolved]
  return ['a', 'b', 'c'].map((sub) => resolved.replace('{s}', sub))
}
