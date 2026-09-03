import type { BookStyle, DealStage, Property, Survey, TourStopSchedule } from '../types'
import { displayName, fullAddress } from './format'
import { directionsQr, directionsUrl } from './directions'
import { api } from '../api'

/**
 * Exports the tour book as a real PDF file.
 *
 * Print-to-PDF already produced a document, but it needs someone standing at a
 * print dialog and what comes out depends on their browser and paper settings.
 * A broker emailing a book to a client wants a file.
 *
 * Text is drawn rather than screenshotted, so it stays selectable, searchable
 * and sharp at any zoom. Rasterising the page would have turned a small
 * document into megabytes of blurry bitmap and made the addresses
 * uncopyable — which matters, because copying an address is what a client
 * does with this.
 *
 * Every stop carries a QR to its directions. On paper nobody can click, and
 * typing an address into a phone from the passenger seat is the friction this
 * removes. The shared web version drops the QR and links instead.
 */

/** Letter portrait, in points, which is jsPDF's native unit. */
const PAGE = { width: 612, height: 792 }
const MARGIN = 42
const CONTENT_WIDTH = PAGE.width - MARGIN * 2
const FOOTER_Y = PAGE.height - 28

export const INK = { r: 15, g: 23, b: 42 }
export const BODY = { r: 51, g: 65, b: 85 }
export const MUTED = { r: 113, g: 128, b: 150 }
export const RULE = { r: 226, g: 232, b: 240 }
export const ACCENT = { r: 1, g: 163, b: 168 }
/** The brand's navy pair: night for the cover ground, deep for headings. */
export const NIGHT = { r: 12, g: 31, b: 66 }
export const DEEP = { r: 20, g: 51, b: 102 }
export const EDGE = { r: 34, g: 64, b: 111 }
export const SUNKEN = { r: 241, g: 245, b: 249 }
const WHITE = { r: 255, g: 255, b: 255 }
const SOFT = { r: 203, g: 213, b: 225 }

/** A colour mixed toward white, for the tinted pills stage chips sit on. */
function tint(colour: typeof INK, amount: number) {
  return {
    r: Math.round(colour.r * amount + 255 * (1 - amount)),
    g: Math.round(colour.g * amount + 255 * (1 - amount)),
    b: Math.round(colour.b * amount + 255 * (1 - amount)),
  }
}

/** The QR block sits bottom-right; content flows above it. */
const QR_SIZE = 96

interface BookInput {
  survey: Survey
  stops: Property[]
  stages: DealStage[]
  times: Map<string, TourStopSchedule>
  summary: { startTime: string; endTime: string; driveLabel: string } | null
  /** Print a directions QR on each stop. The broker's report option. */
  includeQr?: boolean
  /** The book's style levers; the survey's saved style when omitted. */
  style?: BookStyle
}

export interface LoadedImage {
  dataUrl: string
  width: number
  height: number
  format: 'PNG' | 'JPEG'
}

type Doc = import('jspdf').jsPDF

/**
 * Fetches an image and measures it.
 *
 * The natural dimensions matter: jsPDF will stretch an image to whatever box
 * it is given, and a distorted building photo is worse than none. Returns null
 * rather than throwing, so one unreachable image cannot cost the whole export.
 */
export async function loadImage(url: string): Promise<LoadedImage | null> {
  try {
    const response = await fetch(url)
    if (!response.ok) return null
    const blob = await response.blob()

    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(new Error('unreadable'))
      reader.readAsDataURL(blob)
    })

    const size = await new Promise<{ width: number; height: number }>((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
      image.onerror = () => reject(new Error('undecodable'))
      image.src = dataUrl
    })

    return { dataUrl, ...size, format: blob.type.includes('png') ? 'PNG' : 'JPEG' }
  } catch {
    return null
  }
}

/** Fits an image inside a box without distorting it. */
export function contain(image: LoadedImage, box: { width: number; height: number }) {
  const scale = Math.min(box.width / image.width, box.height / image.height)
  return { width: image.width * scale, height: image.height * scale }
}

function setText(doc: Doc, size: number, colour: typeof INK, weight: 'normal' | 'bold' = 'normal') {
  doc.setFont('helvetica', weight)
  doc.setFontSize(size)
  doc.setTextColor(colour.r, colour.g, colour.b)
}

