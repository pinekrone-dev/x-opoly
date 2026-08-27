import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import { Protocol } from 'pmtiles'
import type { Property, TileConfig } from '../types'
import { STAGE_META, displayName, fullAddress } from '../lib/format'
import { METERS_PER_MILE, circlePolygon, tileUrls } from '../lib/geo'
import { pickBasemap, readStoredBasemap, writeStoredBasemap } from '../lib/basemap'

/*
 * The map engine.
 *
 * This was Leaflet. It is MapLibre because the GIS layer draws county parcel
 * data — tens of thousands of polygons in a view — and Leaflet puts every
 * shape in the DOM, which stops being viable in the low thousands. MapLibre
 * draws on the GPU from vector tiles, so the same component carries a survey's
 * dozen pins and a county's sixty thousand parcels.
 *
 * The props are unchanged from the Leaflet version on purpose: they never
 * named a map library, so SurveyWorkspace, ShareView and TourBook did not have
 * to be touched. Behaviour is ported as it was, deliberately including the
 * hover tooltips, so that a porting bug and an intended change can be told
 * apart. Click-to-open is a separate commit.
 */

/*
 * pmtiles:// URLs, resolved by range request against a single file on R2.
 * Registered once for the whole process rather than per map, because the
 * protocol table is global and adding it twice throws.
 */
let pmtilesReady = false
function registerPmtiles() {
  if (pmtilesReady) return
  maplibregl.addProtocol('pmtiles', new Protocol().tile)
  pmtilesReady = true
}

const PARCEL_SOURCE = 'parcels'
const BASEMAP_SOURCE = 'basemap'
const BASEMAP_LAYER = 'basemap'

/*
 * Draw order, bottom to top. Leaflet expressed this with panes and z-indexes
 * and still had ties it could not settle — zones and census shading both asked
 * to be at the back, and whichever effect ran last won. Here the order is a
 * list: a layer is always inserted before the first one below it that exists,
 * so the result does not depend on which effect happened to run.
 */
const OVERLAY_ORDER = [
  // Census shading is context and goes underneath everything, including the
  // parcels: it answers "what kind of area is this", and a translucent wash
  // drawn over the lot lines turns the thing being looked at into background.
  'shading-fill',
  'shading-line',
  // Parcels next. They are the ground a survey happens on, so they sit below
  // the tour line, the zones and the pins, and above the area shading.
  'parcel-fill',
  'parcel-line',
  'zone-fill',
  'zone-line',
  'ring-fill',
  'ring-line',
  'route-line',
  'competitor-circle',
] as const

/**
 * A county parcel layer, served as vector tiles from one .pmtiles file.
 *
 * Deliberately not a list of features: a market is tens of thousands of
 * parcels and the browser only ever loads the tiles under the viewport. The
 * attributes needed to draw — the land-use bucket and the value — travel in
 * the tiles; everything else about a parcel is looked up by id when one is
 * clicked, which is why `onSelectParcel` hands back an id and nothing more.
 */
export interface ParcelLayer {
  /** Absolute URL of the .pmtiles file. */
  url: string
  /** The layer name inside the tiles. */
  sourceLayer?: string
  /** Land use where the county publishes it, assessed value where it does not. */
  colorBy?: 'group' | 'value'
  /** Step breaks for the value ramp, low to high. */
  valueBreaks?: number[] | null
  selectedParcelId?: number | string | null
  onSelectParcel?: (id: number | string) => void
  /**
   * Show only these parcels. Null means all of them.
   *
   * An id list rather than an attribute test because the tiles carry only what
   * the style reads — the bucket and the value — while a filter is built from
   * the whole record: owner, asset type, acreage. The list is resolved against
   * the attribute index and handed here already decided.
   */
  filterIds?: (number | string)[] | null
  /** Fill opacity for an unselected parcel. */
  opacity?: number
}

/** Land-use buckets, in the same colours the parcel map uses. */
const PARCEL_COLORS: [string, string][] = [
  ['Commercial', '#2a78d6'],
  ['Multifamily', '#eb6834'],
  ['Vacant land', '#1baf7a'],
  ['Single family', '#9AA1B4'],
]
const PARCEL_OTHER = '#5C6377'

/** One hue, light to dark. A value is a magnitude, never a set of categories. */
const VALUE_RAMP = ['#EDE7FA', '#D6C6F3', '#BBA0EA', '#9D77DD', '#7F4FCB', '#6031AE', '#43208A']

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
  /** The survey's pipeline, for pin colours that match the sidebar. */
  stages?: { id: string; color: string }[]
  /** Tour start and end, drawn as their own flags — a tour begins at the
   * office, and an invisible start point looks like a geocode that failed. */
  anchors?: { start?: { lat: number; lng: number; label?: string } | null; end?: { lat: number; lng: number; label?: string } | null } | null
  /** Labelled radius circles — non-competes, boundaries. */
  zones?: { id: string; label: string; lat: number; lng: number; radiusMiles: number; color: string }[] | null
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
  choropleth?: { geoid: string; geometry: unknown; color: string | null; info?: string | null }[] | null
  /** Rings drawn around a point, in miles. */
  rings?: { lat: number; lng: number; miles: number[] } | null
  /** Nearby businesses plotted as small secondary markers. */
  competitors?: { id: string; name: string; lat: number; lng: number; miles: number }[]
  /** Changing this refits the view to the current pins. */
  fitKey?: string | number
  /**
   * Jump somewhere specific. Used where there are no pins to fit to — the
   * parcel map opens on the market's own centre, not on wherever the broker
   * last left a survey.
   */
  view?: { center: [number, number]; zoom: number; key: string | number } | null
  /** Show each site's name beside its pin, always — the client share map. */
  labelPins?: boolean
  /** County parcels underneath everything else. */
  parcels?: ParcelLayer | null
  className?: string
}

