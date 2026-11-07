/**
 * The offering memorandum as a PowerPoint deck a broker can edit.
 *
 * Brokers finish an OM in PowerPoint: their own logo, a photo of the
 * storefront, a line about the tenant. So every word here is a native text
 * box or table, and only the maps (with their pins, rings and numbers drawn
 * on) are pictures. Slides are letter landscape, the same size and layout
 * as the PDF pages, so the two read alike.
 */
import { DEMOGRAPHICS, DISCLAIMER, PAGE, brokerLines, landmarkKey, metric, type OmData, type OmMaps } from './omPages'
import { tenantMix } from './amenityGroups'

const NIGHT = '0C1F42'
const ACCENT = '01A3A8'
const TEAL = '1F6F8B'
const INK = '0F172A'
const BODY = '334155'
const MUTED = '718096'
const RULE = 'E2E8F0'
const FACE = 'Arial'

/** Points (the page layout's unit) to inches (PowerPoint's). */
const inch = (pt: number) => pt / 72

type Pptx = InstanceType<typeof import('pptxgenjs').default>
type Slide = ReturnType<Pptx['addSlide']>

function box(slide: Slide, value: string | { text: string; options?: Record<string, unknown> }[], x: number, y: number, w: number, h: number, options: Record<string, unknown> = {}) {
  slide.addText(value as never, {
    x: inch(x), y: inch(y), w: inch(w), h: inch(h),
    fontFace: FACE, fontSize: 10, color: BODY, margin: 0, valign: 'top', ...options,
  })
}

function rect(pptx: Pptx, slide: Slide, x: number, y: number, w: number, h: number, color: string) {
  slide.addShape(pptx.ShapeType.rect, { x: inch(x), y: inch(y), w: inch(w), h: inch(h), fill: { color }, line: { color, width: 0 } })
}

function picture(slide: Slide, canvas: HTMLCanvasElement, x: number, y: number, w: number, h: number) {
  slide.addImage({ data: canvas.toDataURL('image/jpeg', 0.9), x: inch(x), y: inch(y), w: inch(w), h: inch(h) })
}

function band(pptx: Pptx, slide: Slide, data: OmData, title: string) {
  rect(pptx, slide, 0, 0, PAGE.width, 58, NIGHT)
  rect(pptx, slide, 0, 58, PAGE.width, 3, ACCENT)
  box(slide, title.toUpperCase(), 28, 20, 360, 22, { fontSize: 11, bold: true, color: 'FFFFFF', valign: 'middle' })
  box(slide, [
    { text: data.address, options: { fontSize: 13, bold: true, color: 'FFFFFF', breakLine: true } },
    { text: data.cityLine, options: { fontSize: 9, color: 'CBD5E1' } },
  ], 380, 12, PAGE.width - 408, 40, { align: 'right' })
}

function footer(slide: Slide, data: OmData, n: number) {
  slide.addShape('line', { x: inch(28), y: inch(PAGE.height - 34), w: inch(PAGE.width - 56), h: 0, line: { color: RULE, width: 0.75 } })
  box(slide, DISCLAIMER, 28, PAGE.height - 30, 600, 22, { fontSize: 6.5, color: MUTED })
  const by = [data.broker.name, data.broker.company].filter(Boolean).join(' · ')
  box(slide, `${by ? `${by} · ` : ''}${n}`, PAGE.width - 228, PAGE.height - 24, 200, 12, { fontSize: 7.5, color: MUTED, align: 'right' })
}

