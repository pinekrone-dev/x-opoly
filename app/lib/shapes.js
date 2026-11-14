/**
 * Shapes out of the map's own vector tiles, on the server.
 *
 * The parcel store holds a lot's record and its bounding box; its outline
 * lives in the market's tile archive, where the map reads it. This reads
 * the same tiles: a tile's features of any kind for the map image, and one
 * parcel's outline as GeoJSON for an export.
 *
 * A tile cuts every shape at its edge. So a parcel's outline is taken from
 * the finest zoom at which the whole lot sits inside one tile, which is the
 * finest zoom for nearly all of them. A lot that straddles a tile line at
 * every zoom is returned as the pieces the finest tiles hold, and says so.
 */
import { VectorTile } from '@mapbox/vector-tile'
import { PbfReader } from 'pbf'

const TILE = 256

/** World pixels at a zoom, from longitude and latitude. */
export function project(lng, lat, zoom) {
  const scale = TILE * 2 ** zoom
  const sin = Math.sin((Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180)
  return [((lng + 180) / 360) * scale, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale]
}

/** Longitude and latitude from world pixels at a zoom. */
export function unproject(x, y, zoom) {
  const scale = TILE * 2 ** zoom
  const lng = (x / scale) * 360 - 180
  const n = Math.PI - (2 * Math.PI * y) / scale
  return [lng, (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))]
}

/** Every feature of one layer in a tile: { type, id, properties, geometry }. */
export function decodeFeatures(bytes, sourceLayer) {
  if (!bytes) return { extent: 4096, features: [] }
  const tile = new VectorTile(new PbfReader(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)))
  const layer = tile.layers[sourceLayer] ?? Object.values(tile.layers)[0]
  if (!layer) return { extent: 4096, features: [] }
  const features = []
  for (let i = 0; i < layer.length; i += 1) {
    const feature = layer.feature(i)
    features.push({
      type: feature.type, // 1 point, 2 line, 3 polygon
      id: feature.id,
      properties: feature.properties,
      geometry: feature.loadGeometry().map((part) => part.map((p) => [p.x, p.y])),
    })
  }
  return { extent: layer.extent, features }
}

/** A reader over one open archive and one layer in it, tiles decoded once. */
export function featureReader(archive, sourceLayer) {
  const cache = new Map()
  return (z, x, y) => {
    const key = `${z}/${x}/${y}`
    if (!cache.has(key)) {
      cache.set(key, archive.getZxy(z, x, y).then((tile) => decodeFeatures(tile?.data, sourceLayer)).catch(() => null))
    }
    return cache.get(key)
  }
}

const signedArea = (ring) => {
  let sum = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) sum += (ring[j][0] - ring[i][0]) * (ring[i][1] + ring[j][1])
  return sum
}

/**
 * Tile rings as GeoJSON polygons. In a tile an outer ring and its holes
 * wind opposite ways, and each outer ring starts a new polygon.
 */
function polygonsOf(rings, toLngLat) {
  const polygons = []
  let outerSign = 0
  for (const ring of rings) {
    if (ring.length < 3) continue
    const area = signedArea(ring)
    if (area === 0) continue
    const sign = Math.sign(area)
    if (!outerSign) outerSign = sign
    const coords = ring.map(toLngLat)
    const last = coords[coords.length - 1]
    if (last[0] !== coords[0][0] || last[1] !== coords[0][1]) coords.push(coords[0])
    if (sign === outerSign || !polygons.length) polygons.push([coords])
    else polygons[polygons.length - 1].push(coords)
  }
  return polygons
}

const round6 = (n) => Math.round(n * 1e6) / 1e6

/**
 * One parcel's outline as a GeoJSON geometry, or null when its tiles do not
 * hold it. `box` is the lot's [west, south, east, north]; `read` a
 * featureReader over the market's parcel archive; `id` the parcel id, which
 * is the feature id in the tiles.
 */
export async function parcelShape(read, id, box, { minZoom = 11, maxZoom = 16 } = {}) {
  if (!Array.isArray(box) || !box.every(Number.isFinite)) return null
  const [w, s, e, n] = box
  const want = String(id)
  const take = async (z, tx, ty) => {
    const tile = await read(z, tx, ty)
    if (!tile) return []
    const toLngLat = ([px, py]) => unproject((tx + px / tile.extent) * TILE, (ty + py / tile.extent) * TILE, z).map(round6)
    const out = []
    for (const feature of tile.features) {
      if (feature.type === 3 && String(feature.id) === want) out.push(...polygonsOf(feature.geometry, toLngLat))
    }
    return out
  }
  const tileOf = (lng, lat, z) => project(lng, lat, z).map((v) => Math.floor(v / TILE))
  // The finest zoom at which the lot's box sits inside a single tile.
  for (let z = maxZoom; z >= minZoom; z -= 1) {
    const [x0, y0] = tileOf(w, n, z)
    const [x1, y1] = tileOf(e, s, z)
    if (x0 !== x1 || y0 !== y1) continue
    const polygons = await take(z, x0, y0)
    if (polygons.length) return { geometry: asGeometry(polygons), zoom: z, pieces: 1 }
    break
  }
  // Across a tile line at every zoom: the pieces from the finest tiles.
  const [x0, y0] = tileOf(w, n, maxZoom)
  const [x1, y1] = tileOf(e, s, maxZoom)
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 36) return null
  const pieces = []
  for (let tx = x0; tx <= x1; tx += 1) for (let ty = y0; ty <= y1; ty += 1) pieces.push(...(await take(maxZoom, tx, ty)))
  return pieces.length ? { geometry: asGeometry(pieces), zoom: maxZoom, pieces: pieces.length } : null
}

const asGeometry = (polygons) =>
  polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0] } : { type: 'MultiPolygon', coordinates: polygons }