/** The accent as jsPDF wants it, from the style's hex. */
function accentOf(style: BookStyle) {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(style.accent)
  return match
    ? { r: parseInt(match[1], 16), g: parseInt(match[2], 16), b: parseInt(match[3], 16) }
    : ACCENT
}

export async function exportTourBook({ survey, stops, stages, times, summary, includeQr = true, style }: BookInput) {
  // Loaded on demand: dead weight on the map page otherwise.
  const { jsPDF } = await import('jspdf')

  const doc = new jsPDF({ unit: 'pt', format: 'letter', compress: true })
  doc.setProperties({
    title: `${survey.name || 'Tour book'} — site tour`,
    subject: survey.clientName ? `Prepared for ${survey.clientName}` : 'Site tour',
    author: survey.brokerName || survey.companyName || 'Land Quotient',
  })

  // Everything asynchronous happens up front, in parallel, so page layout is
  // synchronous and pages cannot interleave.
  const assets = new Map<string, { hero: LoadedImage | null; extras: LoadedImage[]; qr: string | null }>()
  await Promise.all(
    stops.map(async (property) => {
      const images = property.images ?? []
      const heroImage = images.find((image) => image.id === property.coverImageId) ?? images[0] ?? null
      const extraImages = images.filter((image) => image.id !== heroImage?.id).slice(0, 3)

      const [hero, extras, qr] = await Promise.all([
        heroImage ? loadImage(heroImage.url) : Promise.resolve(null),
        Promise.all(extraImages.map((image) => loadImage(image.url))),
        includeQr && (style ?? survey.book).showQr ? directionsQr(property) : Promise.resolve(null),
      ])

      assets.set(property.id, { hero, extras: extras.filter(Boolean) as LoadedImage[], qr })
    }),
  )

  const book = style ?? survey.book
  const accent = accentOf(book)

  drawCover(doc, { survey, stops, summary, book, accent })
  if (book.showSchedule && stops.length > 0) {
    doc.addPage()
    drawItinerary(doc, { survey, stops, stages, times, summary, accent })
  }

  stops.forEach((property, index) => {
    doc.addPage()
    drawStop(doc, {
      book,
      accent,
      survey,
      property,
      index,
      total: stops.length,
      time: times.get(property.id) ?? null,
      stage: stages.find((entry) => entry.id === property.stageId) ?? null,
      ...(assets.get(property.id) ?? { hero: null, extras: [], qr: null }),
    })
  })

  const name = `${survey.name || 'Tour book'}`.replace(/[^\w\d -]+/g, '').trim() || 'Tour book'
  doc.save(`${name} — tour book.pdf`)
}

