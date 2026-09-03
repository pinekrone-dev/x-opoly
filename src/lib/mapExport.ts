/**
 * Turns the live map canvas into a file a broker can send.
 *
 * The map draws on a WebGL canvas, so the pixels are already composed — what
 * this adds is the part a screenshot loses: a caption band naming the market,
 * the moment, and what the colours mean, plus the attribution the data
 * licences require. Everything happens in the browser; there is no server-side
 * renderer to keep working, which is the same deal the tour book made.
 */

export interface MapExportLegendEntry {
  color: string
  label: string
}

export interface MapExportOptions {
  title: string
  subtitle: string
  legend: MapExportLegendEntry[]
  attribution: string
}

/** The caption band's height in CSS pixels, before the device scale. */
const BAND = 92

/**
 * The map canvas plus a white caption band underneath, as one canvas.
 *
 * Drawn at the map's own resolution — a retina map stays retina — with the
 * band scaled to match, so the type is the same physical size either way.
 */
export function composeMapImage(source: HTMLCanvasElement, options: MapExportOptions): HTMLCanvasElement {
  // The source is a detached copy, so it has no layout box to measure — its
  // bounding rect is zero wide, and dividing by it sized the band as
  // Infinity, which the canvas API answers with an unencodable bitmap. The
  // device pixel ratio is the scale the map painted at.
  const rectWidth = source.getBoundingClientRect().width
  const scale =
    rectWidth > 0
      ? Math.max(1, source.width / rectWidth)
      : Math.max(1, window.devicePixelRatio || 1)
  const band = Math.round(BAND * scale)
  const out = document.createElement('canvas')
  out.width = source.width
  out.height = source.height + band
  const ctx = out.getContext('2d')
  if (!ctx) return out

  ctx.drawImage(source, 0, 0)

  // The band. A hairline separates it from the map, matching the app's line
  // colour, so the export reads as a made thing rather than a screengrab.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, source.height, out.width, band)
  ctx.fillStyle = '#e2e8f0'
  ctx.fillRect(0, source.height, out.width, Math.max(1, Math.round(scale)))

  const pad = 24 * scale
  const x = pad
  ctx.fillStyle = '#0f172a'
  ctx.font = `700 ${16 * scale}px Inter, system-ui, sans-serif`
  ctx.fillText(options.title, x, source.height + 34 * scale)
  ctx.fillStyle = '#64748b'
  ctx.font = `400 ${12 * scale}px Inter, system-ui, sans-serif`
  ctx.fillText(options.subtitle, x, source.height + 56 * scale)
  ctx.fillStyle = '#94a3b8'
  ctx.font = `400 ${10 * scale}px Inter, system-ui, sans-serif`
  ctx.fillText(options.attribution, x, source.height + 76 * scale)

  // Legend chips, right-aligned, dropped one by one if the title needs room.
  let cx = out.width - pad
  ctx.font = `500 ${11 * scale}px Inter, system-ui, sans-serif`
  const titleEnd = x + ctx.measureText(options.title).width + 60 * scale
  for (const entry of [...options.legend].reverse()) {
    const w = ctx.measureText(entry.label).width
    const chip = w + 26 * scale
    if (cx - chip < titleEnd) break
    cx -= chip
    ctx.fillStyle = entry.color
    ctx.beginPath()
    ctx.arc(cx + 6 * scale, source.height + 30 * scale, 5 * scale, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#334155'
    ctx.fillText(entry.label, cx + 16 * scale, source.height + 34 * scale)
  }

  return out
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  // Deferred: revoking synchronously races the click in Safari.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function saveCanvasPng(canvas: HTMLCanvasElement, filename: string): Promise<void> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('The browser could not encode the image.'))
        return
      }
      saveBlob(blob, filename)
      resolve()
    }, 'image/png')
  })
}

/**
 * One letter-landscape page carrying the composed image, sized to fit.
 *
 * JPEG inside the PDF rather than PNG: a county's worth of parcel fills
 * compresses to a tenth the size with no visible loss at print scale.
 */
export async function saveCanvasPdf(canvas: HTMLCanvasElement, filename: string, title: string): Promise<void> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'pt', format: 'letter', orientation: 'landscape' })
  const pageW = doc.internal.pageSize.getWidth()
  const pageH = doc.internal.pageSize.getHeight()
  const margin = 36
  const maxW = pageW - margin * 2
  const maxH = pageH - margin * 2
  const ratio = Math.min(maxW / canvas.width, maxH / canvas.height)
  const w = canvas.width * ratio
  const h = canvas.height * ratio
  doc.setProperties({ title })
  doc.addImage(
    canvas.toDataURL('image/jpeg', 0.92),
    'JPEG',
    (pageW - w) / 2,
    (pageH - h) / 2,
    w,
    h,
  )
  doc.save(filename)
}
