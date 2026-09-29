import { PMTiles } from 'pmtiles'
import type { DecodedTile, ReadTile } from './flood'
import { decodeTile } from './tileDecode'

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
        // No tile is not an error: FEMA drew nothing there.
        .then((response) => decodeTile(response?.data, sourceLayer))
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
