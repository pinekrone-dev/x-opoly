/**
 * A small painter for the server-drawn map: pixels in, pixels out.
 *
 * The Worker has no canvas, so the map image (mapimage.js) is drawn on a
 * plain RGBA buffer with the handful of operations a map needs: paste a
 * tile, fill a polygon (holes by the even-odd rule), stroke a line of any
 * width, and set lettering from the strips in mapfont.js. Edges are
 * smoothed: a shape's coverage of each pixel is worked out from four
 * scanlines through it and the exact span it crosses on each.
 *
 * A stroke is gathered whole before it is laid down, so the joints of a
 * translucent line are not painted twice.
 */
import { FACES } from './mapfont.js'

const SUB = 4

export function createCanvas(width, height, [r, g, b] = [240, 240, 240]) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r
    data[i + 1] = g
    data[i + 2] = b
    data[i + 3] = 255
  }
  return { width, height, data, cover: new Float32Array(width * height), dirty: null }
}

/** '#rrggbb' or '#rgb' as [r, g, b]; grey when it is neither. */
export function rgb(hex) {
  const text = String(hex ?? '').trim().replace(/^#/, '')
  const full = text.length === 3 ? text.split('').map((ch) => ch + ch).join('') : text
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return [120, 120, 120]
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)]
}

function blend(canvas, x, y, [r, g, b], a) {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height || a <= 0) return
  const o = (y * canvas.width + x) * 4
  const d = canvas.data
  const k = a >= 1 ? 1 : a
  d[o] += (r - d[o]) * k
  d[o + 1] += (g - d[o + 1]) * k
  d[o + 2] += (b - d[o + 2]) * k
}

/** Pastes decoded pixels with their top-left corner at (dx, dy). */
export function drawImage(canvas, image, dx, dy) {
  const x0 = Math.max(0, dx)
  const y0 = Math.max(0, dy)
  const x1 = Math.min(canvas.width, dx + image.width)
  const y1 = Math.min(canvas.height, dy + image.height)
  const d = canvas.data
  for (let y = y0; y < y1; y += 1) {
    let s = ((y - dy) * image.width + (x0 - dx)) * 4
    let o = (y * canvas.width + x0) * 4
    for (let x = x0; x < x1; x += 1) {
      const a = image.rgba[s + 3]
      if (a === 255) {
        d[o] = image.rgba[s]
        d[o + 1] = image.rgba[s + 1]
        d[o + 2] = image.rgba[s + 2]
      } else if (a > 0) {
        const k = a / 255
        d[o] += (image.rgba[s] - d[o]) * k
        d[o + 1] += (image.rgba[s + 1] - d[o + 1]) * k
        d[o + 2] += (image.rgba[s + 2] - d[o + 2]) * k
      }
      s += 4
      o += 4
    }
  }
}

export function fillRect(canvas, x, y, w, h, colour, alpha = 1) {
  const x0 = Math.max(0, Math.round(x))
  const y0 = Math.max(0, Math.round(y))
  const x1 = Math.min(canvas.width, Math.round(x + w))
  const y1 = Math.min(canvas.height, Math.round(y + h))
  for (let py = y0; py < y1; py += 1) for (let px = x0; px < x1; px += 1) blend(canvas, px, py, colour, alpha)
}

/**
 * Adds a polygon's coverage to the canvas's gathering buffer, keeping the
 * greater where shapes overlap. `rings` are arrays of [x, y].
 */
function gather(canvas, rings) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (!(maxX >= 0 && maxY >= 0 && minX < canvas.width && minY < canvas.height)) return
  const y0 = Math.max(0, Math.floor(minY))
  const y1 = Math.min(canvas.height - 1, Math.floor(maxY))
  const x0 = Math.max(0, Math.floor(minX))
  const x1 = Math.min(canvas.width - 1, Math.floor(maxX))
  if (y1 < y0 || x1 < x0) return
  const span = x1 - x0 + 1
  const row = new Float32Array(span)
  const xs = []
  for (let y = y0; y <= y1; y += 1) {
    row.fill(0)
    let any = false
    for (let s = 0; s < SUB; s += 1) {
      const sy = y + (s + 0.5) / SUB
      xs.length = 0
      for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
          const ay = ring[j][1]
          const by = ring[i][1]
          if ((ay <= sy && by > sy) || (by <= sy && ay > sy)) {
            xs.push(ring[j][0] + ((sy - ay) / (by - ay)) * (ring[i][0] - ring[j][0]))
          }
        }
      }
      if (xs.length < 2) continue
      xs.sort((a, b) => a - b)
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const from = Math.max(xs[k], x0)
        const to = Math.min(xs[k + 1], x1 + 1)
        if (to <= from) continue
        any = true
        const first = Math.floor(from)
        const last = Math.min(x1, Math.floor(to))
        if (first === last) row[first - x0] += (to - from) / SUB
        else {
          row[first - x0] += (first + 1 - from) / SUB
          for (let px = first + 1; px < last; px += 1) row[px - x0] += 1 / SUB
          if (last <= x1) row[last - x0] += (to - last) / SUB
        }
      }
    }
    if (!any) continue
    const base = y * canvas.width + x0
    for (let i = 0; i < span; i += 1) if (row[i] > canvas.cover[base + i]) canvas.cover[base + i] = Math.min(1, row[i])
  }
  const d = canvas.dirty
  canvas.dirty = d ? [Math.min(d[0], x0), Math.min(d[1], y0), Math.max(d[2], x1), Math.max(d[3], y1)] : [x0, y0, x1, y1]
}

