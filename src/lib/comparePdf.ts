import type { DealStage, Demographics, Property, Survey } from '../types'
import { displayName, fullAddress, money, count, rate, sqft } from './format'
import { METRIC_DEFINITIONS, formatMetric } from '../components/DemographicsPanel'
import {
  ACCENT,
  BODY,
  INK,
  MUTED,
  RULE,
  contain,
  loadImage,
  hexToRgb,
  type LoadedImage,
} from './tourBookPdf'
import { api } from '../api'

/**
 * The side-by-side comparison: a handful of finalists, one column each.
 *
 * A survey with forty pins is for the broker; this is for the meeting where
 * two or three finalists get argued over. Every row shows the same fact for
 * every site, so a gap reads as a gap — an empty cell in "NNN" is itself the
 * point being made.
 *
 * Landscape, because columns are the whole idea and portrait would give each
 * site a strip too narrow to read.
 */

const PAGE = { width: 792, height: 612 }
const MARGIN = 40
const LABEL_WIDTH = 108
const FOOTER_Y = PAGE.height - 24

type Doc = import('jspdf').jsPDF

export interface CompareInput {
  survey: Survey
  properties: Property[]
  stages: DealStage[]
  /** Demographics ring, in miles, that the census rows describe. */
  radius: number
}

interface Column {
  property: Property
  image: LoadedImage | null
  demographics: Demographics | null
}

const FACT_ROWS: { label: string; value: (property: Property) => string }[] = [
  { label: 'Asking rate', value: (p) => rate(p) },
  { label: 'NNN / opex', value: (p) => (p.nnn == null ? '—' : money(p.nnn)) },
  { label: 'Size', value: (p) => sqft(p.sizeSqft) },
  { label: 'Acreage', value: (p) => (p.acreage == null ? '—' : `${p.acreage} ac`) },
  { label: 'Parking', value: (p) => count(p.parkingSpaces) },
  { label: 'Zoning', value: (p) => p.zoning || '—' },
  { label: 'Year built', value: (p) => (p.yearBuilt ? String(p.yearBuilt) : '—') },
  { label: 'Available', value: (p) => p.availability || '—' },
  { label: 'Listing broker', value: (p) => p.listingBroker || '—' },
]

function setFill(doc: Doc, color: { r: number; g: number; b: number }) {
  doc.setFillColor(color.r, color.g, color.b)
}

function setText(doc: Doc, color: { r: number; g: number; b: number }) {
  doc.setTextColor(color.r, color.g, color.b)
}

