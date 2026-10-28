/*
 * "Within a mile of a transmission line", "inside an opportunity zone".
 *
 * A published layer — lines, points or areas — turned into a test a parcel
 * can be put to, the same way in the browser and in the parcel store. The
 * layer is laid on a grid of small square cells and every cell whose centre
 * is within the distance of a feature (or inside it, for an area) is kept.
 * A parcel passes when the cell holding its centre is one of them.
 *
 * A grid rather than a distance per parcel because the store can do nothing
 * else cheaply: the cells go to it as one list, and each parcel is one lookup
 * against that list, with nothing written. The price is precision. Cells are
 * a quarter of the distance across, so a parcel is measured to within about a
 * tenth of the distance asked for — near enough for "within a mile", and said
 * so where the filter is offered.
 */

/** Distances offered for a near test, in miles. Zero is "inside" an area. */
export const NEAR_MILES = [0.25, 0.5, 1, 2, 5, 10] as const

/** The most cells one test may send. Above it the cells are made coarser. */
export const NEAR_MAX_CELLS = 20000

/** How many layers one filter may test against at once. */
export const NEAR_MAX_LAYERS = 4

const METERS_PER_MILE = 1609.344
const METERS_PER_DEGREE = 111320

/** One near test, as the filter holds it: a layer and a distance. */
export interface NearPick {
  layer: string
  /** Miles; 0 means inside the layer's areas. */
  miles: number
}

/** A layer laid on the grid: the cell size in degrees and the cells kept. */
export interface NearGrid {
  dx: number
  dy: number
  cells: number[]
}

type Position = number[]
interface Geometry {
  type: string
  coordinates?: unknown
  geometries?: Geometry[]
}
interface Feature {
  geometry?: Geometry | null
}

/** The cell a point falls in. Shared with the SQL in app/lib/parcels.js. */
export function cellOf(lng: number, lat: number, dx: number, dy: number): number {
  return Math.floor((lng + 180) / dx) * 1000000 + Math.floor((lat + 90) / dy)
}

/** "transmission:1,opportunity-zones:0" from a list of picks, and back. */
export function writeNear(picks: NearPick[]): string {
  return picks.map((p) => `${p.layer}:${p.miles}`).join(',')
}

export function readNear(raw: unknown): NearPick[] {
  const text = typeof raw === 'string' ? raw : ''
  const out: NearPick[] = []
  for (const part of text.split(',')) {
    const [layer, miles] = part.trim().split(':')
    const m = Number(miles)
    if (!/^[a-z0-9-]{1,40}$/.test(layer || '') || !Number.isFinite(m)) continue
    if (m !== 0 && !(NEAR_MILES as readonly number[]).includes(m)) continue
    if (out.some((p) => p.layer === layer)) continue
    out.push({ layer, miles: m })
    if (out.length >= NEAR_MAX_LAYERS) break
  }
  return out
}

/** The parts a geometry is drawn from: points, lines, and polygons as rings. */
function parts(geometry: Geometry | null | undefined) {
  const points: Position[] = []
  const lines: Position[][] = []
  const polygons: Position[][][] = []
  const walk = (g: Geometry | null | undefined) => {
    if (!g) return
    const c = g.coordinates as never
    switch (g.type) {
      case 'Point':
        points.push(c)
        break
      case 'MultiPoint':
        points.push(...(c as Position[]))
        break
      case 'LineString':
        lines.push(c)
        break
      case 'MultiLineString':
        lines.push(...(c as Position[][]))
        break
      case 'Polygon':
        polygons.push(c)
        break
      case 'MultiPolygon':
        polygons.push(...(c as Position[][][]))
        break
      case 'GeometryCollection':
        for (const inner of g.geometries ?? []) walk(inner)
        break
      default:
    }
  }
  walk(geometry)
  return { points, lines, polygons }
}

const finite = (p: Position | undefined): p is Position =>
  Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])

/** Whether a point lies inside a polygon given as rings, holes and all. */
function inside(x: number, y: number, rings: Position[][]): boolean {
  let hit = false
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const [xi, yi] = ring[i]
      const [xj, yj] = ring[j]
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
    }
  }
  return hit
}

/**
 * The grid for one layer at one distance.
 *
 * `bounds`, [west, south, east, north], keeps a long line from filling cells
 * far outside the county the parcels are in. Returns null when the layer has
 * nothing a parcel could be near.
 */