/** Lays the gathered coverage down in one colour and clears the buffer. */
function lay(canvas, colour, alpha) {
  const d = canvas.dirty
  if (!d) return
  for (let y = d[1]; y <= d[3]; y += 1) {
    const base = y * canvas.width
    for (let x = d[0]; x <= d[2]; x += 1) {
      const c = canvas.cover[base + x]
      if (c > 0) {
        blend(canvas, x, y, colour, c * alpha)
        canvas.cover[base + x] = 0
      }
    }
  }
  canvas.dirty = null
}

/** Fills rings (outer and holes together) in one colour. */
export function fillPolygon(canvas, rings, colour, alpha = 1) {
  gather(canvas, rings)
  lay(canvas, colour, alpha)
}

const DISC = Array.from({ length: 16 }, (_, i) => [Math.cos((i / 16) * Math.PI * 2), Math.sin((i / 16) * Math.PI * 2)])

/** Strokes lines (arrays of [x, y]) at a width, joints rounded. */
export function strokeLines(canvas, lines, width, colour, alpha = 1) {
  const half = Math.max(0.5, width / 2)
  for (const line of lines) {
    for (let i = 1; i < line.length; i += 1) {
      const [ax, ay] = line[i - 1]
      const [bx, by] = line[i]
      const dx = bx - ax
      const dy = by - ay
      const length = Math.hypot(dx, dy)
      if (length < 1e-6) continue
      const nx = (-dy / length) * half
      const ny = (dx / length) * half
      gather(canvas, [[[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]]])
      if (width >= 2.5) gather(canvas, [DISC.map(([cx, cy]) => [bx + cx * half, by + cy * half])])
    }
  }
  lay(canvas, colour, alpha)
}

export function fillCircle(canvas, x, y, radius, colour, alpha = 1) {
  const sides = Math.max(16, Math.ceil(radius * 2))
  const ring = Array.from({ length: sides }, (_, i) => [x + Math.cos((i / sides) * Math.PI * 2) * radius, y + Math.sin((i / sides) * Math.PI * 2) * radius])
  fillPolygon(canvas, [ring], colour, alpha)
}

/**
 * A hairline, for the thousands of lot lines on a map: one pixel wide,
 * smoothed by sharing each step between the two pixels it falls between,
 * and laid straight down without the gathering buffer.
 */
export function hairline(canvas, ax, ay, bx, by, colour, alpha = 1) {
  if ((ax < 0 && bx < 0) || (ay < 0 && by < 0) || (ax >= canvas.width && bx >= canvas.width) || (ay >= canvas.height && by >= canvas.height)) return
  const steep = Math.abs(by - ay) > Math.abs(bx - ax)
  if (steep) { [ax, ay, bx, by] = [ay, ax, by, bx] }
  if (ax > bx) { [ax, bx, ay, by] = [bx, ax, by, ay] }
  const dx = bx - ax
  const gradient = dx === 0 ? 0 : (by - ay) / dx
  const limit = steep ? canvas.height : canvas.width
  const from = Math.max(0, Math.round(ax))
  const to = Math.min(limit - 1, Math.round(bx))
  let y = ay + gradient * (from - ax)
  for (let x = from; x <= to; x += 1) {
    const whole = Math.floor(y)
    const part = y - whole
    if (steep) {
      blend(canvas, whole, x, colour, alpha * (1 - part))
      blend(canvas, whole + 1, x, colour, alpha * part)
    } else {
      blend(canvas, x, whole, colour, alpha * (1 - part))
      blend(canvas, x, whole + 1, colour, alpha * part)
    }
    y += gradient
  }
}

const strips = new Map()
function strip(face) {
  if (!strips.has(face)) {
    const binary = atob(FACES[face].alpha)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    strips.set(face, bytes)
  }
  return strips.get(face)
}

/** Characters the strips do not hold are set as the nearest plain one. */
const plain = (text) => String(text ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
const cellOf = (face, ch) => FACES[face].cells[ch] ?? FACES[face].cells[plain(ch)[0]] ?? FACES[face].cells['?']

export function textWidth(face, text) {
  let width = 0
  for (const ch of String(text ?? '')) width += cellOf(face, ch)[2]
  return width
}

/** Shortens text to fit a width, ending in an ellipsis of three dots. */
export function fitText(face, text, max) {
  const value = String(text ?? '')
  if (textWidth(face, value) <= max) return value
  let out = ''
  for (const ch of value) {
    if (textWidth(face, `${out}${ch}...`) > max) break
    out += ch
  }
  return `${out.trimEnd()}...`
}

/** Sets text with its top-left corner at (x, y). Returns the width set. */
export function drawText(canvas, face, x, y, text, colour, alpha = 1) {
  const f = FACES[face]
  const pixels = strip(face)
  let pen = Math.round(x)
  const top = Math.round(y)
  for (const ch of String(text ?? '')) {
    const [sx, width, advance] = cellOf(face, ch)
    for (let row = 0; row < f.height; row += 1) {
      for (let col = 0; col < width; col += 1) {
        const a = pixels[row * f.width + sx + col]
        if (a) blend(canvas, pen - 1 + col, top + row, colour, (a / 255) * alpha)
      }
    }
    pen += advance
  }
  return pen - Math.round(x)
}

export const lineHeight = (face) => FACES[face].height
