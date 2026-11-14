/**
 * A map as a picture, drawn on the server.
 *
 * The connector could save a map and hand back a link, and a link is no use
 * in a proposal: someone had to open it and take a screenshot. This draws
 * the same map as a PNG: the basemap's own tiles, the county's lot lines
 * from the market's tile archive, the lots a search matched picked out,
 * the layers switched on, a circle, pins, and a legend that says what each
 * colour is. It is a drawing of the data, not a screenshot of the app, so
 * it has no logos on its pins and no labels on its layers.
 *
 * Everything outside is handed in: `fetchTile` for a basemap tile's bytes,
 * a reader per tile archive. So the drawing itself is plain arithmetic and
 * can be checked with made-up tiles.
 */
import { decodePng, encodePng, isPng } from './png.js'
import { createCanvas, drawImage, drawText, fillCircle, fillPolygon, fillRect, fitText, hairline, lineHeight, rgb, strokeLines, textWidth } from './raster.js'
import { project, unproject } from './shapes.js'

const TILE = 256
export const MAX_WIDTH = 1600
export const MAX_HEIGHT = 1200
const INK = [22, 27, 45]
const WHITE = [255, 255, 255]
const MATCH = [220, 38, 38]
/** The widest zoom at which lot lines are read and drawn. */
export const LOT_ZOOM = 13

/** Land-use buckets, in the colours the parcel map uses (MapCanvas.tsx). */
export const LAND_USE = [
  ['Commercial', '#2a78d6'],
  ['Multifamily', '#eb6834'],
  ['Vacant land', '#1baf7a'],
  ['Single family', '#9AA1B4'],
]

/** The zoom at which a circle of this many miles fills most of the frame. */
export function zoomToFit(miles, lat, pixels) {
  const metres = miles * 1609.344 * 2.3
  const perPixelAtZero = 156543.03392 * Math.cos((lat * Math.PI) / 180)
  return Math.max(3, Math.min(18, Math.floor(Math.log2((perPixelAtZero * pixels) / metres))))
}

/** The frame: its top-left corner in world pixels, and what it covers. */
export function frameOf({ center, zoom, width, height }) {
  const z = Math.max(3, Math.min(19, Math.round(Number(zoom) || 12)))
  const [cx, cy] = project(center[0], center[1], z)
  const left = Math.round(cx - width / 2)
  const top = Math.round(cy - height / 2)
  const [west, north] = unproject(left, top, z)
  const [east, south] = unproject(left + width, top + height, z)
  return { z, left, top, width, height, box: [west, south, east, north] }
}

/** Tiles of an archive that the frame touches, at the zoom the archive has nearest the frame's. */
function tilesFor(frame, minZoom, maxZoom) {
  const tz = Math.max(minZoom, Math.min(maxZoom, frame.z))
  const scale = 2 ** (frame.z - tz) * TILE
  const x0 = Math.floor(frame.left / scale)
  const y0 = Math.floor(frame.top / scale)
  const x1 = Math.floor((frame.left + frame.width - 1) / scale)
  const y1 = Math.floor((frame.top + frame.height - 1) / scale)
  const max = 2 ** tz - 1
  const tiles = []
  for (let x = Math.max(0, x0); x <= Math.min(max, x1); x += 1) for (let y = Math.max(0, y0); y <= Math.min(max, y1); y += 1) tiles.push([tz, x, y])
  return { tiles, scale }
}

/** A tile feature's geometry in frame pixels. */
const placed = (geometry, extent, tx, ty, scale, frame) =>
  geometry.map((part) => part.map(([px, py]) => [(tx + px / extent) * scale - frame.left, (ty + py / extent) * scale - frame.top]))

async function drawBasemap(canvas, frame, basemap, fetchTile, notes) {
  const z = Math.min(frame.z, basemap.maxZoom ?? 19)
  const scale = 2 ** (frame.z - z)
  if (scale !== 1) {
    notes.push('The basemap has no tiles this close, so the frame is drawn on a plain ground.')
    return false
  }
  const x0 = Math.floor(frame.left / TILE)
  const y0 = Math.floor(frame.top / TILE)
  const x1 = Math.floor((frame.left + frame.width - 1) / TILE)
  const y1 = Math.floor((frame.top + frame.height - 1) / TILE)
  const jobs = []
  const world = 2 ** z
  for (let x = x0; x <= x1; x += 1) {
    for (let y = y0; y <= y1; y += 1) {
      if (y < 0 || y >= world) continue
      const wrapped = ((x % world) + world) % world
      const url = basemap.url.replace('{s}', 'abc'[(wrapped + y) % 3]).replace('{z}', String(z)).replace('{x}', String(wrapped)).replace('{y}', String(y))
      jobs.push(
        fetchTile(url)
          .then(async (bytes) => (bytes && isPng(bytes) ? { image: await decodePng(bytes), x, y } : { other: Boolean(bytes), x, y }))
          .catch(() => ({ x, y })),
      )
    }
  }
  const tiles = await Promise.all(jobs)
  let drawn = 0
  for (const tile of tiles) {
    if (!tile.image) continue
    drawImage(canvas, tile.image, tile.x * TILE - frame.left, tile.y * TILE - frame.top)
    drawn += 1
  }
  if (drawn < tiles.length) {
    notes.push(tiles.some((t) => t.other)
      ? 'Some basemap tiles are in a format this drawing does not read; those squares are plain.'
      : `${tiles.length - drawn} of ${tiles.length} basemap tiles did not arrive; those squares are plain.`)
  }
  return drawn > 0
}