function drawCover(
  doc: Doc,
  {
    survey,
    stops,
    summary,
    book,
    accent,
  }: Pick<BookInput, 'survey' | 'stops' | 'summary'> & { book: BookStyle; accent: typeof INK },
) {
  const navy = book.cover !== 'light'
  const ink = navy ? WHITE : DEEP
  const soft = navy ? SOFT : BODY
  const quiet = navy ? { r: 100, g: 116, b: 139 } : MUTED

  if (navy) {
    doc.setFillColor(NIGHT.r, NIGHT.g, NIGHT.b)
    doc.rect(0, 0, PAGE.width, PAGE.height, 'F')
    // The route motif: a dashed path with a node at each end, quiet enough
    // to read as texture rather than as a map.
    doc.setDrawColor(EDGE.r, EDGE.g, EDGE.b)
    doc.setLineWidth(1.2)
    doc.setLineDashPattern([1.5, 6], 0)
    doc.lines(
      [
        [70, 105, -30, 210, 20, 320],
        [-40, 90, 55, 200, 25, 300],
      ],
      PAGE.width - 150,
      90,
    )
    doc.setLineDashPattern([], 0)
    doc.setFillColor(accent.r, accent.g, accent.b)
    doc.circle(PAGE.width - 150, 90, 5, 'F')
    doc.circle(PAGE.width - 105, 710, 5, 'F')
  } else {
    doc.setFillColor(accent.r, accent.g, accent.b)
    doc.rect(MARGIN, MARGIN + 12, 48, 4.5, 'F')
  }

  // The wordmark, top left on either ground.
  setText(doc, 11, navy ? WHITE : DEEP, 'bold')
  doc.text('Land', MARGIN, MARGIN + (navy ? 10 : 0))
  const landWidth = doc.getTextWidth('Land ')
  setText(doc, 11, accent, 'bold')
  doc.text('Quotient', MARGIN + landWidth, MARGIN + (navy ? 10 : 0))

  let y = 300

  setText(doc, 10, accent, 'bold')
  doc.text('SITE TOUR', MARGIN, y, { charSpace: 3 })
  y += 40

  setText(doc, 34, ink, 'bold')
  for (const line of doc.splitTextToSize(survey.name || 'Site tour', CONTENT_WIDTH - 60).slice(0, 3)) {
    doc.text(line, MARGIN, y)
    y += 38
  }

  if (survey.clientName) {
    y += 2
    setText(doc, 14, soft)
    doc.text(`Prepared for ${survey.clientName}`, MARGIN, y)
    y += 20
  }
  setText(doc, 10, quiet)
  doc.text(
    new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
    MARGIN,
    y,
  )
  y += 24

  if (book.intro) {
    setText(doc, 11, soft)
    for (const line of doc.splitTextToSize(book.intro, CONTENT_WIDTH - 120).slice(0, 4)) {
      doc.text(line, MARGIN, y)
      y += 15
    }
  }

  // The bottom band: who prepared it, and the tour in three numbers.
  const bandY = PAGE.height - 130
  doc.setDrawColor(navy ? EDGE.r : RULE.r, navy ? EDGE.g : RULE.g, navy ? EDGE.b : RULE.b)
  doc.setLineWidth(0.8)
  doc.line(MARGIN, bandY, PAGE.width - MARGIN, bandY)

  let infoY = bandY + 24
  if (survey.brokerName) {
    setText(doc, 12, ink, 'bold')
    doc.text(survey.brokerName, MARGIN, infoY)
    infoY += 15
  }
  if (survey.companyName) {
    setText(doc, 10, quiet)
    doc.text(survey.companyName, MARGIN, infoY)
  }

  const stats: [string, string][] = [[String(stops.length), stops.length === 1 ? 'STOP' : 'STOPS']]
  if (summary) {
    stats.push([`${summary.startTime}–${summary.endTime}`, 'TOUR WINDOW'])
    stats.push([summary.driveLabel, 'DRIVING'])
  }
  let statX = PAGE.width - MARGIN
  for (const [value, label] of [...stats].reverse()) {
    setText(doc, 15, ink, 'bold')
    const valueWidth = doc.getTextWidth(value)
    setText(doc, 7, quiet, 'bold')
    const labelWidth = doc.getTextWidth(label) * 1.4
    const width = Math.max(valueWidth, labelWidth)
    statX -= width
    setText(doc, 15, ink, 'bold')
    doc.text(value, statX + width, bandY + 26, { align: 'right' })
    setText(doc, 7, quiet, 'bold')
    doc.text(label, statX + width, bandY + 40, { align: 'right', charSpace: 1 })
    statX -= 26
  }
}

