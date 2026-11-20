/*
 * A first screen of whether a lot can be built on: how steep it is, and how
 * much of it lies in a flood hazard area, a mapped wetland, or protected or
 * publicly held land.
 *
 * The lot is laid over with a grid of a few hundred cells. Each cell is
 * given its ground elevation (USGS 3DEP), from which its slope is worked out
 * against its neighbours, and is tested against the outlines of FEMA's flood
 * hazard zones, the National Wetlands Inventory and PAD-US. What is left
 * after the cells that fail any of them are taken out is the share of the
 * lot that passes the screen. Everything here is arithmetic on what those
 * services returned; fetching them is app/lib/feasibility.js.
 *
 * It is a screen and says so: a grid of cells is not a survey, FEMA's map is
 * not an elevation certificate, and the wetlands inventory is drawn from
 * aerial photographs, not a delineation.
 */

export type Position = [number, number]
export type Ring = Position[]
export type SiteGeometry = { type: 'Polygon'; coordinates: Ring[] } | { type: 'MultiPolygon'; coordinates: Ring[][] }

const METERS_PER_DEGREE = 111320
const FEET_PER_METER = 3.28084
const SQ_METERS_PER_ACRE = 4046.8564224

/** Even-odd over a set of rings: a hole is outside, a second outline is inside. */
export function inRingSet(rings: Ring[], lng: number, lat: number): boolean {
  let hit = false
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, yi] = ring[i]
      const [xj, yj] = ring[j]
      if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit
    }
  }
  return hit
}

/** The lot's outlines, each with its holes. */
export const polygonsOf = (geometry: SiteGeometry): Ring[][] => (geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates)

export function insideSite(geometry: SiteGeometry, lng: number, lat: number): boolean {
  return polygonsOf(geometry).some((rings) => inRingSet(rings, lng, lat))
}

export function boxOf(geometry: SiteGeometry): [number, number, number, number] {
  const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const rings of polygonsOf(geometry)) {
    for (const [x, y] of rings[0] ?? []) {
      if (x < box[0]) box[0] = x
      if (y < box[1]) box[1] = y
      if (x > box[2]) box[2] = x
      if (y > box[3]) box[3] = y
    }
  }
  return box
}

/** The lot's area in acres, from its outline (holes taken out). */
export function acresOf(geometry: SiteGeometry): number {
  const [, south, , north] = boxOf(geometry)
  const k = Math.cos((((south + north) / 2) * Math.PI) / 180)
  let total = 0
  for (const rings of polygonsOf(geometry)) {
    rings.forEach((ring, index) => {
      let sum = 0
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
        sum += (ring[j][0] * k * METERS_PER_DEGREE) * (ring[i][1] * METERS_PER_DEGREE) - (ring[i][0] * k * METERS_PER_DEGREE) * (ring[j][1] * METERS_PER_DEGREE)
      }
      total += (index === 0 ? 1 : -1) * Math.abs(sum / 2)
    })
  }
  return total / SQ_METERS_PER_ACRE
}

export interface SiteGrid {
  nx: number
  ny: number
  /** A cell's width and height on the ground, in metres. */
  dx: number
  dy: number
  /** Every cell's centre, row by row from the south-west, as [lng, lat]. */
  points: Position[]
  /** Whether each cell's centre is on the lot. */
  inside: boolean[]
}

/**
 * A grid of cells over the lot's box: about `target` of them on the lot, no
 * more than `side` a side (one request to the elevation service holds them
 * all), and none finer than `finest` metres, below which the elevation data
 * has nothing more to say.
 */