async function drawParcels(canvas, frame, parcels, { showLandUse, matches }, notes) {
  // Wider than this a tile holds tens of thousands of lots, each a pixel or
  // less across: nothing to see, and a great deal to read.
  if (frame.z < Math.max(LOT_ZOOM, parcels.minZoom ?? 11)) {
    notes.push(`The frame is too wide for lot lines; they are drawn from zoom ${LOT_ZOOM} in.`)
    return { drawn: 0, matched: 0 }
  }
  const { tiles, scale } = tilesFor(frame, parcels.minZoom ?? 11, parcels.maxZoom ?? 16)
  const outline = frame.z >= 14
  const colours = new Map(LAND_USE.map(([name, hex]) => [name, rgb(hex)]))
  const seen = new Set()
  const hits = []
  let drawn = 0
  for (const [z, tx, ty] of tiles) {
    const tile = await parcels.read(z, tx, ty)
    if (!tile) continue
    for (const feature of tile.features) {
      if (feature.type !== 3) continue
      const rings = placed(feature.geometry, tile.extent, tx, ty, scale, frame)
      const isMatch = matches ? matches.has(String(feature.id)) : false
      if (showLandUse) {
        const colour = colours.get(feature.properties?.gp)
        if (colour) fillPolygon(canvas, rings, colour, 0.45)
      }
      if (outline) {
        for (const ring of rings) {
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) hairline(canvas, ring[j][0], ring[j][1], ring[i][0], ring[i][1], INK, 0.3)
        }
      }
      if (isMatch) {
        hits.push(rings)
        seen.add(String(feature.id))
      }
      drawn += 1
    }
  }
  // The matches go on last, over every lot line, so none is hidden.
  for (const rings of hits) {
    fillPolygon(canvas, rings, MATCH, 0.4)
    strokeLines(canvas, rings.map((ring) => [...ring, ring[0]]), frame.z >= 15 ? 2 : 1.25, MATCH, 0.95)
  }
  return { drawn, matched: seen.size }
}

async function drawLayer(canvas, frame, layer, notes) {
  const { tiles, scale } = tilesFor(frame, layer.minZoom ?? 0, layer.maxZoom ?? 14)
  if (tiles.length > 80) {
    notes.push(`${layer.label} has no tiles at this zoom and was left off.`)
    return 0
  }
  const base = rgb(layer.color)
  const palette = layer.colors ? new Map(Object.entries(layer.colors.map ?? {}).map(([key, hex]) => [key, rgb(hex)])) : null
  const colourOf = (feature) => (palette && palette.get(String(feature.properties?.[layer.colors.field] ?? ''))) || base
  let drawn = 0
  const points = []
  for (const [z, tx, ty] of tiles) {
    const tile = await layer.read(z, tx, ty)
    if (!tile) continue
    for (const feature of tile.features) {
      const parts = placed(feature.geometry, tile.extent, tx, ty, scale, frame)
      const colour = colourOf(feature)
      if (feature.type === 3) {
        fillPolygon(canvas, parts, colour, 0.3)
        strokeLines(canvas, parts.map((ring) => [...ring, ring[0]]), 1, colour, 0.8)
      } else if (feature.type === 2) strokeLines(canvas, parts, 2.5, colour, 0.9)
      else for (const part of parts) for (const point of part) points.push([point, colour])
      drawn += 1
    }
  }
  for (const [[x, y], colour] of points) {
    if (x < -6 || y < -6 || x > frame.width + 6 || y > frame.height + 6) continue
    fillCircle(canvas, x, y, 4.5, WHITE, 0.95)
    fillCircle(canvas, x, y, 3.2, colour, 1)
  }
  return drawn
}

