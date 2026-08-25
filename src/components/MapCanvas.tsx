import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import type { Property, TileConfig } from '../types'
import { STAGE_META, displayName, fullAddress } from '../lib/format'

interface Props {
  tiles: TileConfig
  /** Basemaps the viewer may switch between. Omit to hide the switcher. */
  basemaps?: TileConfig[]
  properties: Property[]
  selectedId?: string | null
  onSelect?: (id: string) => void
  onMapClick?: (lat: number, lng: number) => void
  /** Reports where the map is looking, so a dropped flyer can land nearby. */
  onViewChange?: (center: { lat: number; lng: number }) => void
  /** When set, pins are numbered and joined in this order. */
  routeIds?: string[]
  /**
   * The routed path as [lat, lng] points. When present it is drawn instead of
   * joining the pins directly, so the line follows streets. Absent means
   * routing was unavailable and the straight join is the honest picture.
   */
  routeGeometry?: [number, number][] | null
  routeColor?: string
  /**
   * Census block groups shaded by a metric. Each entry carries its own colour,
   * already resolved, so the map does not need to know what is being shown.
   */
  choropleth?: { geoid: string; geometry: unknown; color: string | null }[] | null
  /** Rings drawn around a point, in miles. */
  rings?: { lat: number; lng: number; miles: number[] } | null
  /** Nearby businesses plotted as small secondary markers. */
  competitors?: { id: string; name: string; lat: number; lng: number; miles: number }[]
  /** Changing this refits the view to the current pins. */
  fitKey?: string | number
  className?: string
}

const FALLBACK_CENTER: [number, number] = [30.2672, -97.7431]

const HOME_STORAGE_KEY = 'sitesurvey.home'

/**
 * The broker's home market: wherever they last left the map.
 *
 * A survey with pins fits to them and never reaches this; an empty new survey
 * used to open on the hardcoded fallback, which is the wrong city for anyone
 * not in Austin. Remembering the last view means the second survey opens
 * where the broker actually works, with nothing to configure.
 */
function homeView(): { center: [number, number]; zoom: number } {
  try {
    const raw = window.localStorage.getItem(HOME_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (
        Number.isFinite(parsed?.lat) &&
        Number.isFinite(parsed?.lng) &&
        Number.isFinite(parsed?.zoom)
      ) {
        return { center: [parsed.lat, parsed.lng], zoom: parsed.zoom }
      }
    }
  } catch {
    // Blocked storage just means the fallback city.
  }
  return { center: FALLBACK_CENTER, zoom: 11 }
}

function rememberView(instance: L.Map) {
  try {
    const center = instance.getCenter()
    window.localStorage.setItem(
      HOME_STORAGE_KEY,
      JSON.stringify({ lat: center.lat, lng: center.lng, zoom: instance.getZoom() }),
    )
  } catch {
    // Nothing to do — the map still works, it just cannot remember.
  }
}