function cover(pptx: Pptx, data: OmData, maps: OmMaps) {
  const slide = pptx.addSlide()
  rect(pptx, slide, 0, 0, PAGE.width, 128, NIGHT)
  rect(pptx, slide, 0, 128, PAGE.width, 3, ACCENT)
  box(slide, data.headline.toUpperCase(), 28, 26, 736, 18, { fontSize: 11, bold: true, color: ACCENT })
  box(slide, data.address, 28, 50, 736, 40, { fontSize: 30, bold: true, color: 'FFFFFF' })
  box(slide, data.cityLine, 28, 94, 736, 20, { fontSize: 13, color: 'CBD5E1' })
  picture(slide, maps.cover.canvas, 0, 131, maps.cover.width, maps.cover.height)

  const hx = 520
  box(slide, 'Property Highlights', hx, 142, 250, 22, { fontSize: 15, bold: true, color: TEAL })
  box(
    slide,
    data.highlights.slice(0, 9).flatMap((row) => [
      { text: row.label, options: { fontSize: 8, bold: true, color: MUTED, breakLine: true } },
      { text: row.text, options: { fontSize: 10, bold: true, color: INK, breakLine: true, paraSpaceAfter: 9 } },
    ]),
    hx, 172, PAGE.width - 24 - hx, 290,
  )
  if (data.description) box(slide, data.description, 28, 476, 460, 90, { fontSize: 10.5, color: BODY, lineSpacingMultiple: 1.2 })
  const lines = brokerLines(data)
  if (lines.length) {
    box(slide, lines.map((line, i) => ({ text: line, options: { fontSize: i === 0 ? 11 : 9, bold: i === 0, color: i === 0 ? INK : BODY, breakLine: true } })), hx, 476, 250, 80)
  }
  footer(slide, data, 1)
}

function location(pptx: Pptx, data: OmData, maps: OmMaps) {
  const slide = pptx.addSlide()
  band(pptx, slide, data, 'Site Location Map')
  picture(slide, maps.location.canvas, 24, 76, maps.location.width, maps.location.height)
  const shown = maps.location.shown.slice(0, 6)
  if (shown.length) {
    const rows = shown.map((l) => [
      { text: l.name, options: { bold: true, color: INK } },
      { text: landmarkKey(l), options: { color: BODY } },
    ])
    const half = Math.ceil(rows.length / 2)
    const table = (part: typeof rows, x: number) =>
      part.length &&
      slide.addTable(part, { x: inch(x), y: inch(76 + maps.location.height + 8), w: inch(366), colW: [inch(170), inch(196)], fontFace: FACE, fontSize: 8, rowH: inch(13), margin: 1, border: { type: 'none' } })
    table(rows.slice(0, half), 24)
    table(rows.slice(half), 402)
  }
  footer(slide, data, 2)
}

function amenities(pptx: Pptx, data: OmData, maps: OmMaps) {
  const slide = pptx.addSlide()
  band(pptx, slide, data, 'Area Retailers & Amenity Map')
  picture(slide, maps.amenity.canvas, 24, 76, maps.amenity.width, maps.amenity.height)
  const lx = 24 + maps.amenity.width + 22
  const width = PAGE.width - 24 - lx
  const list = data.amenities
  if (!list.length) {
    box(slide, data.amenitiesFailed ? 'The store directory did not answer. Try again from the editor.' : 'No chain stores were found within a mile in the directory.', lx, 80, width, 20, { fontSize: 9, color: MUTED })
  } else {
    box(slide, `Tenant mix: ${tenantMix(list)}`, lx, 80, width, 34, { fontSize: 7.5, color: MUTED })
    const top = 120
    const rows = Math.max(1, Math.floor((PAGE.height - 48 - top) / 12.5))
    const table = (part: typeof list, x: number) =>
      part.length &&
      slide.addTable(
        part.map((a) => [
          { text: `${a.n}.`, options: { bold: true, color: INK, align: 'right' } },
          { text: a.name, options: { color: BODY } },
          { text: `${a.miles.toFixed(1)} mi`, options: { color: MUTED, align: 'right' } },
        ]),
        { x: inch(x), y: inch(top), w: inch(width / 2 - 6), colW: [inch(18), inch(width / 2 - 62), inch(38)], fontFace: FACE, fontSize: 8, rowH: inch(12.5), margin: 1, border: { type: 'none' } },
      )
    table(list.slice(0, rows), lx)
    table(list.slice(rows, rows * 2), lx + width / 2)
  }
  footer(slide, data, 3)
}