/** MapLibre takes [lng, lat]; everything above this line speaks [lat, lng]. */
type LngLat = [number, number]

const FALLBACK_CENTER: LngLat = [-97.7431, 30.2672]

const HOME_STORAGE_KEY = 'sitesurvey.home'
const BASEMAP_STORAGE_KEY = 'sitesurvey.basemap'

/**
 * The broker's home market: wherever they last left the map.
 *
 * A survey with pins fits to them and never reaches this; an empty new survey
 * used to open on the hardcoded fallback, which is the wrong city for anyone
 * not in Austin. Remembering the last view means the second survey opens
 * where the broker actually works, with nothing to configure.
 */
function homeView(): { center: LngLat; zoom: number } {
  try {
    const raw = window.localStorage.getItem(HOME_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      // Range-checked, not just finite: a stored latitude of 120 from some
      // earlier build makes the map constructor throw, and a map that throws
      // before it draws is a blank rectangle with no explanation.
      if (
        Number.isFinite(parsed?.lat) && Math.abs(parsed.lat) <= 90 &&
        Number.isFinite(parsed?.lng) && Math.abs(parsed.lng) <= 180 &&
        Number.isFinite(parsed?.zoom) && parsed.zoom >= 0 && parsed.zoom <= 22
      ) {
        return { center: [parsed.lng, parsed.lat], zoom: parsed.zoom }
      }
    }
  } catch {
    // Blocked storage just means the fallback city.
  }
  return { center: FALLBACK_CENTER, zoom: 11 }
}