function pinIcon(property: Property, index: number | null, selected: boolean): L.DivIcon {
  const color = STAGE_META[property.stage]?.color ?? STAGE_META.prospect.color
  const label = index == null ? '' : String(index + 1)
  // A site hidden from the client link stays on the broker's map, dimmed —
  // visible enough to manage, distinct enough that its state is never a guess.
  const dimmed = property.hidden ? 'opacity:0.45;' : ''
  return L.divIcon({
    className: `site-pin${selected ? ' site-pin--selected' : ''}`,
    html: `<div class="site-pin__body" style="background:${color};${dimmed}"><span class="site-pin__label">${label}</span></div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 28],
    popupAnchor: [0, -26],
  })
}

const BASEMAP_STORAGE_KEY = 'sitesurvey.basemap'

/** Remembers the viewer's basemap choice across sessions. */
function storedBasemap(): string | null {
  try {
    return window.localStorage.getItem(BASEMAP_STORAGE_KEY)
  } catch {
    return null
  }
}

export default function MapCanvas({
  tiles,
  basemaps,
  properties,
  selectedId,
  onSelect,
  onMapClick,
  onViewChange,
  routeIds,
  routeGeometry,
  routeColor = '#14b8a6',
  choropleth = null,
  rings = null,
  competitors,
  fitKey,
  className = 'h-full w-full',
}: Props) {
  const container = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const tileLayer = useRef<L.TileLayer | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [activeId, setActiveId] = useState(() => storedBasemap() || tiles.provider)

  const options = basemaps && basemaps.length > 1 ? basemaps : null
  const active = options?.find((entry) => entry.provider === activeId) || tiles
  const markers = useRef<Map<string, L.Marker>>(new Map())
  const route = useRef<L.Polyline | null>(null)
  const shading = useRef<L.LayerGroup | null>(null)
  const ringLayer = useRef<L.LayerGroup | null>(null)
  const competitorLayer = useRef<L.LayerGroup | null>(null)
  const clickHandler = useRef(onMapClick)
  const selectHandler = useRef(onSelect)

  clickHandler.current = onMapClick
  selectHandler.current = onSelect

  // Create the map once; React never re-renders into this subtree.
  useEffect(() => {
    if (!container.current || map.current) return

    const home = homeView()
    const instance = L.map(container.current, { zoomControl: true, attributionControl: true }).setView(home.center, home.zoom)
    instance.on('click', (event: L.LeafletMouseEvent) => clickHandler.current?.(event.latlng.lat, event.latlng.lng))
    instance.on('moveend', () => rememberView(instance))
    map.current = instance

    // The container is often sized by a flex parent that settles after mount.
    const resize = new ResizeObserver(() => instance.invalidateSize())
    resize.observe(container.current)

    return () => {
      resize.disconnect()
      instance.remove()
      map.current = null
      tileLayer.current = null
      markers.current.clear()
    }
  }, [])

  // The basemap is its own layer so it can be swapped without tearing down the
  // map, which would drop every pin and reset the viewport.
  useEffect(() => {
    const instance = map.current
    if (!instance) return

    tileLayer.current?.remove()
    tileLayer.current = L.tileLayer(active.url, {
      attribution: active.attribution,
      maxZoom: active.maxZoom || 19,
      subdomains: active.url.includes('{s}') ? ['a', 'b', 'c'] : [],
      // Keep the basemap beneath the rings, routes and pins.
      zIndex: 1,
    }).addTo(instance)
  }, [active.url, active.attribution, active.maxZoom])

  // Sync pins with the property list.
  useEffect(() => {
    const instance = map.current
    if (!instance) return

    const order = routeIds ?? []
    const wanted = new Set<string>()

    for (const property of properties) {
      if (property.lat == null || property.lng == null) continue
      wanted.add(property.id)

      const position: [number, number] = [property.lat, property.lng]
      const routeIndex = order.indexOf(property.id)
      const icon = pinIcon(property, routeIndex >= 0 ? routeIndex : null, property.id === selectedId)

      let marker = markers.current.get(property.id)
      if (marker) {
        marker.setLatLng(position)
        marker.setIcon(icon)
      } else {
        marker = L.marker(position, { icon, title: displayName(property) }).addTo(instance)
        marker.on('click', () => selectHandler.current?.(property.id))
        markers.current.set(property.id, marker)
      }

      marker.bindTooltip(
        `<strong>${displayName(property)}</strong><br>${fullAddress(property)}`,
        { direction: 'top', offset: [0, -24], className: 'site-tooltip' },
      )
    }

    for (const [id, marker] of markers.current) {
      if (!wanted.has(id)) {
        marker.remove()
        markers.current.delete(id)
      }
    }
  }, [properties, selectedId, routeIds])

  useEffect(() => {
    const instance = map.current
    if (!instance || !onViewChange) return undefined

    const report = () => {
      const center = instance.getCenter()
      onViewChange({ lat: center.lat, lng: center.lng })
    }
    instance.on('moveend', report)
    report()
    return () => {
      instance.off('moveend', report)
    }
  }, [onViewChange])

  // Draw the tour line.
  useEffect(() => {
    const instance = map.current
    if (!instance) return

    route.current?.remove()
    route.current = null
    if (!routeIds || routeIds.length < 2) return

    // A real routed path is solid, because it is what the drive looks like.
    // The pin-to-pin fallback stays dashed, so an estimate never reads as a
    // road that exists.
    const routed = routeGeometry && routeGeometry.length >= 2
    const points = routed
      ? routeGeometry
      : routeIds
          .map((id) => properties.find((property) => property.id === id))
          .filter((property): property is Property => Boolean(property?.lat && property?.lng))
          .map((property) => [property.lat as number, property.lng as number] as [number, number])

    if (points.length >= 2) {
      route.current = L.polyline(points, {
        color: routeColor,
        weight: routed ? 5 : 4,
        opacity: 0.9,
        dashArray: routed ? undefined : '8 8',
      }).addTo(instance)
    }
  }, [routeIds, routeGeometry, properties, routeColor])

  // Shade census block groups by whichever metric is selected.
  useEffect(() => {
    const instance = map.current
    if (!instance) return

    shading.current?.remove()
    shading.current = null
    if (!choropleth || choropleth.length === 0) return

    const group = L.layerGroup()
    for (const area of choropleth) {
      if (!area.geometry || !area.color) continue
      L.geoJSON(area.geometry as never, {
        style: {
          color: area.color,
          weight: 1,
          opacity: 0.6,
          fillColor: area.color,
          // Kept translucent so the streets underneath stay legible — the
          // shading is context for the map, not a replacement for it.
          fillOpacity: 0.45,
        },
        interactive: false,
      }).addTo(group)
    }
    group.addTo(instance)
    // Behind the pins and the route, which must stay readable on top of it.
    group.eachLayer((layer) => {
      if ('bringToBack' in layer) (layer as L.Polygon).bringToBack()
    })
    shading.current = group
  }, [choropleth])

  // Radius rings around the site being scoped.
  useEffect(() => {
    const instance = map.current
    if (!instance) return

    ringLayer.current?.remove()
    ringLayer.current = null
    if (!rings || rings.miles.length === 0) return

    const group = L.layerGroup()
    // Largest first so the smaller rings draw on top of the bigger fills.
    for (const miles of [...rings.miles].sort((a, b) => b - a)) {
      L.circle([rings.lat, rings.lng], {
        radius: miles * 1609.34,
        color: '#0f766e',
        weight: 1.6,
        opacity: 0.75,
        fillColor: '#14b8a6',
        fillOpacity: 0.06,
        dashArray: '5 6',
        interactive: false,
      })
        .bindTooltip(`${miles} mile${miles === 1 ? '' : 's'}`, { permanent: false, direction: 'top' })
        .addTo(group)
    }
    group.addTo(instance)
    ringLayer.current = group
  }, [rings])

  // Nearby businesses, drawn smaller than the survey's own pins.
  useEffect(() => {
    const instance = map.current
    if (!instance) return

    competitorLayer.current?.remove()
    competitorLayer.current = null
    if (!competitors || competitors.length === 0) return

    const group = L.layerGroup()
    for (const business of competitors) {
      L.circleMarker([business.lat, business.lng], {
        radius: 5,
        color: '#0f172a',
        weight: 1.5,
        fillColor: '#f97316',
        fillOpacity: 0.95,
      })
        .bindTooltip(`<strong>${business.name}</strong><br>${business.miles} mi away`, { direction: 'top' })
        .addTo(group)
    }
    group.addTo(instance)
    competitorLayer.current = group
  }, [competitors])

  // Fit the view to the pins when the caller asks.
  useEffect(() => {
    const instance = map.current
    if (!instance) return

    const points = properties
      .filter((property) => property.lat != null && property.lng != null)
      .map((property) => [property.lat as number, property.lng as number] as [number, number])

    if (points.length === 0) return
    // Without animation on purpose: the selected-pin effect below reads
    // getBounds() right after this, and an animated fit reports the old view
    // mid-flight — so the pan "correcting" the selection undid the fit and
    // slid every other pin off the screen.
    if (points.length === 1) {
      instance.setView(points[0], 14, { animate: false })
      return
    }
    instance.fitBounds(L.latLngBounds(points), { padding: [48, 48], maxZoom: 15, animate: false })
  }, [fitKey])

  // Keep the selected pin in view when it is chosen from a list.
  useEffect(() => {
    const instance = map.current
    if (!instance || !selectedId) return
    const property = properties.find((entry) => entry.id === selectedId)
    if (property?.lat == null || property?.lng == null) return

    // Only move when it is actually out of view. Adding a site both fits the
    // map to every pin and selects the new one; recentring on the selection
    // after that fit slid the other pins off the screen — which read as
    // "my points don't all show on the map".
    const target = L.latLng(property.lat, property.lng)
    if (instance.getBounds().pad(-0.05).contains(target)) return
    instance.panTo(target, { animate: true })
  }, [selectedId])

  const chooseBasemap = (id: string) => {
    setActiveId(id)
    setPickerOpen(false)
    try {
      window.localStorage.setItem(BASEMAP_STORAGE_KEY, id)
    } catch {
      /* a viewer with storage disabled just loses the preference */
    }
  }

  return (
    <div className={`relative h-full w-full ${active.darkNative ? 'map-dark' : ''}`}>
      <div ref={container} className={className} role="application" aria-label="Property map" />

      {options && (
        <div className="absolute right-3 top-3 z-[500]">
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-lg border border-line bg-surface/90 px-2.5 py-1.5 text-xs font-medium text-ink shadow-lg backdrop-blur hover:border-muted"
            aria-expanded={pickerOpen}
            aria-label="Change basemap"
            onClick={() => setPickerOpen((open) => !open)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <path d="m12 3 9 5-9 5-9-5 9-5ZM3 13l9 5 9-5M3 17l9 5 9-5" />
            </svg>
            {active.label || 'Basemap'}
          </button>

          {pickerOpen && (
            <ul className="animate-fade-in mt-1 w-48 overflow-hidden rounded-lg border border-line bg-surface/95 shadow-xl backdrop-blur">
              {options.map((option) => (
                <li key={option.provider}>
                  <button
                    type="button"
                    className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs hover:bg-sunken ${
                      option.provider === active.provider ? 'text-brand' : 'text-body'
                    }`}
                    onClick={() => chooseBasemap(option.provider)}
                  >
                    {option.label || option.provider}
                    {option.provider === active.provider && <span aria-hidden>✓</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
