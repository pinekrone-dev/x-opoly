/**
 * The map that works when the GPU does not.
 *
 * MapLibre draws everything — basemap included — through one WebGL canvas, so
 * on a machine where WebGL is missing, disabled, or broken by a driver, the
 * whole map is dark: no streets, no parcels, both tabs at once. That failure
 * belongs to the machine, not the person, and "works for everyone" means it
 * cannot be allowed to matter.
 *
 * This tier asks nothing of the machine. Leaflet places raster basemap tiles
 * as plain <img> elements and draws vectors with Canvas 2D, which every
 * browser has. Parcels arrive from the server one tile at a time as GeoJSON —
 * the server holds the archive, seeks the tile, and unpacks the protobuf, so
 * the weak machine receives coordinates it can draw with no decoding at all.
 *
 * Deliberately less than the full map: no choropleths, no extra layers, no
 * routes. It says so, visibly, rather than looking like a broken version of
 * the other one. The panel, the search, and the filters are untouched because
 * they were always server-driven — this tier costs one map component, not a
 * second application.
 */
import { useEffect, useRef } from 'react'

import type { Property, TileConfig } from '../types'

/** Zooms the parcel archive actually holds; asking outside it invents 404s. */
const LITE_PARCEL_MIN = 13
const LITE_PARCEL_DEEPEST = 16
/** Tiles fetched per view, at most. A screen is 6–12 tiles; runaway is a bug. */
const TILES_PER_VIEW = 16

const tileX = (lng: number, z: number) => Math.floor(((lng + 180) / 360) * 2 ** z)
const tileY = (lat: number, z: number) => {
  const rad = (lat * Math.PI) / 180
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z)
}

