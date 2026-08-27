import { useEffect, useMemo, useRef, useState } from 'react'
import MapCanvas from '../components/MapCanvas'
import ParcelPanel, { type PanelGroup } from '../components/ParcelPanel'
import GisRail, {
  CheckList,
  LAYER_ICONS,
  LayerGrid,
  RangeInput,
  type LayerCard,
  type RailTab,
} from '../components/GisRail'
import { api } from '../api'
import { navigate } from '../lib/router'
import type { Deal, Place, TileConfig } from '../types'

/*
 * GIS: the county's own parcel record, underneath everything else.
 *
 * The data is not this app's. It is published by each county assessor, built
 * into vector tiles by the Prospector pipeline and served from R2, so this
 * view fetches rather than stores. That is also why a market is chosen rather
 * than assumed: coverage is per county, and what a county publishes differs
 * enough that the map has to be told how to colour itself.
 */

/*
 * The catalog lives on R2 with the heavy data, published by the pipeline
 * through the ingest door the moment a build finishes. Reading it from the
 * same place means a new county appears here with no site deploy between
 * the pipeline and the customer.
 */
const CATALOG_DEFAULT = 'https://data.realestateaistudio.com'

/*
 * Both hosts are overridable so the map can be looked at from a sandbox that
 * cannot reach the open internet: VITE_PARCEL_CATALOG moves the catalogue,
 * VITE_PARCEL_PROXY rewrites the absolute data host that meta.json hands back.
 * Neither is set in a normal build, so production talks to the real hosts.
 */
const CATALOG = import.meta.env.VITE_PARCEL_CATALOG || CATALOG_DEFAULT
const DATA_PROXY = import.meta.env.VITE_PARCEL_PROXY || ''

function viaProxy(url: string): string {
  if (!DATA_PROXY || !url.startsWith('https://')) return url
  return url.replace(/^https:\/\/([^/]+)/, `${DATA_PROXY}/$1`)
}

/** A fetch that treats an error page as the failure it is, not as JSON. */
const asJson = (r: Response) => {
  if (!r.ok) throw new Error(`${r.status}`)
  return r.json()
}

/*
 * Is this tab running an older build than the server is serving?
 *
 * A single-page app can outlive its own deployment: the tab keeps running
 * whatever bundle it loaded, and if a deploy changed what that bundle asks
 * for, its requests start failing in ways no amount of server health can
 * explain. So when a catalog fetch fails, ask the server which commit it is
 * on — if it differs from the one baked in here, the cure is a reload, and
 * the error should say so instead of shrugging.
 */
async function bundleIsStale(): Promise<boolean> {
  if (__BUILD_COMMIT__ === 'dev') return false
  try {
    const health = await fetch('/api/health').then((r) => r.json())
    return typeof health.commit === 'string' && health.commit !== 'dev' && health.commit !== __BUILD_COMMIT__
  } catch {
    return false
  }
}

interface Market {
  slug: string
  name: string
  region: string
  status: string
  stats?: { parcels: number; value: number; center?: [number, number] }
}

interface MarketMeta {
  market: string
  region: string
  center: [number, number]
  zoom: number
  heavyBase?: string
  colorBy?: 'value'
  valueLabel?: string
  idLabel?: string
  panel?: PanelGroup[]
  note?: string
  attribution?: string
  tiles?: boolean
  count?: number
}

/** Attributes for every parcel in a market, stored one array per field. */
interface MarketIndex {
  n: number
  keys: string[]
  cols: Record<string, (string | number | null)[]>
  /** Four numbers per parcel: west, south, east, north. */
  bb: number[]
}

/**
 * What the pipeline made of a market's owner names.
 *
 * `p` is portfolios: one holder resolved across spelling variants, keyed by
 * the id every one of its parcels carries. `b` is back offices: one mailing
 * address that several different names answer to, which is how a single
 * operator behind a row of single-purpose LLCs becomes visible. `t` lists
 * those names. Values are the market total each group holds.
 */
interface OwnerGroup {
  /** Portfolio name. Back offices have names in `t` instead. */
  n?: string
  /** Mailing address. */
  a?: string
  /** Parcels held. */
  c: number
  /** Market value held. */
  v: number
  /** Distinct names at this address, for back offices. */
  t?: string[]
}

/**
 * A layer this market publishes that the app has no built-in knowledge of.
 *
 * The pipeline fetches somebody's operational map — permits, zoning, flood,
 * opportunity zones — and describes it here: what to call it, how it draws,
 * and which file holds it. Everything the catalog says, the app obeys, which
 * is what lets a market gain a layer without this file changing.
 */
interface PublishedLayer {
  id: string
  label: string
  note?: string
  kind: 'point' | 'polygon' | 'line'
  color: string
  file: string
  count?: number
  attribution?: string
  fields?: string[]
}

interface OwnerIndex {
  p?: Record<string, OwnerGroup>
  b?: Record<string, OwnerGroup>
}

/** The land-use colours, matching what the map draws. */
const LEGEND: [string, string][] = [
  ['Commercial', '#2a78d6'],
  ['Multifamily', '#eb6834'],
  ['Vacant land', '#1baf7a'],
  ['Single family', '#9AA1B4'],
  ['Other', '#5C6377'],
]

const VALUE_RAMP = ['#EDE7FA', '#D6C6F3', '#BBA0EA', '#9D77DD', '#7F4FCB', '#6031AE', '#43208A']

/*
 * Ramps for the shaded layers.
 *
 * Every one is a single hue running light to dark, because these carry
 * magnitudes: a rainbow would invent categories where there is only more and
 * less. Which hue to use is a real choice though — it has to survive being
 * printed, projected in a lit room, and laid over whichever basemap the
 * viewer picked — so it belongs to the viewer, not to this file.
 */
const RAMPS: { id: string; label: string; colors: string[] }[] = [
  { id: 'violet', label: 'Violet', colors: VALUE_RAMP },
  {
    id: 'teal',
    label: 'Teal',
    colors: ['#E0F2F1', '#B2DFDB', '#80CBC4', '#4DB6AC', '#26A69A', '#00897B', '#00695C'],
  },
  {
    id: 'amber',
    label: 'Amber',
    colors: ['#FFF3E0', '#FFE0B2', '#FFCC80', '#FFB74D', '#FB8C00', '#EF6C00', '#E65100'],
  },
  {
    id: 'blue',
    label: 'Blue',
    colors: ['#E3F2FD', '#BBDEFB', '#90CAF9', '#64B5F6', '#2196F3', '#1976D2', '#0D47A1'],
  },
  {
    id: 'slate',
    label: 'Neutral',
    colors: ['#F1F3F6', '#DDE1E8', '#C3C9D4', '#A3ABBB', '#7F899C', '#5C6377', '#3B4152'],
  },
]

/*
 * Icons for the layers a market publishes.
 *
 * Matched by the registry's own id, so a source gains its mark by being
 * named — and anything unrecognised still gets a card, with the generic
 * layers mark, because the catalog is allowed to know things this file
 * does not.
 */
const PUBLISHED_ICONS: Record<string, JSX.Element> = {
  zoning: LAYER_ICONS.zoning,
  permits: LAYER_ICONS.pipeline,
  'plan-review': LAYER_ICONS.entitlements,
  'opportunity-zones': LAYER_ICONS.absorption,
  schools: LAYER_ICONS.demographics,
  'school-districts': LAYER_ICONS.zoning,
  txdot: LAYER_ICONS.absorption,
}

