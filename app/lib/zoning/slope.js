/**
 * Slope bands for one lot from USGS 3DEP lidar, read when a Hillside Area
 * lot's report is opened.
 *
 * LAMC 12.21 C.10(b) sets a Hillside lot's maximum Residential Floor Area
 * from the area of the lot in each slope band (Table 12.21 C.10-2a) and asks
 * for a slope analysis map stamped by a civil engineer or surveyor. This is
 * an estimate of that map: the elevation service returns a grid of bare
 * earth heights at about one metre, each cell's slope is the rise over its
 * neighbours, and the lot's area is totalled by band.
 *
 * The lot comes as a GeoJSON polygon in longitude and latitude. The grid is
 * asked for in the same degrees, sized so a cell is about a metre, and the
 * distances between cells are worked out at the lot's latitude.
 */

export const SERVICE = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage'
export const BANDS = [[0, 15], [15, 30], [30, 45], [45, 60], [60, 100], [100, Infinity]]
const LABELS = ['0-14.99', '15-29.99', '30-44.99', '45-59.99', '60-99.99', '100+']
const SQFT_PER_SQM = 10.7639
const MAX_CELLS = 600 * 600

function rings(geometry) {
  if (!geometry) return []
  if (geometry.type === 'Polygon') return [geometry.coordinates]
  if (geometry.type === 'MultiPolygon') return geometry.coordinates
  return []
}

function inRing(x, y, ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function inPolygon(x, y, polys) {
  for (const poly of polys) {
    if (!inRing(x, y, poly[0])) continue
    let hole = false
    for (let h = 1; h < poly.length; h += 1) if (inRing(x, y, poly[h])) { hole = true; break }
    if (!hole) return true
  }
  return false
}

/** Area of a lon/lat polygon in square feet, planar at its latitude. */
export function areaSqft(geometry) {
  let total = 0
  for (const poly of rings(geometry)) {
    poly.forEach((ring, k) => {
      const lat = ring.reduce((t, p) => t + p[1], 0) / ring.length
      const kx = 111320 * Math.cos((lat * Math.PI) / 180)
      const ky = 110540
      let a = 0
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        a += ring[j][0] * kx * ring[i][1] * ky - ring[i][0] * kx * ring[j][1] * ky
      }
      total += (Math.abs(a) / 2) * (k === 0 ? 1 : -1)
    })
  }
  return Math.max(total, 0) * SQFT_PER_SQM
}

/**
 * Slope bands for a lot. fetchImpl is fetch (injected for tests).
 * Returns { bands: [{ band, sf }], mean_slope_pct, relief_ft, cells, source } or null.
 */
export async function slopeBands(geometry, { fetchImpl = fetch, tries = 3 } = {}) {
  const polys = rings(geometry)
  if (!polys.length) return null
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const poly of polys) for (const [x, y] of poly[0]) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y)
  }
  const lat = (y0 + y1) / 2
  const mx = 111320 * Math.cos((lat * Math.PI) / 180)   // metres per degree of longitude here
  const my = 110540
  const cellX = 1 / mx                                  // one metre, in degrees
  const cellY = 1 / my
  x0 -= 2 * cellX; x1 += 2 * cellX; y0 -= 2 * cellY; y1 += 2 * cellY
  let w = Math.max(3, Math.ceil((x1 - x0) / cellX))
  let h = Math.max(3, Math.ceil((y1 - y0) / cellY))
  let scale = 1
  if (w * h > MAX_CELLS) { scale = Math.sqrt((w * h) / MAX_CELLS); w = Math.ceil(w / scale); h = Math.ceil(h / scale) }
  const dx = ((x1 - x0) / w) * mx                       // metres between columns
  const dy = ((y1 - y0) / h) * my
  const q = new URLSearchParams({ bbox: `${x0},${y0},${x1},${y1}`, bboxSR: '4326', imageSR: '4326',
    size: `${w},${h}`, format: 'bsq', pixelType: 'F32', interpolation: 'RSP_BilinearInterpolation', f: 'image' })
  let buf = null
  for (let attempt = 0; attempt < tries && !buf; attempt += 1) {
    try {
      const res = await fetchImpl(`${SERVICE}?${q}`)
      if (res.ok) buf = await res.arrayBuffer()
    } catch { /* the service answers 504 under load; asked again */ }
  }
  if (!buf || buf.byteLength < w * h * 4) return null
  const z = new Float32Array(buf.slice(0, w * h * 4))
  const at = (r, c) => z[Math.min(h - 1, Math.max(0, r)) * w + Math.min(w - 1, Math.max(0, c))]
  const counts = new Array(BANDS.length).fill(0)
  let n = 0
  let sum = 0
  let lo = Infinity
  let hi = -Infinity
  for (let r = 0; r < h; r += 1) {
    const y = y1 - (r + 0.5) * ((y1 - y0) / h)          // row 0 is the north edge
    for (let c = 0; c < w; c += 1) {
      const x = x0 + (c + 0.5) * ((x1 - x0) / w)
      if (!inPolygon(x, y, polys)) continue
      const gx = (at(r, c + 1) - at(r, c - 1)) / (2 * dx)
      const gy = (at(r - 1, c) - at(r + 1, c)) / (2 * dy)
      const pct = Math.hypot(gx, gy) * 100
      if (!Number.isFinite(pct)) continue
      const band = BANDS.findIndex(([a, b]) => pct >= a && pct < b)
      counts[band] += 1
      n += 1
      sum += pct
      lo = Math.min(lo, z[r * w + c]); hi = Math.max(hi, z[r * w + c])
    }
  }
  if (!n) return null
  const lotSf = areaSqft(geometry)
  return {
    bands: LABELS.map((band, i) => ({ band, sf: Math.round((counts[i] / n) * lotSf) })),
    mean_slope_pct: Math.round((sum / n) * 10) / 10,
    relief_ft: Math.round((hi - lo) * 3.28084 * 10) / 10,
    cells: n,
    cell_m: Math.round(Math.max(dx, dy) * 100) / 100,
    source: 'USGS 3DEP lidar, bare earth, about 1 m',
  }
}