function drawItinerary(
  doc: Doc,
  {
    survey,
    stops,
    stages,
    times,
    summary,
    accent,
  }: Pick<BookInput, 'survey' | 'stops' | 'stages' | 'times' | 'summary'> & { accent: typeof INK },
) {
  setText(doc, 9, accent, 'bold')
  doc.text('ITINERARY', MARGIN, MARGIN + 12, { charSpace: 2.5 })
  setText(doc, 17, DEEP, 'bold')
  doc.text(doc.splitTextToSize(survey.name || 'Site tour', CONTENT_WIDTH - 140)[0] ?? '', MARGIN, MARGIN + 34)
  if (summary) {
    setText(doc, 9, MUTED)
    doc.text(
      `Starts ${summary.startTime} · ${stops.length} stops · ${summary.driveLabel} driving`,
      PAGE.width - MARGIN,
      MARGIN + 34,
      { align: 'right' },
    )
  }
  doc.setDrawColor(DEEP.r, DEEP.g, DEEP.b)
  doc.setLineWidth(1.4)
  doc.line(MARGIN, MARGIN + 46, PAGE.width - MARGIN, MARGIN + 46)

  let y = MARGIN + 78
  const timeX = MARGIN + 44
  const nodeX = timeX + 26
  const textX = nodeX + 22

  stops.forEach((property, index) => {
    if (y > FOOTER_Y - 44) {
      footer(doc, survey, null)
      doc.addPage()
      y = MARGIN + 30
    }
    const time = times.get(property.id)
    const stage = stages.find((entry) => entry.id === property.stageId) ?? null
    const last = index === stops.length - 1

    if (!last) {
      doc.setDrawColor(RULE.r, RULE.g, RULE.b)
      doc.setLineWidth(1.2)
      doc.line(nodeX, y - 2, nodeX, y + 46)
    }
    doc.setFillColor(last ? accent.r : DEEP.r, last ? accent.g : DEEP.g, last ? accent.b : DEEP.b)
    doc.circle(nodeX, y - 3, 9, 'F')
    setText(doc, 9, WHITE, 'bold')
    doc.text(String(index + 1), nodeX, y, { align: 'center' })

    setText(doc, 10, INK, 'bold')
    doc.text(time?.arrive ?? '', timeX, y, { align: 'right' })

    setText(doc, 11, INK, 'bold')
    const name = doc.splitTextToSize(displayName(property), CONTENT_WIDTH - 200)[0] ?? ''
    doc.text(name, textX, y - 3)
    if (stage) {
      const colour = hexToRgb(stage.color)
      setText(doc, 7.5, colour, 'bold')
      doc.text(stage.name.toUpperCase(), textX + doc.getTextWidth(name) * 1.16 + 10, y - 3, { charSpace: 0.8 })
    }
    setText(doc, 9, MUTED)
    doc.text(doc.splitTextToSize(fullAddress(property) || '—', CONTENT_WIDTH - 200)[0] ?? '', textX, y + 9)

    if (time && time.driveMinutes > 0 && !last) {
      setText(doc, 8, { r: 148, g: 163, b: 184 })
      doc.text(`↓  ${time.driveMinutes} min drive`, textX, y + 24)
    }
    y += 46
  })

  footer(doc, survey, null)
}