const rampOf = (id: string) => RAMPS.find((r) => r.id === id)?.colors ?? VALUE_RAMP

/** A percentage slider for a layer's opacity. The one control every layer has. */
function OpacityRow({
  id,
  label,
  value,
  onChange,
}: {
  id: string
  label: string
  value: number
  onChange: (next: number) => void
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <label className="text-[11px] font-medium text-body" htmlFor={id}>
          {label}
        </label>
        <span className="text-[10px] tabular-nums text-muted">{Math.round(value * 100)}%</span>
      </div>
      <input
        id={id}
        type="range"
        min={0}
        max={1}
        step={0.02}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full accent-accent"
      />
    </div>
  )
}

/** The ramp picker: each option shown as the gradient it actually paints. */
function RampRow({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-medium text-body">Colour</p>
      <div className="flex flex-wrap gap-1.5">
        {RAMPS.map((ramp) => (
          <button
            key={ramp.id}
            type="button"
            title={ramp.label}
            aria-label={ramp.label}
            aria-pressed={value === ramp.id}
            onClick={() => onChange(ramp.id)}
            className={`flex h-6 w-12 overflow-hidden rounded border ${
              value === ramp.id ? 'border-accent ring-1 ring-accent/40' : 'border-line'
            }`}
          >
            {ramp.colors.map((hue) => (
              <span key={hue} className="flex-1" style={{ backgroundColor: hue }} />
            ))}
          </button>
        ))}
      </div>
    </div>
  )
}

/** The columns worth handing to someone else, in the order they read. */
const CSV_COLUMNS: [string, string][] = [
  ['gid', 'Parcel'],
  ['ad', 'Address'],
  ['zp', 'ZIP'],
  ['ow', 'Owner of record'],
  ['at', 'Asset type'],
  ['mv', 'Value'],
  ['lv', 'Land value'],
  ['iv', 'Improvements'],
  ['ac', 'Acres'],
  ['tr', 'Census tract'],
]

/**
 * A CSV of what is on screen.
 *
 * Quoted and doubled rather than escaped: an owner of record is a legal name
 * and legal names contain commas, so anything less loses a column halfway
 * down a file nobody re-reads.
 */
