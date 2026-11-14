/**
 * PNG, read and written with nothing but the platform's own deflate.
 *
 * The map image (mapimage.js) is drawn here on the server, where there is no
 * canvas: a basemap tile arrives as a PNG and has to become pixels, and the
 * finished map has to leave as one. Both directions use the Compression
 * Streams the Worker runtime and Node already carry, so no image library is
 * shipped for it.
 *
 * Reading covers what map tiles are: 8-bit grey, RGB and RGBA, and palettes
 * of 1 to 8 bits with optional transparency, not interlaced. Anything else
 * is refused by name rather than decoded wrongly.
 */

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes, start, end) {
  let c = 0xffffffff
  for (let i = start; i < end; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

async function pump(bytes, stream) {
  const writer = stream.writable.getWriter()
  const written = writer.write(bytes).then(() => writer.close())
  const chunks = []
  let size = 0
  const reader = stream.readable.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.length
  }
  await written
  const out = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

const inflate = (bytes) => pump(bytes, new DecompressionStream('deflate'))
const deflate = (bytes) => pump(bytes, new CompressionStream('deflate'))

export const isPng = (bytes) => bytes?.length > 8 && SIGNATURE.every((b, i) => bytes[i] === b)
export const isJpeg = (bytes) => bytes?.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff

const paeth = (a, b, c) => {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** A PNG's pixels as { width, height, rgba }. */
export async function decodePng(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (!isPng(bytes)) throw new Error('not a PNG')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 8
  let header = null
  let palette = null
  let alpha = null
  const data = []
  let dataSize = 0
  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at)
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7])
    const body = bytes.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') {
      header = {
        width: view.getUint32(at + 8), height: view.getUint32(at + 12),
        depth: bytes[at + 16], colour: bytes[at + 17], interlace: bytes[at + 20],
      }
    } else if (type === 'PLTE') palette = body
    else if (type === 'tRNS') alpha = body
    else if (type === 'IDAT') {
      data.push(body)
      dataSize += body.length
    } else if (type === 'IEND') break
    at += 12 + length
  }
  if (!header) throw new Error('PNG has no header')
  const { width, height, depth, colour } = header
  if (header.interlace) throw new Error('interlaced PNG is not read')
  if (width > 4096 || height > 4096) throw new Error('PNG is too large')
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colour]
  if (!channels) throw new Error(`PNG colour type ${colour} is not read`)
  if (colour === 3 ? ![1, 2, 4, 8].includes(depth) : depth !== 8) throw new Error(`PNG bit depth ${depth} is not read`)

  const packed = new Uint8Array(dataSize)
  let offset = 0
  for (const chunk of data) {
    packed.set(chunk, offset)
    offset += chunk.length
  }
  const raw = await inflate(packed)
  const bpp = Math.max(1, (channels * depth) >> 3)
  const stride = Math.ceil((width * channels * depth) / 8)
  if (raw.length < (stride + 1) * height) throw new Error('PNG data is short')

  // Undo the row filters in place.
  const lines = new Uint8Array(stride * height)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const dst = y * stride
    const up = dst - stride
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? lines[dst + x - bpp] : 0
      const b = y > 0 ? lines[up + x] : 0
      const c = x >= bpp && y > 0 ? lines[up + x - bpp] : 0
      const value = raw[src + x]
      lines[dst + x] =
        filter === 0 ? value
          : filter === 1 ? value + a
            : filter === 2 ? value + b
              : filter === 3 ? value + ((a + b) >> 1)
                : value + paeth(a, b, c)
    }
  }

  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    const row = y * stride
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4
      if (colour === 3) {
        const index = depth === 8
          ? lines[row + x]
          : (lines[row + ((x * depth) >> 3)] >> (8 - depth - ((x * depth) & 7))) & ((1 << depth) - 1)
        rgba[o] = palette?.[index * 3] ?? 0
        rgba[o + 1] = palette?.[index * 3 + 1] ?? 0
        rgba[o + 2] = palette?.[index * 3 + 2] ?? 0
        rgba[o + 3] = alpha && index < alpha.length ? alpha[index] : 255
      } else if (colour === 0) {
        rgba[o] = rgba[o + 1] = rgba[o + 2] = lines[row + x]
        rgba[o + 3] = 255
      } else if (colour === 4) {
        rgba[o] = rgba[o + 1] = rgba[o + 2] = lines[row + x * 2]
        rgba[o + 3] = lines[row + x * 2 + 1]
      } else {
        const p = row + x * channels
        rgba[o] = lines[p]
        rgba[o + 1] = lines[p + 1]
        rgba[o + 2] = lines[p + 2]
        rgba[o + 3] = channels === 4 ? lines[p + 3] : 255
      }
    }
  }
  return { width, height, rgba }
}

function chunk(type, body) {
  const out = new Uint8Array(12 + body.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, body.length)
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i)
  out.set(body, 8)
  view.setUint32(8 + body.length, crc32(out, 4, 8 + body.length))
  return out
}

/**
 * RGBA pixels as an opaque RGB PNG.
 *
 * Each row takes whichever of the Sub, Up and Paeth filters leaves the
 * smallest residue, which is what makes a map (flat fills, long edges)
 * compress to a fraction of its raw size.
 */
export async function encodePng(width, height, rgba) {
  const stride = width * 3
  const raw = new Uint8Array((stride + 1) * height)
  const line = new Uint8Array(stride)
  const prev = new Uint8Array(stride)
  const tries = [new Uint8Array(stride), new Uint8Array(stride), new Uint8Array(stride)]
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const s = (y * width + x) * 4
      line[x * 3] = rgba[s]
      line[x * 3 + 1] = rgba[s + 1]
      line[x * 3 + 2] = rgba[s + 2]
    }
    const sums = [0, 0, 0]
    for (let x = 0; x < stride; x += 1) {
      const a = x >= 3 ? line[x - 3] : 0
      const b = prev[x]
      const c = x >= 3 ? prev[x - 3] : 0
      const sub = (line[x] - a) & 0xff
      const up = (line[x] - b) & 0xff
      const pae = (line[x] - paeth(a, b, c)) & 0xff
      tries[0][x] = sub
      tries[1][x] = up
      tries[2][x] = pae
      sums[0] += sub < 128 ? sub : 256 - sub
      sums[1] += up < 128 ? up : 256 - up
      sums[2] += pae < 128 ? pae : 256 - pae
    }
    const best = sums[0] <= sums[1] && sums[0] <= sums[2] ? 0 : sums[1] <= sums[2] ? 1 : 2
    const at = y * (stride + 1)
    raw[at] = best === 0 ? 1 : best === 1 ? 2 : 4
    raw.set(tries[best], at + 1)
    prev.set(line)
  }
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header[8] = 8 // bit depth
  header[9] = 2 // RGB
  const parts = [Uint8Array.from(SIGNATURE), chunk('IHDR', header), chunk('IDAT', await deflate(raw)), chunk('IEND', new Uint8Array(0))]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}
