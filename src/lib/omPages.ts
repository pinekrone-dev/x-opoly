/**
 * An offering memorandum, drawn page by page onto canvases.
 *
 * One renderer serves three uses: the pages on screen, the PDF (each page
 * placed whole), and a PNG of any one page — the amenity map on its own is
 * a thing brokers send. Drawn at three pixels to the point, so text and
 * pins stay sharp on paper.
 *
 * The layout follows what a listing broker's OM carries: a cover with the
 * aerial and the property highlights, a location map with rings and the
 * landmarks that sell the site, a numbered map of the retailers around it,
 * and the trade area's demographics beside the county's record.
 */
import type { Demographics, Landmark } from '../types'
import { staticMap, type StaticMap } from './staticMap'
import { amenityGroups, placeMarkers, tenantMix, type NumberedAmenity } from './amenityGroups'
import { drawLayerKey, drawLayers, type DocLayer } from './mapLayers'

/** Letter, landscape, in points. */
export const PAGE = { width: 792, height: 612 }
const SCALE = 3
const MILE = 1609.344

const NIGHT = '#0c1f42'
const ACCENT = '#01a3a8'
const INK = '#0f172a'
const BODY = '#334155'
const MUTED = '#718096'
const RULE = '#e2e8f0'
const RING = '#facc15'
const FONT = 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif'

export interface OmRow {
  label: string
  text: string
}

export interface OmData {
  headline: string
  price: string
  description: string
  address: string
  cityLine: string
  lat: number
  lng: number
  highlights: OmRow[]
  broker: { name: string; email: string; phone: string; company: string }
  record: { group: string; rows: OmRow[] }[]
  /** Chains near the site, already numbered in the order they print. */
  amenities: NumberedAmenity[]
  /** The market's layers to draw on every map (zoning, flood zones...). */
  layers?: DocLayer[]
  /** The store directory did not answer: say so, never "no stores". */
  amenitiesFailed?: boolean
  landmarks: Landmark[]
  demographics: Demographics | null
  sources: string[]
}

type Ctx = CanvasRenderingContext2D

function page(): { canvas: HTMLCanvasElement; ctx: Ctx } {
  const canvas = document.createElement('canvas')
  canvas.width = PAGE.width * SCALE
  canvas.height = PAGE.height * SCALE
  const ctx = canvas.getContext('2d') as Ctx
  ctx.scale(SCALE, SCALE)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, PAGE.width, PAGE.height)
  ctx.textBaseline = 'alphabetic'
  return { canvas, ctx }
}

function font(ctx: Ctx, size: number, weight = 400) {
  ctx.font = `${weight} ${size}px ${FONT}`
}

function text(ctx: Ctx, value: string, x: number, y: number, { size = 10, weight = 400, color = BODY, align = 'left' as CanvasTextAlign, max = 0 } = {}) {
  font(ctx, size, weight)
  ctx.fillStyle = color
  ctx.textAlign = align
  let out = value
  if (max > 0 && ctx.measureText(out).width > max) {
    while (out.length > 1 && ctx.measureText(`${out}…`).width > max) out = out.slice(0, -1)
    out = `${out}…`
  }
  ctx.fillText(out, x, y)
  ctx.textAlign = 'left'
}

/** Wrapped text; returns the y after the last line. */
function para(ctx: Ctx, value: string, x: number, y: number, width: number, { size = 10, lead = 1.45, color = BODY, weight = 400, lines = 99 } = {}) {
  font(ctx, size, weight)
  ctx.fillStyle = color
  const words = value.replace(/\s+/g, ' ').trim().split(' ')
  let line = ''
  let count = 0
  for (let i = 0; i < words.length; i += 1) {
    const next = line ? `${line} ${words[i]}` : words[i]
    if (ctx.measureText(next).width > width && line) {
      count += 1
      if (count >= lines) {
        ctx.fillText(`${line}…`, x, y)
        return y + size * lead
      }
      ctx.fillText(line, x, y)
      y += size * lead
      line = words[i]
    } else {
      line = next
    }
  }
  if (line) {
    ctx.fillText(line, x, y)
    y += size * lead
  }
  return y
}

function rect(ctx: Ctx, x: number, y: number, w: number, h: number, color: string) {
  ctx.fillStyle = color
  ctx.fillRect(x, y, w, h)
}

