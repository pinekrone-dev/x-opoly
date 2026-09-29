import { VectorTile } from '@mapbox/vector-tile'
import { PbfReader } from 'pbf'
import type { DecodedTile, TileFeature } from './flood'

/*
 * One vector tile's polygons, as rings with a bounding box each.
 *
 * Shared by the browser (the parcel card) and the server (the brain panel's
 * bulk checks). The box is worked out once here so a point is only tested
 * against the few polygons whose box holds it: a zoning tile can carry
 * hundreds of districts, and a thousand parcels at nine points each would
 * otherwise walk every outline for every point.
 */
export function decodeTile(bytes: ArrayBuffer | Uint8Array | null | undefined, sourceLayer: string): DecodedTile {
  if (!bytes) return { extent: 4096, features: [] }
  const layer = new VectorTile(new PbfReader(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))).layers[sourceLayer]
  if (!layer) return { extent: 4096, features: [] }
  const features: TileFeature[] = []
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i)
    if (feature.type !== 3) continue
    const rings = feature.loadGeometry()
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const ring of rings) {
      for (const p of ring) {
        if (p.x < minX) minX = p.x
        if (p.y < minY) minY = p.y
        if (p.x > maxX) maxX = p.x
        if (p.y > maxY) maxY = p.y
      }
    }
    features.push({ rings, properties: feature.properties, bbox: [minX, minY, maxX, maxY] })
  }
  return { extent: layer.extent, features }
}