export function gridOver(geometry: SiteGeometry, { target = 220, side = 20, finest = 3 } = {}): SiteGrid {
  const [west, south, east, north] = boxOf(geometry)
  const k = Math.cos((((south + north) / 2) * Math.PI) / 180)
  const wide = Math.max(1, (east - west) * k * METERS_PER_DEGREE)
  const tall = Math.max(1, (north - south) * METERS_PER_DEGREE)
  const want = Math.max(finest, Math.sqrt((wide * tall) / target))
  const nx = Math.min(side, Math.max(3, Math.round(wide / want)))
  const ny = Math.min(side, Math.max(3, Math.round(tall / want)))
  const points: Position[] = []
  const inside: boolean[] = []
  for (let j = 0; j < ny; j += 1) {
    for (let i = 0; i < nx; i += 1) {
      const lng = west + ((i + 0.5) / nx) * (east - west)
      const lat = south + ((j + 0.5) / ny) * (north - south)
      points.push([Math.round(lng * 1e7) / 1e7, Math.round(lat * 1e7) / 1e7])
      inside.push(insideSite(geometry, lng, lat))
    }
  }
  // A sliver of a lot can miss every centre: the cell nearest its middle stands for it.
  if (!inside.some(Boolean)) inside[Math.floor(ny / 2) * nx + Math.floor(nx / 2)] = true
  return { nx, ny, dx: wide / nx, dy: tall / ny, points, inside }
}

/**
 * Each cell's slope in percent (rise over run, times a hundred), from its
 * neighbours' elevations in metres: across both neighbours where it has two,
 * to the one it has at the edge of the grid. NaN where an elevation is missing.
 */
export function slopesOf(z: number[], grid: Pick<SiteGrid, 'nx' | 'ny' | 'dx' | 'dy'>): number[] {
  const { nx, ny, dx, dy } = grid
  const at = (i: number, j: number) => z[j * nx + i]
  const along = (a: number, b: number, run: number) => (Number.isFinite(a) && Number.isFinite(b) ? (b - a) / run : NaN)
  const out: number[] = []
  for (let j = 0; j < ny; j += 1) {
    for (let i = 0; i < nx; i += 1) {
      const here = at(i, j)
      if (!Number.isFinite(here)) {
        out.push(NaN)
        continue
      }
      const w = i > 0 ? i - 1 : i
      const e = i < nx - 1 ? i + 1 : i
      const s = j > 0 ? j - 1 : j
      const n = j < ny - 1 ? j + 1 : j
      let gx = e > w ? along(at(w, j), at(e, j), (e - w) * dx) : 0
      let gy = n > s ? along(at(i, s), at(i, n), (n - s) * dy) : 0
      // A neighbour with no elevation: the slope to the one that has it, or flat that way.
      if (!Number.isFinite(gx)) gx = Number.isFinite(at(e, j)) && e !== i ? (at(e, j) - here) / dx : Number.isFinite(at(w, j)) && w !== i ? (here - at(w, j)) / dx : 0
      if (!Number.isFinite(gy)) gy = Number.isFinite(at(i, n)) && n !== j ? (at(i, n) - here) / dy : Number.isFinite(at(i, s)) && s !== j ? (here - at(i, s)) / dy : 0
      out.push(Math.sqrt(gx * gx + gy * gy) * 100)
    }
  }
  return out
}

/** An outline from one of the services, with what it says about itself. */
export interface Overlay {
  rings: Ring[]
  attributes: Record<string, unknown>
}

export interface Screen<T> {
  /** False when the service did not answer; `reason` says what happened. */
  available: boolean
  reason?: string
  data?: T
}

export interface FeasibilityInput {
  geometry: SiteGeometry
  grid: SiteGrid
  /** Elevation in metres per cell, and the finest source resolution the service reported. */
  elevation: Screen<{ z: number[]; resolutionMeters: number | null }>
  flood: Screen<Overlay[]>
  wetlands: Screen<Overlay[]>
  protectedLand: Screen<Overlay[]>
  maxSlopePercent?: number
}

export interface Feasibility {
  acres: number
  cells: { count: number; spacingFeet: number }
  slope:
    | { available: true; meanPercent: number; medianPercent: number; maxPercent: number; shareOverLimit: number; limitPercent: number; elevationMinFeet: number; elevationMaxFeet: number; reliefFeet: number; resolutionMeters: number | null }
    | { available: false; reason: string }
  flood:
    | { available: true; mapped: boolean; shareInHazardArea: number; zones: { zone: string; subtype: string | null; hazardArea: boolean; share: number }[] }
    | { available: false; reason: string }
  wetlands: { available: true; share: number; types: { type: string; code: string | null; share: number }[] } | { available: false; reason: string }
  protectedLand:
    | { available: true; share: number; units: { name: string; manager: string | null; designation: string | null; category: string | null; gapStatus: string | null; access: string | null; share: number; counted: boolean }[] }
    | { available: false; reason: string }
  buildable: { share: number; acres: number; limitPercent: number; screened: string[]; notScreened: string[]; takenOut: { slope: number; flood: number; wetlands: number; protectedLand: number } }
}