function rounded(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function band(ctx: Ctx, data: OmData, title: string) {
  rect(ctx, 0, 0, PAGE.width, 58, NIGHT)
  rect(ctx, 0, 58, PAGE.width, 3, ACCENT)
  text(ctx, title.toUpperCase(), 28, 36, { size: 11, weight: 700, color: '#ffffff' })
  text(ctx, data.address, PAGE.width - 28, 30, { size: 13, weight: 700, color: '#ffffff', align: 'right', max: 420 })
  text(ctx, data.cityLine, PAGE.width - 28, 46, { size: 9, color: '#cbd5e1', align: 'right', max: 420 })
}

function footer(ctx: Ctx, data: OmData, n: number) {
  ctx.strokeStyle = RULE
  ctx.lineWidth = 0.75
  ctx.beginPath()
  ctx.moveTo(28, PAGE.height - 34)
  ctx.lineTo(PAGE.width - 28, PAGE.height - 34)
  ctx.stroke()
  para(
    ctx,
    DISCLAIMER,
    28,
    PAGE.height - 22,
    600,
    { size: 6.5, color: MUTED, lead: 1.3, lines: 2 },
  )
  const by = [data.broker.name, data.broker.company].filter(Boolean).join(' · ')
  text(ctx, `${by ? `${by} · ` : ''}${n}`, PAGE.width - 28, PAGE.height - 14, { size: 7.5, color: MUTED, align: 'right' })
}

function mapImage(ctx: Ctx, map: StaticMap, x: number, y: number) {
  if (map.image) ctx.drawImage(map.image, x, y, map.width, map.height)
  else {
    rect(ctx, x, y, map.width, map.height, '#e5e7eb')
    text(ctx, 'The basemap could not be loaded.', x + map.width / 2, y + map.height / 2, { size: 10, color: MUTED, align: 'center' })
  }
}

function pin(ctx: Ctx, x: number, y: number, label?: string) {
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.35)'
  ctx.shadowBlur = 4
  ctx.fillStyle = ACCENT
  ctx.beginPath()
  ctx.arc(x, y - 16, 10, Math.PI, 0)
  ctx.lineTo(x, y)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
  ctx.fillStyle = '#ffffff'
  ctx.beginPath()
  ctx.arc(x, y - 16, 4, 0, Math.PI * 2)
  ctx.fill()
  if (label) pill(ctx, label, x, y - 34, { color: NIGHT, size: 9, weight: 700 })
}

/** A label in a rounded box, centred on x; returns its box. */
function pill(ctx: Ctx, label: string, x: number, y: number, { color = ACCENT, size = 8, weight = 600 } = {}) {
  font(ctx, size, weight)
  const w = ctx.measureText(label).width + 10
  const h = size + 7
  const box = { x: x - w / 2, y: y - h / 2, w, h }
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.3)'
  ctx.shadowBlur = 3
  ctx.fillStyle = color
  rounded(ctx, box.x, box.y, w, h, h / 2)
  ctx.fill()
  ctx.restore()
  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'center'
  ctx.fillText(label, x, y + size / 2 - 1)
  ctx.textAlign = 'left'
  return box
}