function drawStop(
  doc: Doc,
  {
    survey,
    property,
    index,
    total,
    time,
    stage,
    hero,
    extras,
    qr,
    book,
    accent,
  }: {
    survey: Survey
    property: Property
    index: number
    total: number
    time: TourStopSchedule | null
    stage: DealStage | null
    hero: LoadedImage | null
    extras: LoadedImage[]
    qr: string | null
    book: BookStyle
    accent: typeof INK
  },
) {
  let y = MARGIN + 20

  doc.setFillColor(DEEP.r, DEEP.g, DEEP.b)
  doc.circle(MARGIN + 13, y - 5, 13, 'F')
  setText(doc, 13, { r: 255, g: 255, b: 255 }, 'bold')
  doc.text(String(index + 1), MARGIN + 13, y, { align: 'center' })

  if (stage) {
    // The pill the app uses: the stage colour at thirteen percent behind
    // itself, so map, sidebar and book all speak one language.
    const colour = hexToRgb(stage.color)
    const ground = tint(colour, 0.13)
    setText(doc, 8, colour, 'bold')
    const pillWidth = doc.getTextWidth(stage.name.toUpperCase()) * 1.15 + 16
    doc.setFillColor(ground.r, ground.g, ground.b)
    doc.roundedRect(PAGE.width - MARGIN - pillWidth, y - 17, pillWidth, 15, 7, 7, 'F')
    doc.text(stage.name.toUpperCase(), PAGE.width - MARGIN - pillWidth / 2, y - 7, {
      align: 'center',
      charSpace: 0.8,
    })
  }

  const left = MARGIN + 38
  const headWidth = CONTENT_WIDTH - 38 - (stage ? 100 : 0)

  setText(doc, 18, INK, 'bold')
  for (const line of doc.splitTextToSize(displayName(property), headWidth).slice(0, 2)) {
    doc.text(line, left, y)
    y += 21
  }

  // The full address, given its own line at readable size — this is the single
  // most-used fact on the page.
  setText(doc, 11, BODY)
  for (const line of doc.splitTextToSize(fullAddress(property) || '—', headWidth).slice(0, 2)) {
    doc.text(line, left, y)
    y += 14
  }

  if (time) {
    y += 6
    doc.setFillColor(SUNKEN.r, SUNKEN.g, SUNKEN.b)
    doc.roundedRect(MARGIN, y - 11, CONTENT_WIDTH, 22, 5, 5, 'F')
    const drive = time.driveMinutes > 0 ? ` after ${time.driveMinutes} min drive` : ''
    setText(doc, 9.5, BODY)
    doc.text(
      `Arrive ${time.arrive}${drive}   ·   ${time.stopMinutes} min on site   ·   Depart ${time.depart}`,
      MARGIN + 12,
      y + 3,
    )
    y += 20
  }

  y += 14

  if (hero) {
    const box = contain(hero, { width: CONTENT_WIDTH, height: 236 })
    doc.addImage(hero.dataUrl, hero.format, MARGIN, y, box.width, box.height)
    y += box.height + 10

    if (extras.length > 0) {
      const slot = (CONTENT_WIDTH - 8 * (extras.length - 1)) / extras.length
      let x = MARGIN
      for (const extra of extras) {
        const box2 = contain(extra, { width: slot, height: 70 })
        doc.addImage(extra.dataUrl, extra.format, x, y, box2.width, box2.height)
        x += slot + 8
      }
      y += 78
    }
  } else {
    doc.setDrawColor(RULE.r, RULE.g, RULE.b)
    doc.roundedRect(MARGIN, y, CONTENT_WIDTH, 64, 4, 4)
    setText(doc, 9, MUTED)
    doc.text('No photo yet', PAGE.width / 2, y + 37, { align: 'center' })
    y += 80
  }

  // Details, two columns, filling down the left before the right.
  const fields = book.showDetails ? property.fields ?? [] : []
  if (fields.length > 0) {
    y += 6
    doc.setDrawColor(RULE.r, RULE.g, RULE.b)
    doc.line(MARGIN, y, PAGE.width - MARGIN, y)
    y += 16

    setText(doc, 8, MUTED, 'bold')
    doc.text('PROPERTY DETAILS', MARGIN, y, { charSpace: 1.2 })
    y += 16

    const columnWidth = CONTENT_WIDTH / 2 - 12
    const rows = Math.ceil(fields.length / 2)
    const startY = y

    fields.forEach((field, position) => {
      const column = position < rows ? 0 : 1
      const row = position < rows ? position : position - rows
      const x = MARGIN + column * (columnWidth + 24)
      const lineY = startY + row * 16

      setText(doc, 9, MUTED)
      doc.text(doc.splitTextToSize(field.label, columnWidth * 0.55)[0] ?? '', x, lineY)

      setText(doc, 9, INK, 'bold')
      doc.text(
        doc.splitTextToSize(field.value || '—', columnWidth * 0.45)[0] ?? '—',
        x + columnWidth,
        lineY,
        { align: 'right' },
      )
    })

    y = startY + rows * 16 + 10
  }

  // Notes, trimmed to what fits above the directions block.
  const notesRoom = FOOTER_Y - QR_SIZE - 46 - y
  if (property.notes && notesRoom > 30) {
    doc.setDrawColor(RULE.r, RULE.g, RULE.b)
    doc.line(MARGIN, y, PAGE.width - MARGIN, y)
    y += 16
    setText(doc, 9, BODY)
    const maxLines = Math.max(1, Math.floor(notesRoom / 12) - 1)
    for (const line of doc.splitTextToSize(property.notes, CONTENT_WIDTH).slice(0, maxLines)) {
      doc.text(line, MARGIN, y)
      y += 12
    }
    y += 6
  }

  // Directions and contact, anchored to the bottom so every page ends the same
  // way — a client flipping through knows where to look.
  const blockTop = FOOTER_Y - QR_SIZE - 16
  doc.setDrawColor(RULE.r, RULE.g, RULE.b)
  doc.line(MARGIN, blockTop - 14, PAGE.width - MARGIN, blockTop - 14)

  if (qr) {
    const pad = 8
    doc.setFillColor(233, 245, 246)
    doc.roundedRect(
      PAGE.width - MARGIN - QR_SIZE - pad * 2,
      blockTop - pad,
      QR_SIZE + pad * 2,
      QR_SIZE + pad * 2 + 12,
      6,
      6,
      'F',
    )
    doc.addImage(qr, 'PNG', PAGE.width - MARGIN - QR_SIZE - pad, blockTop, QR_SIZE, QR_SIZE)
    setText(doc, 7.5, DEEP, 'bold')
    doc.text('SCAN FOR DIRECTIONS', PAGE.width - MARGIN - pad - QR_SIZE / 2, blockTop + QR_SIZE + 11, {
      align: 'center',
      charSpace: 0.5,
    })
  }

  let contactY = blockTop + 6

  /*
   * No listing contact here on purpose. The tour book goes to the client, and
   * a tenant rep does not hand their client a direct line to the listing
   * broker. The details stay in the workspace, where the broker needs them.
   */

  // A clickable destination for anyone reading the PDF on a screen. The QR
  // serves paper; this serves the same person on a laptop.
  const link = directionsUrl(property)
  if (link) {
    setText(doc, 9, accent, 'bold')
    doc.textWithLink('Get directions →', MARGIN, Math.min(contactY + 4, FOOTER_Y - 12), { url: link })
  }

  footer(doc, survey, `${index + 1} of ${total}`)
}