export function nearGrid(
  features: Feature[],
  miles: number,
  bounds?: [number, number, number, number] | null,
): NearGrid | null {
  const all = features.map((f) => parts(f?.geometry))
  const points = all.flatMap((p) => p.points).filter(finite)
  const lines = all.flatMap((p) => p.lines).map((l) => l.filter(finite)).filter((l) => l.length > 0)
  const polygons = all.flatMap((p) => p.polygons)
  if (!points.length && !lines.length && !polygons.length) return null
  // Areas count their edges as lines when a distance is asked for.
  if (miles > 0) for (const rings of polygons) for (const ring of rings) lines.push(ring.filter(finite))

  // The latitude the longitudes are scaled to: the middle of what is drawn.
  let lat0 = 0
  {
    let sum = 0
    let n = 0
    const add = (p: Position) => {
      sum += p[1]
      n += 1
    }
    points.forEach(add)
    for (const l of lines) add(l[0])
    for (const rings of polygons) if (rings[0]?.[0]) add(rings[0][0])
    lat0 = bounds ? (bounds[1] + bounds[3]) / 2 : n ? sum / n : 0
  }
  const k = Math.max(0.01, Math.cos((lat0 * Math.PI) / 180))

  // A quarter of the distance across, or a tenth of a mile for "inside".
  let size = miles > 0 ? Math.max(0.05, miles / 4) : 0.1
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const grid = cellsAt(size)
    if (grid) return grid
    size *= 1.6
  }
  return null

  function cellsAt(sizeMiles: number): NearGrid | null {
    const dy = (sizeMiles * METERS_PER_MILE) / METERS_PER_DEGREE
    const dx = dy / k
    const r = (miles * METERS_PER_MILE) / METERS_PER_DEGREE // in degrees of latitude
    const kept = new Set<number>()
    let overflow = false
    const within = (ix: number, iy: number) => {
      if (!bounds) return true
      const x = (ix + 0.5) * dx - 180
      const y = (iy + 0.5) * dy - 90
      return x >= bounds[0] - dx && x <= bounds[2] + dx && y >= bounds[1] - dy && y <= bounds[3] + dy
    }
    const keep = (ix: number, iy: number) => {
      if (overflow || !within(ix, iy)) return
      kept.add(ix * 1000000 + iy)
      if (kept.size > NEAR_MAX_CELLS) overflow = true
    }
    // The cells spanning a box, clipped to the bounds.
    const span = (w: number, s: number, e: number, n: number) => {
      if (bounds) {
        w = Math.max(w, bounds[0] - dx)
        s = Math.max(s, bounds[1] - dy)
        e = Math.min(e, bounds[2] + dx)
        n = Math.min(n, bounds[3] + dy)
      }
      return {
        x0: Math.floor((w + 180) / dx),
        x1: Math.floor((e + 180) / dx),
        y0: Math.floor((s + 90) / dy),
        y1: Math.floor((n + 90) / dy),
      }
    }

    // Distance from a cell centre to a segment, in degrees of latitude, with
    // the longitudes scaled so the measure is flat and true.
    const segment = (a: Position, b: Position) => {
      const rx = r / k
      const box = span(Math.min(a[0], b[0]) - rx, Math.min(a[1], b[1]) - r, Math.max(a[0], b[0]) + rx, Math.max(a[1], b[1]) + r)
      const ax = a[0] * k
      const ay = a[1]
      const vx = b[0] * k - ax
      const vy = b[1] - ay
      const len = vx * vx + vy * vy
      for (let ix = box.x0; ix <= box.x1 && !overflow; ix += 1) {
        const cx = ((ix + 0.5) * dx - 180) * k
        for (let iy = box.y0; iy <= box.y1; iy += 1) {
          const cy = (iy + 0.5) * dy - 90
          let t = len ? ((cx - ax) * vx + (cy - ay) * vy) / len : 0
          t = Math.max(0, Math.min(1, t))
          const ex = ax + t * vx - cx
          const ey = ay + t * vy - cy
          if (ex * ex + ey * ey <= r * r) keep(ix, iy)
        }
      }
    }

    if (miles > 0) {
      for (const p of points) segment(p, p)
      for (const line of lines) {
        if (line.length === 1) segment(line[0], line[0])
        for (let i = 1; i < line.length && !overflow; i += 1) segment(line[i - 1], line[i])
      }
    }
    for (const rings of polygons) {
      const outer = (rings[0] ?? []).filter(finite)
      if (outer.length < 3) continue
      let w = Infinity
      let s = Infinity
      let e = -Infinity
      let n = -Infinity
      for (const [x, y] of outer) {
        w = Math.min(w, x)
        e = Math.max(e, x)
        s = Math.min(s, y)
        n = Math.max(n, y)
      }
      const box = span(w, s, e, n)
      for (let ix = box.x0; ix <= box.x1 && !overflow; ix += 1) {
        const cx = (ix + 0.5) * dx - 180
        for (let iy = box.y0; iy <= box.y1; iy += 1) {
          if (inside(cx, (iy + 0.5) * dy - 90, rings)) keep(ix, iy)
        }
      }
    }
    if (overflow) return null
    return { dx, dy, cells: [...kept].sort((a, b) => a - b) }
  }
}

/** Whether a point passes a grid. */
export function inGrid(grid: NearGrid, cells: Set<number>, lng: number, lat: number): boolean {
  return cells.has(cellOf(lng, lat, grid.dx, grid.dy))
}

/*
 * Which published layers the near filter offers, and under which tab.
 *
 * Not every layer makes a sensible "near": zoning and flood have their own
 * filters, and a layer that covers the whole county (school districts, land
 * use) is near everything. What is left is grouped by what a broker asks of
 * it: the grid a project would tie into, and the places a site sits by.
 */
export const NEAR_GROUPS: { id: 'power' | 'hazards' | 'places'; label: string; layers: string[] }[] = [
  { id: 'power', label: 'Power', layers: ['transmission', 'substations', 'power-plants'] },
  // What a phase I environmental report would ask about first: leaking
  // tanks, and the tank sites that could become one.
  { id: 'hazards', label: 'Hazards', layers: ['lust', 'ust'] },
  {
    id: 'places',
    label: 'Places',
    layers: [
      'opportunity-zones',
      'rail-stations',
      'schools',
      'private-schools',
      'redevelopment',
      'tirz',
      'uez',
      'nez',
      'lara',
      'landmarks',
      'city-land',
    ],
  },
]