function ring(ctx: Ctx, map: StaticMap, ox: number, oy: number, miles: number, cx: number, cy: number) {
  const r = map.unitsForMeters(miles * MILE)
  ctx.save()
  ctx.beginPath()
  ctx.rect(ox, oy, map.width, map.height)
  ctx.clip()
  ctx.strokeStyle = RING
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
  // The label where the ring crosses the lower right, if that is on the map.
  const lx = cx + r * Math.cos(Math.PI / 5)
  const ly = cy + r * Math.sin(Math.PI / 5)
  if (lx > ox + 20 && lx < ox + map.width - 20 && ly > oy + 10 && ly < oy + map.height - 10) {
    const label = `${miles} Mile${miles === 1 ? '' : 's'}`
    font(ctx, 8, 700)
    const w = ctx.measureText(label).width + 10
    ctx.fillStyle = RING
    rounded(ctx, lx - w / 2, ly - 7.5, w, 15, 7.5)
    ctx.fill()
    text(ctx, label, lx, ly + 3, { size: 8, weight: 700, color: INK, align: 'center' })
  }
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US')

/** One line on how big a landmark is. */
export function landmarkLine(l: Landmark): string {
  if (l.students) return `${fmt(l.students)} students`
  if (l.capacity) return `${fmt(l.capacity)} seats${l.teams?.length ? ` · ${l.teams.slice(0, 2).join(', ')}` : ''}`
  if (l.passengers) return `${fmt(l.passengers)} passengers a year`
  if (l.beds) return `${fmt(l.beds)} beds`
  if (l.employees) return `${fmt(l.employees)} employees${l.located && l.located !== 'exact' ? ' (HQ city)' : ''}`
  return ''
}

const KIND: Record<string, string> = {
  colleges: 'College', hospitals: 'Hospital', stadiums: 'Stadium', airports: 'Airport', malls: 'Shopping',
  attractions: 'Attraction', convention: 'Convention', military: 'Military', headquarters: 'HQ',
}

/* ----------------------------------------------------------------- maps */

/**
 * A map with its pins, rings and labels drawn on, on a canvas of its own:
 * placed whole on a PDF page, and as a picture on a PowerPoint slide where
 * the text around it stays editable.
 */
export interface MapPicture {
  canvas: HTMLCanvasElement
  width: number
  height: number
}

export interface OmMaps {
  cover: MapPicture
  location: MapPicture & { shown: Landmark[] }
  amenity: MapPicture
}

/** The basemap with the chosen layers on it, ready for pins and labels. */
async function surface(map: StaticMap, layers: DocLayer[] = []) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(map.width * SCALE)
  canvas.height = Math.round(map.height * SCALE)
  const ctx = canvas.getContext('2d') as Ctx
  ctx.scale(SCALE, SCALE)
  mapImage(ctx, map, 0, 0)
  await drawLayers(ctx, map, layers)
  return { canvas, ctx }
}

async function coverMap(data: OmData): Promise<MapPicture> {
  // The aerial, close enough to read the lot.
  const map = await staticMap({ lat: data.lat, lng: data.lng, metersAcross: 320, width: 500, height: 330, basemap: 'imagery', labels: true })
  const { canvas, ctx } = await surface(map, data.layers)
  const [px, py] = map.project(data.lat, data.lng)
  pin(ctx, px, py)
  drawLayerKey(ctx, map, data.layers ?? [])
  return { canvas, width: map.width, height: map.height }
}

async function locationMap(data: OmData): Promise<MapPicture & { shown: Landmark[] }> {
  // Tall enough for the two-mile ring with a little room, as wide as the page.
  const map = await staticMap({ lat: data.lat, lng: data.lng, metersAcross: 2.3 * 2 * MILE * (744 / 444), width: 744, height: 444, basemap: 'imagery', labels: false })
  const { canvas, ctx } = await surface(map, data.layers)
  const [cx, cy] = map.project(data.lat, data.lng)
  ring(ctx, map, 0, 0, 1, cx, cy)
  ring(ctx, map, 0, 0, 2, cx, cy)

  // The landmarks on the map, largest first, none on top of another.
  const taken: { x: number; y: number; w: number; h: number }[] = []
  const hits = (b: { x: number; y: number; w: number; h: number }) =>
    taken.some((t) => b.x < t.x + t.w + 4 && b.x + b.w + 4 > t.x && b.y < t.y + t.h + 3 && b.y + b.h + 3 > t.y)
  const shown: Landmark[] = []
  for (const l of data.landmarks) {
    // A headquarters Wikidata places only by its city would be pinned on the
    // city centre: a point on a map that is not where the office is.
    if (l.kind === 'headquarters' && l.located !== 'exact') continue
    const [lx, ly] = map.project(l.lat, l.lng)
    if (lx < 40 || lx > map.width - 40 || ly < 14 || ly > map.height - 14) continue
    font(ctx, 8, 600)
    const w = ctx.measureText(l.name).width + 10
    const box = { x: lx - w / 2, y: ly - 7.5, w, h: 15 }
    if (hits(box)) continue
    pill(ctx, l.name.length > 34 ? `${l.name.slice(0, 33)}…` : l.name, lx, ly, { color: 'rgba(14,116,144,0.92)' })
    taken.push(box)
    shown.push(l)
    if (shown.length >= 14) break
  }
  pin(ctx, cx, cy, 'Subject Property')
  drawLayerKey(ctx, map, data.layers ?? [])
  return { canvas, width: map.width, height: map.height, shown }
}