function metricAt(demographics: Demographics | null, radius: number, key: string): number | null {
  const ring = demographics?.radii.find((entry) => entry.miles === radius)
  const value = ring?.metrics?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export async function exportComparison({ survey, properties, stages, radius }: CompareInput) {
  const { jsPDF } = await import('jspdf')

  /*
   * Demographics load per site and any of them may fail — a site with no pin,
   * a census outage. A failed column shows em-dashes rather than sinking the
   * document: the broker can still hand over the rent comparison.
   */
  const columns: Column[] = await Promise.all(
    properties.map(async (property): Promise<Column> => {
      const cover =
        property.images.find((image) => image.id === property.coverImageId) ??
        property.images[0] ??
        null
      const [image, demographics] = await Promise.all([
        cover?.url ? loadImage(cover.url) : property.photoUrl ? loadImage(property.photoUrl) : null,
        property.lat != null && property.lng != null
          ? api.demographics(property.lat, property.lng).catch(() => null)
          : Promise.resolve(null),
      ])
      return { property, image, demographics }
    }),
  )

  const doc = new jsPDF({ unit: 'pt', format: 'letter', orientation: 'landscape' })
  const accent = survey.brandColor ? hexToRgb(survey.brandColor) : ACCENT
  const columnGap = 10
  const columnWidth =
    (PAGE.width - MARGIN * 2 - LABEL_WIDTH - columnGap * columns.length) / columns.length
  const columnX = (index: number) => MARGIN + LABEL_WIDTH + columnGap + index * (columnWidth + columnGap)

  // --- header ---------------------------------------------------------------
  setFill(doc, accent)
  doc.rect(0, 0, PAGE.width, 6, 'F')

  setText(doc, INK)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(18)
  doc.text('Site comparison', MARGIN, 40)

  setText(doc, MUTED)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(10)
  const subtitle = [survey.name, survey.clientName ? `for ${survey.clientName}` : null]
    .filter(Boolean)
    .join(' — ')
  doc.text(subtitle, MARGIN, 56)

  let y = 76

  // --- photos and names -----------------------------------------------------
  const photoHeight = 92
  columns.forEach((column, index) => {
    const x = columnX(index)
    if (column.image) {
      const fitted = contain(column.image, { width: columnWidth, height: photoHeight })
      doc.addImage(
        column.image.dataUrl,
        column.image.format,
        x + (columnWidth - fitted.width) / 2,
        y + (photoHeight - fitted.height) / 2,
        fitted.width,
        fitted.height,
      )
    } else {
      setFill(doc, RULE)
      doc.roundedRect(x, y, columnWidth, photoHeight, 4, 4, 'F')
      setText(doc, MUTED)
      doc.setFontSize(8)
      doc.text('No photo', x + columnWidth / 2, y + photoHeight / 2 + 2, { align: 'center' })
    }
  })
  y += photoHeight + 14

  columns.forEach((column, index) => {
    const x = columnX(index)
    setText(doc, INK)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(11)
    const name = doc.splitTextToSize(displayName(column.property), columnWidth) as string[]
    doc.text(name.slice(0, 2), x, y)

    setText(doc, MUTED)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    const address = doc.splitTextToSize(fullAddress(column.property), columnWidth) as string[]
    doc.text(address.slice(0, 2), x, y + name.slice(0, 2).length * 12 + 2)

    const stage = stages.find((entry) => entry.id === column.property.stageId)
    if (stage) {
      const chipY = y + name.slice(0, 2).length * 12 + address.slice(0, 2).length * 9 + 8
      const chip = hexToRgb(stage.color)
      setFill(doc, chip)
      doc.circle(x + 3, chipY - 2.5, 3, 'F')
      setText(doc, BODY)
      doc.text(stage.name, x + 10, chipY)
    }
  })
  y += 58

  // --- the fact rows --------------------------------------------------------
  const drawRow = (label: string, values: string[], shaded: boolean) => {
    const rowHeight = 17
    if (shaded) {
      setFill(doc, { r: 248, g: 250, b: 252 })
      doc.rect(MARGIN, y - 11, PAGE.width - MARGIN * 2, rowHeight - 2, 'F')
    }
    setText(doc, MUTED)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(8)
    doc.text(label.toUpperCase(), MARGIN, y)

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9.5)
    setText(doc, BODY)
    values.forEach((value, index) => {
      doc.text(value, columnX(index), y, { maxWidth: columnWidth })
    })
    y += rowHeight
  }

  const sectionTitle = (title: string, note?: string) => {
    y += 6
    doc.setDrawColor(RULE.r, RULE.g, RULE.b)
    doc.line(MARGIN, y - 14, PAGE.width - MARGIN, y - 14)
    setText(doc, accent)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    doc.text(title.toUpperCase(), MARGIN, y)
    if (note) {
      setText(doc, MUTED)
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(8)
      doc.text(note, PAGE.width - MARGIN, y, { align: 'right' })
    }
    y += 14
  }

  FACT_ROWS.forEach((row, index) => {
    drawRow(row.label, columns.map((column) => row.value(column.property)), index % 2 === 1)
  })

  // --- demographics ---------------------------------------------------------
  const anyDemographics = columns.some((column) => column.demographics)
  sectionTitle(
    `Trade area — ${radius} mile${radius === 1 ? '' : 's'}`,
    anyDemographics
      ? columns.find((column) => column.demographics)?.demographics?.source
      : 'Census data was not reachable when this was generated.',
  )

  METRIC_DEFINITIONS.forEach((metric, index) => {
    drawRow(
      metric.label + (metric.approximate ? ' *' : ''),
      columns.map((column) =>
        formatMetric(metricAt(column.demographics, radius, metric.key), metric.format),
      ),
      index % 2 === 1,
    )
  })

  if (columns.some((column) => column.demographics)) {
    setText(doc, MUTED)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7)
    doc.text(
      '* Population-weighted across block groups — an approximation, not a published census figure.',
      MARGIN,
      y,
    )
  }

  // --- footer ---------------------------------------------------------------
  setText(doc, MUTED)
  doc.setFontSize(8)
  doc.text(survey.brokerName || survey.companyName || 'Site comparison', MARGIN, FOOTER_Y)
  doc.text(new Date().toLocaleDateString(), PAGE.width - MARGIN, FOOTER_Y, { align: 'right' })

  const slug = (survey.name || 'sites').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  doc.save(`${slug || 'sites'}-comparison.pdf`)
}
