/**
 * Point-in-parcel matching, with no dependencies.
 *
 * A market's parcels arrive as a GeoJSON FeatureCollection of polygons and
 * multipolygons. A practice point lands in at most one parcel; the grid index
 * keeps each test to the handful of parcels whose bounding box contains the
 * point rather than the whole county.
 */

/** Ray casting against one ring. Boundary points count as inside. */
function insideRing(ring, x, y) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    const crosses = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (crosses) inside = !inside
  }
  return inside
}

/** Inside the outer ring and outside every hole. */
function insidePolygon(rings, x, y) {
  if (rings.length === 0 || !insideRing(rings[0], x, y)) return false
  for (let i = 1; i < rings.length; i++) if (insideRing(rings[i], x, y)) return false
  return true
}

export function pointInGeometry(geometry, lng, lat) {
  if (!geometry) return false
  if (geometry.type === 'Polygon') return insidePolygon(geometry.coordinates, lng, lat)
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.some((polygon) => insidePolygon(polygon, lng, lat))
  return false
}

export function bboxOf(geometry) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const walk = (coords) => {
    if (typeof coords[0] === 'number') {
      if (coords[0] < minX) minX = coords[0]
      if (coords[0] > maxX) maxX = coords[0]
      if (coords[1] < minY) minY = coords[1]
      if (coords[1] > maxY) maxY = coords[1]
      return
    }
    for (const part of coords) walk(part)
  }
  if (geometry?.coordinates) walk(geometry.coordinates)
  return [minX, minY, maxX, maxY]
}

/**
 * Parcels bucketed by grid cell. A cell of 0.005 degrees is roughly half a
 * kilometre, so a dense downtown cell holds tens of parcels, not thousands.
 */
export class ParcelIndex {
  constructor(features, { cell = 0.005 } = {}) {
    this.cell = cell
    this.cells = new Map()
    this.parcels = []
    this.bbox = [Infinity, Infinity, -Infinity, -Infinity]
    for (const feature of features) {
      if (!feature?.geometry || !['Polygon', 'MultiPolygon'].includes(feature.geometry.type)) continue
      const box = bboxOf(feature.geometry)
      if (!Number.isFinite(box[0])) continue
      const index = this.parcels.push({ feature, box }) - 1
      this.bbox = [
        Math.min(this.bbox[0], box[0]),
        Math.min(this.bbox[1], box[1]),
        Math.max(this.bbox[2], box[2]),
        Math.max(this.bbox[3], box[3]),
      ]
      for (let cx = Math.floor(box[0] / cell); cx <= Math.floor(box[2] / cell); cx++) {
        for (let cy = Math.floor(box[1] / cell); cy <= Math.floor(box[3] / cell); cy++) {
          const key = `${cx}:${cy}`
          const list = this.cells.get(key) ?? []
          list.push(index)
          this.cells.set(key, list)
        }
      }
    }
  }

  get size() {
    return this.parcels.length
  }

  /** Whether a point is inside the county envelope at all. */
  covers(lng, lat) {
    const [minX, minY, maxX, maxY] = this.bbox
    return lng >= minX && lng <= maxX && lat >= minY && lat <= maxY
  }

  /** The parcel feature containing the point, or null. */
  find(lng, lat) {
    const key = `${Math.floor(lng / this.cell)}:${Math.floor(lat / this.cell)}`
    for (const index of this.cells.get(key) ?? []) {
      const { feature, box } = this.parcels[index]
      if (lng < box[0] || lng > box[2] || lat < box[1] || lat > box[3]) continue
      if (pointInGeometry(feature.geometry, lng, lat)) return feature
    }
    return null
  }
}
