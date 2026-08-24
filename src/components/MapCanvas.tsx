import { useEffect, useRef } from 'react'
import L from 'leaflet'
import type { Property, TileConfig } from '../types'
import { STAGE_META, displayName, fullAddress } from '../lib/format'

interface Props {
  tiles: TileConfig
  properties: Property[]
  selectedId?: string | null
  onSelect?: (id: string) => void
  onMapClick?: (lat: number, lng: number) => void
  /** When set, pins are numbered and joined in this order. */
  routeIds?: string[]
  routeColor?: string
  /** Rings drawn around a point, in miles. */
  rings?: { lat: number; lng: number; miles: number[] } | null
  /** Nearby businesses plotted as small secondary markers. */
  competitors?: { id: string; name: string; lat: number; lng: number; miles: number }[]
  /** Changing this refits the view to the current pins. */
  fitKey?: string | number
  className?: string
}

const FALLBACK_CENTER: [number, number] = [30.2672, -97.7431]

function pinIcon(property: Property, index: number | null, selected: boolean): L.DivIcon {
  const color = STAGE_META[property.stage]?.color ?? STAGE_META.prospect.color
  const label = index == null ? '' : String(index + 1)
  return L.divIcon({
    className: `site-pin${selected ? ' site-pin--selected' : ''}`,
    html: `<div class="site-pin__body" style="background:${color}"><span class="site-pin__label">${label}</span></div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 28],
    popupAnchor: [0, -26],
  })
}

export default function MapCanvas({
  tiles,
  properties,
  selectedId,
  onSelect,
  onMapClick,
  routeIds,
  routeColor = '#14b8a6',
  rings = null,
  competitors,
  fitKey,
  className = 'h-full w-full',
}: Props) {
  const container = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const markers = useRef<Map<string, L.Marker>>(new Map())
  const route = useRef<L.Polyline | null>(null)
  const ringLayer = useRef<L.LayerGroup | null>(null)
  const competitorLayer = useRef<L.LayerGroup | null>(null)
  const clickHandler = useRef(onMapClick)
  const selectHandler = useRef(onSelect)

  clickHandler.current = onMapClick
  selectHandler.current = onSelect

  // Create the map once; React never re-renders into this subtree.
  useEffect(() => {
    if (!container.current || map.current) return

    const instance = L.map(container.current, { zoomControl: true, attributionControl: true }).setView(FALLBACK_CENTER, 11)
    L.tileLayer(tiles.url, {
      attribution: tiles.attribution,
      maxZoom: tiles.maxZoom || 19,
      // Light basemaps are inverted by CSS to sit in a dark UI; a basemap that
      // is already dark must be left alone or it comes back out white.
      className: tiles.darkNative ? 'tile-native-dark' : '',
      subdomains: tiles.url.includes('{s}') ? ['a', 'b', 'c'] : [],
    }).addTo(instance)
    instance.on('click', (event: L.LeafletMouseEvent) => clickHandler.current?.(event.latlng.lat, event.latlng.lng))
    map.current = instance

    // The container is often sized by a flex parent that settles after mount.
    const resize = new ResizeObserver(() => instance.invalidateSize())
    resize.observe(container.current)

    return () => {
      resize.disconnect()
      instance.remove()
      map.current = null
      markers.current.clear()
    }
  }, [tiles.url, tiles.attribution, tiles.maxZoom, tiles.darkNative])

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

  // Draw the tour line.
  useEffect(() => {
    const instance = map.current
    if (!instance) return

    route.current?.remove()
    route.current = null
    if (!routeIds || routeIds.length < 2) return

    const points = routeIds
      .map((id) => properties.find((property) => property.id === id))
      .filter((property): property is Property => Boolean(property?.lat && property?.lng))
      .map((property) => [property.lat as number, property.lng as number] as [number, number])

    if (points.length >= 2) {
      route.current = L.polyline(points, { color: routeColor, weight: 3, opacity: 0.85, dashArray: '7 7' }).addTo(instance)
    }
  }, [routeIds, properties, routeColor])

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
        color: '#14b8a6',
        weight: 1.2,
        opacity: 0.55,
        fillColor: '#14b8a6',
        fillOpacity: 0.05,
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
    if (points.length === 1) {
      instance.setView(points[0], 14)
      return
    }
    instance.fitBounds(L.latLngBounds(points), { padding: [48, 48], maxZoom: 15 })
  }, [fitKey])

  // Keep the selected pin in view when it is chosen from a list.
  useEffect(() => {
    const instance = map.current
    if (!instance || !selectedId) return
    const property = properties.find((entry) => entry.id === selectedId)
    if (property?.lat == null || property?.lng == null) return
    instance.panTo([property.lat, property.lng], { animate: true })
  }, [selectedId])

  return <div ref={container} className={className} role="application" aria-label="Property map" />
}
