/*
 * Whether a parcel sits in a FEMA flood hazard area, read from the market's
 * own flood tiles.
 *
 * The flood layer already ships as a tile archive for the map, so this asks
 * that archive directly for the tile under the parcel and tests the parcel
 * against the polygons in it. The answer is on every parcel card whether the
 * layer is switched on or not, and it costs one ranged read of a file the
 * edge already caches: no database row, no pipeline join, nothing written.
 *
 * The card knows a parcel's bounding box, not its outline, so the parcel's
 * centre decides "in", and a small grid of points inside the box decides
 * "partly": a lot whose centre is dry but whose back edge runs into a
 * floodway should not read as clear. The grid stays inside the box's
 * middle, because a box is looser than the lot it holds and its corners are
 * often a neighbour's yard.
 *
 * This module is pure: the tile arrives as decoded rings through `readTile`,
 * so the geometry can be tested without a network or a map.
 */

export type Ring = { x: number; y: number }[]

/** One polygon feature from a decoded tile: its rings in tile units, and its properties. */
export interface TileFeature {
  rings: Ring[]
  properties: Record<string, unknown>
  /** minX, minY, maxX, maxY in tile units, when the decoder worked it out. */
  bbox?: [number, number, number, number]
}

/** Whether a point is inside a feature, testing its box before its outline. */
export function insideFeature(px: number, py: number, feature: TileFeature): boolean {
  const box = feature.bbox
  if (box && (px < box[0] || px > box[2] || py < box[1] || py > box[3])) return false
  return insideRings(px, py, feature.rings)
}

export interface DecodedTile {
  extent: number
  features: TileFeature[]
}

export type ReadTile = (z: number, x: number, y: number) => Promise<DecodedTile | null>

export interface FloodAnswer {
  /** in: the centre is in a hazard area. partly: some of the lot is. out: none of it. */
  status: 'in' | 'partly' | 'out'
  /** The zone at the centre, or the first zone found on the lot. */
  zone: string | null
  subtype: string | null
  /** Base flood elevation in feet, when FEMA publishes one for the zone. */
  bfe: number | null
  /** Every distinct zone met across the lot, for a lot that straddles two. */
  zones: string[]
}

/** Where a longitude and latitude fall at a zoom: which tile, and where inside it. */
export function tileCoords(lng: number, lat: number, z: number, extent: number) {
  const n = 2 ** z
  const x = ((lng + 180) / 360) * n
  const rad = (lat * Math.PI) / 180
  const y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n
  const tx = Math.floor(x)
  const ty = Math.floor(y)
  return { tx, ty, px: (x - tx) * extent, py: (y - ty) * extent }
}

/**
 * Even-odd across every ring of a feature: right for a polygon with holes,
 * and for a multipolygon, without first sorting outer rings from inner.
 */
export function insideRings(px: number, py: number, rings: Ring[]): boolean {
  let inside = false
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i]
      const b = ring[j]
      if (a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) inside = !inside
    }
  }
  return inside
}

/** The points a lot is tested at: its centre first, then a grid inside its box. */
export function samplePoints(box: [number, number, number, number]): [number, number][] {
  const [w, s, e, n] = box
  const cx = (w + e) / 2
  const cy = (s + n) / 2
  // Inside the middle of the box: 35% of the half-width either side.
  const dx = (e - w) * 0.35
  const dy = (n - s) * 0.35
  const points: [number, number][] = [[cx, cy]]
  for (const fx of [-1, 0, 1]) {
    for (const fy of [-1, 0, 1]) {
      if (fx || fy) points.push([cx + fx * dx, cy + fy * dy])
    }
  }
  return points
}

const text = (value: unknown) => (value == null || value === '' ? null : String(value).trim() || null)

/** FEMA writes -9999 where a zone has no published elevation. */
function elevation(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > -9000 ? n : null
}

/**
 * What an overlay's polygons hold at a lot: the feature under its centre,
 * and every feature met across the sample grid, one per point.
 *
 * Shared by the flood row and the zoning check, so both read a lot the same
 * way. Throws when nothing was found and a tile could not be read, because
 * "nothing here" and "could not look" must never be the same answer.
 */