function drawCircle(canvas, frame, circle) {
  const [cx, cy] = project(circle.lng, circle.lat, frame.z)
  const metresPerPixel = (156543.03392 * Math.cos((circle.lat * Math.PI) / 180)) / 2 ** frame.z
  const radius = (circle.miles * 1609.344) / metresPerPixel
  const ring = Array.from({ length: 97 }, (_, i) => [cx - frame.left + Math.cos((i / 96) * Math.PI * 2) * radius, cy - frame.top + Math.sin((i / 96) * Math.PI * 2) * radius])
  fillPolygon(canvas, [ring.slice(0, 96)], [37, 99, 235], 0.06)
  strokeLines(canvas, [ring], 2, [37, 99, 235], 0.9)
}

const overlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]

function drawPins(canvas, frame, pins) {
  const taken = []
  const at = pins
    .map((pin) => {
      const [x, y] = project(pin.lng, pin.lat, frame.z)
      return { ...pin, x: x - frame.left, y: y - frame.top }
    })
    .filter((pin) => pin.x > -10 && pin.y > -10 && pin.x < frame.width + 10 && pin.y < frame.height + 10)
  for (const pin of at) {
    fillCircle(canvas, pin.x, pin.y, 7, WHITE, 1)
    fillCircle(canvas, pin.x, pin.y, 5.2, INK, 1)
    taken.push([pin.x - 8, pin.y - 8, pin.x + 8, pin.y + 8])
  }
  // A label where there is room for one, the first pins first.
  const h = lineHeight('label')
  let labelled = 0
  for (const pin of at) {
    if (!pin.label || labelled >= 40) continue
    const text = fitText('label', pin.label, 170)
    const w = textWidth('label', text) + 8
    const spots = [[pin.x + 10, pin.y - h / 2 - 1], [pin.x - 10 - w, pin.y - h / 2 - 1], [pin.x - w / 2, pin.y + 9], [pin.x - w / 2, pin.y - 11 - h]]
    const spot = spots.map(([x, y]) => [x, y, x + w, y + h + 2]).find((box) => box[0] >= 2 && box[1] >= 2 && box[2] <= frame.width - 2 && box[3] <= frame.height - 20 && !taken.some((t) => overlaps(box, t)))
    if (!spot) continue
    fillRect(canvas, spot[0], spot[1], w, h + 2, WHITE, 0.88)
    drawText(canvas, 'label', spot[0] + 4, spot[1] + 1, text, INK)
    taken.push(spot)
    labelled += 1
  }
  return at.length
}

function drawLegend(canvas, frame, title, entries) {
  const pad = 10
  let y = 12
  if (title) {
    const text = fitText('title', title, frame.width - 60)
    const w = textWidth('title', text) + pad * 2
    fillRect(canvas, 12, y, w, lineHeight('title') + 10, WHITE, 0.94)
    drawText(canvas, 'title', 12 + pad, y + 5, text, INK)
    y += lineHeight('title') + 16
  }
  if (!entries.length) return
  const shown = entries.slice(0, 12)
  const h = lineHeight('small') + 4
  const w = Math.min(frame.width - 24, Math.max(...shown.map((e) => textWidth('small', fitText('small', e.label, 240)))) + 34)
  fillRect(canvas, 12, y, w, shown.length * h + 10, WHITE, 0.92)
  shown.forEach((entry, i) => {
    const top = y + 5 + i * h
    if (entry.kind === 'line') fillRect(canvas, 20, top + h / 2 - 2, 14, 3, entry.colour, 1)
    else if (entry.kind === 'point') fillCircle(canvas, 27, top + h / 2 - 1, 4, entry.colour, 1)
    else {
      fillRect(canvas, 20, top + 2, 14, h - 6, entry.colour, entry.alpha ?? 0.6)
      if (entry.outline) strokeLines(canvas, [[[20, top + 2], [34, top + 2], [34, top + h - 4], [20, top + h - 4], [20, top + 2]]], 1, entry.colour, 1)
    }
    drawText(canvas, 'small', 40, top + 1, fitText('small', entry.label, 240), INK)
  })
}