function details(pptx: Pptx, data: OmData) {
  const slide = pptx.addSlide()
  band(pptx, slide, data, 'Demographics & Property Details')
  box(slide, 'Trade Area Demographics', 28, 78, 420, 20, { fontSize: 13, bold: true, color: TEAL })
  const radii = (data.demographics?.radii ?? []).slice(0, 3)
  let below = 110
  if (radii.length) {
    const head = [{ text: '', options: {} }, ...radii.map((r) => ({ text: `${r.miles} Mile${r.miles === 1 ? '' : 's'}`, options: { bold: true, color: INK, align: 'right' } }))]
    const body = DEMOGRAPHICS.map((m) => [
      { text: m.label, options: { color: BODY } },
      ...radii.map((r) => ({ text: metric(r.metrics[m.key], m.format), options: { bold: true, color: INK, align: 'right' } })),
    ])
    slide.addTable([head, ...body] as never, {
      x: inch(28), y: inch(104), w: inch(420), colW: [inch(180), inch(80), inch(80), inch(80)],
      fontFace: FACE, fontSize: 9, rowH: inch(16), margin: 2, border: { type: 'solid', pt: 0.5, color: RULE },
    })
    below = 104 + (DEMOGRAPHICS.length + 1) * 16 + 8
    box(slide, data.demographics?.source ?? 'US Census ACS', 28, below, 420, 12, { fontSize: 7, color: MUTED })
    below += 20
  } else {
    box(slide, 'The Census figures could not be loaded for this point.', 28, 108, 420, 16, { fontSize: 9, color: MUTED })
    below = 140
  }

  box(slide, 'Property Details', 470, 78, 294, 20, { fontSize: 13, bold: true, color: TEAL })
  const fit = Math.floor((PAGE.height - 60 - 104) / 12.5)
  const rows: { text: string; options: Record<string, unknown> }[][] = []
  for (const group of data.record) {
    if (rows.length + 2 > fit) break
    rows.push([{ text: group.group.toUpperCase(), options: { bold: true, color: MUTED, fontSize: 7.5 } }, { text: '', options: {} }])
    for (const row of group.rows) {
      if (rows.length >= fit) break
      rows.push([{ text: row.label, options: { color: MUTED } }, { text: row.text, options: { bold: true, color: INK, align: 'right' } }])
    }
  }
  if (rows.length) {
    slide.addTable(rows as never, { x: inch(470), y: inch(104), w: inch(294), colW: [inch(120), inch(174)], fontFace: FACE, fontSize: 8, rowH: inch(12.5), margin: 1, border: { type: 'none' } })
  }

  box(slide, [
    { text: 'Sources', options: { bold: true, color: INK, fontSize: 9, breakLine: true } },
    ...data.sources.map((line) => ({ text: line, options: { color: MUTED, fontSize: 7.5, breakLine: true } })),
  ], 28, Math.max(below, 330), 420, 120)
  footer(slide, data, 4)
}

/** The deck, downloaded as `filename`. */
export async function omPptx(data: OmData, maps: OmMaps, filename: string) {
  const { default: PptxGenJS } = await import('pptxgenjs')
  const pptx = new PptxGenJS()
  pptx.defineLayout({ name: 'LETTER_LANDSCAPE', width: 11, height: 8.5 })
  pptx.layout = 'LETTER_LANDSCAPE'
  pptx.title = `${data.address} — Offering Memorandum`
  if (data.broker.name) pptx.author = data.broker.name
  if (data.broker.company) pptx.company = data.broker.company
  cover(pptx, data, maps)
  location(pptx, data, maps)
  amenities(pptx, data, maps)
  details(pptx, data)
  // Saved through a link of our own, in the page, so the file keeps its
  // name (the library's own link came down as "download" in some browsers).
  const blob = (await pptx.write({ outputType: 'blob' })) as Blob
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