export default function LiteMap({
  tiles,
  properties = [],
  stages,
  view,
  parcelsUrl = null,
  selectedParcelId = null,
  onSelect,
  onSelectParcel,
  onViewChange,
  onExit,
}: {
  tiles: TileConfig
  properties?: Property[]
  stages?: { id: string; color: string }[]
  view?: { center: [number, number]; zoom: number; key: string | number } | null
  parcelsUrl?: string | null
  selectedParcelId?: string | number | null
  onSelect?: (id: string) => void
  onSelectParcel?: (id: string | number) => void
  onViewChange?: (view: { lat: number; lng: number; zoom: number }) => void
  onExit?: () => void
}) {
  const container = useRef<HTMLDivElement | null>(null)
  // Leaflet's namespace and the live map, held loosely: the library arrives
  // by dynamic import so the WebGL path never pays for it.
  const leaflet = useRef<typeof import('leaflet') | null>(null)
  const map = useRef<import('leaflet').Map | null>(null)
  const parcelPane = useRef<import('leaflet').GeoJSON | null>(null)
  const pins = useRef<import('leaflet').Layer[]>([])
  const fetched = useRef<Map<string, GeoJSON.Feature[]>>(new Map())
  const loading = useRef(false)
  const selectRef = useRef(onSelectParcel)
  selectRef.current = onSelectParcel
  const selectedRef = useRef(selectedParcelId)
  selectedRef.current = selectedParcelId

  /* The map itself, built once. */
  useEffect(() => {
    let gone = false
    ;(async () => {
      const L = await import('leaflet')
      await import('leaflet/dist/leaflet.css')
      if (gone || !container.current) return
      leaflet.current = L

      const instance = L.map(container.current, {
        center: view ? [view.center[1], view.center[0]] : [39, -96],
        zoom: view?.zoom ?? 4,
        zoomControl: true,
        // Canvas 2D for every vector. This is the point of the tier.
        preferCanvas: true,
      })
      L.tileLayer(tiles.url, {
        maxZoom: tiles.maxZoom || 19,
        attribution: tiles.attribution,
      }).addTo(instance)
      map.current = instance

      instance.on('moveend', () => {
        const centre = instance.getCenter()
        onViewChange?.({ lat: centre.lat, lng: centre.lng, zoom: instance.getZoom() })
        void refreshParcels()
      })
      void refreshParcels()
    })()
    return () => {
      gone = true
      map.current?.remove()
      map.current = null
    }
    // Built once; later view changes arrive through the view effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /*
   * The parcels under the current view, one server-decoded tile at a time.
   *
   * Tiles already seen are kept for the session — panning back over a block
   * costs nothing — and the layer is redrawn whole from the visible set,
   * which at these zooms is a few thousand small polygons: comfortably
   * inside what Canvas 2D draws in a frame.
   */
  async function refreshParcels() {
    const L = leaflet.current
    const instance = map.current
    if (!L || !instance || !parcelsUrl) return
    const zoom = Math.floor(instance.getZoom())
    if (zoom < LITE_PARCEL_MIN) {
      parcelPane.current?.remove()
      parcelPane.current = null
      return
    }
    if (loading.current) return
    loading.current = true
    try {
      const base = parcelsUrl.replace(/parcels\.pmtiles$/, 'lite')
      const z = Math.min(zoom, LITE_PARCEL_DEEPEST)
      const bounds = instance.getBounds()
      const x0 = tileX(bounds.getWest(), z)
      const x1 = tileX(bounds.getEast(), z)
      const y0 = tileY(bounds.getNorth(), z)
      const y1 = tileY(bounds.getSouth(), z)
      const wanted: [number, number][] = []
      for (let x = x0; x <= x1 && wanted.length < TILES_PER_VIEW; x += 1) {
        for (let y = y0; y <= y1 && wanted.length < TILES_PER_VIEW; y += 1) wanted.push([x, y])
      }
      await Promise.all(
        wanted.map(async ([x, y]) => {
          const at = `${z}/${x}/${y}`
          if (fetched.current.has(at)) return
          try {
            const res = await fetch(`${base}/${at}.json`)
            if (!res.ok) throw new Error(String(res.status))
            const doc = (await res.json()) as GeoJSON.FeatureCollection
            fetched.current.set(at, doc.features ?? [])
          } catch {
            // One missing tile is a hole, not a failure; the next pan retries.
          }
        }),
      )

      const visible: GeoJSON.Feature[] = []
      for (const [x, y] of wanted) visible.push(...(fetched.current.get(`${z}/${x}/${y}`) ?? []))

      parcelPane.current?.remove()
      parcelPane.current = L.geoJSON(
        { type: 'FeatureCollection', features: visible } as GeoJSON.FeatureCollection,
        {
          style: (feature) => {
            const id = (feature?.id ?? feature?.properties?.id) as string | number | undefined
            const picked = id != null && String(id) === String(selectedRef.current ?? '')
            return {
              color: picked ? '#0d9488' : '#0f172a',
              weight: picked ? 2.5 : 0.8,
              opacity: 0.85,
              fillColor: picked ? '#14b8a6' : '#0f172a',
              fillOpacity: picked ? 0.25 : 0.04,
            }
          },
          onEachFeature: (feature, layer) => {
            layer.on('click', () => {
              const id = (feature.id ?? feature.properties?.id) as string | number | undefined
              if (id != null) selectRef.current?.(id)
            })
          },
        },
      ).addTo(instance)
    } finally {
      loading.current = false
    }
  }

  /* A changed selection restyles what is already drawn. */
  useEffect(() => {
    void refreshParcels()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedParcelId])

  /* The caller's view — a chosen market, a picked record — moves the camera. */
  useEffect(() => {
    if (map.current && view) map.current.setView([view.center[1], view.center[0]], view.zoom)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.key])

  /* The survey's pins, plain circle markers with the stage's own colour. */
  useEffect(() => {
    const L = leaflet.current
    const instance = map.current
    if (!L || !instance) return
    for (const pin of pins.current) pin.remove()
    pins.current = []
    const colours = new Map((stages ?? []).map((s) => [s.id, s.color]))
    for (const property of properties) {
      if (property.lat == null || property.lng == null) continue
      const marker = L.circleMarker([property.lat, property.lng], {
        radius: 8,
        color: '#ffffff',
        weight: 2,
        fillColor: colours.get(String(property.stage ?? '')) ?? '#0d9488',
        fillOpacity: 1,
      })
        .addTo(instance)
        .bindTooltip(property.name || property.address || '')
      marker.on('click', () => onSelect?.(property.id))
      pins.current.push(marker)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [properties, stages, leaflet.current])

  return (
    <div className="relative h-full w-full">
      <div ref={container} className="h-full w-full" aria-label="Property map (basic)" role="application" />
      <div className="pointer-events-none absolute inset-x-0 bottom-2 z-[700] flex justify-center">
        <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-line bg-surface/95 px-3 py-1.5 text-[11px] text-body shadow-sm">
          <span>
            Basic map — runs without graphics acceleration.
            {parcelsUrl ? ' Zoom in to see parcels; some overlays are hidden.' : ''}
          </span>
          {onExit ? (
            <button type="button" className="font-medium text-ink underline" onClick={onExit}>
              Try the full map
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