export async function pointHits(
  box: [number, number, number, number],
  zoom: number,
  readTile: ReadTile,
  what = 'overlay',
): Promise<{ centre: TileFeature | null; found: TileFeature[] }> {
  const tiles = new Map<string, Promise<DecodedTile | null>>()
  let unread = false
  const hitAt = async (lng: number, lat: number) => {
    // The extent is not known until a tile arrives; 4096 is what tippecanoe
    // writes, and the coordinates are recomputed against the real one.
    const probe = tileCoords(lng, lat, zoom, 4096)
    const key = `${probe.tx}/${probe.ty}`
    if (!tiles.has(key)) tiles.set(key, readTile(zoom, probe.tx, probe.ty).catch(() => null))
    const tile = await tiles.get(key)
    if (!tile) {
      unread = true
      return null
    }
    const { px, py } = tileCoords(lng, lat, zoom, tile.extent)
    return tile.features.find((f) => insideFeature(px, py, f)) ?? null
  }
  const hits = await Promise.all(samplePoints(box).map(([lng, lat]) => hitAt(lng, lat)))
  const found = hits.filter((h): h is TileFeature => h != null)
  if (unread && !found.length) throw new Error(`The ${what} tiles could not be read.`)
  return { centre: hits[0], found }
}

/**
 * Tests a lot against the flood tiles at one zoom.
 *
 * `fields` names the properties the pipeline wrote: the zone, subtype and
 * elevation columns, under whatever labels the layer entry gives them.
 */
export async function floodAt(
  box: [number, number, number, number],
  zoom: number,
  readTile: ReadTile,
  fields = { zone: 'Zone', subtype: 'Subtype', bfe: 'Base flood elevation' },
): Promise<FloodAnswer> {
  // A tile that could not be read is not a dry lot. Saying "not in a flood
  // zone" because the network failed is the one answer this must never give.
  const { centre, found } = await pointHits(box, zoom, readTile, 'flood')
  const zones = [...new Set(found.map((f) => text(f.properties[fields.zone])).filter((z): z is string => z != null))]
  const lead = centre ?? found[0] ?? null
  return {
    status: centre ? 'in' : found.length ? 'partly' : 'out',
    zone: lead ? text(lead.properties[fields.zone]) : null,
    subtype: lead ? text(lead.properties[fields.subtype]) : null,
    bfe: lead ? elevation(lead.properties[fields.bfe]) : null,
    zones,
  }
}

export interface ZoningAnswer {
  code: string | null
  category: string | null
  city: string | null
}

/**
 * The zoning district a lot sits in: the one under its centre, or, for a lot
 * whose centre falls on a street or a gap between districts, the district
 * most of its sample points land in. Null fields when no district covers it.
 */
export async function zoningAt(
  box: [number, number, number, number],
  zoom: number,
  readTile: ReadTile,
): Promise<ZoningAnswer> {
  const { centre, found } = await pointHits(box, zoom, readTile, 'zoning')
  let lead = centre
  if (!lead && found.length) {
    const counts = new Map<TileFeature, number>()
    for (const f of found) counts.set(f, (counts.get(f) ?? 0) + 1)
    lead = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
  }
  return {
    code: lead ? text(lead.properties.Zoning) : null,
    category: lead ? text(lead.properties.Category) : null,
    city: lead ? text(lead.properties.City) : null,
  }
}

/** What a zone letter means, in the words a broker would use with a client. */
export function zoneMeaning(zone: string | null): string | null {
  if (!zone) return null
  const z = zone.toUpperCase()
  if (z.startsWith('V')) return 'Coastal high hazard area, with wave action, 1% annual chance'
  if (z === 'AO' || z === 'AH') return 'Shallow flooding, 1% annual chance'
  if (z === 'A99') return 'Protected by a levee under construction, 1% annual chance'
  if (z.startsWith('A')) return '1% annual chance flood (the "100-year" floodplain)'
  return null
}
