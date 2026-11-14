/**
 * Builds real vector tiles for tests: the same bytes a tile archive holds,
 * so what reads them is tested on the format itself and not on a stand-in.
 */
import { PbfWriter } from 'pbf'

const zigzag = (n) => (n << 1) ^ (n >> 31)

/** Tile geometry commands for rings, lines or points (arrays of [x, y]). */
function commands(type, parts) {
  const out = []
  let cx = 0
  let cy = 0
  const move = (x, y) => {
    out.push(zigzag(x - cx), zigzag(y - cy))
    cx = x
    cy = y
  }
  for (const part of parts) {
    if (type === 1) {
      out.push((1 & 0x7) | (part.length << 3))
      for (const [x, y] of part) move(x, y)
      continue
    }
    out.push((1 & 0x7) | (1 << 3))
    move(part[0][0], part[0][1])
    out.push((2 & 0x7) | ((part.length - 1) << 3))
    for (const [x, y] of part.slice(1)) move(x, y)
    if (type === 3) out.push(7 | (1 << 3))
  }
  return out
}

/**
 * One layer of features as tile bytes. Each feature:
 * { type: 1 | 2 | 3, id, properties, geometry: [[[x, y], ...], ...] }.
 */
export function encodeTile(layerName, features, extent = 4096) {
  const keys = []
  const values = []
  const keyIndex = (k) => (keys.includes(k) ? keys.indexOf(k) : keys.push(k) - 1)
  const valueIndex = (v) => {
    const found = values.findIndex((x) => x === v)
    return found >= 0 ? found : values.push(v) - 1
  }
  const tile = new PbfWriter()
  tile.writeMessage(3, (_, layer) => {
    layer.writeVarintField(15, 2)
    layer.writeStringField(1, layerName)
    for (const feature of features) {
      const tags = []
      for (const [k, v] of Object.entries(feature.properties ?? {})) tags.push(keyIndex(k), valueIndex(v))
      layer.writeMessage(2, (__, f) => {
        if (feature.id != null) f.writeVarintField(1, feature.id)
        f.writePackedVarint(2, tags)
        f.writeVarintField(3, feature.type)
        f.writePackedVarint(4, commands(feature.type, feature.geometry))
      }, null)
    }
    for (const key of keys) layer.writeStringField(3, key)
    for (const value of values) {
      layer.writeMessage(4, (__, v) => {
        if (typeof value === 'number') v.writeDoubleField(3, value)
        else v.writeStringField(1, String(value))
      }, null)
    }
    layer.writeVarintField(5, extent)
  }, null)
  return tile.finish()
}

/** An archive stand-in: header and a function from z/x/y to tile bytes. */
export function fakeArchive(header, tileAt) {
  return {
    getHeader: async () => ({ minZoom: 11, maxZoom: 16, minLon: -105.1, minLat: 39.6, maxLon: -104.6, maxLat: 39.9, ...header }),
    getZxy: async (z, x, y) => {
      const data = tileAt(z, x, y)
      return data ? { data } : undefined
    },
  }
}