const round = (value: number, places = 0) => Math.round(value * 10 ** places) / 10 ** places
const text = (value: unknown) => (value == null ? null : String(value).trim() || null)

/** Which cells on the lot fall inside each outline, and how many in any. */
function cover(grid: SiteGrid, overlays: Overlay[], counts: (overlay: Overlay) => boolean = () => true) {
  const any = new Uint8Array(grid.points.length)
  const each = overlays.map(() => 0)
  overlays.forEach((overlay, o) => {
    grid.points.forEach(([lng, lat], i) => {
      if (!grid.inside[i] || !inRingSet(overlay.rings, lng, lat)) return
      each[o] += 1
      if (counts(overlay)) any[i] = 1
    })
  })
  return { any, each }
}

/** PAD-US units that are land held for conservation or by a public body, not a boundary drawn round other people's land. */
const HELD = new Set(['FEE', 'EASEMENT'])

/** The screen, from what the four services returned. */
export function assess(input: FeasibilityInput): Feasibility {
  const { geometry, grid } = input
  const limit = Number.isFinite(input.maxSlopePercent) && (input.maxSlopePercent as number) > 0 ? (input.maxSlopePercent as number) : 15
  const cells = grid.inside.reduce((n, yes) => n + (yes ? 1 : 0), 0)
  const share = (count: number) => (cells ? round(count / cells, 3) : 0)
  const fail = new Uint8Array(grid.points.length)
  const takenOut = { slope: 0, flood: 0, wetlands: 0, protectedLand: 0 }
  const screened: string[] = []
  const notScreened: string[] = []

  let slope: Feasibility['slope']
  if (input.elevation.available && input.elevation.data) {
    const { z, resolutionMeters } = input.elevation.data
    const all = slopesOf(z, grid)
    const on = all.filter((value, i) => grid.inside[i] && Number.isFinite(value)).sort((a, b) => a - b)
    const heights = z.filter((value, i) => grid.inside[i] && Number.isFinite(value))
    if (on.length) {
      let over = 0
      all.forEach((value, i) => {
        if (grid.inside[i] && Number.isFinite(value) && value > limit) {
          over += 1
          fail[i] = 1
        }
      })
      takenOut.slope = share(over)
      const low = Math.min(...heights)
      const high = Math.max(...heights)
      slope = {
        available: true,
        meanPercent: round(on.reduce((a, b) => a + b, 0) / on.length, 1),
        medianPercent: round(on[Math.floor((on.length - 1) / 2)], 1),
        maxPercent: round(on[on.length - 1], 1),
        shareOverLimit: share(over),
        limitPercent: limit,
        elevationMinFeet: round(low * FEET_PER_METER),
        elevationMaxFeet: round(high * FEET_PER_METER),
        reliefFeet: round((high - low) * FEET_PER_METER),
        resolutionMeters,
      }
      screened.push('slope')
    } else {
      slope = { available: false, reason: 'The elevation service has no ground elevation for this lot.' }
      notScreened.push('slope')
    }
  } else {
    slope = { available: false, reason: input.elevation.reason || 'The elevation service did not answer.' }
    notScreened.push('slope')
  }

  let flood: Feasibility['flood']
  if (input.flood.available && input.flood.data) {
    const zones = input.flood.data
    // FEMA's own flag for the special flood hazard area: the 1% annual chance flood.
    const hazard = (overlay: Overlay) => String(overlay.attributes.SFHA_TF ?? '').toUpperCase() === 'T'
    const covered = cover(grid, zones, hazard)
    const inHazard = covered.any.reduce((n, v) => n + v, 0)
    covered.any.forEach((v, i) => { if (v) fail[i] = 1 })
    takenOut.flood = share(inHazard)
    const byZone = new Map<string, { zone: string; subtype: string | null; hazardArea: boolean; count: number }>()
    zones.forEach((overlay, o) => {
      if (!covered.each[o]) return
      const zone = text(overlay.attributes.FLD_ZONE) ?? 'Unnamed'
      const subtype = text(overlay.attributes.ZONE_SUBTY)
      const key = `${zone}|${subtype ?? ''}`
      const held = byZone.get(key) ?? { zone, subtype, hazardArea: hazard(overlay), count: 0 }
      held.count += covered.each[o]
      byZone.set(key, held)
    })
    flood = {
      available: true,
      // No zone under any cell: FEMA has not mapped this ground, which is not the same as no hazard.
      mapped: byZone.size > 0,
      shareInHazardArea: share(inHazard),
      zones: [...byZone.values()].sort((a, b) => b.count - a.count).map(({ count, ...zone }) => ({ ...zone, share: share(count) })),
    }
    screened.push('flood')
  } else {
    flood = { available: false, reason: input.flood.reason || 'FEMA\'s flood map service did not answer.' }
    notScreened.push('flood')
  }

  let wetlands: Feasibility['wetlands']
  if (input.wetlands.available && input.wetlands.data) {
    const covered = cover(grid, input.wetlands.data)
    const wet = covered.any.reduce((n, v) => n + v, 0)
    covered.any.forEach((v, i) => { if (v) fail[i] = 1 })
    takenOut.wetlands = share(wet)
    const byType = new Map<string, { type: string; code: string | null; count: number }>()
    input.wetlands.data.forEach((overlay, o) => {
      if (!covered.each[o]) return
      const type = text(overlay.attributes.WETLAND_TYPE) ?? 'Wetland'
      const code = text(overlay.attributes.ATTRIBUTE)
      const held = byType.get(`${type}|${code ?? ''}`) ?? { type, code, count: 0 }
      held.count += covered.each[o]
      byType.set(`${type}|${code ?? ''}`, held)
    })
    wetlands = { available: true, share: share(wet), types: [...byType.values()].sort((a, b) => b.count - a.count).map(({ count, ...type }) => ({ ...type, share: share(count) })) }
    screened.push('wetlands')
  } else {
    wetlands = { available: false, reason: input.wetlands.reason || 'The wetlands inventory did not answer.' }
    notScreened.push('wetlands')
  }

  let protectedLand: Feasibility['protectedLand']
  if (input.protectedLand.available && input.protectedLand.data) {
    const held = (overlay: Overlay) => HELD.has(String(overlay.attributes.Category ?? '').toUpperCase())
    const covered = cover(grid, input.protectedLand.data, held)
    const kept = covered.any.reduce((n, v) => n + v, 0)
    covered.any.forEach((v, i) => { if (v) fail[i] = 1 })
    takenOut.protectedLand = share(kept)
    protectedLand = {
      available: true,
      share: share(kept),
      units: input.protectedLand.data
        .map((overlay, o) => ({
          name: text(overlay.attributes.Unit_Nm) ?? 'Unnamed unit',
          manager: text(overlay.attributes.MngNm_Desc),
          designation: text(overlay.attributes.DesTp_Desc),
          category: text(overlay.attributes.Category),
          gapStatus: text(overlay.attributes.GAP_Sts),
          access: text(overlay.attributes.Pub_Access),
          share: share(covered.each[o]),
          counted: held(overlay),
        }))
        .filter((unit) => unit.share > 0)
        .sort((a, b) => b.share - a.share)
        .slice(0, 12),
    }
    screened.push('protected land')
  } else {
    protectedLand = { available: false, reason: input.protectedLand.reason || 'The protected areas database did not answer.' }
    notScreened.push('protected land')
  }

  const failed = fail.reduce((n, v, i) => n + (grid.inside[i] ? v : 0), 0)
  const acres = acresOf(geometry)
  const passing = cells ? (cells - failed) / cells : 0
  return {
    acres: round(acres, acres < 10 ? 2 : 1),
    cells: { count: cells, spacingFeet: round(Math.sqrt(grid.dx * grid.dy) * FEET_PER_METER) },
    slope,
    flood,
    wetlands,
    protectedLand,
    buildable: { share: round(passing, 3), acres: round(acres * passing, acres < 10 ? 2 : 1), limitPercent: limit, screened, notScreened, takenOut },
  }
}
