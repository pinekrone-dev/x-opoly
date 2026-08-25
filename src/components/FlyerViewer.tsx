import { useCallback, useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import { api } from '../api'
import type { Property, PropertyImage } from '../types'

/**
 * Renders a flyer and lets the broker cut photographs out of it.
 *
 * The pictures a tour book needs are already in the PDF — the elevation, the
 * site plan, the aerial. Asking someone to screenshot and crop those by hand
 * is the kind of chore this tool exists to remove, so instead the page renders
 * to a canvas and a dragged box becomes a stored image.
 *
 * The page is rasterised at twice the display size so a crop taken from a
 * small region is still sharp enough to print.
 */

// Bundled rather than fetched from a CDN, so the viewer works offline and is
// not subject to someone else's uptime.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).href

/** Rasterisation factor over the displayed size, for crop sharpness. */
const QUALITY = 2

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Below this a drag is a mis-click, not a selection. */
const MIN_SELECTION = 12

export default function FlyerViewer({
  property,
  onChange,
}: {
  property: Property
  onChange?: (property: Property) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const documentRef = useRef<pdfjs.PDFDocumentProxy | null>(null)
  const renderTask = useRef<pdfjs.RenderTask | null>(null)

  const [ready, setReady] = useState(false)
  const [width, setWidth] = useState(0)
  const [pageCount, setPageCount] = useState(0)
  const [page, setPage] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selection, setSelection] = useState<Rect | null>(null)
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [images, setImages] = useState<PropertyImage[]>(property.images ?? [])

  useEffect(() => setImages(property.images ?? []), [property.images])

  // Open the document once per flyer.
  useEffect(() => {
    if (!property.flyerUrl) {
      setLoading(false)
      return undefined
    }

    let cancelled = false
    setLoading(true)
    setError(null)

    const task = pdfjs.getDocument({ url: property.flyerUrl })
    task.promise
      .then((document) => {
        // The loading task's own destroy() in the cleanup below tears the
        // document down; there is nothing extra to release here.
        if (cancelled) return
        documentRef.current = document
        setPageCount(document.numPages)
        setPage(1)
        setReady(true)
        setLoading(false)
      })
      .catch((cause: Error) => {
        if (cancelled) return
        setLoading(false)
        // A flyer that is not a PDF at all is a normal case, not a crash:
        // brokers attach JPEGs too.
        setError(
          /invalid|password|structure/i.test(cause.message)
            ? 'That file could not be read as a PDF.'
            : `The flyer could not be loaded (${cause.message}).`,
        )
      })

    return () => {
      cancelled = true
      void task.destroy()
      documentRef.current = null
      setReady(false)
    }
  }, [property.flyerUrl])

  /*
   * Watch the container, and redraw when it changes size.
   *
   * Without this the page was rasterised once, at whatever width the container
   * happened to be on the first pass — which in the clipping dialog was before
   * layout had settled, so it fell back to a hardcoded 600 and rendered at
   * 300 CSS pixels inside a full-screen window. It also means the page now
   * reflows when the window is resized, which it never did.
   */
  useEffect(() => {
    const element = wrapRef.current
    if (!element || typeof ResizeObserver === 'undefined') return undefined

    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width ?? 0)
      // Ignore sub-pixel jitter, which would otherwise redraw continuously.
      setWidth((current) => (Math.abs(current - next) > 8 ? next : current))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Draw the current page whenever it or the zoom changes.
  const draw = useCallback(async () => {
    const document = documentRef.current
    const canvas = canvasRef.current
    if (!document || !canvas) return

    // Cancelling matters: paging quickly otherwise leaves two renders racing
    // for the same canvas, and the slower one wins.
    renderTask.current?.cancel()

    const pdfPage = await document.getPage(page)
    // `?? 600` was wrong twice over: it only catches null, so a container
    // measured at 0 produced a zero-width canvas, and a null ref produced a
    // 600pt page regardless of how much room there actually was.
    const measured = wrapRef.current?.clientWidth || width
    const available = measured > 0 ? measured - 24 : 600
    const unscaled = pdfPage.getViewport({ scale: 1 })
    const fitScale = (available / unscaled.width) * zoom
    const viewport = pdfPage.getViewport({ scale: fitScale * QUALITY })

    canvas.width = viewport.width
    canvas.height = viewport.height
    canvas.style.width = `${viewport.width / QUALITY}px`
    canvas.style.height = `${viewport.height / QUALITY}px`

    const context = canvas.getContext('2d')
    if (!context) return

    const task = pdfPage.render({ canvasContext: context, viewport, canvas })
    renderTask.current = task
    try {
      await task.promise
    } catch (cause) {
      // A cancelled render is the expected outcome of paging, not an error.
      if ((cause as Error)?.name !== 'RenderingCancelledException') {
        setError(`That page could not be rendered (${(cause as Error).message}).`)
      }
    }
  }, [page, zoom, ready, width])

  useEffect(() => {
    void draw()
    setSelection(null)
  }, [draw])

  /** Pointer position in CSS pixels relative to the canvas. */
  const pointIn = (event: React.PointerEvent) => {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const bounds = canvas.getBoundingClientRect()
    return {
      x: Math.min(Math.max(0, event.clientX - bounds.left), bounds.width),
      y: Math.min(Math.max(0, event.clientY - bounds.top), bounds.height),
    }
  }

  const onPointerDown = (event: React.PointerEvent) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = pointIn(event)
    setDragStart(point)
    setSelection({ x: point.x, y: point.y, width: 0, height: 0 })
  }

  const onPointerMove = (event: React.PointerEvent) => {
    if (!dragStart) return
    const point = pointIn(event)
    setSelection({
      x: Math.min(dragStart.x, point.x),
      y: Math.min(dragStart.y, point.y),
      width: Math.abs(point.x - dragStart.x),
      height: Math.abs(point.y - dragStart.y),
    })
  }

  const onPointerUp = () => {
    setDragStart(null)
    setSelection((current) => {
      if (!current) return null
      // Treat a click as clearing the selection rather than making a 1px one.
      return current.width < MIN_SELECTION || current.height < MIN_SELECTION ? null : current
    })
  }

  /** Cuts the selected region out of the rendered page and stores it. */
  const capture = async () => {
    const canvas = canvasRef.current
    if (!canvas || !selection) return

    setCapturing(true)
    setError(null)
    try {
      // Selection is in CSS pixels; the canvas holds QUALITY times as many.
      const ratio = canvas.width / (canvas.clientWidth || canvas.width)
      const sx = Math.round(selection.x * ratio)
      const sy = Math.round(selection.y * ratio)
      const sw = Math.round(selection.width * ratio)
      const sh = Math.round(selection.height * ratio)

      const crop = document.createElement('canvas')
      crop.width = sw
      crop.height = sh
      const context = crop.getContext('2d')
      if (!context) throw new Error('This browser could not create the image.')
      context.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh)

      const blob = await new Promise<Blob | null>((resolve) => crop.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('The crop could not be encoded.')

      const { property: updated, image } = await api.addImage(property.id, blob, {
        caption: `Flyer page ${page}`,
        source: 'flyer-crop',
      })
      setImages((current) => [...current, image])
      onChange?.(updated)
      setSelection(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That region could not be captured.')
    } finally {
      setCapturing(false)
    }
  }

  const removeImage = async (imageId: string) => {
    await api.deleteImage(imageId)
    setImages((current) => current.filter((image) => image.id !== imageId))
    onChange?.({
      ...property,
      images: images.filter((image) => image.id !== imageId),
      coverImageId: property.coverImageId === imageId ? null : property.coverImageId,
    })
  }

  const setCover = async (imageId: string) => {
    const { property: updated } = await api.updateProperty(property.id, { coverImageId: imageId })
    onChange?.(updated)
  }

  if (!property.flyerUrl) {
    return (
      <p className="p-4 text-xs text-muted">
        No flyer on this site yet. Upload one and its pages render here, ready to cut photos out of.
      </p>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <button
          type="button"
          className="btn-secondary px-2 py-1 text-xs"
          disabled={page <= 1}
          onClick={() => setPage((current) => Math.max(1, current - 1))}
        >
          Prev
        </button>
        <span className="text-xs text-muted">
          Page {page}
          {pageCount ? ` of ${pageCount}` : ''}
        </span>
        <button
          type="button"
          className="btn-secondary px-2 py-1 text-xs"
          disabled={page >= pageCount}
          onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
        >
          Next
        </button>

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className="btn-secondary px-2 py-1 text-xs"
            onClick={() => setZoom((current) => Math.max(0.5, Math.round((current - 0.25) * 100) / 100))}
            aria-label="Zoom out"
          >
            −
          </button>
          <span className="w-12 text-center text-xs text-muted">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            className="btn-secondary px-2 py-1 text-xs"
            onClick={() => setZoom((current) => Math.min(4, Math.round((current + 0.25) * 100) / 100))}
            aria-label="Zoom in"
          >
            +
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 border-b border-line bg-sunken px-3 py-2">
        <p className="text-xs text-muted">
          {selection
            ? `${Math.round(selection.width)} × ${Math.round(selection.height)} selected`
            : 'Drag a box over the page to cut out a photo.'}
        </p>
        <button
          type="button"
          className="btn-primary ml-auto px-2 py-1 text-xs"
          disabled={!selection || capturing}
          onClick={() => void capture()}
        >
          {capturing ? 'Capturing…' : 'Capture selection'}
        </button>
        {selection ? (
          <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => setSelection(null)}>
            Clear
          </button>
        ) : null}
      </div>

      {error ? <p className="px-3 py-2 text-xs text-rose-400">{error}</p> : null}
      {loading ? <p className="px-3 py-2 text-xs text-muted">Loading the flyer…</p> : null}

      <div ref={wrapRef} className="flex-1 overflow-auto p-3">
        <div className="relative inline-block">
          <canvas
            ref={canvasRef}
            className="max-w-none cursor-crosshair rounded-md bg-white shadow-lg"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            aria-label="Flyer page"
          />
          {selection ? (
            <div
              className="pointer-events-none absolute border-2 border-brand bg-brand/20"
              style={{
                left: selection.x,
                top: selection.y,
                width: selection.width,
                height: selection.height,
              }}
              aria-hidden
            />
          ) : null}
        </div>
      </div>

      {images.length > 0 ? (
        <div className="border-t border-line p-3">
          <h4 className="label">Captured photos ({images.length})</h4>
          <ul className="mt-2 grid grid-cols-3 gap-2">
            {images.map((image) => (
              <li key={image.id} className="group relative">
                <img
                  src={image.url}
                  alt={image.caption ?? 'Captured from the flyer'}
                  className={`h-20 w-full rounded-md object-cover ${
                    property.coverImageId === image.id ? 'ring-2 ring-brand' : ''
                  }`}
                />
                <div className="absolute inset-x-0 bottom-0 flex justify-between gap-1 rounded-b-md bg-surface/80 px-1 py-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    type="button"
                    className="text-[10px] text-body hover:text-brand-deep"
                    onClick={() => void setCover(image.id)}
                  >
                    Cover
                  </button>
                  <button
                    type="button"
                    className="text-[10px] text-body hover:text-rose-400"
                    onClick={() => void removeImage(image.id)}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
