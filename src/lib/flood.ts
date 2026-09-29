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
    return tile.features.find((f) => insideRings(px, py, f.rings)) ?? null
  }

  const points = samplePoints(box)
  const hits = await Promise.all(points.map(([lng, lat]) => hitAt(lng, lat)))
  const found = hits.filter((h): h is TileFeature => h != null)
  // A tile that could not be read is not a dry lot. Saying "not in a flood
  // zone" because the network failed is the one answer this must never give.
  if (unread && !found.length) throw new Error('The flood tiles could not be read.')
  const zones = [...new Set(found.map((f) => text(f.properties[fields.zone])).filter((z): z is string => z != null))]
  const lead = hits[0] ?? found[0] ?? null
  return {
    status: hits[0] ? 'in' : found.length ? 'partly' : 'out',
    zone: lead ? text(lead.properties[fields.zone]) : null,
    subtype: lead ? text(lead.properties[fields.subtype]) : null,
    bfe: lead ? elevation(lead.properties[fields.bfe]) : null,
    zones,
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