function rememberView(instance: maplibregl.Map) {
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

/** The element a pin is made of. Same markup and classes Leaflet's divIcon
 *  produced, so index.css keeps styling it. */
function pinElement(
  property: Property,
  index: number | null,
  selected: boolean,
  stageColor?: string | null,
): HTMLDivElement {
  // The survey's own pipeline colours the pin, so map, sidebar and dropdown
  // all say the same thing; the legacy palette only covers a stage-less site.
  const color = stageColor ?? STAGE_META[property.stage]?.color ?? STAGE_META.prospect.color
  const label = index == null ? '' : String(index + 1)
  const wrap = document.createElement('div')
  wrap.className = `site-pin${selected ? ' site-pin--selected' : ''}`
  const body = document.createElement('div')
  body.className = 'site-pin__body'
  body.style.background = color
  // A site hidden from the client link stays on the broker's map, dimmed —
  // visible enough to manage, distinct enough that its state is never a guess.
  if (property.hidden) body.style.opacity = '0.45'
  const span = document.createElement('span')
  span.className = 'site-pin__label'
  span.textContent = label
  body.appendChild(span)
  wrap.appendChild(body)
  return wrap
}

function labelElement(text: string, className: string): HTMLDivElement {
  const el = document.createElement('div')
  el.className = className
  el.textContent = text
  return el
}

function emptySource(): maplibregl.GeoJSONSourceSpecification {
  return { type: 'geojson', data: { type: 'FeatureCollection', features: [] } }
}

export default function MapCanvas({
  tiles,
  basemaps,
  properties,
  selectedId,
  onSelect,
  onMapClick,
  onViewChange,
  stages,
  anchors = null,
  zones = null,
  routeIds,
  routeGeometry,
  routeColor = '#14b8a6',
  choropleth = null,
  rings = null,
  competitors,
  fitKey,
  view = null,
  labelPins = false,
  parcels = null,
  className = 'h-full w-full',
}: Props) {
  const container = useRef<HTMLDivElement>(null)
  const map = useRef<maplibregl.Map | null>(null)
  const ready = useRef(false)
  const [loaded, setLoaded] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [activeId, setActiveId] = useState(() => {
    try {
      return readStoredBasemap(window.localStorage.getItem(BASEMAP_STORAGE_KEY), tiles.provider) || tiles.provider
    } catch {
      return tiles.provider
    }
  })
  /** Basemaps whose tiles have failed here; never chosen automatically again. */
  const [brokenIds, setBrokenIds] = useState<string[]>([])
  // Set when the map engine itself cannot start or never finishes starting —
  // WebGL refused, storage poisoned, anything that would otherwise be a
  // silent blank rectangle. Rendered as a card with a reset, because the
  // person looking at it cannot open a console.
  const [engineNote, setEngineNote] = useState<string | null>(null)
  const [basemapNote, setBasemapNote] = useState<string | null>(null)
  /** Parcel tiles failing to arrive, said out loud instead of an empty map. */
  const [parcelNote, setParcelNote] = useState<string | null>(null)

  const options = basemaps && basemaps.length > 1 ? basemaps : null
  const active = pickBasemap({ activeId, options, fallback: tiles, broken: brokenIds })

  const markers = useRef<Map<string, maplibregl.Marker>>(new Map())
  const labels = useRef<Map<string, maplibregl.Marker>>(new Map())
  const anchorMarkers = useRef<maplibregl.Marker[]>([])
  const zoneLabels = useRef<maplibregl.Marker[]>([])
  const popup = useRef<maplibregl.Popup | null>(null)
  const attribution = useRef<maplibregl.AttributionControl | null>(null)

  const clickHandler = useRef(onMapClick)
  const selectHandler = useRef(onSelect)
  clickHandler.current = onMapClick
  selectHandler.current = onSelect

  /** Where a new overlay layer belongs, so draw order never depends on the
   *  order the effects happened to run in. */
  const insertBefore = (id: string): string | undefined => {
    const instance = map.current
    if (!instance) return undefined
    const at = OVERLAY_ORDER.indexOf(id as (typeof OVERLAY_ORDER)[number])
    if (at < 0) return undefined
    for (let i = at + 1; i < OVERLAY_ORDER.length; i += 1) {
      if (instance.getLayer(OVERLAY_ORDER[i])) return OVERLAY_ORDER[i]
    }
    return undefined
  }

  /** Creates a source and its layers once, then only swaps the data. */
  const upsert = (
    source: string,
    data: GeoJSON.FeatureCollection,
    layers: maplibregl.LayerSpecification[],
  ) => {
    const instance = map.current
    if (!instance || !ready.current) return
    const existing = instance.getSource(source) as maplibregl.GeoJSONSource | undefined
    if (existing) {
      existing.setData(data)
      return
    }
    instance.addSource(source, { type: 'geojson', data })
    for (const layer of layers) instance.addLayer(layer, insertBefore(layer.id))
  }

  const clear = (source: string) => {
    const instance = map.current
    if (!instance || !ready.current) return
    const existing = instance.getSource(source) as maplibregl.GeoJSONSource | undefined
    if (existing) existing.setData({ type: 'FeatureCollection', features: [] })
  }

  // Create the map once; React never re-renders into this subtree.
  useEffect(() => {
    if (!container.current || map.current) return
    const host = container.current

    const home = homeView()
    let instance: maplibregl.Map
    try {
      instance = buildMap()
    } catch (cause) {
      // Usually WebGL being unavailable to this tab. Without this catch the
      // whole view survives — panels, pickers, legends — around a map that
      // simply is not there, which reads as data missing rather than the
      // engine failing.
      setEngineNote(
        `The map engine could not start${cause instanceof Error && cause.message ? ` — ${cause.message}` : ''}.`,
      )
      return
    }

    function buildMap() {
      return new maplibregl.Map({
      container: host,
      style: {
        version: 8,
        sources: { [BASEMAP_SOURCE]: emptySource() as never },
        // No `glyphs` key at all. The style spec validates it as a string, so
        // an explicit `undefined` is rejected outright and the map never
        // finishes loading — which looks like a blank map, not a config error.
        // Nothing here draws map text: every label is a DOM marker.
        // Transparent, so the container's own CSS shows through. That CSS
        // draws the neutral grid used when no basemap is configured, and it
        // has a dark variant — painting an opaque colour here would cover
        // both and leave a flat grey rectangle instead.
        layers: [{ id: 'canvas', type: 'background', paint: { 'background-opacity': 0 } }],
      },
      center: home.center,
      zoom: home.zoom,
      attributionControl: false,
      })
    }

    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left')
    instance.on('click', (event) => clickHandler.current?.(event.lngLat.lat, event.lngLat.lng))
    instance.on('moveend', () => rememberView(instance))
    instance.on('load', () => {
      ready.current = true
      setLoaded(true)
      setEngineNote(null)
    })

    // A start that hangs is as blank as one that throws. Long enough that a
    // slow connection never sees it; the note clears itself if load lands.
    const slowStart = window.setTimeout(() => {
      if (!ready.current) {
        setEngineNote('The map is taking unusually long to start. Reloading the page usually fixes it.')
      }
    }, 12000)

    popup.current = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 14 })
    map.current = instance

    // The container is often sized by a flex parent that settles after mount.
    const resize = new ResizeObserver(() => instance.resize())
    resize.observe(container.current)

    return () => {
      window.clearTimeout(slowStart)
      resize.disconnect()
      popup.current?.remove()
      instance.remove()
      map.current = null
      ready.current = false
      markers.current.clear()
      labels.current.clear()
    }
  }, [])

  // The basemap is its own source and layer so it can be swapped without
  // tearing down the map, which would drop every pin and reset the viewport.
  useEffect(() => {
    const instance = map.current
    if (!instance || !loaded) return

    if (instance.getLayer(BASEMAP_LAYER)) instance.removeLayer(BASEMAP_LAYER)
    if (instance.getSource(BASEMAP_SOURCE)) instance.removeSource(BASEMAP_SOURCE)

    const maxzoom = active.maxZoom || 19
    instance.setMaxZoom(maxzoom)

    /*
     * The offline placeholder is an SVG per tile, and a raster source cannot
     * decode SVG — Leaflet could, because it put tiles in <img> elements.
     * Rather than fake a basemap, draw none: the transparent background layer
     * lets the container's grid CSS through, which is what "no basemap
     * configured" is supposed to look like anyway.
     */
    if (active.placeholder) {
      if (attribution.current) instance.removeControl(attribution.current)
      attribution.current = new maplibregl.AttributionControl({
        compact: true,
        customAttribution: active.attribution,
      })
      instance.addControl(attribution.current, 'bottom-right')
      return
    }

    instance.addSource(BASEMAP_SOURCE, {
      type: 'raster',
      tiles: tileUrls(active.url),
      tileSize: 256,
      maxzoom,
      attribution: active.attribution,
    })
    // Above the empty canvas, below everything else.
    const first = OVERLAY_ORDER.find((id) => instance.getLayer(id))
    instance.addLayer({ id: BASEMAP_LAYER, type: 'raster', source: BASEMAP_SOURCE }, first)

    // Attribution is a control rather than a source property so the credit
    // updates when the basemap does; the licences require it stay visible.
    if (attribution.current) instance.removeControl(attribution.current)
    attribution.current = new maplibregl.AttributionControl({
      compact: true,
      customAttribution: active.attribution,
    })
    instance.addControl(attribution.current, 'bottom-right')

    /*
     * A tile host that refuses us must not read as an empty world.
     *
     * Nothing was watching this before, so a throttled or blocked basemap
     * produced a blank grid and no signal at all — not to the viewer, who
     * cannot tell it from a map with nothing on it, and not to the operator,
     * who cannot see it from the server. A handful of failures is enough to
     * call it: tiles that fail arrive in bursts, and a single miss at the
     * edge of a pan is normal.
     */
    let failures = 0
    const failed = (event: { sourceId?: string }) => {
      if (event.sourceId !== BASEMAP_SOURCE) return
      failures += 1
      if (failures < 4) return
      const provider = active.provider
      setBrokenIds((current) => (current.includes(provider) ? current : [...current, provider]))
      setBasemapNote(`${active.label ?? 'That basemap'} is not responding. Switched to another.`)
    }
    instance.on('error', failed)
    return () => {
      instance.off('error', failed)
    }
  }, [loaded, active.provider, active.label, active.url, active.attribution, active.maxZoom])

  // Sync pins with the property list.
  useEffect(() => {
    const instance = map.current
    if (!instance || !loaded) return

    const order = routeIds ?? []
    const wanted = new Set<string>()

    /*
     * Sites that landed on the exact same coordinates — two flyers placed at
     * the same map centre, say — would stack into what looks like a single
     * pin, and "I added two sites and see one" is indistinguishable from a
     * bug. Nudge the duplicates apart in a small ring so every pin is
     * individually visible and clickable; the stored coordinates are
     * untouched.
     */
    const seenAt = new Map<string, number>()

    for (const property of properties) {
      if (property.lat == null || property.lng == null) continue
      wanted.add(property.id)

      const key = `${property.lat.toFixed(5)},${property.lng.toFixed(5)}`
      const stacked = seenAt.get(key) ?? 0
      seenAt.set(key, stacked + 1)

      let position: LngLat = [property.lng, property.lat]
      if (stacked > 0) {
        const angle = (stacked - 1) * (Math.PI / 3)
        const step = 0.00035 * Math.ceil(stacked / 6)
        position = [property.lng + step * Math.sin(angle), property.lat + step * Math.cos(angle)]
      }
      const routeIndex = order.indexOf(property.id)
      const stageColor = property.stageId
        ? stages?.find((stage) => stage.id === property.stageId)?.color ?? null
        : null
      const element = pinElement(
        property,
        routeIndex >= 0 ? routeIndex : null,
        property.id === selectedId,
        stageColor,
      )
      element.title = displayName(property)

      // The pin's own click must not also reach the map, or dropping a site
      // by clicking the map would fire every time one is selected.
      element.addEventListener('click', (event) => {
        event.stopPropagation()
        selectHandler.current?.(property.id)
      })

      if (!labelPins) {
        element.addEventListener('mouseenter', () => {
          popup.current
            ?.setLngLat(position)
            .setHTML(`<strong>${displayName(property)}</strong><br>${fullAddress(property)}`)
            .addTo(instance)
        })
        element.addEventListener('mouseleave', () => popup.current?.remove())
      }

      markers.current.get(property.id)?.remove()
      const marker = new maplibregl.Marker({ element, anchor: 'bottom' })
        .setLngLat(position)
        .addTo(instance)
      markers.current.set(property.id, marker)

      // The name rides the pin permanently on the client share map: a client
      // reading it should never have to hover or tap to learn which site is
      // which.
      labels.current.get(property.id)?.remove()
      labels.current.delete(property.id)
      if (labelPins) {
        const label = new maplibregl.Marker({
          element: labelElement(displayName(property), 'site-label'),
          anchor: 'bottom',
          offset: [0, -32],
        })
          .setLngLat(position)
          .addTo(instance)
        labels.current.set(property.id, label)
      }
    }

    for (const [id, marker] of markers.current) {
      if (!wanted.has(id)) {
        marker.remove()
        markers.current.delete(id)
        labels.current.get(id)?.remove()
        labels.current.delete(id)
      }
    }
  }, [loaded, properties, selectedId, routeIds, stages, labelPins])

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
    if (!instance || !loaded) return

    if (!routeIds || routeIds.length < 2) {
      clear('route')
      return
    }

    const routed = Boolean(routeGeometry && routeGeometry.length >= 2)
    const points: LngLat[] = routed
      ? (routeGeometry as [number, number][]).map(([lat, lng]) => [lng, lat])
      : routeIds
          .map((id) => properties.find((property) => property.id === id))
          .filter((property): property is Property => Boolean(property?.lat && property?.lng))
          .map((property) => [property.lng as number, property.lat as number])

    if (points.length < 2) {
      clear('route')
      return
    }

    upsert(
      'route',
      {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: points } }],
      },
      [
        {
          id: 'route-line',
          type: 'line',
          source: 'route',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': routeColor, 'line-width': 4, 'line-opacity': 0.9 },
        },
      ],
    )

    /*
     * Paint is set after the layer, every time, not only when it is created.
     * `upsert` builds a layer once and thereafter only swaps its data, so a
     * dash chosen at creation would be permanent — a tour that later got real
     * routed geometry would keep drawing the estimate's dashes, and one that
     * lost routing would keep claiming a road that was no longer being
     * followed.
     */
    if (instance.getLayer('route-line')) {
      instance.setPaintProperty('route-line', 'line-color', routeColor)
      instance.setPaintProperty('route-line', 'line-width', routed ? 5 : 4)
      // A real routed path is solid, because it is what the drive looks like.
      // The pin-to-pin fallback stays dashed, so an estimate never reads as a
      // road that exists.
      instance.setPaintProperty('route-line', 'line-dasharray', routed ? null : [2, 2])
    }
  }, [loaded, routeIds, routeGeometry, properties, routeColor])

  // Shade census block groups by whichever metric is selected.
  useEffect(() => {
    const instance = map.current
    if (!instance || !loaded) return

    if (!choropleth || choropleth.length === 0) {
      clear('shading')
      return
    }

    const features: GeoJSON.Feature[] = []
    for (const area of choropleth) {
      if (!area.geometry || !area.color) continue
      features.push({
        type: 'Feature',
        properties: { color: area.color, info: area.info ?? '' },
        geometry: area.geometry as GeoJSON.Geometry,
      })
    }

    upsert('shading', { type: 'FeatureCollection', features }, [
      {
        id: 'shading-fill',
        type: 'fill',
        source: 'shading',
        paint: {
          'fill-color': ['get', 'color'],
          // Kept translucent so the streets underneath stay legible — the
          // shading is context for the map, not a replacement for it.
          'fill-opacity': 0.45,
        },
      },
      {
        id: 'shading-line',
        type: 'line',
        source: 'shading',
        paint: { 'line-color': ['get', 'color'], 'line-width': 1, 'line-opacity': 0.6 },
      },
    ])
  }, [loaded, choropleth])

  // A tract says what it is worth saying — but never while a map click is
  // armed for dropping a pin or placing a zone, when the click must fall
  // through to the map itself.
  useEffect(() => {
    const instance = map.current
    if (!instance || !loaded) return undefined
    if (onMapClick) return undefined

    const open = (event: maplibregl.MapLayerMouseEvent) => {
      const info = event.features?.[0]?.properties?.info
      if (!info) return
      /*
       * The parcel wins.
       *
       * MapLibre fires a click on every layer under the pointer that has a
       * handler, so with area shading on, one click opened the parcel card
       * AND a tract popup on top of it. The parcel is the subject and the
       * tract is context, so the tract only speaks when the click did not
       * land on a parcel at all.
       */
      if (instance.getLayer('parcel-fill')) {
        if (instance.queryRenderedFeatures(event.point, { layers: ['parcel-fill'] }).length) return
      }
      new maplibregl.Popup({ closeButton: true, maxWidth: '240px' })
        .setLngLat(event.lngLat)
        .setHTML(String(info))
        .addTo(instance)
    }
    instance.on('click', 'shading-fill', open)
    return () => {
      instance.off('click', 'shading-fill', open)
    }
  }, [loaded, onMapClick, choropleth])

  // Start and end flags for the tour.
  useEffect(() => {
    const instance = map.current
    if (!instance || !loaded) return

    for (const marker of anchorMarkers.current) marker.remove()
    anchorMarkers.current = []
    if (!anchors || (!anchors.start && !anchors.end)) return

    const flag = (point: { lat: number; lng: number; label?: string }, kind: 'start' | 'end') => {
      const el = document.createElement('div')
      el.className = 'anchor-pin'
      const body = document.createElement('div')
      body.className = `anchor-pin__body anchor-pin__body--${kind}`
      body.textContent = kind === 'start' ? 'A' : 'B'
      el.appendChild(body)
      if (point.label) el.title = `${kind === 'start' ? 'Start' : 'End'}: ${point.label}`
      anchorMarkers.current.push(
        new maplibregl.Marker({ element: el }).setLngLat([point.lng, point.lat]).addTo(instance),
      )
    }
    if (anchors.start) flag(anchors.start, 'start')
    if (anchors.end) flag(anchors.end, 'end')
  }, [loaded, anchors])

  // Non-compete circles and other labelled zones.
  useEffect(() => {
    const instance = map.current
    if (!instance || !loaded) return

    for (const marker of zoneLabels.current) marker.remove()
    zoneLabels.current = []

    if (!zones || zones.length === 0) {
      clear('zones')
      return
    }

    const features: GeoJSON.Feature[] = zones.map((zone) => ({
      type: 'Feature',
      properties: { color: zone.color },
      geometry: {
        type: 'Polygon',
        coordinates: [circlePolygon(zone.lat, zone.lng, zone.radiusMiles * METERS_PER_MILE)],
      },
    }))

    upsert('zones', { type: 'FeatureCollection', features }, [
      {
        id: 'zone-fill',
        type: 'fill',
        source: 'zones',
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.08 },
      },
      {
        id: 'zone-line',
        type: 'line',
        source: 'zones',
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 2,
          'line-dasharray': [3, 2],
        },
      },
    ])

    // The label rides at the centre of the circle, always visible: an
    // unlabelled dashed ring reads as a bug, a labelled one reads as a
    // boundary.
    for (const zone of zones) {
      zoneLabels.current.push(
        new maplibregl.Marker({
          element: labelElement(`${zone.label} · ${zone.radiusMiles} mi`, 'zone-label'),
        })
          .setLngLat([zone.lng, zone.lat])
          .addTo(instance),
      )
    }
  }, [loaded, zones])

  // Radius rings around the site being scoped. Never interactive: they are
  // scale, not something to click.
  useEffect(() => {
    const instance = map.current
    if (!instance || !loaded) return

    if (!rings || rings.miles.length === 0) {
      clear('rings')
      return
    }

    // Largest first so the smaller rings draw on top of the bigger fills.
    const features: GeoJSON.Feature[] = [...rings.miles]
      .sort((a, b) => b - a)
      .map((miles) => ({
        type: 'Feature',
        properties: { miles },
        geometry: {
          type: 'Polygon',
          coordinates: [circlePolygon(rings.lat, rings.lng, miles * METERS_PER_MILE)],
        },
      }))

    upsert('rings', { type: 'FeatureCollection', features }, [
      {
        id: 'ring-fill',
        type: 'fill',
        source: 'rings',
        paint: { 'fill-color': '#14b8a6', 'fill-opacity': 0.06 },
      },
      {
        id: 'ring-line',
        type: 'line',
        source: 'rings',
        paint: {
          'line-color': '#0f766e',
          'line-width': 1.6,
          'line-opacity': 0.75,
          'line-dasharray': [3, 3],
        },
      },
    ])
  }, [loaded, rings])

  // Nearby businesses, drawn smaller than the survey's own pins.
  useEffect(() => {
    const instance = map.current
    if (!instance || !loaded) return

    if (!competitors || competitors.length === 0) {
      clear('competitors')
      return
    }

    upsert(
      'competitors',
      {
        type: 'FeatureCollection',
        features: competitors.map((business) => ({
          type: 'Feature',
          properties: { name: business.name, miles: business.miles },
          geometry: { type: 'Point', coordinates: [business.lng, business.lat] },
        })),
      },
      [
        {
          id: 'competitor-circle',
          type: 'circle',
          source: 'competitors',
          paint: {
            'circle-radius': 5,
            'circle-color': '#f97316',
            'circle-opacity': 0.95,
            'circle-stroke-color': '#0f172a',
            'circle-stroke-width': 1.5,
          },
        },
      ],
    )
  }, [loaded, competitors])

  useEffect(() => {
    const instance = map.current
    if (!instance || !loaded) return undefined

    const enter = (event: maplibregl.MapLayerMouseEvent) => {
      const props = event.features?.[0]?.properties
      if (!props) return
      instance.getCanvas().style.cursor = 'pointer'
      popup.current
        ?.setLngLat(event.lngLat)
        .setHTML(`<strong>${props.name}</strong><br>${props.miles} mi away`)
        .addTo(instance)
    }
    const leave = () => {
      instance.getCanvas().style.cursor = ''
      popup.current?.remove()
    }
    instance.on('mousemove', 'competitor-circle', enter)
    instance.on('mouseleave', 'competitor-circle', leave)
    return () => {
      instance.off('mousemove', 'competitor-circle', enter)
      instance.off('mouseleave', 'competitor-circle', leave)
    }
  }, [loaded, competitors])

  /*
   * County parcels.
   *
   * The source is rebuilt only when the file changes, because rebuilding it
   * discards every tile the browser has already fetched. Colour and selection
   * are paint and feature-state on the existing layers, which cost nothing.
   */
  useEffect(() => {
    const instance = map.current
    if (!instance || !loaded) return

    if (!parcels) {
      if (instance.getLayer('parcel-line')) instance.removeLayer('parcel-line')
      if (instance.getLayer('parcel-fill')) instance.removeLayer('parcel-fill')
      if (instance.getSource(PARCEL_SOURCE)) instance.removeSource(PARCEL_SOURCE)
      return
    }

    registerPmtiles()
    const sourceLayer = parcels.sourceLayer || 'parcels'

    if (instance.getLayer('parcel-line')) instance.removeLayer('parcel-line')
    if (instance.getLayer('parcel-fill')) instance.removeLayer('parcel-fill')
    if (instance.getSource(PARCEL_SOURCE)) instance.removeSource(PARCEL_SOURCE)

    setParcelNote(null)
    instance.addSource(PARCEL_SOURCE, {
      type: 'vector',
      url: `pmtiles://${parcels.url}`,
    })

    const below = insertBefore('parcel-fill')
    instance.addLayer(
      {
        id: 'parcel-fill',
        type: 'fill',
        source: PARCEL_SOURCE,
        'source-layer': sourceLayer,
        paint: { 'fill-color': PARCEL_OTHER, 'fill-opacity': 0.34 },
      },
      below,
    )
    instance.addLayer(
      {
        id: 'parcel-line',
        type: 'line',
        source: PARCEL_SOURCE,
        'source-layer': sourceLayer,
        paint: {
          'line-color': PARCEL_OTHER,
          'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.4, 15, 0.9, 18, 1.6],
          'line-opacity': 0.5,
        },
      },
      insertBefore('parcel-line'),
    )

    /*
     * A parcel archive that cannot be read must say so. The two live failure
     * modes — a host that answers without CORS for this origin, and a host
     * that cannot serve HTTP ranges — both surface here as source errors and
     * used to render as a county with no parcels, which reads as "the data
     * is missing" when the truth is "the data was refused".
     */
    /*
     * The first error is already definitive. A tile the archive simply lacks
     * is not an error at all — the pmtiles protocol answers it with an empty
     * tile — so anything that does error is the archive itself failing:
     * unreachable, refused for this origin, or a host that cannot serve
     * ranges. There is no benign version to wait out.
     */
    let reported = false
    const failed = (event: { sourceId?: string; error?: { message?: string } }) => {
      if (event.sourceId !== PARCEL_SOURCE || reported) return
      reported = true
      const why = event.error?.message ? ` (${event.error.message.slice(0, 120)})` : ''
      setParcelNote(`County parcels could not be loaded${why}`)
    }
    instance.on('error', failed)
    return () => {
      instance.off('error', failed)
    }
  }, [loaded, parcels?.url, parcels?.sourceLayer])

  // Colour is separate from the source so changing the metric does not throw
  // away tiles the browser already has.
  useEffect(() => {
    const instance = map.current
    if (!instance || !loaded || !parcels) return
    if (!instance.getLayer('parcel-fill')) return

    let color: maplibregl.ExpressionSpecification | string
    if (parcels.colorBy === 'value' && parcels.valueBreaks?.length) {
      // Where a county publishes no land use, every parcel lands in one bucket
      // and the map renders as a single grey mass — honest and useless. Value
      // is the other thing every roll carries.
      const steps: unknown[] = ['step', ['get', 'mv'], VALUE_RAMP[0]]
      parcels.valueBreaks.forEach((cut, i) => steps.push(cut, VALUE_RAMP[i + 1] ?? VALUE_RAMP[VALUE_RAMP.length - 1]))
      color = steps as maplibregl.ExpressionSpecification
    } else {
      const match: unknown[] = ['match', ['get', 'gp']]
      for (const [group, hue] of PARCEL_COLORS) match.push(group, hue)
      match.push(PARCEL_OTHER)
      color = match as maplibregl.ExpressionSpecification
    }

    // A selected parcel keeps its own outline rather than changing colour, so
    // the land-use reading of the map never shifts when something is picked.
    instance.setPaintProperty('parcel-fill', 'fill-color', color)
    instance.setPaintProperty('parcel-fill', 'fill-opacity', [
      'case',
      ['boolean', ['feature-state', 'sel'], false],
      0.7,
      ['boolean', ['feature-state', 'hover'], false],
      Math.min((parcels.opacity ?? 0.34) + 0.24, 1),
      parcels.opacity ?? 0.34,
    ])
    instance.setPaintProperty('parcel-line', 'line-color', [
      'case',
      ['boolean', ['feature-state', 'sel'], false],
      '#C4A6FF',
      color,
    ])
  }, [loaded, parcels?.colorBy, parcels?.valueBreaks, parcels?.url, parcels?.opacity])

  // Which parcels are shown. One filter expression for the whole layer beats
  // restyling features one at a time.
  useEffect(() => {
    const instance = map.current
    if (!instance || !loaded || !parcels) return
    if (!instance.getLayer('parcel-fill')) return
    /*
     * `['id']`, not `['get','id']`. The tiles are built with tippecanoe's
     * --use-attribute-for-id, which moves the id off the properties and onto
     * the feature, so reading it as a property returns null and the filter
     * hides every parcel on the map.
     */
    const filter = parcels.filterIds
      ? (['in', ['id'], ['literal', parcels.filterIds]] as maplibregl.FilterSpecification)
      : null
    instance.setFilter('parcel-fill', filter)
    instance.setFilter('parcel-line', filter)
  }, [loaded, parcels?.filterIds, parcels?.url])

  /*
   * Clicking a parcel selects it; hovering only outlines it.
   *
   * A card that opens on hover is unusable on a map this dense — the pointer
   * crosses dozens of parcels on the way anywhere. Hover is the affordance
   * that says what a click would hit, and nothing more.
   */
  useEffect(() => {
    const instance = map.current
    if (!instance || !loaded || !parcels) return undefined

    const sourceLayer = parcels.sourceLayer || 'parcels'
    let hovered: string | number | null = null
    const state = (id: string | number, key: string, value: boolean) => {
      try {
        instance.setFeatureState({ source: PARCEL_SOURCE, sourceLayer, id }, { [key]: value })
      } catch {
        // A feature can leave the viewport between the event and this call.
      }
    }

    const move = (event: maplibregl.MapLayerMouseEvent) => {
      const id = event.features?.[0]?.id
      if (id == null) return
      instance.getCanvas().style.cursor = 'pointer'
      if (hovered !== null && hovered !== id) state(hovered, 'hover', false)
      hovered = id
      state(id, 'hover', true)
    }
    const leave = () => {
      instance.getCanvas().style.cursor = ''
      if (hovered !== null) state(hovered, 'hover', false)
      hovered = null
    }
    const click = (event: maplibregl.MapLayerMouseEvent) => {
      const id = event.features?.[0]?.id
      if (id != null) parcels.onSelectParcel?.(id)
    }

    instance.on('mousemove', 'parcel-fill', move)
    instance.on('mouseleave', 'parcel-fill', leave)
    instance.on('click', 'parcel-fill', click)
    return () => {
      instance.off('mousemove', 'parcel-fill', move)
      instance.off('mouseleave', 'parcel-fill', leave)
      instance.off('click', 'parcel-fill', click)
    }
  }, [loaded, parcels?.url, parcels?.onSelectParcel, parcels?.sourceLayer])

  // The selected parcel, carried as feature-state so the style does it.
  useEffect(() => {
    const instance = map.current
    if (!instance || !loaded || !parcels) return undefined
    const sourceLayer = parcels.sourceLayer || 'parcels'
    const id = parcels.selectedParcelId
    if (id == null) return undefined
    try {
      instance.setFeatureState({ source: PARCEL_SOURCE, sourceLayer, id }, { sel: true })
    } catch {
      /* the parcel is not in a loaded tile yet */
    }
    return () => {
      try {
        instance.setFeatureState({ source: PARCEL_SOURCE, sourceLayer, id }, { sel: false })
      } catch {
        /* nothing to clear */
      }
    }
  }, [loaded, parcels?.selectedParcelId, parcels?.url, parcels?.sourceLayer])

  // Go where the caller says, when the caller says it changed.
  useEffect(() => {
    const instance = map.current
    if (!instance || !loaded || !view) return
    instance.jumpTo({ center: view.center, zoom: view.zoom })
  }, [loaded, view?.key])

  // Fit the view to the pins when the caller asks.
  useEffect(() => {
    const instance = map.current
    if (!instance || !loaded) return

    const points = properties
      .filter((property) => property.lat != null && property.lng != null)
      .map((property) => [property.lng as number, property.lat as number] as LngLat)

    if (points.length === 0) return
    // Without animation on purpose: the selected-pin effect below reads the
    // bounds right after this, and an animated fit reports the old view
    // mid-flight — so the pan "correcting" the selection undid the fit and
    // slid every other pin off the screen.
    if (points.length === 1) {
      instance.jumpTo({ center: points[0], zoom: 14 })
      return
    }
    const bounds = points.reduce(
      (box, point) => box.extend(point),
      new maplibregl.LngLatBounds(points[0], points[0]),
    )
    instance.fitBounds(bounds, { padding: 48, maxZoom: 15, animate: false })
  }, [loaded, fitKey])

  // Keep the selected pin in view when it is chosen from a list.
  useEffect(() => {
    const instance = map.current
    if (!instance || !loaded || !selectedId) return
    const property = properties.find((entry) => entry.id === selectedId)
    if (property?.lat == null || property?.lng == null) return

    // Only move when it is actually out of view. Adding a site both fits the
    // map to every pin and selects the new one; recentring on the selection
    // after that fit slid the other pins off the screen — which read as
    // "my points don't all show on the map".
    const target: LngLat = [property.lng, property.lat]
    const bounds = instance.getBounds()
    const padX = (bounds.getEast() - bounds.getWest()) * 0.05
    const padY = (bounds.getNorth() - bounds.getSouth()) * 0.05
    const inside =
      target[0] > bounds.getWest() + padX &&
      target[0] < bounds.getEast() - padX &&
      target[1] > bounds.getSouth() + padY &&
      target[1] < bounds.getNorth() - padY
    if (inside) return
    instance.panTo(target, { animate: true })
  }, [loaded, selectedId])

  const chooseBasemap = (id: string) => {
    setActiveId(id)
    setPickerOpen(false)
    setBrokenIds((current) => current.filter((entry) => entry !== id))
    setBasemapNote(null)
    try {
      // Recorded against today's default, so a later change to it retires
      // this preference rather than overriding the deployment forever.
      window.localStorage.setItem(BASEMAP_STORAGE_KEY, writeStoredBasemap(id, tiles.provider))
    } catch {
      /* a viewer with storage disabled just loses the preference */
    }
  }

  return (
    <div className={`relative h-full w-full ${active.darkNative ? 'map-dark' : ''}`}>
      <div ref={container} className={className} role="application" aria-label="Property map" />

      {/*
        * Said out loud rather than silently swapped. A basemap changing under
        * the viewer is confusing; a blank map with no explanation is worse.
        */}
      {engineNote ? (
        <div className="absolute inset-0 z-[550] flex items-center justify-center">
          <div className="w-80 max-w-[90%] rounded-lg border border-line bg-surface/97 p-4 text-center shadow-xl backdrop-blur">
            <p className="text-sm font-semibold text-ink">The map did not start</p>
            <p className="mt-1 text-xs leading-snug text-body">{engineNote}</p>
            <button
              type="button"
              className="mt-3 rounded-md border border-line px-3 py-1.5 text-xs font-medium text-ink hover:bg-sunken"
              onClick={() => {
                try {
                  window.localStorage.removeItem(HOME_STORAGE_KEY)
                  window.localStorage.removeItem(BASEMAP_STORAGE_KEY)
                } catch {
                  /* storage may be blocked; the reload alone can still help */
                }
                window.location.reload()
              }}
            >
              Reset map settings and reload
            </button>
          </div>
        </div>
      ) : null}

      {basemapNote || parcelNote ? (
        <div
          role="status"
          className="pointer-events-none absolute inset-x-0 top-3 z-[600] mx-auto w-fit max-w-[90%] space-y-1 rounded-lg border border-line bg-surface/95 px-3 py-1.5 text-xs text-body shadow-sm"
        >
          {basemapNote ? <p>{basemapNote}</p> : null}
          {parcelNote ? <p>{parcelNote}</p> : null}
        </div>
      ) : null}

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