async function amenityMap(data: OmData): Promise<MapPicture> {
  const list = data.amenities
  // Wide enough to hold every numbered store, at least a mile each way.
  // Close in where the stores are close: a downtown block, not a mile of it.
  const far = Math.max(0.3, ...list.map((a) => a.miles)) * 1.2
  const map = await staticMap({ lat: data.lat, lng: data.lng, metersAcross: far * 2 * MILE, width: 400, height: 500, basemap: 'light', labels: true })
  const { canvas, ctx } = await surface(map, data.layers)
  ctx.strokeStyle = RULE
  ctx.strokeRect(0, 0, map.width, map.height)

  // One marker per spot ("12–15" for a centre's tenants), each put where it
  // is free, nearest its stores; the lines first, so none crosses a number.
  const groups = amenityGroups(list)
  const label = (g: { first: number; last: number }) => (g.first === g.last ? String(g.first) : `${g.first}–${g.last}`)
  font(ctx, 7.5, 700)
  const wants = groups.map((g) => {
    const [x, y] = map.project(g.lat, g.lng)
    const text = label(g)
    const w = g.first === g.last ? 15 : Math.max(15, ctx.measureText(text).width + 9)
    return { x, y, w, h: 15 }
  })
  const [cx, cy] = map.project(data.lat, data.lng)
  const spots = placeMarkers(wants, map, [{ x: cx, y: cy - 14, w: 22, h: 30 }])
  ctx.strokeStyle = '#1f6f8b'
  ctx.lineWidth = 0.8
  spots.forEach((spot, i) => {
    const want = wants[i]
    if (Math.hypot(spot.x - want.x, spot.y - want.y) < 4) return
    ctx.beginPath()
    ctx.moveTo(want.x, want.y)
    ctx.lineTo(spot.x, spot.y)
    ctx.stroke()
    ctx.fillStyle = '#1f6f8b'
    ctx.beginPath()
    ctx.arc(want.x, want.y, 1.8, 0, Math.PI * 2)
    ctx.fill()
  })
  pin(ctx, cx, cy)
  spots.forEach((spot, i) => marker(ctx, label(groups[i]), spot.x, spot.y, wants[i].w))
  drawLayerKey(ctx, map, data.layers ?? [])
  return { canvas, width: map.width, height: map.height }
}

/** A numbered marker: a circle for one store, a pill for a range. */
function marker(ctx: Ctx, value: string, x: number, y: number, w: number) {
  const h = 15
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.3)'
  ctx.shadowBlur = 2
  ctx.fillStyle = '#1f6f8b'
  rounded(ctx, x - w / 2, y - h / 2, w, h, h / 2)
  ctx.fill()
  ctx.restore()
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 1
  rounded(ctx, x - w / 2, y - h / 2, w, h, h / 2)
  ctx.stroke()
  text(ctx, value, x, y + 2.8, { size: value.length > 2 && w <= 15 ? 6.5 : 7.5, weight: 700, color: '#ffffff', align: 'center' })
}

/** The three maps an OM carries, drawn once for every export. */
export async function omMaps(data: OmData): Promise<OmMaps> {
  const [cover, location, amenity] = await Promise.all([coverMap(data), locationMap(data), amenityMap(data)])
  return { cover, location, amenity }
}

/** The landmark key under the location map: name, then kind, size and distance. */
export function landmarkKey(l: Landmark): string {
  return [KIND[l.kind], landmarkLine(l), `${l.miles} mi`].filter(Boolean).join(' · ')
}

/* ---------------------------------------------------------------- pages */

function cover(data: OmData, maps: OmMaps) {
  const { canvas, ctx } = page()
  rect(ctx, 0, 0, PAGE.width, 128, NIGHT)
  rect(ctx, 0, 128, PAGE.width, 3, ACCENT)
  text(ctx, data.headline.toUpperCase(), 28, 40, { size: 11, weight: 700, color: ACCENT, max: 736 })
  text(ctx, data.address, 28, 82, { size: 30, weight: 700, color: '#ffffff', max: 736 })
  text(ctx, data.cityLine, 28, 108, { size: 13, weight: 500, color: '#cbd5e1', max: 736 })
  ctx.drawImage(maps.cover.canvas, 0, 131, maps.cover.width, maps.cover.height)

  // Highlights.
  const hx = 520
  text(ctx, 'Property Highlights', hx, 158, { size: 15, weight: 700, color: '#1f6f8b' })
  let y = 182
  for (const row of data.highlights.slice(0, 9)) {
    text(ctx, row.label, hx, y, { size: 8, weight: 600, color: MUTED })
    text(ctx, row.text, hx, y + 13, { size: 10, weight: 600, color: INK, max: 250 })
    ctx.strokeStyle = RULE
    ctx.lineWidth = 0.75
    ctx.beginPath()
    ctx.moveTo(hx, y + 21)
    ctx.lineTo(PAGE.width - 24, y + 21)
    ctx.stroke()
    y += 32
  }

  // The pitch, and who to call.
  if (data.description) para(ctx, data.description, 28, 488, 460, { size: 10.5, lines: 6, color: BODY })
  let by0 = 488
  for (const [i, line] of brokerLines(data).entries()) {
    text(ctx, line, hx, by0, { size: i === 0 ? 11 : 9, weight: i === 0 ? 700 : 400, color: i === 0 ? INK : BODY, max: 250 })
    by0 += i === 0 ? 15 : 13
  }
  footer(ctx, data, 1)
  return canvas
}