function exportCsv(rows: Record<string, string | number | null>[], slug: string) {
  const cell = (value: string | number | null) => {
    const text = value == null ? '' : String(value)
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const header = CSV_COLUMNS.map(([, label]) => label).join(',')
  const body = rows.map((row) => CSV_COLUMNS.map(([key]) => cell(row[key] ?? null)).join(',')).join('\n')
  const blob = new Blob([`${header}\n${body}\n`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${slug}-parcels.csv`
  link.click()
  URL.revokeObjectURL(url)
}

/** A census figure, in the units its field declares — the panel's own rules. */
function censusValue(value: number, kind: string): string {
  if (!Number.isFinite(value)) return '—'
  if (kind === 'money') return `$${Math.round(value).toLocaleString()}`
  if (kind === 'pct') return `${value.toFixed(1)}%`
  if (kind === 'one') return value.toFixed(1)
  return Math.round(value).toLocaleString()
}

const money = (n: number) => {
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`
  return `$${Math.round(n).toLocaleString()}`
}

export default function Gis({ tiles, basemaps, slug }: { tiles: TileConfig; basemaps?: TileConfig[]; slug?: string }) {
  const [markets, setMarkets] = useState<Market[]>([])
  const [active, setActive] = useState<string | null>(slug ?? null)
  const [meta, setMeta] = useState<MarketMeta | null>(null)
  const [index, setIndex] = useState<MarketIndex | null>(null)
  const [rowOf, setRowOf] = useState<Map<string | number, number>>(new Map())
  const [selected, setSelected] = useState<string | number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const activeRef = useRef<string | null>(null)
  activeRef.current = active
  const [known, setKnown] = useState<{ place: Place | null; deals: Deal[] } | null>(null)
  const [saving, setSaving] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [details, setDetails] = useState<Record<string, string | number | null> | null>(null)
  const [detailsLoading, setDetailsLoading] = useState(false)
  const [codes, setCodes] = useState<Record<string, { d?: string }>>({})

  const [rail, setRail] = useState<RailTab | null>('layers')
  const [showParcels, setShowParcels] = useState(true)
  const [showOwners, setShowOwners] = useState(false)
  /*
   * Who is behind the parcels.
   *
   * The pipeline already resolves each market's owner names into portfolios
   * (one holder, many parcels) and back offices (one mailing address behind
   * several names), and stamps every parcel with the id of each. owners.json
   * carries what those ids mean, so this is a small fetch that turns a column
   * of numbers into "everything City of Austin owns".
   */
  const [owners, setOwners] = useState<OwnerIndex | null>(null)
  const [ownerPick, setOwnerPick] = useState<{ kind: 'p' | 'b'; id: string } | null>(null)
  /*
   * How each layer draws. Every layer that paints something owns its opacity
   * and, where it shades by magnitude, its ramp — because two layers stacked
   * over a satellite basemap is a judgement about legibility that only the
   * person looking at it can make.
   */
  /*
   * The published layers: what this market offers, what is switched on, the
   * geometry once fetched, and the viewer's colour and opacity for each. All
   * keyed by layer id, because the set of layers is the catalog's to decide.
   */
  const [published, setPublished] = useState<PublishedLayer[]>([])
  const [layerOn, setLayerOn] = useState<Record<string, boolean>>({})
  const [layerData, setLayerData] = useState<Record<string, GeoJSON.FeatureCollection>>({})
  const [layerStyle, setLayerStyle] = useState<Record<string, { color: string; opacity: number }>>({})
  const [layerBusy, setLayerBusy] = useState<Record<string, boolean>>({})
  const [censusOpacity, setCensusOpacity] = useState(0.45)
  const [censusRamp, setCensusRamp] = useState('violet')
  const [parcelRamp, setParcelRamp] = useState('violet')
  /** 'auto' follows what the county publishes; the rest override it. */
  const [parcelColorBy, setParcelColorBy] = useState<'auto' | 'group' | 'value'>('auto')
  const [showCensus, setShowCensus] = useState(false)
  const [showZoning, setShowZoning] = useState(false)
  const [metric, setMetric] = useState('inc')
  const [censusYear, setCensusYear] = useState<number | null>(null)
  const [census, setCensus] = useState<{
    fields: [string, string, string][]
    tracts: Record<string, Record<string, number | string>>
    shapes: { tr: string; geometry: unknown }[]
  } | null>(null)
  const [opacity, setOpacity] = useState(0.34)
  const [query, setQuery] = useState('')
  const [assets, setAssets] = useState<Set<string>>(new Set())
  const [value, setValue] = useState({ min: '', max: '' })
  const [acres, setAcres] = useState({ min: '', max: '' })

  // The scout: a hunt typed in plain English, answered as the filters above.
  const [hunt, setHunt] = useState('')
  const [hunting, setHunting] = useState(false)
  const [huntNote, setHuntNote] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)

  useEffect(() => {
    fetch(`${CATALOG}/markets.json`)
      .then(asJson)
      .then((d) => {
        const live: Market[] = (d.markets || []).filter((m: Market) => m.status === 'live')
        setMarkets(live)
        setActive((current) => current || live[0]?.slug || null)
      })
      .catch(() => {
        bundleIsStale().then((outdated) => (outdated ? setStale(true) : setError('Could not reach the parcel catalogue.')))
      })
  }, [])

  // Meta first: it carries where the market opens and how it is coloured.
  useEffect(() => {
    if (!active) return
    setMeta(null)
    setIndex(null)
    setSelected(null)
    // Filters do not travel between markets: an asset type one county
    // publishes may not exist in the next, and a stale filter would show an
    // empty map with no explanation.
    setAssets(new Set())
    setValue({ min: '', max: '' })
    setAcres({ min: '', max: '' })
    setQuery('')
    setHunt('')
    setHuntNote(null)
    setOwners(null)
    setOwnerPick(null)
    setPublished([])
    setLayerOn({})
    setLayerData({})
    setLayerStyle({})
    setError(null)
    fetch(`${CATALOG}/${active}/meta.json`)
      .then(asJson)
      .then(setMeta)
      .catch(() => {
        bundleIsStale().then((outdated) => (outdated ? setStale(true) : setError('Could not load that market.')))
      })
  }, [active])

  /*
   * The attribute index arrives behind the map, not in front of it.
   *
   * The tiles carry only what the style reads, so a parcel's address and owner
   * live here. It is a couple of megabytes, which is worth waiting for after
   * the map is usable and never worth blocking it on.
   */
  useEffect(() => {
    if (!meta?.heavyBase) return
    let cancelled = false
    fetch(`${viaProxy(meta.heavyBase)}index.json`)
      .then((r) => r.json())
      .then((data: MarketIndex) => {
        if (cancelled) return
        const ids = data.cols.id || []
        const lookup = new Map<string | number, number>()
        ids.forEach((id, row) => {
          if (id != null) lookup.set(id as string | number, row)
        })
        setIndex(data)
        setRowOf(lookup)
      })
      .catch(() => {
        /* the map still works; the card just stays thin */
      })
    return () => {
      cancelled = true
    }
  }, [meta?.heavyBase])

  /*
   * Whether this parcel is already in the CRM.
   *
   * Asked in this direction on purpose: the map holds tens of thousands of
   * parcels and the CRM holds a handful of places, so the map has an id and
   * asks whether it means anything here — never the reverse.
   */
  useEffect(() => {
    if (selected == null || !active) {
      setKnown(null)
      setExpanded(false)
      return
    }
    let cancelled = false
    setKnown(null)
    api.crm
      .parcel(active, String(selected))
      .then((found) => {
        if (!cancelled) setKnown(found)
      })
      .catch(() => {
        if (!cancelled) setKnown({ place: null, deals: [] })
      })
    return () => {
      cancelled = true
    }
  }, [selected, active])

  /*
   * What extra layers this market publishes.
   *
   * A small file, fetched with the market, listing somebody else's live map
   * per entry. A market that publishes none simply has none — this is not an
   * error, and older markets predate the registry entirely.
   */
  useEffect(() => {
    if (!active) return undefined
    let cancelled = false
    fetch(`${CATALOG}/${active}/layers.json`)
      .then(asJson)
      .then((doc: { layers?: PublishedLayer[] }) => {
        if (cancelled) return
        const list = doc.layers ?? []
        setPublished(list)
        setLayerStyle(
          Object.fromEntries(list.map((layer) => [layer.id, { color: layer.color, opacity: 0.7 }])),
        )
      })
      .catch(() => {
        // No registry here yet. Nothing to say about it.
      })
    return () => {
      cancelled = true
    }
  }, [active])

  /*
   * The geometry behind a layer, fetched the first time it is switched on
   * and kept after. These run to megabytes, so nothing is loaded until
   * someone asks to see it.
   */
  useEffect(() => {
    if (!active) return
    for (const layer of published) {
      if (!layerOn[layer.id] || layerData[layer.id] || layerBusy[layer.id]) continue
      setLayerBusy((busy) => ({ ...busy, [layer.id]: true }))
      fetch(`${CATALOG}/${active}/${layer.file}`)
        .then(asJson)
        .then((data: GeoJSON.FeatureCollection) => {
          setLayerData((current) => ({ ...current, [layer.id]: data }))
        })
        .catch(() => setError(`Could not load the ${layer.label.toLowerCase()} layer.`))
        .finally(() => setLayerBusy((busy) => ({ ...busy, [layer.id]: false })))
    }
  }, [published, layerOn, layerData, layerBusy, active])

  /** What the map should draw: every layer switched on, with its geometry. */
  const extras = useMemo(
    () =>
      published
        .filter((layer) => layerOn[layer.id] && layerData[layer.id])
        .map((layer) => ({
          id: layer.id,
          kind: layer.kind,
          data: layerData[layer.id],
          color: layerStyle[layer.id]?.color ?? layer.color,
          opacity: layerStyle[layer.id]?.opacity ?? 0.7,
          fields: layer.fields,
        })),
    [published, layerOn, layerData, layerStyle],
  )

  /*
   * The owner groups, fetched only once someone asks for them.
   *
   * Small — a couple of megabytes at county scale — and useless until the
   * layer is on, so it waits. The parcels already carry the ids, so this
   * only supplies the names behind them.
   */
  useEffect(() => {
    if (!showOwners || !active || owners) return undefined
    let cancelled = false
    fetch(`${CATALOG}/${active}/owners.json`)
      .then(asJson)
      .then((doc: OwnerIndex) => {
        if (!cancelled) setOwners(doc)
      })
      .catch(() => setError('Could not load ownership for this market.'))
    return () => {
      cancelled = true
    }
  }, [showOwners, active, owners])

  /*
   * The census layer, fetched only once someone asks for it.
   *
   * Two files, both published per market: the finished ACS numbers, and the
   * tract outlines to hang them on. Neither is needed to draw parcels, and
   * together they are heavier than the map itself in a market like Broward
   * with four hundred tracts, so nothing is fetched until the layer is on.
   */
  useEffect(() => {
    if (!showCensus || !active || census) return undefined
    let cancelled = false
    Promise.all([
      fetch(`${CATALOG}/${active}/census.json`).then((r) => r.json()),
      fetch(`${CATALOG}/${active}/tracts.geojson`).then((r) => r.json()),
    ])
      .then(([numbers, shapes]) => {
        if (cancelled) return
        setCensusYear(numbers.year ?? null)
        setCensus({
          fields: numbers.fields,
          tracts: numbers.tracts,
          shapes: (shapes.features || []).map((f: { properties: { tr: string }; geometry: unknown }) => ({
            tr: f.properties.tr,
            geometry: f.geometry,
          })),
        })
      })
      .catch(() => setError('Could not load demographics for this market.'))
    return () => {
      cancelled = true
    }
  }, [showCensus, active, census])

  // A new market means new tracts; drop the old ones rather than shading the
  // wrong city with them.
  useEffect(() => {
    setCensus(null)
    setDetails(null)
    setCodes({})
    fetchingDetails.current = false
  }, [active])

  /*
   * Tract shading.
   *
   * Quantile breaks over the tracts this market actually touches, not over a
   * national range: a median income ramp fixed to the whole country would
   * render one city as a single flat colour. Purple because the four parcel
   * hues are blue, orange, green and grey, and a sequential ramp has to be a
   * part of the wheel nothing else occupies.
   */
  /** What the parcels end up coloured by, after any override. */
  const effectiveColorBy: 'group' | 'value' =
    parcelColorBy === 'auto' ? (meta?.colorBy === 'value' ? 'value' : 'group') : parcelColorBy

  const choropleth = useMemo(() => {
    if (!showCensus || !census) return null
    const values = census.shapes
      .map((shape) => Number(census.tracts[shape.tr]?.[metric]))
      .filter((v) => Number.isFinite(v) && v > 0)
      .sort((a, b) => a - b)
    if (!values.length) return null
    const ramp = rampOf(censusRamp)
    const breaks: number[] = []
    for (let i = 1; i < ramp.length; i += 1) {
      breaks.push(values[Math.floor((i * values.length) / ramp.length)])
    }
    const field = census.fields.find(([key]) => key === metric)
    const label = field?.[1] ?? metric
    const kind = field?.[2] ?? 'count'
    const areas = census.shapes.map((shape) => {
      const row = census.tracts[shape.tr]
      const value = Number(row?.[metric])
      let color: string | null = null
      if (Number.isFinite(value) && value > 0) {
        let step = 0
        while (step < breaks.length && value >= breaks[step]) step += 1
        color = ramp[step]
      }
      return {
        geoid: shape.tr,
        geometry: shape.geometry,
        color,
        info: row
          ? `<strong>${row.n ?? shape.tr}</strong><br>${label}: ${
              Number.isFinite(value) && value > 0 ? Math.round(value).toLocaleString() : 'not published'
            }`
          : null,
      }
    })
    // The legend draws this scale; the same sorted values the breaks came
    // from, so the bar and the map can never disagree.
    return {
      areas,
      label,
      kind,
      scale: {
        min: values[0],
        median: values[Math.floor(values.length / 2)],
        max: values[values.length - 1],
      },
    }
  }, [showCensus, census, metric, censusRamp])

  /** Value breaks, computed from the market itself rather than guessed. */
  const valueBreaks = useMemo(() => {
    if (!index || meta?.colorBy !== 'value') return null
    const values = (index.cols.mv || [])
      .map((v) => Number(v) || 0)
      .filter((v) => v > 0)
      .sort((a, b) => a - b)
    if (!values.length) return null
    const breaks: number[] = []
    for (let i = 1; i < 7; i += 1) breaks.push(values[Math.floor((i * values.length) / 7)])
    return breaks
  }, [index, meta?.colorBy])

  const parcel = useMemo(() => {
    if (selected == null || !index) return null
    const row = rowOf.get(selected)
    if (row == null) return null
    const out: Record<string, string | number | null> = {}
    for (const key of index.keys) out[key] = index.cols[key]?.[row] ?? null
    return out
  }, [selected, index, rowOf])

  /*
   * The county's full record, fetched the first time it is asked for.
   *
   * details.json is the heaviest file a market publishes — fourteen megabytes
   * in Broward — and nothing on the map needs it. It is only ever read to fill
   * this panel, so it downloads on the first expand and is reused after that.
   */
  /*
   * The in-flight guard is a ref, not state, and that is not a style choice.
   *
   * With `detailsLoading` in the dependency array, setting it re-ran the
   * effect, which ran the previous run's cleanup, which set `cancelled` — so
   * the fetch this effect had just started was cancelled by the flag saying it
   * had started. It downloaded six megabytes and threw the result away, and
   * the panel read 'Loading…' forever. A ref changes no dependency, so the
   * request outlives the render that began it.
   */
  const fetchingDetails = useRef(false)
  useEffect(() => {
    const base = meta?.heavyBase
    if (!expanded || !base || !active || fetchingDetails.current) return
    fetchingDetails.current = true
    setDetailsLoading(true)
    const market = active
    Promise.all([
      fetch(`${viaProxy(base)}details.json`).then((r) => r.json()),
      fetch(`${CATALOG}/${market}/codes.json`).then((r) => r.json()).catch(() => ({})),
    ])
      .then(([record, table]) => {
        // The market can be switched while six megabytes are in flight; the
        // wrong county's records would silently fill the panel.
        if (market !== activeRef.current) return
        setDetails(record)
        setCodes(table)
      })
      .catch(() => setError('Could not load the full record for this market.'))
      .finally(() => {
        fetchingDetails.current = false
        setDetailsLoading(false)
      })
  }, [expanded, meta?.heavyBase, active])

  /** Rows as plain objects, built once per market rather than per keystroke. */
  const rows = useMemo(() => {
    if (!index) return []
    const { keys, cols, n } = index
    const out: Record<string, string | number | null>[] = new Array(n)
    for (let i = 0; i < n; i += 1) {
      const row: Record<string, string | number | null> = {}
      for (const key of keys) row[key] = cols[key]?.[i] ?? null
      out[i] = row
    }
    return out
  }, [index])

  /** Asset types this county actually publishes, with how many of each. */
  const assetOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const row of rows) {
      const at = String(row.at || '').trim()
      if (at) counts.set(at, (counts.get(at) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count)
  }, [rows])

  /*
   * The one filtered set.
   *
   * Search, the filter panel and the report all read this, so the number in
   * the report is by construction the set the map is drawing. Returning null
   * when nothing is set matters: it is the difference between "show
   * everything" and "show these thirty thousand", and the second is a filter
   * expression the size of the county.
   */
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const lo = (raw: string) => (raw.trim() === '' ? null : Number(raw))
    const vMin = lo(value.min)
    const vMax = lo(value.max)
    const aMin = lo(acres.min)
    const aMax = lo(acres.max)
    const active =
      Boolean(needle) || assets.size > 0 || ownerPick != null ||
      [vMin, vMax, aMin, aMax].some((n) => n != null && Number.isFinite(n))
    if (!active || !rows.length) return null

    const out: Record<string, string | number | null>[] = []
    for (const row of rows) {
      // A chosen owner narrows the map to their holdings, which is the whole
      // point of the layer: one operator's footprint across the county.
      if (ownerPick && String(row[ownerPick.kind === 'p' ? 'po' : 'bo'] ?? '') !== ownerPick.id) continue
      if (assets.size && !assets.has(String(row.at || ''))) continue
      const mv = Number(row.mv) || 0
      if (vMin != null && Number.isFinite(vMin) && mv < vMin) continue
      if (vMax != null && Number.isFinite(vMax) && mv > vMax) continue
      const ac = Number(row.ac) || 0
      if (aMin != null && Number.isFinite(aMin) && ac < aMin) continue
      if (aMax != null && Number.isFinite(aMax) && ac > aMax) continue
      if (needle) {
        const hay = `${row.ad ?? ''} ${row.ow ?? ''} ${row.gid ?? ''} ${row.id ?? ''}`.toLowerCase()
        if (!hay.includes(needle)) continue
      }
      out.push(row)
    }
    return out
  }, [rows, query, assets, value, acres, ownerPick])

  const filterIds = useMemo(
    () => (filtered ? filtered.map((row) => row.id as number | string) : null),
    [filtered],
  )

  /** What the current set adds up to. The report is a reading, not a second query. */
  const summary = useMemo(() => {
    const set = filtered ?? rows
    let total = 0
    let acreage = 0
    const byAsset = new Map<string, number>()
    for (const row of set) {
      total += Number(row.mv) || 0
      acreage += Number(row.ac) || 0
      const at = String(row.at || 'Unclassified')
      byAsset.set(at, (byAsset.get(at) ?? 0) + 1)
    }
    return {
      count: set.length,
      total,
      acreage,
      byAsset: [...byAsset.entries()].sort((a, b) => b[1] - a[1]),
    }
  }, [filtered, rows])

  /*
   * What this market can actually show.
   *
   * Decided from the data rather than declared: zoning is a layer in Nashville
   * and a blank column in Broward, and a card that offers it everywhere would
   * be promising something the county never published. `soon` is reserved for
   * things this product has not built yet, and is never used to paper over a
   * county that simply has no such record.
   */
  const coverage = useMemo(() => {
    const has = (key: string) =>
      rows.length > 0 && rows.some((row) => row[key] !== null && row[key] !== '' && row[key] !== 0)
    return {
      owner: has('ow'),
      zoning: has('zn'),
      tract: has('tr'),
      // Whether the pipeline resolved groups here, read from the parcels
      // themselves. Orange County publishes no owner names, so Costa Mesa has
      // no portfolios — but its mailing addresses still cluster into back
      // offices, and that is worth offering on its own.
      portfolios: has('po'),
      backOffices: has('bo'),
    }
  }, [rows])

  /**
   * The market's owner groups, largest holding first.
   *
   * Ranked by value rather than parcel count: a hundred lots in a subdivision
   * is not the story, four downtown blocks is. Only groups the loaded parcels
   * actually reference are listed, so a market that publishes fewer parcels
   * than the roll never offers an owner with nothing to show.
   */
  const ownerList = useMemo(() => {
    if (!owners) return []
    const seen = new Set<string>()
    for (const row of rows) {
      if (row.po != null) seen.add(`p:${row.po}`)
      if (row.bo != null) seen.add(`b:${row.bo}`)
    }
    const out: {
      key: string
      kind: 'p' | 'b'
      id: string
      title: string
      detail: string
      count: number
      value: number
    }[] = []
    for (const kind of ['p', 'b'] as const) {
      const groups = owners[kind]
      if (!groups) continue
      for (const [id, g] of Object.entries(groups)) {
        if (!seen.has(`${kind}:${id}`)) continue
        const names = g.t ?? []
        out.push({
          key: `${kind}:${id}`,
          kind,
          id,
          title: kind === 'p' ? g.n || 'Unnamed holder' : g.a || 'Unnamed address',
          detail:
            kind === 'p'
              ? g.a || ''
              : names.length
                ? `${names.length} names: ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`
                : '',
          count: g.c,
          value: g.v,
        })
      }
    }
    return out.sort((a, b) => b.value - a.value)
  }, [owners, rows])

  const pickedOwner = useMemo(
    () => (ownerPick ? ownerList.find((o) => o.key === `${ownerPick.kind}:${ownerPick.id}`) ?? null : null),
    [ownerPick, ownerList],
  )

  const layerCards: LayerCard[] = useMemo(() => {
    const pending = (label: string, icon: JSX.Element): LayerCard => ({
      id: label,
      label,
      state: 'soon',
      note: 'Not built yet',
      icon,
    })
    return [
      {
        id: 'parcels',
        label: 'Assessor parcels',
        state: showParcels ? 'on' : 'off',
        note: meta?.count ? `${meta.count.toLocaleString()} parcels` : undefined,
        icon: LAYER_ICONS.parcels,
      },
      {
        id: 'ownership',
        label: 'Ownership',
        // Live wherever the pipeline resolved groups. Costa Mesa has no owner
        // names to portfolio, but its mailing addresses still cluster, so the
        // layer is offered there too — for back offices only.
        state: coverage.portfolios || coverage.backOffices ? (showOwners ? 'on' : 'off') : 'unavailable',
        note:
          coverage.portfolios || coverage.backOffices
            ? ownerList.length
              ? `${ownerList.length.toLocaleString()} owner groups`
              : 'Portfolios and back offices'
            : 'County withholds owner names',
        icon: LAYER_ICONS.ownership,
      },
      {
        id: 'demographics',
        label: 'Demographics',
        state: coverage.tract ? (showCensus ? 'on' : 'off') : 'unavailable',
        note: coverage.tract ? 'ACS by census tract' : 'No tract on these parcels',
        icon: LAYER_ICONS.demographics,
      },
      ...(published.some((l) => l.id === 'zoning')
        ? []
        : [{
        id: 'zoning',
        label: 'Zoning',
        state: coverage.zoning ? 'soon' : 'unavailable',
        note: coverage.zoning ? 'Published here, not mapped yet' : 'Not published here',
        icon: LAYER_ICONS.zoning,
      } as LayerCard]),
      // Everything the market publishes, drawn from its own catalog. An icon
      // is matched by label where one fits; the rest get the generic layers
      // mark, because a card must appear for a source this app has never
      // heard of — that is the point of the registry.
      ...published.map(
        (layer): LayerCard => ({
          id: `x:${layer.id}`,
          label: layer.label,
          state: layerOn[layer.id] ? 'on' : 'off',
          note: layerBusy[layer.id]
            ? 'Loading…'
            : layer.count
              ? `${layer.count.toLocaleString()} ${layer.kind === 'point' ? 'points' : 'areas'}`
              : layer.note,
          icon: PUBLISHED_ICONS[layer.id] ?? LAYER_ICONS.parcels,
        }),
      ),
      // Still genuinely unbuilt: no public source publishes these, so they
      // stay honest rather than becoming empty cards.
      ...(published.some((l) => l.id === 'permits') ? [] : [pending('Development pipeline', LAYER_ICONS.pipeline)]),
      ...(published.some((l) => l.id === 'plan-review') ? [] : [pending('Entitlements', LAYER_ICONS.entitlements)]),
      pending('Market surveys', LAYER_ICONS.surveys),
      pending('Comps', LAYER_ICONS.comps),
      pending('Absorption', LAYER_ICONS.absorption),
      pending('Rent trends', LAYER_ICONS.rent),
      pending('Forecasts', LAYER_ICONS.forecasts),
    ]
  }, [showParcels, showOwners, showCensus, showZoning, coverage, meta?.count, ownerList.length, published, layerOn, layerBusy])

  /** The centre of the selected parcel, from its bounding box in the index. */
  const centre = useMemo(() => {
    if (selected == null || !index?.bb) return null
    const row = rowOf.get(selected)
    if (row == null) return null
    const [w, s, e, n] = index.bb.slice(row * 4, row * 4 + 4)
    if (![w, s, e, n].every(Number.isFinite)) return null
    return { lat: (s + n) / 2, lng: (w + e) / 2 }
  }, [selected, index, rowOf])

  /*
   * The scout writes into the same filter state a person would, so the map,
   * the count, the report and the CSV agree with the answer by construction —
   * and the panel below shows exactly what was understood, ready to correct.
   */
  async function runHunt() {
    const ask = hunt.trim()
    if (!ask || hunting) return
    setHunting(true)
    setHuntNote(null)
    try {
      const res = await api.gisScout({
        prompt: ask,
        assetTypes: assetOptions.map((option) => option.value),
        valueLabel: meta?.valueLabel || 'Value',
      })
      if (res.empty) {
        setHuntNote({
          tone: 'warn',
          text:
            res.source === 'ai'
              ? 'That did not translate into any filter this county supports.'
              : 'Could not read that. Try a phrasing like "vacant land over 5 acres under $2M" — or set an AI key on the server for free-form hunts.',
        })
      } else {
        const f = res.filters
        setAssets(new Set(f.assetTypes))
        setValue({
          min: f.valueMin != null ? String(f.valueMin) : '',
          max: f.valueMax != null ? String(f.valueMax) : '',
        })
        setAcres({
          min: f.acresMin != null ? String(f.acresMin) : '',
          max: f.acresMax != null ? String(f.acresMax) : '',
        })
        setQuery(f.keyword ?? '')
        setHuntNote({
          tone: 'ok',
          text: res.explanation ?? 'Filters set below — adjust them freely.',
        })
      }
    } catch (cause) {
      setHuntNote({
        tone: 'warn',
        text: cause instanceof Error ? cause.message : 'The scout could not answer.',
      })
    } finally {
      setHunting(false)
    }
  }

  async function addToCrm() {
    if (!parcel || !active || selected == null) return
    setSaving(true)
    try {
      const { record } = await api.crm.create<Place>('places', {
        name: String(parcel.ad || `Parcel ${parcel.gid ?? selected}`),
        address: parcel.ad ?? null,
        zip: parcel.zp ?? null,
        acreage: parcel.ac ?? null,
        market: active,
        parcelId: String(selected),
        lat: centre?.lat ?? null,
        lng: centre?.lng ?? null,
        notes: parcel.ow ? `Owner of record: ${parcel.ow}` : null,
      })
      setKnown({ place: record, deals: [] })
    } catch {
      setError('Could not save that parcel.')
    } finally {
      setSaving(false)
    }
  }

  /** The census figures for the tract this parcel sits in, when they are loaded. */
  const neighborhood = useMemo(() => {
    const tract = parcel?.tr
    if (!tract || !census) return null
    const row = census.tracts[String(tract)]
    if (!row) return null
    return census.fields
      .map(([key, label, kind]) => {
        const value = Number(row[key])
        if (!Number.isFinite(value)) return null
        const text =
          kind === 'money'
            ? `$${Math.round(value).toLocaleString()}`
            : kind === 'pct'
              ? `${value.toFixed(1)}%`
              : kind === 'one'
                ? value.toFixed(1)
                : Math.round(value).toLocaleString()
        return { label, value: text }
      })
      .filter((entry): entry is { label: string; value: string } => entry !== null)
  }, [parcel, census])

  const market = markets.find((m) => m.slug === active)

  return (
    <div className="relative h-full w-full">
      {meta?.tiles && meta.heavyBase ? (
        <MapCanvas
          tiles={tiles}
          basemaps={basemaps}
          properties={[]}
          parcels={
            showParcels
              ? {
                  url: `${viaProxy(meta.heavyBase)}parcels.pmtiles`,
                  colorBy: parcelColorBy === 'auto' ? (meta.colorBy === 'value' ? 'value' : 'group') : parcelColorBy,
                  valueBreaks,
                  selectedParcelId: selected,
                  onSelectParcel: setSelected,
                  filterIds,
                  // Dimmed while the census shading is on: a choropleth under
                  // three hundred thousand full-strength parcel fills reads
                  // as nothing at all — so switching demographics on drops
                  // this once, below, and the slider takes it back.
                  opacity,
                  valueRamp: rampOf(parcelRamp),
                }
              : null
          }
          view={{ center: meta.center, zoom: meta.zoom, key: active ?? '' }}
          choropleth={choropleth?.areas ?? null}
          choroplethOpacity={censusOpacity}
          extras={extras}
        />
      ) : stale ? (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted">
          <p>This tab is running an older version of Land Quotient than the server. Reload to pick up the update.</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-lg bg-ink px-4 py-2 text-sm font-medium text-white"
          >
            Reload now
          </button>
        </div>
      ) : (
        <div className="flex h-full w-full items-center justify-center text-sm text-muted">
          {error ?? (active ? 'Loading parcels…' : 'No markets available.')}
        </div>
      )}

      <GisRail
        open={rail !== null}
        tab={rail ?? 'layers'}
        onTab={setRail}
        badge={{
          filter: filtered ? String(filtered.length.toLocaleString()) : undefined,
        }}
      >
        {rail === 'layers' && (
          <div className="space-y-3">
            {/* The market belongs here rather than floating over the map:
                coverage is per county, so choosing one is choosing what the
                layer even is. */}
            <div>
              <label className="mb-1 block text-[11px] font-medium text-body" htmlFor="gis-market">
                Market
              </label>
              <select
                id="gis-market"
                className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink"
                value={active ?? ''}
                onChange={(event) => setActive(event.target.value)}
              >
                {markets.map((entry) => (
                  <option key={entry.slug} value={entry.slug}>
                    {entry.name} · {entry.region}
                  </option>
                ))}
              </select>
              {market?.stats && (
                <p className="mt-1 text-[11px] text-muted">
                  {market.stats.parcels.toLocaleString()} parcels · {money(market.stats.value)}
                  {!index && <span> · loading detail…</span>}
                </p>
              )}
            </div>

            <div className="border-t border-line pt-3">
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
                Layers
              </p>
              <LayerGrid
                cards={layerCards}
                onToggle={(id) => {
                  if (id === 'parcels') setShowParcels((on) => !on)
                  if (id === 'ownership')
                    setShowOwners((on) => {
                      // Switching the layer off must not leave the map filtered
                      // to an owner with nothing on screen to explain why.
                      if (on) setOwnerPick(null)
                      return !on
                    })
                  if (id === 'demographics')
                    setShowCensus((on) => {
                      // Shading a county through opaque parcels shows nothing,
                      // so the first time it goes on the parcels step back —
                      // once, as a starting point the slider can undo.
                      if (!on) setOpacity((current) => (current > 0.2 ? 0.12 : current))
                      return !on
                    })
                  if (id === 'zoning') setShowZoning((on) => !on)
                  if (id.startsWith('x:')) {
                    const key = id.slice(2)
                    setLayerOn((current) => ({ ...current, [key]: !current[key] }))
                  }
                }}
              />
            </div>

            {showOwners && (
              <div>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
                  Owner groups
                </p>
                {pickedOwner ? (
                  <div className="rounded-md border border-accent/40 bg-accent/5 p-2">
                    <p className="text-xs font-medium text-ink">{pickedOwner.title}</p>
                    {pickedOwner.detail && (
                      <p className="mt-0.5 text-[11px] text-muted">{pickedOwner.detail}</p>
                    )}
                    <p className="mt-1 text-[11px] text-body">
                      {pickedOwner.count.toLocaleString()} {pickedOwner.count === 1 ? 'parcel' : 'parcels'} · {money(pickedOwner.value)}
                    </p>
                    <button
                      type="button"
                      onClick={() => setOwnerPick(null)}
                      className="mt-1.5 text-[11px] font-medium text-accent underline"
                    >
                      Show the whole market again
                    </button>
                  </div>
                ) : !owners ? (
                  <p className="text-[11px] text-muted">Loading who is behind these parcels…</p>
                ) : ownerList.length === 0 ? (
                  <p className="text-[11px] text-muted">
                    This county publishes no owner names to group.
                  </p>
                ) : (
                  <>
                    <p className="mb-1.5 text-[11px] text-muted">
                      Largest holders first. Pick one to see everything they own here.
                    </p>
                    <ul className="max-h-64 space-y-1 overflow-y-auto pr-1">
                      {ownerList.slice(0, 40).map((entry) => (
                        <li key={entry.key}>
                          <button
                            type="button"
                            onClick={() => setOwnerPick({ kind: entry.kind, id: entry.id })}
                            className="w-full rounded-md border border-line px-2 py-1.5 text-left hover:border-accent/50"
                          >
                            <span className="block truncate text-xs font-medium text-ink">
                              {entry.title}
                            </span>
                            <span className="mt-0.5 block text-[11px] text-muted">
                              {entry.count.toLocaleString()} {entry.count === 1 ? 'parcel' : 'parcels'} · {money(entry.value)}
                              {entry.kind === 'b' ? ' · back office' : ''}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}

            {published
              .filter((layer) => layerOn[layer.id])
              .map((layer) => {
                const style = layerStyle[layer.id] ?? { color: layer.color, opacity: 0.7 }
                const set = (next: Partial<{ color: string; opacity: number }>) =>
                  setLayerStyle((current) => ({
                    ...current,
                    [layer.id]: { ...style, ...next },
                  }))
                return (
                  <div key={layer.id} className="space-y-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                      {layer.label}
                    </p>
                    <OpacityRow
                      id={`gis-layer-${layer.id}-opacity`}
                      label="Opacity"
                      value={style.opacity}
                      onChange={(opacityNext) => set({ opacity: opacityNext })}
                    />
                    <div>
                      <label
                        className="mb-1 block text-[11px] font-medium text-body"
                        htmlFor={`gis-layer-${layer.id}-color`}
                      >
                        Colour
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          id={`gis-layer-${layer.id}-color`}
                          type="color"
                          value={style.color}
                          onChange={(event) => set({ color: event.target.value })}
                          className="h-7 w-12 cursor-pointer rounded border border-line bg-surface p-0.5"
                        />
                        <button
                          type="button"
                          onClick={() => set({ color: layer.color })}
                          className="text-[11px] text-accent underline"
                        >
                          Reset
                        </button>
                      </div>
                    </div>
                    {layer.attribution && (
                      <p className="text-[11px] text-faint">Source: {layer.attribution}</p>
                    )}
                  </div>
                )
              })}

            {showCensus && (
              <div>
                <label className="mb-1 block text-[11px] font-medium text-body" htmlFor="gis-metric">
                  Shade tracts by
                </label>
                <select
                  id="gis-metric"
                  className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-ink"
                  value={metric}
                  onChange={(event) => setMetric(event.target.value)}
                  disabled={!census}
                >
                  {(census?.fields ?? [['inc', 'Median household income', 'money']]).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
                <p className="mt-1 mb-2 text-[11px] text-faint">
                  {census
                    ? `American Community Survey ${'' + (censusYear ?? '')}, by census tract.`
                    : 'Loading tracts…'}
                </p>
                <div className="space-y-2 border-t border-line pt-2">
                  <OpacityRow
                    id="gis-census-opacity"
                    label="Shading opacity"
                    value={censusOpacity}
                    onChange={setCensusOpacity}
                  />
                  <RampRow value={censusRamp} onChange={setCensusRamp} />
                </div>
              </div>
            )}

            {showParcels && (
              <div className="space-y-2">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                  Assessor parcels
                </p>
                <OpacityRow
                  id="gis-parcel-opacity"
                  label="Fill opacity"
                  value={opacity}
                  onChange={setOpacity}
                />
                <div>
                  <label
                    className="mb-1 block text-[11px] font-medium text-body"
                    htmlFor="gis-parcel-colorby"
                  >
                    Colour parcels by
                  </label>
                  <select
                    id="gis-parcel-colorby"
                    className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-ink"
                    value={parcelColorBy}
                    onChange={(event) =>
                      setParcelColorBy(event.target.value as 'auto' | 'group' | 'value')
                    }
                  >
                    <option value="auto">
                      What this county publishes
                      {meta?.colorBy === 'value' ? ' (value)' : ' (land use)'}
                    </option>
                    <option value="group">Land use</option>
                    <option value="value">{meta?.valueLabel || 'Assessed value'}</option>
                  </select>
                </div>
                {effectiveColorBy === 'value' && <RampRow value={parcelRamp} onChange={setParcelRamp} />}
              </div>
            )}

            {/* The legend says what the colours mean, and says plainly when a
                county publishes no land use to colour by. */}
            <div className="border-t border-line pt-2">
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
                {effectiveColorBy === 'value' ? meta?.valueLabel || 'Value' : 'Land use'}
              </p>
              {effectiveColorBy === 'value' ? (
                <>
                  <div className="flex h-2 overflow-hidden rounded">
                    {rampOf(parcelRamp).map((hue) => (
                      <i key={hue} className="flex-1" style={{ background: hue }} />
                    ))}
                  </div>
                  <p className="mt-1 text-[11px] text-muted">Low to high, by seventh.</p>
                </>
              ) : (
                <ul className="space-y-1">
                  {LEGEND.map(([label, hue]) => (
                    <li key={label} className="flex items-center gap-2 text-xs text-body">
                      <i className="h-2.5 w-2.5 rounded-sm" style={{ background: hue }} />
                      {label}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {meta?.attribution && (
              <p
                className="border-t border-line pt-2 text-[11px] leading-snug text-faint"
                dangerouslySetInnerHTML={{ __html: meta.attribution }}
              />
            )}
          </div>
        )}

        {rail === 'search' && (
          <div className="space-y-2">
            <input
              className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink"
              placeholder="Address, owner or parcel id"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {!index && <p className="text-[11px] text-muted">Loading the market's records…</p>}
            {query.trim() !== '' && filtered && (
              <>
                <p className="text-[11px] text-muted">
                  {filtered.length.toLocaleString()} match{filtered.length === 1 ? '' : 'es'}
                  {filtered.length > 200 && ', showing the first 200'}
                </p>
                <ul className="divide-y divide-line">
                  {filtered.slice(0, 200).map((row) => (
                    <li key={String(row.id)}>
                      <button
                        type="button"
                        className="w-full py-1.5 text-left hover:bg-sunken"
                        onClick={() => setSelected(row.id as number | string)}
                      >
                        <span className="block truncate text-xs font-medium text-ink">
                          {String(row.ad || `Parcel ${row.gid ?? row.id}`)}
                        </span>
                        <span className="block truncate text-[11px] text-muted">
                          {money(Number(row.mv) || 0)} · {String(row.ow || 'Owner not published')}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}

        {rail === 'filter' && (
          <div className="space-y-3">
            {!index ? (
              <p className="text-[11px] text-muted">Loading the market's records…</p>
            ) : (
              <>
                <div className="border-b border-line pb-3">
                  <label className="mb-1 block text-[11px] font-medium text-body" htmlFor="gis-scout">
                    Ask for parcels
                  </label>
                  <textarea
                    id="gis-scout"
                    rows={2}
                    className="w-full resize-none rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-ink"
                    placeholder='Plain English — "vacant land over 5 acres under $2M"'
                    value={hunt}
                    onChange={(event) => setHunt(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault()
                        runHunt()
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="mt-1.5 w-full rounded-md bg-brand px-2 py-1.5 text-xs font-semibold text-white hover:bg-brand-soft hover:text-brand-night disabled:opacity-50"
                    disabled={hunting || hunt.trim() === ''}
                    onClick={runHunt}
                  >
                    {hunting ? 'Reading the hunt…' : 'Find parcels'}
                  </button>
                  {huntNote && (
                    <p
                      role="status"
                      className={`mt-1.5 text-[11px] leading-snug ${huntNote.tone === 'ok' ? 'text-muted' : 'text-amber-600'}`}
                    >
                      {huntNote.text}
                    </p>
                  )}
                </div>
                {assetOptions.length > 0 ? (
                  <div>
                    <p className="mb-1 text-[11px] font-medium text-body">Asset type</p>
                    <CheckList
                      options={assetOptions}
                      selected={assets}
                      onToggle={(entry) =>
                        setAssets((current) => {
                          const next = new Set(current)
                          if (next.has(entry)) next.delete(entry)
                          else next.add(entry)
                          return next
                        })
                      }
                    />
                  </div>
                ) : (
                  <p className="text-[11px] text-muted">
                    This county publishes no land use, so there is nothing to filter by here.
                  </p>
                )}
                <RangeInput
                  label={meta?.valueLabel || 'Value'}
                  min={value.min}
                  max={value.max}
                  onChange={setValue}
                />
                <RangeInput label="Lot size" suffix="ac" min={acres.min} max={acres.max} onChange={setAcres} />
                <div className="flex items-center justify-between border-t border-line pt-2">
                  <span className="text-xs text-muted">
                    {(filtered ?? rows).length.toLocaleString()} of {rows.length.toLocaleString()}
                  </span>
                  <button
                    type="button"
                    className="text-xs font-medium text-brand hover:underline disabled:text-faint"
                    disabled={!filtered}
                    onClick={() => {
                      setAssets(new Set())
                      setValue({ min: '', max: '' })
                      setAcres({ min: '', max: '' })
                      setQuery('')
                    }}
                  >
                    Clear
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {rail === 'report' && (
          <div className="space-y-3">
            {!index ? (
              <p className="text-[11px] text-muted">Loading the market's records…</p>
            ) : (
              <>
                <p className="text-[11px] text-muted">
                  {filtered ? 'The parcels matching your filter.' : 'Every parcel in this market.'}
                </p>
                <dl className="space-y-1 text-xs">
                  <Row label="Parcels" value={summary.count.toLocaleString()} />
                  <Row label={meta?.valueLabel || 'Value'} value={money(summary.total)} />
                  <Row label="Acres" value={Math.round(summary.acreage).toLocaleString()} />
                  <Row
                    label="Average"
                    value={summary.count ? money(summary.total / summary.count) : '—'}
                  />
                </dl>
                {summary.byAsset.length > 1 && (
                  <div className="border-t border-line pt-2">
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted">
                      By asset type
                    </p>
                    <dl className="space-y-1 text-xs">
                      {summary.byAsset.slice(0, 10).map(([label, count]) => (
                        <Row key={label} label={label} value={count.toLocaleString()} />
                      ))}
                    </dl>
                  </div>
                )}
                <button
                  type="button"
                  className="w-full rounded-md border border-line px-2 py-1.5 text-xs font-medium text-ink hover:bg-sunken"
                  onClick={() => exportCsv(filtered ?? rows, active ?? 'market')}
                >
                  Export {summary.count.toLocaleString()} rows as CSV
                </button>
                <p className="text-[11px] leading-snug text-faint">
                  Figures are the county's own, reproduced rather than estimated. An assessed
                  value is a tax figure, not a market appraisal.
                </p>
              </>
            )}
          </div>
        )}
      </GisRail>

      {choropleth && (
        <div className="absolute bottom-9 left-1/2 z-[500] w-60 -translate-x-1/2 rounded-lg border border-line bg-surface/95 p-2.5 shadow-lg backdrop-blur">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">
            {choropleth.label}
          </p>
          <div className="mt-1.5 flex h-2 overflow-hidden rounded-full" aria-hidden>
            {rampOf(censusRamp).map((hue) => (
              <i key={hue} className="flex-1" style={{ background: hue }} />
            ))}
          </div>
          <div className="mt-0.5 flex justify-between text-[10px] text-faint">
            <span>{censusValue(choropleth.scale.min, choropleth.kind)}</span>
            <span className="text-body">{censusValue(choropleth.scale.median, choropleth.kind)} med</span>
            <span>{censusValue(choropleth.scale.max, choropleth.kind)}</span>
          </div>
          <p className="mt-1 text-[10px] leading-snug text-faint">
            By census tract, shaded in sevenths of this market's range.
          </p>
        </div>
      )}

      {/* The full county record, opened from the card's arrow. Its own panel
          rather than a taller card: the market's panel spec runs to twenty
          rows in some counties, and a card that long stops being a card. */}
      {expanded && selected != null && parcel && (
        <ParcelPanel
          title={String(parcel.ad || `Parcel ${parcel.gid ?? selected}`)}
          subtitle={`${parcel.zp ? `${parcel.zp} · ` : ''}${meta?.idLabel || 'Parcel'} ${
            parcel.gid ?? selected
          }`}
          groups={meta?.panel ?? []}
          attributes={parcel}
          details={details?.[String(selected)] as Record<string, string | number | null> | null}
          codes={codes}
          neighborhood={neighborhood}
          note={meta?.note}
          loading={detailsLoading}
          onClose={() => setExpanded(false)}
        />
      )}

      {/* The card. Opens on click and never on hover: on a map this dense the
          pointer crosses dozens of parcels on the way anywhere. Raised clear of
          the attribution control, which the basemap licences require stay
          readable. */}
      {selected != null && !expanded && (
        <div className="absolute bottom-9 right-3 z-[500] w-80 rounded-lg border border-line bg-surface/97 p-3 shadow-xl backdrop-blur">
          <button
            type="button"
            className="float-right text-muted hover:text-ink"
            aria-label="Close parcel"
            onClick={() => setSelected(null)}
          >
            ×
          </button>
          {parcel ? (
            <>
              <p className="text-sm font-semibold text-ink">{String(parcel.ad || 'No situs address')}</p>
              <p className="text-xs text-muted">
                {String(parcel.zp || '')} · {meta?.idLabel || 'Parcel'} {String(parcel.gid ?? selected)}
              </p>
              <dl className="mt-2 space-y-1 text-xs">
                <Row label={meta?.valueLabel || 'Value'} value={money(Number(parcel.mv) || 0)} />
                <Row label="Owner of record" value={String(parcel.ow || 'Not published')} />
                <Row label="Asset type" value={String(parcel.at || '—')} />
                <Row
                  label="Lot size"
                  value={parcel.ac ? `${Number(parcel.ac).toFixed(2)} ac` : '—'}
                />
              </dl>

              {/* What the CRM already knows. A parcel with a deal on it is the
                  reason to have clicked, so it leads. */}
              <div className="mt-3 border-t border-line pt-2">
                <button
                  type="button"
                  className="mb-2 flex w-full items-center justify-between gap-2 rounded-md border border-line px-2 py-1 text-xs font-medium text-ink hover:bg-sunken"
                  onClick={() => setExpanded(true)}
                >
                  Full county record
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                </button>
                {known === null ? (
                  <p className="text-[11px] text-muted">Checking your records…</p>
                ) : known.place ? (
                  <>
                    <button
                      type="button"
                      className="text-xs font-semibold text-brand hover:underline"
                      onClick={() => navigate(`/places/${known.place?.id}`)}
                    >
                      In your CRM · {known.place.name || 'Place'}
                    </button>
                    {known.deals.length > 0 && (
                      <ul className="mt-1 space-y-0.5">
                        {known.deals.map((deal) => (
                          <li key={deal.id}>
                            <button
                              type="button"
                              className="text-[11px] text-body hover:underline"
                              onClick={() => navigate(`/deals/${deal.id}`)}
                            >
                              {deal.name} · {deal.stage}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                ) : (
                  <button
                    type="button"
                    className="rounded-md border border-line px-2 py-1 text-xs font-medium text-ink hover:bg-sunken disabled:opacity-50"
                    disabled={saving}
                    onClick={addToCrm}
                  >
                    {saving ? 'Saving…' : 'Add to CRM'}
                  </button>
                )}
              </div>
            </>
          ) : (
            <p className="text-xs text-muted">
              {index ? 'No record for that parcel.' : 'Loading parcel detail…'}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right text-body">{value}</dd>
    </div>
  )
}
