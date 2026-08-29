import { useEffect, useRef, useState, type MutableRefObject } from 'react'
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

/*
 * How far a restored position may sit from the market it is restored into.
 *
 * Degrees, and deliberately loose: a county is a degree or so across, and the
 * point is not to police where someone was looking but to catch a position
 * that belongs to a different part of the country entirely.
 */
const SAME_MARKET_DEGREES = 3
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
  /**
   * Whether the land-use wash paints, with the geometry staying either way.
   *
   * The parcels card used to remove the whole layer, which also removed the
   * outlines and every click target — a county you could not touch. Off now
   * means invisible fill: the hairline outlines stay so there is always a
   * shape to click, and hover and selection still light the parcel up.
   */
  fillVisible?: boolean
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
  /** The ramp to paint a value with, light to dark. Defaults to the house one. */
  valueRamp?: string[]
}

/** Land-use buckets, in the same colours the parcel map uses. */
const PARCEL_COLORS: [string, string][] = [
  ['Commercial', '#2a78d6'],
  ['Multifamily', '#eb6834'],
  ['Vacant land', '#1baf7a'],
  ['Single family', '#9AA1B4'],
]
/*
 * The outline colour when nothing shades the map.
 *
 * Near-black rather than black: pure #000 against a pale basemap reads as a
 * printing artefact, and against the dark basemap it disappears entirely.
 * This is the brand's ink, which is what every other line in the product uses.
 */
const PARCEL_INK = '#0f172a'

const PARCEL_OTHER = '#5C6377'

/** One hue, light to dark. A value is a magnitude, never a set of categories. */
const VALUE_RAMP = ['#EDE7FA', '#D6C6F3', '#BBA0EA', '#9D77DD', '#7F4FCB', '#6031AE', '#43208A']

/**
 * A layer the market publishes that this app knows nothing about.
 *
 * Permits, zoning, opportunity zones, school districts — each is somebody
 * else's operational map, declared in the market's catalog and drawn from
 * whatever geometry it turns out to have. The app renders the declaration
 * rather than the source, which is what lets a county gain a layer without
 * this file changing.
 */
export interface ExtraLayer {
  id: string
  kind: 'point' | 'polygon' | 'line'
  data: GeoJSON.FeatureCollection
  color: string
  opacity: number
  /** Property names worth showing when one is clicked, in reading order. */
  fields?: string[]
  /**
   * Paint each category its own colour instead of the layer one hue.
   *
   * Zoning is the case that demands it: a single pink wash over 22,000
   * districts says only "there is zoning here", while a colour per district
   * type says which blocks are commercial. The mapping is decided upstream —
   * this only paints what it is handed.
   */
  categories?: { field: string; colors: Record<string, string> } | null
}

/** Values come from other people's databases, so they are never markup. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

interface Props {
  tiles: TileConfig
  /** Basemaps the viewer may switch between. Omit to hide the switcher. */
  basemaps?: TileConfig[]
  properties: Property[]
  selectedId?: string | null
  onSelect?: (id: string) => void
  onMapClick?: (lat: number, lng: number) => void
  /** Reports where the map is looking, so a dropped flyer can land nearby. */
  /**
   * Where the map is looking, on every settle.
   *
   * Zoom rides along with the centre because a saved view has to restore both
   * — "here at county scale" and "here at street scale" are different views of
   * the same point. Existing callers that only read lat and lng are unaffected.
   */
  onViewChange?: (center: { lat: number; lng: number; zoom: number }) => void
  /**
   * A hook the view fills with "photograph the map, now".
   *
   * A ref rather than a callback prop on purpose: the capture function only
   * exists while a live, loaded map instance does, and a ref lets the export
   * button ask at click time without the map re-rendering to keep a prop
   * fresh. The capture waits for a render frame, because reading a WebGL
   * canvas outside one returns black — the buffer is not preserved, and
   * preserving it full-time taxes every frame to serve a rare export.
   */
  captureRef?: MutableRefObject<(() => Promise<HTMLCanvasElement | null>) | null>
  /**
   * A clicked extra-layer feature, handed to the view instead of a popup.
   *
   * The popup was the first draft and it reads like a tooltip: cramped,
   * covering the map, gone on the next click. A view that supplies this
   * callback gets the feature's properties and renders them wherever records
   * belong — the same right-hand card a parcel uses.
   */
  onExtraPick?: (pick: { layerId: string; properties: Record<string, unknown> }) => void
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
  /** How strongly the shaded areas paint. The viewer's call, not the map's. */
  choroplethOpacity?: number
  /** Published layers to draw above the parcels. */
  extras?: ExtraLayer[] | null
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
/*
 * What the GPU situation actually is, asked when the map fails to start.
 *
 * A start that hangs with no error gives the person a shrug and gives a bug
 * report nothing to go on — an afternoon went on exactly that. The three
 * conditions this tells apart want three different responses: WebGL denied
 * outright means the browser needs hardware acceleration switched on or tabs
 * closed; a software renderer means acceleration is off and everything will
 * crawl; a healthy GPU means the stall is elsewhere, and in practice that is
 * an extension interfering with the map's background workers.
 */