function drawFooter(canvas, frame, attribution) {
  const h = lineHeight('small') + 4
  // A scale bar: the round number of miles (or feet) nearest a fifth of the width.
  const [, lat] = unproject(frame.left + frame.width / 2, frame.top + frame.height / 2, frame.z)
  const metresPerPixel = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** frame.z
  const milesWide = (frame.width / 5) * metresPerPixel / 1609.344
  const steps = [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500]
  const miles = steps.filter((s) => s <= milesWide).pop() ?? steps[0]
  const bar = (miles * 1609.344) / metresPerPixel
  const label = miles < 0.1 ? `${Math.round(miles * 5280)} ft` : `${miles} mi`
  const y = frame.height - h - 12
  fillRect(canvas, 12, y - 2, bar + 16 + textWidth('small', label), h + 4, WHITE, 0.88)
  fillRect(canvas, 18, y + h - 5, bar, 3, INK, 1)
  fillRect(canvas, 18, y + h - 9, 1.5, 7, INK, 1)
  fillRect(canvas, 18 + bar - 1.5, y + h - 9, 1.5, 7, INK, 1)
  drawText(canvas, 'small', 24 + bar, y + 1, label, INK)

  const text = fitText('small', attribution, frame.width - bar - 90)
  const w = textWidth('small', text) + 10
  fillRect(canvas, frame.width - w, frame.height - h, w, h, WHITE, 0.82)
  drawText(canvas, 'small', frame.width - w + 5, frame.height - h + 2, text, INK)
}

/**
 * Draws the map and returns { png, width, height, frame, shown, notes }.
 *
 *   center [lng, lat], zoom, width, height
 *   basemap { url, attribution, maxZoom }, fetchTile(url) -> bytes | null
 *   parcels { read, minZoom, maxZoom } | null, showLandUse, matches: Set<string> | null
 *   matchPoints [[lng, lat]]: the matches' centres, dotted where lots are too small to see
 *   layers [{ label, kind, color, colors?: { field, map }, read, minZoom, maxZoom }]
 *   circle { lat, lng, miles }, pins [{ lat, lng, label }], title, matchLabel
 */
export async function renderMap(options) {
  const width = Math.max(320, Math.min(MAX_WIDTH, Math.round(Number(options.width) || 1000)))
  const height = Math.max(240, Math.min(MAX_HEIGHT, Math.round(Number(options.height) || 700)))
  const frame = frameOf({ center: options.center, zoom: options.zoom, width, height })
  const canvas = createCanvas(width, height, [236, 238, 242])
  const notes = []
  const legend = []

  if (options.basemap && options.fetchTile) await drawBasemap(canvas, frame, options.basemap, options.fetchTile, notes)

  for (const layer of (options.layers ?? []).filter((l) => l.kind === 'polygon')) {
    if (await drawLayer(canvas, frame, layer, notes)) legend.push({ label: layer.label, colour: rgb(layer.color), kind: 'polygon', outline: true, alpha: 0.35 })
  }

  let parcels = { drawn: 0, matched: 0 }
  if (options.parcels) {
    parcels = await drawParcels(canvas, frame, options.parcels, { showLandUse: Boolean(options.showLandUse), matches: options.matches ?? null }, notes)
    if (options.showLandUse && parcels.drawn) for (const [name, hex] of LAND_USE) legend.push({ label: name, colour: rgb(hex), kind: 'polygon', alpha: 0.6 })
  }
  // Where a lot is too small to see as a shape, a dot marks each match.
  let dotted = 0
  if (frame.z < 15 && Array.isArray(options.matchPoints)) {
    for (const [lng, lat] of options.matchPoints) {
      const [x, y] = project(lng, lat, frame.z)
      const px = x - frame.left
      const py = y - frame.top
      if (px < 0 || py < 0 || px > width || py > height) continue
      fillCircle(canvas, px, py, 4, WHITE, 0.9)
      fillCircle(canvas, px, py, 2.8, MATCH, 1)
      dotted += 1
    }
    if (!parcels.matched) parcels.matched = dotted
  }
  if (options.matches) legend.unshift({ label: options.matchLabel || 'Search matches', colour: MATCH, kind: 'polygon', outline: true, alpha: 0.45 })

  for (const layer of (options.layers ?? []).filter((l) => l.kind !== 'polygon')) {
    if (await drawLayer(canvas, frame, layer, notes)) legend.push({ label: layer.label, colour: rgb(layer.color), kind: layer.kind === 'line' ? 'line' : 'point' })
  }

  if (options.circle) drawCircle(canvas, frame, options.circle)
  const pinned = options.pins?.length ? drawPins(canvas, frame, options.pins) : 0
  if (pinned) legend.push({ label: `Pins (${pinned})`, colour: INK, kind: 'point' })

  drawLegend(canvas, frame, options.title, legend)
  drawFooter(canvas, frame, [options.basemap?.attribution, 'Parcels: county records via Land Quotient'].filter(Boolean).join(' · '))

  return {
    png: await encodePng(width, height, canvas.data),
    width, height, frame,
    shown: { parcels: parcels.drawn, matches: parcels.matched, pins: pinned, layers: legend.filter((e) => e.kind && !LAND_USE.some(([n]) => n === e.label)).length },
    notes,
  }
}
