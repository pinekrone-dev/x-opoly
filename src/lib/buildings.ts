import type { ReadTile } from './flood'

/*
 * What stands on a parcel, from Overture Maps' building footprints.
 *
 * Overture publishes every building outline it holds (OpenStreetMap, Microsoft
 * and Esri footprints, merged) as one vector-tile archive on its own public
 * CDN, with a height where one is known. This reads the tiles under a batch
 * of parcels and gives each parcel its buildings: how many, how much ground
 * they cover, and the tallest. Shared by the parcel card, which asks for one
 * lot, and the tagging pass, which asks for two thousand at a time.
 *
 * A building belongs to the parcel whose box holds its centre, the smallest
 * such box where boxes overlap. Parcels are held as boxes here, not outlines,
 * so a building near a crooked boundary can land next door; the count and the
 * footprint are right for ordinary lots and approximate for odd ones, and the
 * card says "about".
 */

/** The archive, and the credit its licence (ODbL) asks for wherever it is shown. */
export const OVERTURE_RELEASE = '2026-09-23.1'
export const OVERTURE_BUILDINGS_URL = `https://tiles.overturemaps.org/${OVERTURE_RELEASE}/buildings.pmtiles`
export const OVERTURE_ATTRIBUTION = 'Building footprints © OpenStreetMap contributors, Overture Maps Foundation (ODbL)'

/** The archive's deepest zoom: every footprint is present, unsimplified. */
export const BUILDING_ZOOM = 14

const EARTH = 40075016.686
const FLOOR_METRES = 3.2

export interface BuildingSummary {
  count: number
  /** Footprint on the ground, square metres. */
  area: number
  /** The tallest, metres, when any building here has a height. */
  tallest: number | null
}

function tileOf(lng: number, lat: number, z: number) {
  const n = 2 ** z
  const rad = (lat * Math.PI) / 180
  return {
    x: Math.floor(((lng + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n),
  }
}

function toLngLat(tx: number, ty: number, px: number, py: number, extent: number, z: number): [number, number] {
  const n = 2 ** z
  const lng = ((tx + px / extent) / n) * 360 - 180
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty + py / extent)) / n))) * 180) / Math.PI
  return [lng, lat]
}

const numberOr = (value: unknown): number | null => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * The buildings on each box, [west, south, east, north]. Null for a box a
 * tile under it could not be read for, which is "unknown", not "none".
 */
export async function buildingsFor(
  boxes: ([number, number, number, number] | null)[],
  readTile: ReadTile,
  z = BUILDING_ZOOM,
): Promise<(BuildingSummary | null)[]> {
  // Which tiles each box touches, and which boxes each tile serves.
  const byTile = new Map<string, number[]>()
  boxes.forEach((box, i) => {
    if (!box || !box.every(Number.isFinite)) return
    const a = tileOf(box[0], box[3], z)
    const b = tileOf(box[2], box[1], z)
    for (let x = a.x; x <= b.x; x++) {
      for (let y = a.y; y <= b.y; y++) {
        const key = `${x}/${y}`
        const list = byTile.get(key)
        if (list) list.push(i)
        else byTile.set(key, [i])
      }
    }
  })

  const unreadable = new Set<number>()
  // One entry per building: a building crossing a tile edge comes back from
  // each tile it touches, clipped, and the largest piece stands for it.
  const found = new Map<string, { lng: number; lat: number; area: number; height: number | null; candidates: number[] }>()
  await Promise.all(
    [...byTile.entries()].map(async ([key, members]) => {
      const [tx, ty] = key.split('/').map(Number)
      const tile = await readTile(z, tx, ty).catch(() => null)
      if (!tile) {
        for (const i of members) unreadable.add(i)
        return
      }
      const extent = tile.extent || 4096
      tile.features.forEach((feature, index) => {
        const box = feature.bbox
        if (!box) return
        const [lng, lat] = toLngLat(tx, ty, (box[0] + box[2]) / 2, (box[1] + box[3]) / 2, extent, z)
        // Clipped copies of a neighbour's building sit in the tile buffer;
        // only a centre inside this tile is this tile's to report.
        const own = tileOf(lng, lat, z)
        if (own.x !== tx || own.y !== ty) return
        let signed = 0
        for (const ring of feature.rings) {
          for (let k = 0, j = ring.length - 1; k < ring.length; j = k++) {
            signed += ring[j].x * ring[k].y - ring[k].x * ring[j].y
          }
        }
        const metresPerUnit = (EARTH * Math.cos((lat * Math.PI) / 180)) / 2 ** z / extent
        const area = (Math.abs(signed) / 2) * metresPerUnit * metresPerUnit
        const props = feature.properties
        const height = numberOr(props.height) ?? (numberOr(props.num_floors) ? Number(props.num_floors) * FLOOR_METRES : null)
        const id = String(props.id ?? `${key}:${index}`)
        const held = found.get(id)
        if (!held || area > held.area) found.set(id, { lng, lat, area, height, candidates: members })
      })
    }),
  )

  const out: (BuildingSummary | null)[] = boxes.map((box, i) =>
    box && box.every(Number.isFinite) && !unreadable.has(i) ? { count: 0, area: 0, tallest: null } : null,
  )
  const boxArea = (box: [number, number, number, number]) => (box[2] - box[0]) * (box[3] - box[1])
  for (const building of found.values()) {
    let owner = -1
    for (const i of building.candidates) {
      const box = boxes[i]
      if (!box || !out[i]) continue
      if (building.lng < box[0] || building.lng > box[2] || building.lat < box[1] || building.lat > box[3]) continue
      if (owner < 0 || boxArea(box) < boxArea(boxes[owner] as [number, number, number, number])) owner = i
    }
    if (owner < 0) continue
    const summary = out[owner] as BuildingSummary
    summary.count += 1
    summary.area += building.area
    if (building.height != null && (summary.tallest == null || building.height > summary.tallest)) summary.tallest = building.height
  }
  for (const summary of out) {
    if (!summary) continue
    summary.area = Math.round(summary.area)
    if (summary.tallest != null) summary.tallest = Math.round(summary.tallest * 10) / 10
  }
  return out
}

/** How much of a lot its buildings cover, 0 to 1, when the lot's size is known. */
export function coverage(summary: BuildingSummary | null, acres: number | null | undefined): number | null {
  const lot = Number(acres) * 4046.86
  if (!summary || !(lot > 0)) return null
  return Math.min(1, summary.area / lot)
}

/** A card line: "2 buildings, about 8,400 sq ft of footprint, tallest 38 ft, covering 31% of the lot". */
export function describeBuildings(summary: BuildingSummary | null, acres?: number | null): string | null {
  if (!summary) return null
  if (!summary.count) return 'No building footprint mapped on this lot'
  const sqft = Math.round(summary.area * 10.7639)
  const parts = [
    `${summary.count} ${summary.count === 1 ? 'building' : 'buildings'}`,
    `about ${sqft.toLocaleString()} sq ft of footprint`,
  ]
  if (summary.tallest != null) parts.push(`tallest about ${Math.round(summary.tallest * 3.28084)} ft`)
  const share = coverage(summary, acres)
  if (share != null) parts.push(`covering about ${Math.round(share * 100)}% of the lot`)
  return parts.join(', ')
}