function engineDiagnosis(): string {
  try {
    const probe = document.createElement('canvas')
    const gl = probe.getContext('webgl2') ?? probe.getContext('webgl')
    if (!gl) {
      return 'This tab could not get graphics access at all — usually hardware acceleration switched off in the browser settings, or too many open tabs holding graphics memory. Closing tabs or re-enabling acceleration should cure it.'
    }
    const info = gl.getExtension('WEBGL_debug_renderer_info')
    const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : ''
    // The probe context is handed back immediately: the browser caps live
    // contexts, and the whole point here is not to hold one the map needs.
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    if (/swiftshader|software|llvmpipe|basic render/i.test(renderer)) {
      return `The browser is drawing with software (${renderer}) instead of the graphics card, which makes the map far too slow to start. Switching hardware acceleration on in the browser settings should cure it.`
    }
    return `Graphics look healthy${renderer ? ` (${renderer})` : ''}, so the start is stuck elsewhere — a browser extension blocking the map's background workers is the usual cause. A private window with extensions off will confirm it.`
  } catch {
    return 'The graphics check itself was blocked, which points at the browser or an extension denying canvas access.'
  }
}

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
  captureRef,
  onExtraPick,
  stages,
  anchors = null,
  zones = null,
  routeIds,
  routeGeometry,
  routeColor = '#14b8a6',
  choropleth = null,
  choroplethOpacity = 0.45,
  extras = null,
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
  /*
   * A rebuild counter, and the reason the last start failed.
   *
   * Every source and layer effect below depends on `loaded`, so tearing the
   * instance down and building a new one re-applies all of them — which makes
   * rebuilding a real recovery rather than a blank canvas with the panels
   * still around it.
   */
  const [attempt, setAttempt] = useState(0)
  // What MapLibre itself said, kept in a ref because the timeout reads it
  // without wanting to re-run on every error.
  const startupError = useRef<string | null>(null)
  // Set the moment the GPU takes the context away, and read by the teardown.
  const contextLost = useRef(false)
  // Automatic rebuilds since the last healthy start. Bounded, because a
  // machine whose GPU refuses WebGL outright would otherwise rebuild in a
  // loop forever; the button has no such limit.
  const autoTries = useRef(0)
  const [basemapNote, setBasemapNote] = useState<string | null>(null)
  /** Parcel tiles failing to arrive, said out loud instead of an empty map. */
  const [parcelNote, setParcelNote] = useState<string | null>(null)

  const options = basemaps && basemaps.length > 1 ? basemaps : null
  const active = pickBasemap({ activeId, options, fallback: tiles, broken: brokenIds })

  // When every host is failing there is nothing left to switch to, and
  // "switched to another" would be a lie. This is what a content blocker
  // looks like from inside the app, so say that.
  useEffect(() => {
    if (!options?.length) return
    if (options.every((option) => brokenIds.includes(option.provider))) {
      setBasemapNote(
        'No map tile host is responding. A content blocker, VPN, or network filter in this browser may be blocking map tiles.',
      )
    }
  }, [brokenIds, options])

  const markers = useRef<Map<string, maplibregl.Marker>>(new Map())
  const labels = useRef<Map<string, maplibregl.Marker>>(new Map())
  const anchorMarkers = useRef<maplibregl.Marker[]>([])
  const zoneLabels = useRef<maplibregl.Marker[]>([])
  const popup = useRef<maplibregl.Popup | null>(null)
  /** Whether the URL named a view before this map was built. */
  const hadHash = useRef(false)
  /** Whether the caller's view has been applied even once. */
  const viewApplied = useRef(false)
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
    /*
     * Published layers share one slot. They are other people's data drawn
     * over the parcels, so they belong above the ground and below anything
     * this survey put on the map — the tour line, the zones, the pins.
     */
    const at = id.startsWith('x-')
      ? OVERLAY_ORDER.indexOf('zone-fill') - 1
      : OVERLAY_ORDER.indexOf(id as (typeof OVERLAY_ORDER)[number])
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
    /*
     * Read before the map exists, because the map rewrites it.
     *
     * With `hash: true` MapLibre keeps the URL in step with the view, so by
     * the time anything else runs there is always a hash and asking then tells
     * you nothing. Asking here distinguishes the two cases that matter: a
     * fresh visit, which should open where the market opens, and a reload or a
     * pasted link, which already says where to be and must not be overridden.
     */
    hadHash.current = /^#[\d.]+\//.test(window.location.hash)
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
      /*
       * The view lives in the URL.
       *
       * Refreshing used to drop you back at the market's default centre,
       * which on a county-wide map means losing the block you were reading.
       * MapLibre's own hash keeps zoom and centre in the address bar, so a
       * refresh returns to the same spot — and a pasted URL opens on it,
       * which is the same feature seen from the other side.
       */
      hash: true,
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
    const markReady = () => {
      ready.current = true
      startupError.current = null
      autoTries.current = 0
      setLoaded(true)
      setEngineNote(null)
    }
    instance.on('load', markReady)

    // Whatever MapLibre says on the way up, kept so the note can name it.
    // Without this the only symptom of a real failure is a timeout message
    // that describes the delay rather than the cause, which is how one
    // afternoon went entirely on ruling out things that were never wrong.
    instance.on('error', (event) => {
      const message = (event as { error?: Error }).error?.message
      if (message && !ready.current) startupError.current = message
    })

    /*
     * The GPU can take the context away — another tab, a driver reset, a
     * laptop switching cards — and MapLibre does not come back on its own.
     * Losing it before `load` is the one failure that looks exactly like a
     * hang: the constructor succeeded, so nothing threw, and no further
     * event ever arrives.
     */
    const canvas = instance.getCanvas()
    let retry: number | undefined
    const rebuild = () => setAttempt((n) => n + 1)
    const onLost = (event: Event) => {
      // Prevents the default so the browser will attempt a restore at all.
      event.preventDefault()
      contextLost.current = true
      ready.current = false
      setLoaded(false)
      /*
       * Then recover without being asked. Context loss is a browser under
       * memory pressure evicting the oldest context — a machine with forty
       * tabs hits it on every visit — and the person looking at the grey
       * grid did nothing wrong, so they should not have to click anything.
       * A few seconds' pause gives the browser room to actually free the
       * GPU; rebuilding instantly tends to get the new context evicted too.
       */
      if (autoTries.current < 3) {
        autoTries.current += 1
        setEngineNote('The browser took the graphics context back — restarting the map…')
        retry = window.setTimeout(rebuild, 2500)
      } else {
        setEngineNote(
          'The browser keeps taking the graphics context away, which usually means it is out of GPU memory. ' +
            'Closing other tabs tends to cure it.',
        )
      }
    }
    const onRestored = rebuild
    /*
     * Coming back to the tab is the other natural recovery point: whatever
     * needed the GPU had it while this tab was hidden, and returning is the
     * moment the context is most likely to be grantable again.
     */
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !ready.current && contextLost.current) rebuild()
    }
    canvas.addEventListener('webglcontextlost', onLost)
    canvas.addEventListener('webglcontextrestored', onRestored)
    document.addEventListener('visibilitychange', onVisible)

    // A start that hangs is as blank as one that throws. Long enough that a
    // slow connection never sees it; the note clears itself if load lands.
    const slowStart = window.setTimeout(() => {
      if (ready.current) return
      // Ask the map rather than trusting the flag. If the event was missed —
      // and a missed event is indistinguishable from a hang to everything
      // else here — the map is fine and saying otherwise is a false alarm
      // over a working map.
      if (instance.loaded()) {
        markReady()
        return
      }
      /*
       * One silent retry before any message. A wedged start — a worker that
       * never answered, a context granted and then starved — often unsticks
       * on a fresh instance, and the person should not see a scary panel for
       * a hiccup that cures itself.
       */
      if (!startupError.current && autoTries.current < 1) {
        autoTries.current += 1
        rebuild()
        return
      }
      setEngineNote(
        startupError.current
          ? `The map engine stopped while starting — ${startupError.current}`
          : `The map did not finish starting. ${engineDiagnosis()}`,
      )
    }, 12000)

    popup.current = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 14 })
    map.current = instance
    if (captureRef) {
      captureRef.current = () =>
        new Promise((resolve) => {
          if (!ready.current) {
            resolve(null)
            return
          }
          // Copied inside the render event, where the buffer is guaranteed
          // full — one frame later it may already be cleared.
          instance.once('render', () => {
            const source = instance.getCanvas()
            const copy = document.createElement('canvas')
            copy.width = source.width
            copy.height = source.height
            copy.getContext('2d')?.drawImage(source, 0, 0)
            resolve(copy)
          })
          instance.triggerRepaint()
        })
    }
    // For the browser checks: the instance is reachable from the DOM, so a
    // test can read the real layer order instead of inferring it from pixels.
    ;(host as HTMLDivElement & { __map?: maplibregl.Map }).__map = instance

    // The container is often sized by a flex parent that settles after mount.
    const resize = new ResizeObserver(() => instance.resize())
    resize.observe(container.current)

    return () => {
      window.clearTimeout(slowStart)
      window.clearTimeout(retry)
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      document.removeEventListener('visibilitychange', onVisible)
      resize.disconnect()
      /*
       * The bookkeeping runs whatever happens to the teardown, and that
       * ordering is the whole reason a rebuild works.
       *
       * remove() throws when the graphics context is already gone — which is
       * exactly the case a rebuild exists for. Left unguarded it aborted the
       * cleanup before `map.current` was cleared, so the effect's own
       * `if (map.current) return` guard then refused to build the
       * replacement: the recovery button tore the map down and put nothing
       * back.
       */
      /*
       * A map whose context is gone is not torn down — it is abandoned.
       *
       * remove() walks its controls calling onRemove, and those reach through
       * the painter that died with the context, so it throws from inside
       * MapLibre where no try/catch of ours can contain it: the error escapes
       * to React, which unmounts this whole subtree, and the recovery button
       * takes the map away for good instead of bringing it back.
       *
       * So when the context is lost the instance is simply dropped. The
       * container div is keyed on `attempt`, so React discards the element
       * holding the dead canvas and mounts a fresh one for the next build,
       * which is the same disposal by a route that cannot throw.
       */
      try {
        popup.current?.remove()
        if (!contextLost.current) instance.remove()
      } catch {
        /* a half-built map is still better dropped than left attached */
      }
      contextLost.current = false
      if (captureRef) captureRef.current = null
      map.current = null
      ready.current = false
      markers.current.clear()
      labels.current.clear()
    }
  }, [attempt])

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
      onViewChange({ lat: center.lat, lng: center.lng, zoom: instance.getZoom() })
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
          // Translucent by default so the streets underneath stay legible —
          // the shading is context for the map, not a replacement for it —
          // but how translucent is the viewer's to decide.
          'fill-opacity': choroplethOpacity,
        },
      },
      {
        id: 'shading-line',
        type: 'line',
        source: 'shading',
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 1,
          // Outlines track the fill so a faded layer fades whole.
          'line-opacity': Math.min(1, choroplethOpacity + 0.15),
        },
      },
    ])

    // upsert only refreshes an existing source's data — the paint above is
    // read once, when the layer is first added. So an opacity the viewer
    // changes afterwards has to be pushed onto the live layer, or the slider
    // moves and the map does not.
    if (instance.getLayer('shading-fill')) {
      instance.setPaintProperty('shading-fill', 'fill-opacity', choroplethOpacity)
    }
    if (instance.getLayer('shading-line')) {
      instance.setPaintProperty('shading-line', 'line-opacity', Math.min(1, choroplethOpacity + 0.15))
    }
  }, [loaded, choropleth, choroplethOpacity])

  /*
   * The published layers, synced to whatever the catalog currently offers.
   *
   * Sources and layers are created once per id and then only updated, because
   * a market's permits are megabytes and re-adding them on every paint change
   * would rebuild the tile index for nothing. Anything no longer in the list
   * is removed outright — switching a layer off must leave no trace on the
   * map or in memory.
   */
  const extraIds = useRef<string[]>([])
  useEffect(() => {
    const instance = map.current
    if (!instance || !loaded) return

    const wanted = extras ?? []
    const live = new Set(wanted.map((layer) => layer.id))

    for (const id of extraIds.current) {
      if (live.has(id)) continue
      for (const suffix of ['fill', 'line', 'point']) {
        const layerId = `x-${id}-${suffix}`
        if (instance.getLayer(layerId)) instance.removeLayer(layerId)
      }
      if (instance.getSource(`x-${id}`)) instance.removeSource(`x-${id}`)
    }
    extraIds.current = [...live]

    for (const layer of wanted) {
      const source = `x-${layer.id}`
      const existing = instance.getSource(source) as maplibregl.GeoJSONSource | undefined
      if (existing) {
        existing.setData(layer.data)
      } else {
        instance.addSource(source, { type: 'geojson', data: layer.data })
        const specs: maplibregl.LayerSpecification[] =
          layer.kind === 'point'
            ? [{ id: `x-${layer.id}-point`, type: 'circle', source, paint: {} }]
            : layer.kind === 'line'
              ? [{ id: `x-${layer.id}-line`, type: 'line', source, paint: {} }]
              : [
                  { id: `x-${layer.id}-fill`, type: 'fill', source, paint: {} },
                  { id: `x-${layer.id}-line`, type: 'line', source, paint: {} },
                ]
        for (const spec of specs) instance.addLayer(spec, insertBefore(spec.id))
      }

      // Paint every time: colour and opacity are the viewer's controls, and
      // a layer added earlier would otherwise keep the shade it was born with.
      const fill = `x-${layer.id}-fill`
      const line = `x-${layer.id}-line`
      const point = `x-${layer.id}-point`

      /*
       * One colour, or one per category. A match expression reads the
       * feature's own field, so the tiles do the lookup rather than the
       * browser walking twenty thousand features on every repaint.
       */
      const paintColor: unknown = layer.categories
        ? [
            'match',
            ['coalesce', ['get', layer.categories.field], ''],
            ...Object.entries(layer.categories.colors).flatMap(([value, hue]) => [value, hue]),
            layer.color,
          ]
        : layer.color

      if (instance.getLayer(fill)) {
        instance.setPaintProperty(fill, 'fill-color', paintColor as string)
        instance.setPaintProperty(fill, 'fill-opacity', layer.opacity * 0.55)
      }
      if (instance.getLayer(line)) {
        instance.setPaintProperty(line, 'line-color', paintColor as string)
        instance.setPaintProperty(line, 'line-width', layer.kind === 'line' ? 2.5 : 1)
        instance.setPaintProperty(line, 'line-opacity', Math.min(1, layer.opacity + 0.2))
      }
      if (instance.getLayer(point)) {
        instance.setPaintProperty(point, 'circle-color', paintColor as string)
        instance.setPaintProperty(point, 'circle-opacity', layer.opacity)
        instance.setPaintProperty(point, 'circle-stroke-color', '#ffffff')
        instance.setPaintProperty(point, 'circle-stroke-width', 0.6)
        // Small when a county is in view, readable once someone is working a
        // block: a permit dot has to be clickable without hiding the parcel.
        instance.setPaintProperty(point, 'circle-radius', [
          'interpolate', ['linear'], ['zoom'], 10, 2.2, 14, 4.5, 17, 8,
        ])
      }
    }
  }, [loaded, extras])

  /*
   * What a published feature says when it is clicked.
   *
   * Only the fields the pipeline kept, in the order it kept them, and only
   * when the click did not land on a parcel — the parcel is the subject and
   * these are context, same rule as the tracts.
   */
  useEffect(() => {
    const instance = map.current
    if (!instance || !loaded || onMapClick) return undefined
    const wanted = extras ?? []
    if (!wanted.length) return undefined

    const handlers: [string, (event: maplibregl.MapLayerMouseEvent) => void][] = []
    for (const layer of wanted) {
      const open = (event: maplibregl.MapLayerMouseEvent) => {
        if (instance.getLayer('parcel-fill')) {
          if (instance.queryRenderedFeatures(event.point, { layers: ['parcel-fill'] }).length) return
        }
        const props = event.features?.[0]?.properties ?? {}
        if (onExtraPick) {
          onExtraPick({ layerId: layer.id, properties: props })
          return
        }
        // No handler, nothing to say. The panel is the only place a
        // feature's fields are ever read out now; a popup here would be a
        // second, worse copy of it that covers the map while it does so.
      }
      for (const suffix of ['fill', 'line', 'point']) {
        const id = `x-${layer.id}-${suffix}`
        if (instance.getLayer(id)) {
          instance.on('click', id, open)
          handlers.push([id, open])
        }
      }
    }
    return () => {
      for (const [id, open] of handlers) instance.off('click', id, open)
    }
  }, [loaded, extras, onMapClick, onExtraPick])

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
      // Into the panel with everything else. A tract is context, and context
      // belongs beside the subject rather than floating over it.
      onExtraPick?.({
        layerId: 'census-tract',
        properties: event.features?.[0]?.properties ?? {},
      })
    }
    instance.on('click', 'shading-fill', open)
    return () => {
      instance.off('click', 'shading-fill', open)
    }
  }, [loaded, onMapClick, choropleth, onExtraPick])

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
      const ramp = parcels.valueRamp?.length ? parcels.valueRamp : VALUE_RAMP
      const steps: unknown[] = ['step', ['get', 'mv'], ramp[0]]
      parcels.valueBreaks.forEach((cut, i) => steps.push(cut, ramp[i + 1] ?? ramp[ramp.length - 1]))
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
    const washOff = parcels.fillVisible === false
    instance.setPaintProperty('parcel-fill', 'fill-opacity', [
      'case',
      ['boolean', ['feature-state', 'sel'], false],
      0.7,
      ['boolean', ['feature-state', 'hover'], false],
      washOff ? 0.28 : Math.min((parcels.opacity ?? 0.34) + 0.24, 1),
      /*
       * Not zero, even though this reads as "no fill".
       *
       * A wholly transparent fill stops hit-testing, and the click target is
       * the entire point of drawing every parcel. Two per cent is below what
       * the eye resolves against any basemap — the outline is what you see —
       * while still giving the renderer a surface to catch the click on.
       */
      washOff ? 0.02 : parcels.opacity ?? 0.34,
    ])
    /*
     * Outline-only draws in ink, not in land use.
     *
     * With the wash on, the line repeats the fill's colour because the two are
     * one shape reading as one thing. With it off, the colour would be the
     * only thing left carrying land use, and a map of thin coloured threads
     * reads as noise. Ink says "here is a parcel" and nothing else, which is
     * what an unshaded map is for.
     */
    instance.setPaintProperty('parcel-line', 'line-opacity', washOff ? 0.85 : 0.5)
    instance.setPaintProperty('parcel-line', 'line-color', [
      'case',
      ['boolean', ['feature-state', 'sel'], false],
      '#C4A6FF',
      washOff ? PARCEL_INK : color,
    ])
  }, [loaded, parcels?.colorBy, parcels?.valueBreaks, parcels?.url, parcels?.opacity, parcels?.valueRamp, parcels?.fillVisible])

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

  /*
   * Go where the caller says, when the caller says it changed.
   *
   * With one exception, and it is the whole of "the map stays put when I
   * refresh": the first thing a market does is ask for its own centre, which
   * would throw away the position the URL just restored. A hash that was
   * already there is the more specific instruction, so the first ask is
   * skipped and every later one — switching markets, opening a saved view —
   * still moves the map.
   *
   * But only when the two are talking about the same place. The hash survives
   * everything — a reload, a hard reload, closing the tab and opening the
   * link again — so a position left over from another county strands the map
   * a thousand miles from the parcels it just loaded, and every reload puts
   * it back. That looks exactly like a map that will not load, and it cannot
   * be cleared by reloading, which is the worst property a bug can have.
   *
   * So the restore has to agree with the market. If it does not, the market
   * wins: it is the thing the person just chose, and the hash is a memory of
   * something else.
   */
  useEffect(() => {
    const instance = map.current
    if (!instance || !loaded || !view) return
    if (!viewApplied.current) {
      viewApplied.current = true
      if (hadHash.current) {
        const here = instance.getCenter()
        const stray =
          Math.abs(here.lng - view.center[0]) > SAME_MARKET_DEGREES ||
          Math.abs(here.lat - view.center[1]) > SAME_MARKET_DEGREES
        if (!stray) return
      }
    }
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
      <div key={attempt} ref={container} className={className} role="application" aria-label="Property map" />

      {/*
        * Said out loud rather than silently swapped. A basemap changing under
        * the viewer is confusing; a blank map with no explanation is worse.
        */}
      {engineNote ? (
        /*
         * pointer-events-none on the shield, restored on the card. The shield
         * spans the whole map area and sits above the tool rail, so left
         * interactive it silently ate every click and scroll on the layers
         * panel and the account menu — "the side menu will not scroll" was
         * this overlay, not the menu.
         */
        <div className="pointer-events-none absolute inset-0 z-[550] flex items-center justify-center">
          <div className="pointer-events-auto w-80 max-w-[90%] rounded-lg border border-line bg-surface/97 p-4 text-center shadow-xl backdrop-blur">
            <p className="text-sm font-semibold text-ink">The map did not start</p>
            <p className="mt-1 text-xs leading-snug text-body">{engineNote}</p>
            {/*
              * Two buttons, cheapest first. Rebuilding the engine keeps the
              * work already on screen — the market, the filters, the pins —
              * where a reload throws all of it away, and it is what actually
              * cures a lost graphics context. The reset stays for the case
              * where a stored view or basemap is the thing at fault.
              */}
            <div className="mt-3 flex flex-col gap-2">
              <button
                type="button"
                className="rounded-md bg-ink px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
                onClick={() => {
                  setEngineNote(null)
                  startupError.current = null
                  autoTries.current = 0
                  setAttempt((n) => n + 1)
                }}
              >
                Try again
              </button>
              <button
                type="button"
                className="rounded-md border border-line px-3 py-1.5 text-xs font-medium text-ink hover:bg-sunken"
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
