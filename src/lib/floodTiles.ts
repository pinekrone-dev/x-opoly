import { PMTiles } from 'pmtiles'
import { VectorTile } from '@mapbox/vector-tile'
import { PbfReader } from 'pbf'
import type { DecodedTile, ReadTile } from './flood'

/*
 * The browser half of flood.ts: one tile out of a market's flood archive,
 * decoded to rings.
 *
 * One archive handle per URL for the life of the page, so its header and
 * directory are read once however many parcels are opened, and decoded
 * tiles are kept so walking a street re-reads nothing.
 */

const archives = new Map<string, PMTiles>()
const decoded = new Map<string, Promise<DecodedTile | null>>()

function archive(url: string) {
  let found = archives.get(url)
  if (!found) {
    found = new PMTiles(url)
    archives.set(url, found)
  }
  return found
}

/** The deepest zoom the archive holds: the finest outline FEMA's polygons were cut at. */
export async function floodZoom(url: string): Promise<number> {
  const header = await archive(url).getHeader()
  return header.maxZoom
}

/** A tile reader over one archive and one layer inside it. */
export function tileReader(url: string, sourceLayer: string): ReadTile {
  return (z, x, y) => {
    const key = `${url}|${sourceLayer}|${z}/${x}/${y}`
    let pending = decoded.get(key)
    if (!pending) {
      pending = archive(url)
        .getZxy(z, x, y)
        .then((response) => {
          // No tile is not an error: FEMA drew nothing there.
          if (!response?.data) return { extent: 4096, features: [] }
          const layer = new VectorTile(new PbfReader(new Uint8Array(response.data))).layers[sourceLayer]
          if (!layer) return { extent: 4096, features: [] }
          const features = []
          for (let i = 0; i < layer.length; i++) {
            const feature = layer.feature(i)
            if (feature.type !== 3) continue
            features.push({ rings: feature.loadGeometry(), properties: feature.properties })
          }
          return { extent: layer.extent, features }
        })
        .catch(() => {
          // A failed read is forgotten, so the next parcel opened tries again.
          decoded.delete(key)
          return null
        })
      decoded.set(key, pending)
    }
    return pending
  }
}