/** Who to call: the name first, then company, phone and email. */
export function brokerLines(data: OmData): string[] {
  const by = data.broker
  const lead = by.name || by.company
  if (!lead) return []
  return [lead, ...(by.name && by.company ? [by.company] : []), by.phone, by.email].filter(Boolean)
}

function location(data: OmData, maps: OmMaps) {
  const { canvas, ctx } = page()
  band(ctx, data, 'Site Location Map')
  const ox = 24
  const oy = 76
  ctx.drawImage(maps.location.canvas, ox, oy, maps.location.width, maps.location.height)
  // The key: what each landmark is and how big a draw.
  let y = oy + maps.location.height + 18
  const colW = 744 / 2
  maps.location.shown.slice(0, 6).forEach((l, i) => {
    const x = ox + (i % 2) * colW
    if (i % 2 === 0 && i > 0) y += 13
    text(ctx, l.name, x, y, { size: 8.5, weight: 700, color: INK, max: 170 })
    text(ctx, landmarkKey(l), x + 175, y, { size: 8, color: BODY, max: colW - 185 })
  })
  footer(ctx, data, 2)
  return canvas
}

function amenities(data: OmData, maps: OmMaps) {
  const { canvas, ctx } = page()
  band(ctx, data, 'Area Retailers & Amenity Map')
  const ox = 24
  const oy = 76
  const list = data.amenities
  ctx.drawImage(maps.amenity.canvas, ox, oy, maps.amenity.width, maps.amenity.height)

  // The legend in number order, which is the map's order from the site
  // outward; the tenant mix above it.
  const lx = ox + maps.amenity.width + 22
  const colW = (PAGE.width - 24 - lx) / 2
  let y = oy + 10
  if (list.length) {
    y = para(ctx, `Tenant mix: ${tenantMix(list)}`, lx, y, PAGE.width - 24 - lx, { size: 7.5, color: MUTED, lead: 1.35, lines: 3 }) + 6
  } else {
    text(ctx, data.amenitiesFailed ? 'The store directory did not answer. Try again from the editor.' : 'No chain stores were found within a mile in the directory.', lx, y, { size: 9, color: MUTED })
  }
  const top = y
  const rows = Math.max(1, Math.floor((PAGE.height - 48 - top) / 12.5))
  list.slice(0, rows * 2).forEach((a, i) => {
    const x = lx + Math.floor(i / rows) * colW
    const ry = top + (i % rows) * 12.5 + 8
    text(ctx, `${a.n}.`, x + 14, ry, { size: 8, weight: 700, color: INK, align: 'right' })
    text(ctx, a.name, x + 18, ry, { size: 8, color: BODY, max: colW - 50 })
    text(ctx, `${a.miles.toFixed(1)} mi`, x + colW - 10, ry, { size: 7, color: MUTED, align: 'right' })
  })
  footer(ctx, data, 3)
  return canvas
}

export const DEMOGRAPHICS: { key: string; label: string; format: 'count' | 'money' | 'percent' | 'decimal' }[] = [
  { key: 'population', label: 'Population', format: 'count' },
  { key: 'households', label: 'Households', format: 'count' },
  { key: 'medianHouseholdIncome', label: 'Median household income', format: 'money' },
  { key: 'medianAge', label: 'Median age', format: 'decimal' },
  { key: 'renterShare', label: 'Renter households', format: 'percent' },
  { key: 'educationShare', label: 'Bachelor’s degree or higher', format: 'percent' },
  { key: 'medianHomeValue', label: 'Median home value', format: 'money' },
]

