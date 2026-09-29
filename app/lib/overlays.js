/**
 * Zoning and flood for a batch of parcels, read from the market's own tile
 * archives on the server.
 *
 * The same geometry as the parcel card (src/lib/flood.ts), run here so an
 * upload of a thousand addresses is answered in one request rather than a
 * thousand. The archives come out of the bucket by range, and each tile is
 * decoded once however many parcels fall in it, so a batch costs a few
 * hundred small reads and no database at all.
 */

import { floodAt, zoningAt } from '../../src/lib/flood.ts'
import { decodeTile } from '../../src/lib/tileDecode.ts'

/** A tile reader over one open archive and one layer inside it, caching decoded tiles. */
export function archiveReader(archive, sourceLayer) {
  const cache = new Map()
  return (z, x, y) => {
    const key = `${z}/${x}/${y}`
    if (!cache.has(key)) {
      cache.set(
        key,
        archive
          .getZxy(z, x, y)
          .then((tile) => decodeTile(tile?.data, sourceLayer))
          .catch(() => null),
      )
    }
    return cache.get(key)
  }
}

/**
 * The zoom a batch is checked at: the archive's finest for a short list,
 * two levels coarser for a long one, where the tiles are sixteen times fewer
 * and the outlines still hold to about ten metres.
 */
export async function checkZoom(archive, count) {
  const header = await archive.getHeader()
  const finest = Math.min(header.maxZoom, 14)
  const wanted = count > 500 ? finest - 2 : finest
  return Math.max(header.minZoom, wanted)
}

async function inBatches(items, size, work) {
  const out = new Array(items.length)
  for (let i = 0; i < items.length; i += size) {
    const slice = items.slice(i, i + size)
    const done = await Promise.all(slice.map((item, j) => work(item, i + j)))
    done.forEach((value, j) => {
      out[i + j] = value
    })
  }
  return out
}

/**
 * Zoning and flood for each parcel with a box. `flood` and `zoning` are
 * { archive, sourceLayer } or null when the market has no such layer. Each
 * answer is null where it could not be read, which the caller reports as
 * that rather than as a pass.
 */
export async function checkParcels(parcels, { flood = null, zoning = null } = {}) {
  const withBox = parcels.filter((p) => Array.isArray(p.bb) && p.bb.every(Number.isFinite))
  const floodZoom = flood ? await checkZoom(flood.archive, withBox.length).catch(() => null) : null
  const zoningZoom = zoning ? await checkZoom(zoning.archive, withBox.length).catch(() => null) : null
  const floodRead = flood && floodZoom != null ? archiveReader(flood.archive, flood.sourceLayer) : null
  const zoningRead = zoning && zoningZoom != null ? archiveReader(zoning.archive, zoning.sourceLayer) : null
  return inBatches(parcels, 40, async (parcel) => {
    if (!Array.isArray(parcel.bb) || !parcel.bb.every(Number.isFinite)) return { flood: null, zoning: null }
    const [floodAnswer, zoningAnswer] = await Promise.all([
      floodRead ? floodAt(parcel.bb, floodZoom, floodRead).catch(() => null) : null,
      zoningRead ? zoningAt(parcel.bb, zoningZoom, zoningRead).catch(() => null) : null,
    ])
    return { flood: floodAnswer, zoning: zoningAnswer }
  })
}
