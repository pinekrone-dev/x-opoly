import { api } from '../api'
import type { Property } from '../types'

/**
 * Gives a site its card photo straight from the OM.
 *
 * A property that arrived as a flyer upload already holds its best image —
 * the flyer's first page. Rendering it here (pdf.js for PDFs, the file
 * itself for images) and storing it as the photo means every card, list row
 * and tour book page gets a thumbnail without anyone cropping anything.
 * Manual photos are never overwritten: this only runs when no photo exists.
 */
export async function autoPhotoFromFlyer(property: Property): Promise<Property | null> {
  if (!property.flyerUrl || property.photoUrl) return null

  try {
    const isPdf =
      /\.pdf(\?|$)/i.test(property.flyerUrl) || (property.flyerName ?? '').toLowerCase().endsWith('.pdf')

    let blob: Blob | null
    if (isPdf) {
      const pdfjs = await import('pdfjs-dist')
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url,
      ).toString()
      const doc = await pdfjs.getDocument({ url: property.flyerUrl }).promise
      const page = await doc.getPage(1)
      const base = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: Math.min(2, 1200 / base.width) })
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(viewport.width)
      canvas.height = Math.round(viewport.height)
      const context = canvas.getContext('2d')
      if (!context) return null
      await page.render({ canvasContext: context, viewport, canvas }).promise
      blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
      await doc.cleanup().catch(() => undefined)
    } else {
      const response = await fetch(property.flyerUrl)
      if (!response.ok) return null
      blob = await response.blob()
    }
    if (!blob) return null

    const file = new File([blob], 'flyer-cover.jpg', { type: blob.type || 'image/jpeg' })
    const { property: updated } = await api.uploadPhoto(property.id, file)
    return updated
  } catch {
    // A failed thumbnail is a cosmetic miss, never an error worth surfacing.
    return null
  }
}