export function metric(value: number | null | undefined, format: string) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  if (format === 'money') return `$${fmt(value)}`
  if (format === 'percent') return `${(value <= 1 ? value * 100 : value).toFixed(1)}%`
  if (format === 'decimal') return value.toFixed(1)
  return fmt(value)
}

function details(data: OmData) {
  const { canvas, ctx } = page()
  band(ctx, data, 'Demographics & Property Details')
  const ox = 28
  let y = 92
  text(ctx, 'Trade Area Demographics', ox, y, { size: 13, weight: 700, color: '#1f6f8b' })
  y += 14
  const radii = data.demographics?.radii ?? []
  if (radii.length) {
    const colX = [ox, ox + 190, ox + 270, ox + 350]
    rect(ctx, ox - 4, y, 420, 18, '#f1f5f9')
    radii.slice(0, 3).forEach((r, i) => text(ctx, `${r.miles} Mile${r.miles === 1 ? '' : 's'}`, colX[i + 1] + 60, y + 12.5, { size: 8.5, weight: 700, color: INK, align: 'right' }))
    y += 18
    for (const m of DEMOGRAPHICS) {
      y += 15
      text(ctx, m.label, colX[0], y, { size: 9, color: BODY })
      radii.slice(0, 3).forEach((r, i) => text(ctx, metric(r.metrics[m.key], m.format), colX[i + 1] + 60, y, { size: 9, weight: 600, color: INK, align: 'right' }))
      ctx.strokeStyle = RULE
      ctx.beginPath()
      ctx.moveTo(ox - 4, y + 5)
      ctx.lineTo(ox + 416, y + 5)
      ctx.stroke()
    }
    y += 16
    text(ctx, data.demographics?.source ?? 'US Census ACS', ox, y, { size: 7, color: MUTED })
  } else {
    y += 16
    text(ctx, 'The Census figures could not be loaded for this point.', ox, y, { size: 9, color: MUTED })
  }

  // The county's record, as the parcel card shows it, in two columns.
  const rx = 470
  let ry = 92
  text(ctx, 'Property Details', rx, ry, { size: 13, weight: 700, color: '#1f6f8b' })
  ry += 10
  const limit = PAGE.height - 50
  for (const group of data.record) {
    if (ry + 30 > limit) break
    ry += 16
    text(ctx, group.group.toUpperCase(), rx, ry, { size: 7.5, weight: 700, color: MUTED })
    for (const row of group.rows) {
      if (ry + 13 > limit) break
      ry += 12.5
      text(ctx, row.label, rx, ry, { size: 8, color: MUTED, max: 120 })
      text(ctx, row.text, PAGE.width - 28, ry, { size: 8, weight: 600, color: INK, align: 'right', max: 170 })
    }
  }

  // Where it all came from.
  const sy = Math.max(y + 30, 380)
  if (sy < PAGE.height - 70) {
    text(ctx, 'Sources', ox, sy, { size: 9, weight: 700, color: INK })
    let s = sy + 13
    for (const line of data.sources) {
      s = para(ctx, line, ox, s, 410, { size: 7.5, color: MUTED, lead: 1.35, lines: 2 })
      if (s > PAGE.height - 50) break
    }
  }
  footer(ctx, data, 4)
  return canvas
}

/** Every page, in order, and the maps they were drawn with. */
export async function renderOm(data: OmData): Promise<{ pages: HTMLCanvasElement[]; maps: OmMaps }> {
  if (document.fonts?.ready) await document.fonts.ready.catch(() => undefined)
  const maps = await omMaps(data)
  return { pages: [cover(data, maps), location(data, maps), amenities(data, maps), details(data)], maps }
}

/** The disclaimer every page carries. */
export const DISCLAIMER =
  'Figures are from public records (the county assessor, the US Census ACS, OpenStreetMap, Wikidata) and have not been verified. They are not an appraisal or a survey; buyers should make their own investigation.'

/** The pages as one PDF, letter landscape, each page placed whole. */
export async function omPdf(pages: HTMLCanvasElement[], filename: string) {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter', compress: true })
  pages.forEach((canvas, i) => {
    if (i > 0) doc.addPage('letter', 'landscape')
    doc.addImage(canvas.toDataURL('image/jpeg', 0.9), 'JPEG', 0, 0, PAGE.width, PAGE.height, undefined, 'FAST')
  })
  doc.save(filename)
}
