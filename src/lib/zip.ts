/**
 * A ZIP file, written with nothing but arithmetic.
 *
 * The Library hands over a package of pieces (maps that are already PNG,
 * small spreadsheets) as one download. The files are stored as they are,
 * not compressed again: a PNG gains nothing from it, and the tables are a
 * few kilobytes. That leaves the format's bookkeeping, which is all this is.
 */
const TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export interface ZipEntry {
  name: string
  data: Uint8Array
}

/** The entries as one ZIP archive. Names are made unique by the caller. */
export function zip(entries: ZipEntry[], now = new Date()): Uint8Array {
  const encoder = new TextEncoder()
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()
  const locals: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const crc = crc32(entry.data)
    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, 0x0800, true) // names are UTF-8
    lv.setUint16(8, 0, true) // stored
    lv.setUint16(10, time, true)
    lv.setUint16(12, date, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, entry.data.length, true)
    lv.setUint32(22, entry.data.length, true)
    lv.setUint16(26, name.length, true)
    local.set(name, 30)
    const head = new Uint8Array(46 + name.length)
    const hv = new DataView(head.buffer)
    hv.setUint32(0, 0x02014b50, true)
    hv.setUint16(4, 20, true)
    hv.setUint16(6, 20, true)
    hv.setUint16(8, 0x0800, true)
    hv.setUint16(10, 0, true)
    hv.setUint16(12, time, true)
    hv.setUint16(14, date, true)
    hv.setUint32(16, crc, true)
    hv.setUint32(20, entry.data.length, true)
    hv.setUint32(24, entry.data.length, true)
    hv.setUint16(28, name.length, true)
    hv.setUint32(42, offset, true)
    head.set(name, 46)
    locals.push(local, entry.data)
    central.push(head)
    offset += local.length + entry.data.length
  }
  const size = central.reduce((n, part) => n + part.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, size, true)
  ev.setUint32(16, offset, true)
  const out = new Uint8Array(offset + size + 22)
  let at = 0
  for (const part of [...locals, ...central, end]) {
    out.set(part, at)
    at += part.length
  }
  return out
}