function footer(doc: Doc, survey: Survey, position: string | null) {
  setText(doc, 8, MUTED)
  const label = [survey.name, survey.companyName].filter(Boolean).join(' · ')
  doc.text(doc.splitTextToSize(label, CONTENT_WIDTH - 80)[0] ?? '', MARGIN, FOOTER_Y)
  if (position) doc.text(position, PAGE.width - MARGIN, FOOTER_Y, { align: 'right' })
}

/** "#eab308" to jsPDF's separate channels. Falls back to the muted grey. */
export function hexToRgb(hex: string) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ''))
  if (!match) return MUTED
  const value = parseInt(match[1], 16)
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
}

/**
 * Builds and downloads the book for a survey, working out the order itself.
 *
 * The share tab needs this without the broker having opened the tour planner
 * first — "send the client the book" should not require visiting another tab
 * to establish what order the stops are in. A saved tour order wins; failing
 * that the server optimises one, and failing that the survey's own order is
 * used, so a book is always produced.
 */
export async function buildTourBookFor({
  surveyId,
  survey,
  properties,
  stages,
}: {
  surveyId: string
  survey: Survey
  properties: Property[]
  stages: DealStage[]
}) {
  const located = properties.filter((property) => property.lat != null && property.lng != null)
  if (located.length === 0) {
    throw new Error('No sites have a location yet, so there is nothing to tour.')
  }

  const saved = located
    .filter((property) => property.tourOrder != null)
    .sort((a, b) => (a.tourOrder ?? 0) - (b.tourOrder ?? 0))

  let stops = saved.length > 0 ? saved : located
  let summary: { startTime: string; endTime: string; driveLabel: string } | null = null
  let times = new Map<string, TourStopSchedule>()

  try {
    const plan = await api.planTour(surveyId, {
      propertyIds: stops.map((property) => property.id),
      // Only decide the order when the broker has not: their arrangement is a
      // decision, not a draft to be improved on.
      optimize: saved.length === 0,
      startTime: survey.tour?.startTime,
      stopMinutes: survey.tour?.stopMinutes,
    })
    if (plan.stops?.length) stops = plan.stops
    times = new Map((plan.itinerary?.items ?? []).map((item) => [item.id, item]))
    if (plan.itinerary) {
      summary = {
        startTime: plan.itinerary.startTime,
        endTime: plan.itinerary.endTime,
        driveLabel: plan.itinerary.driveLabel,
      }
    }
  } catch {
    // A routing outage costs the times, not the book.
  }

  await exportTourBook({
    survey,
    stops,
    stages,
    times,
    summary,
    includeQr: survey.share?.showQr !== false,
  })
}
