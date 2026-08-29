import { useEffect, useMemo, useRef, useState } from 'react'
import MapCanvas from '../components/MapCanvas'
import ParcelPanel, { type PanelGroup } from '../components/ParcelPanel'
import Coachmarks, { type Coachmark } from '../components/Coachmarks'
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
import { composeMapImage, saveCanvasPdf, saveCanvasPng } from '../lib/mapExport'
import type {
  Comp,
  Deal,
  MapView,
  MarketStatus,
  ParcelRow,
  ParcelSearch,
  Place,
  TileConfig,
} from '../types'

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
 * One address for everything the pipeline publishes, overridable so the map
 * can be looked at from a sandbox that cannot reach the open internet.
 *
 * There used to be a second knob here that rewrote the absolute data host
 * meta.json hands back, because the heavy files were fetched from that host
 * directly. They are not any more — tiles, the index and the details go
 * through this same origin, which is what removed the cross-origin failure —
 * so the knob had nothing left to rewrite.
 */
/*
 * Read from this origin by default.
 *
 * The catalogue used to be fetched straight from the data domain, which put
 * every one of these files behind that bucket's CORS policy. A refusal there
 * does not announce itself: it arrives as `TypeError: Failed to fetch` with
 * status 0, the market list comes back empty, no county is chosen, and the
 * view is blank. The map looked broken when the app had simply been told
 * there were no markets — and it only looked broken from some origins, which
 * is what made it so hard to see.
 *
 * The app now serves the same files itself, so there is no cross-origin
 * request left to refuse. CATALOG_DEFAULT stays as the address the server
 * reads from, and as the fallback below for anything serving this bundle
 * without that route.
 */
const CATALOG = import.meta.env.VITE_PARCEL_CATALOG || '/catalog'
/** A fetch that treats an error page as the failure it is, not as JSON. */
const asJson = (r: Response) => {
  if (!r.ok) throw new Error(`${r.status}`)
  return r.json()
}

/*
 * A catalogue file, from this origin, or from the data domain if this origin
 * does not serve one.
 *
 * The fallback is for a deployment running this bundle without the catalogue
 * route — a preview, an older Worker, the dev server. It is deliberately a
 * fallback rather than the first choice: the direct fetch is the one that can
 * be refused cross-origin, and the whole point is not to depend on it.
 */
async function catalogue(path: string) {
  try {
    return await asJson(await fetch(`${CATALOG}/${path}`))
  } catch (first) {
    if (CATALOG === CATALOG_DEFAULT) throw first
    return asJson(await fetch(`${CATALOG_DEFAULT}/${path}`))
  }
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
  /*
   * The same layer as a tile archive, when the market has been tiled.
   *
   * `file` stays beside it so a market that has not been tiled keeps working
   * untouched — markets migrate one at a time, and both paths stay live. When
   * this is set the GeoJSON is never fetched at all, which is the whole point:
   * Austin's zoning is 41 MB downloaded and parsed before one district draws.
   */
  tiles?: string
  sourceLayer?: string
  minzoom?: number
  maxzoom?: number
  count?: number
  /** How many the source holds here, when it would say. */
  total?: number | null
  /** What bounds this layer, in words a customer can check. */
  filter?: string
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
  comps: LAYER_ICONS.comps,
}

/*
 * Colours for categories, not magnitudes.
 *
 * Distinct hues rather than a ramp: a zoning district is not more or less
 * than the one beside it, and a light-to-dark scale would imply an order
 * that does not exist. Twelve, because past that nobody can tell two
 * swatches apart in a legend, and the rest are honestly "other".
 */
const CATEGORY_COLORS = [
  '#2a78d6', '#e8590c', '#1baf7a', '#d6336c', '#7048e8', '#f59f00',
  '#0ca678', '#ae3ec9', '#4c6ef5', '#c2255c', '#5c940d', '#e67700',
]

/** How many distinct values are still worth their own colour. */
const CATEGORY_LIMIT = 12

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

/**
 * A point to fly to, from any geometry a layer might hold.
 *
 * The mean of the coordinates rather than a true centroid: a true one needs
 * the polygon's area and would put the camera fractionally better on a
 * crescent-shaped parcel, which is not a difference anyone flying to a
 * building can see.
 */
function featureCentre(geometry: unknown): [number, number] | null {
  const geom = geometry as { coordinates?: unknown } | null
  if (!geom?.coordinates) return null
  let sx = 0
  let sy = 0
  let n = 0
  const walk = (part: unknown): void => {
    const arr = part as unknown[]
    if (typeof arr[0] === 'number' && typeof arr[1] === 'number') {
      sx += arr[0] as number
      sy += arr[1] as number
      n += 1
      return
    }
    for (const piece of arr) walk(piece)
  }
  walk(geom.coordinates)
  return n ? [sx / n, sy / n] : null
}

/**
 * What is actually in a layer, listed.
 *
 * Switching a layer on used to paint shapes and say nothing about them: the
 * panel offered colour, opacity and a legend, which is how a layer looks
 * rather than what it holds. A hundred and eight city lots for sale with
 * asking prices on them are worth reading as a list, and a zoning layer is
 * worth searching.
 *
 * Bounded deliberately. Some layers run to twenty thousand points and a list
 * that long is neither useful nor survivable, so the first two hundred show
 * and the search narrows past that — with the count of what matched, so a
 * short list is never mistaken for a small layer.
 */
const RECORD_LIMIT = 200

function LayerRecords({
  features,
  fields,
  picked,
  onPick,
}: {
  features: GeoJSON.Feature[]
  fields: string[]
  picked: number | null
  onPick: (index: number | null, centre: [number, number] | null) => void
}) {
  const [needle, setNeedle] = useState('')

  const matches = useMemo(() => {
    const want = needle.trim().toLowerCase()
    const out: number[] = []
    for (let i = 0; i < features.length; i += 1) {
      if (!want) {
        out.push(i)
        if (out.length > RECORD_LIMIT * 4) break
        continue
      }
      const props = features[i]?.properties ?? {}
      if (Object.values(props).some((v) => String(v ?? '').toLowerCase().includes(want))) {
        out.push(i)
      }
    }
    return out
  }, [features, needle])

  const shown = matches.slice(0, RECORD_LIMIT)
  const lead = fields[0]
  const second = fields[1]
  const chosen = picked != null ? features[picked] : null

  return (
    <div className="space-y-1.5">
      <input
        type="search"
        value={needle}
        onChange={(event) => setNeedle(event.target.value)}
        placeholder={`Search ${features.length.toLocaleString()} records`}
        className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-ink"
        aria-label="Search this layer"
      />
      {chosen && (
        <div className="rounded-md border border-accent/40 bg-accent/5 p-2">
          {/* The close control gets its own row rather than floating: a
              float here wrapped the first field around it, which put the
              value and the × on top of each other. */}
          <div className="mb-1 flex items-start justify-between gap-2">
            <p className="text-[11px] font-medium text-ink">
              {String((lead && (chosen.properties ?? {})[lead]) || 'Selected record')}
            </p>
            <button
              type="button"
              className="shrink-0 leading-none text-muted hover:text-ink"
              aria-label="Clear the selected record"
              onClick={() => onPick(null, null)}
            >
              ×
            </button>
          </div>
          <dl className="space-y-0.5">
            {fields.map((field) => {
              const value = (chosen.properties ?? {})[field]
              if (value == null || value === '') return null
              return (
                <div key={field} className="flex justify-between gap-3 text-[11px]">
                  <dt className="shrink-0 text-muted">{field}</dt>
                  <dd className="min-w-0 truncate text-right text-ink">{String(value)}</dd>
                </div>
              )
            })}
          </dl>
        </div>
      )}
      <ul className="max-h-56 space-y-0.5 overflow-y-auto pr-1">
        {shown.map((index) => {
          const props = features[index]?.properties ?? {}
          return (
            <li key={index}>
              <button
                type="button"
                onClick={() => onPick(index, featureCentre(features[index]?.geometry))}
                className={`w-full rounded-md border px-2 py-1 text-left hover:border-accent/50 ${
                  picked === index ? 'border-accent/60 bg-accent/5' : 'border-line'
                }`}
              >
                <span className="block truncate text-[11px] font-medium text-ink">
                  {String((lead && props[lead]) || `Record ${index + 1}`)}
                </span>
                {second && props[second] != null && props[second] !== '' && (
                  <span className="block truncate text-[11px] text-muted">
                    {String(props[second])}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
      {matches.length > shown.length && (
        <p className="text-[11px] text-faint">
          {needle.trim()
            ? `${matches.length.toLocaleString()} match; showing the first ${RECORD_LIMIT}.`
            : `Showing the first ${RECORD_LIMIT} of ${features.length.toLocaleString()}. Search to narrow.`}
        </p>
      )}
      {needle.trim() && matches.length === 0 && (
        <p className="text-[11px] text-faint">Nothing in this layer matches.</p>
      )}
    </div>
  )
}

/**
 * The capture the broker runs in their own browser.
 *
 * Kept as a string the panel hands over rather than something this app runs:
 * it executes on the page the broker is already looking at, under their own
 * licence to look at it, and produces a list only they receive. That is the
 * whole difference between a broker keeping notes and this company operating
 * a scraper against somebody else's database, and it is not a small one.
 */
const CAPTURE_SNIPPET = `copy(JSON.stringify([...document.querySelectorAll('article,[data-id]')].map(card => ({
  address: card.querySelector('[class*=address]')?.innerText,
  name: card.querySelector('a[href]')?.innerText,
  priceStr: card.innerText.match(/\\$[\\d,]+/)?.[0],
  url: card.querySelector('a[href]')?.href,
}))))`

/**
 * Importing comps, and saying honestly where they can and cannot come from.
 *
 * The panel does the explaining because this is the one layer whose data the
 * app does not fetch: it cannot, and the reason a broker should hear is the
 * real one rather than "not built yet".
 */
function CompsImport({
  comps,
  unplaced,
  busy,
  paste,
  note,
  onPaste,
  onImport,
  onFile,
  onPlace,
}: {
  comps: Comp[] | null
  unplaced: number
  busy: boolean
  paste: string
  note: { tone: 'ok' | 'warn'; text: string } | null
  onPaste: (value: string) => void
  onImport: () => void
  onFile: (file: File) => void
  onPlace: () => void
}) {
  const [open, setOpen] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const empty = !comps?.length

  return (
    <div className="space-y-1.5 rounded-md border border-line bg-sunken/50 p-2">
      {empty && (
        <p className="text-[11px] text-body">
          Your own comps, kept in this workspace. Nothing is collected for you: a
          listing site's compiled database is theirs, so this takes what your own
          browser showed you and stores it here, visible to nobody else.
        </p>
      )}
      {!empty && (
        <p className="text-[11px] text-muted">
          {comps.length.toLocaleString()} {comps.length === 1 ? 'comp' : 'comps'} in this
          workspace
          {unplaced > 0 ? `, ${unplaced.toLocaleString()} not located yet` : ''}.
        </p>
      )}

      {unplaced > 0 && (
        <button
          type="button"
          onClick={onPlace}
          disabled={busy}
          className="w-full rounded-md border border-line px-2 py-1 text-[11px] text-ink hover:border-accent/50 disabled:opacity-50"
        >
          {busy ? 'Locating…' : `Locate ${unplaced.toLocaleString()} more`}
        </button>
      )}

      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        className="text-[11px] text-accent underline"
      >
        {open ? 'Hide import' : empty ? 'Import comps' : 'Import more'}
      </button>

      {open && (
        <div className="space-y-1.5">
          {/* The file first, because that is how listings actually arrive —
              a CSV out of a spreadsheet, an export somebody emailed. Telling
              a broker to open it and copy its contents is telling them not to
              bother. */}
          <input
            ref={picker}
            type="file"
            accept=".csv,.tsv,.txt,.json,text/csv,application/json"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0]
              // Cleared so choosing the same file twice fires again — a broker
              // who fixes a column and re-picks expects it to re-import.
              event.target.value = ''
              if (file) onFile(file)
            }}
          />
          <button
            type="button"
            onClick={() => picker.current?.click()}
            disabled={busy}
            className="w-full rounded-md border border-dashed border-line px-2 py-2 text-[11px] text-body hover:border-accent/50 disabled:opacity-50"
          >
            {busy ? 'Working…' : 'Choose a CSV or JSON file'}
          </button>
          <p className="text-center text-[10px] text-faint">or paste below</p>
          <textarea
            value={paste}
            onChange={(event) => onPaste(event.target.value)}
            rows={4}
            placeholder={'Address,Price,Property Type\n123 Main St,"$4,250,000",Retail'}
            className="w-full rounded-md border border-line bg-surface px-2 py-1.5 font-mono text-[11px] text-ink"
            aria-label="Listings as CSV or JSON"
          />
          <button
            type="button"
            onClick={onImport}
            disabled={busy || !paste.trim()}
            className="w-full rounded-md bg-brand px-2 py-1 text-[11px] font-medium text-white disabled:opacity-50"
          >
            {busy ? 'Importing…' : 'Import'}
          </button>
          <details className="text-[11px] text-faint">
            <summary className="cursor-pointer">Where the JSON comes from</summary>
            <p className="mt-1">
              A CSV with a header row, or any list of objects. Column names are
              matched loosely, so both a spreadsheet's <code>Property Type</code>{' '}
              and a capture's <code>propType</code> land in the same place —
              likewise <code>Address</code>, <code>Price</code>, <code>SF</code>,{' '}
              <code>Acres</code>, <code>Units</code>, <code>Cap Rate</code>,{' '}
              <code>Year Built</code> and <code>URL</code>. Missing columns are
              simply missing, and a big file is sent in batches so it cannot time
              out. If you would rather capture from a page you are looking at,
              this run in your browser's console copies a starting shape to the
              clipboard:
            </p>
            <pre className="mt-1 overflow-x-auto rounded bg-sunken p-1.5 text-[10px] leading-snug">
              {CAPTURE_SNIPPET}
            </pre>
          </details>
        </div>
      )}

      {note && (
        <p className={`text-[11px] ${note.tone === 'warn' ? 'text-rose-600' : 'text-muted'}`}>
          {note.text}
        </p>
      )}
    </div>
  )
}

/**
 * Saved views: this market, configured, under a name.
 *
 * Getting a map to say something takes a dozen small decisions, and until
 * this existed all of them lived in the tab — gone on refresh, impossible to
 * return to next week, impossible to hand to a colleague. Saving is one field
 * and one button because anything more ceremonious does not get used.
 */
function SavedViews({
  views,
  name,
  busy,
  note,
  onName,
  onSave,
  onOpen,
  onDelete,
}: {
  views: MapView[] | null
  name: string
  busy: boolean
  note: { tone: 'ok' | 'warn'; text: string } | null
  onName: (value: string) => void
  onSave: () => void
  onOpen: (view: MapView) => void
  onDelete: (id: string) => void
}) {
  return (
    <div className="border-t border-line pt-3">
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
        Saved views
      </p>

      {views?.length ? (
        <ul className="mb-2 space-y-0.5">
          {views.map((view) => (
            <li key={view.id} className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => onOpen(view)}
                className="min-w-0 flex-1 truncate rounded-md border border-line px-2 py-1 text-left text-[11px] text-ink hover:border-accent/50"
                title={`Saved ${new Date(view.updatedAt).toLocaleDateString()}`}
              >
                {view.name}
              </button>
              <button
                type="button"
                onClick={() => onDelete(view.id)}
                aria-label={`Delete the view "${view.name}"`}
                className="shrink-0 px-1 leading-none text-muted hover:text-ink"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-2 text-[11px] text-faint">
          {views === null
            ? 'Loading…'
            : 'Set the layers, colours and filters you want, then save them here to come back to.'}
        </p>
      )}

      <div className="flex gap-1">
        <input
          value={name}
          onChange={(event) => onName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onSave()
          }}
          placeholder="Name this view"
          className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-ink"
          aria-label="Name for the saved view"
        />
        <button
          type="button"
          onClick={onSave}
          disabled={busy || !name.trim()}
          className="shrink-0 rounded-md bg-brand px-2.5 py-1.5 text-[11px] font-medium text-white disabled:opacity-50"
        >
          Save
        </button>
      </div>
      {note && (
        <p className={`mt-1 text-[11px] ${note.tone === 'warn' ? 'text-rose-600' : 'text-muted'}`}>
          {note.text}
        </p>
      )}
    </div>
  )
}

/**
 * The first-run tips.
 *
 * Four, in the order somebody actually works: choose the county, switch on
 * what you want to see, keep the map you built, then narrow it. The second is
 * the one that matters — the view now opens with nothing drawn, and without a
 * sentence saying so an empty map reads as a failure rather than as a choice.
 *
 * Each points at a `data-tour` attribute rather than a class name, so
 * restyling the panel cannot silently aim a tip at nothing.
 */
const GIS_TIPS: Coachmark[] = [
  {
    target: '[data-tour="market"]',
    title: 'Start with a county',
    body: 'Every market is one county’s own record, so choosing one chooses what the data is. Switching markets reframes the map.',
  },
  {
    target: '[data-tour="layers"]',
    title: 'Nothing is on until you say so',
    body: 'The map opens empty on purpose. Switch on parcels, ownership, demographics, zoning or comps — each square is a layer, and they stack.',
  },
  {
    target: '[data-tour="views"]',
    title: 'Keep the map you build',
    body: 'Layers, colours, filters and where you are looking, saved under a name. Your colleagues see it too, so a good read on a market only gets built once.',
  },
  {
    target: '[data-tour="rail"]',
    title: 'Search, filter, report',
    body: 'Find a parcel by address or owner, narrow by asset type, value and acreage, then export what is left.',
  },
]

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

/*
 * The most rows one export writes.
 *
 * The browser used to hold the whole county, so "export everything" cost
 * nothing beyond the file. Now the rows live on the server and each page is a
 * request, so an unbounded export of Harris County would be five hundred of
 * them. This is a working set — large enough for any list a broker actually
 * works, small enough to fetch in a handful of calls — and the button says so
 * rather than promising a county and delivering a page.
 */
export const CSV_LIMIT = 5000

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

/**
 * A market's attribution as plain text.
 *
 * meta.json writes it for HTML — "Parcels &amp; values: Clark County Assessor"
 * — and that string is about to become a value in a record list, where an
 * escaped ampersand reads as a typo rather than as markup.
 */
const stripTags = (html: string) =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()

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
  /*
   * What the server can answer for this market.
   *
   * The attribute index used to be the only way to search a county: download
   * all of it, hold it in memory, scan it on every keystroke. Travis County is
   * 18.7 MB compressed and Harris is four times that, and the wait was long
   * enough that people read it as a broken map.
   *
   * So the server holds the rows now and answers questions about them. This is
   * the answer to "can it?" — null while asking, then a market that is either
   * `ready` or not. Not ready is not an error: it means this county's rebuild
   * has not reached the store yet, and everything below falls back to the
   * download exactly as before.
   */
  const [server, setServer] = useState<MarketStatus | null>(null)
  const [found, setFound] = useState<ParcelSearch | null>(null)
  const [searching, setSearching] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [serverParcel, setServerParcel] = useState<ParcelRow | null>(null)
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
  /*
   * Nothing is switched on when the view opens.
   *
   * Landing with the parcel layer already drawn meant every visit began by
   * dismissing a map somebody else chose — and on a county of four hundred
   * thousand parcels that is a heavy thing to render before anyone has asked
   * for it. The catalog and the saved views are the way in instead, and the
   * first-run tips say so, because an empty map with no explanation is
   * indistinguishable from a broken one.
   *
   * The attribute index still loads either way: search and the filters need
   * it, and it is what makes the first switch-on instant.
   */
  const [showParcels, setShowParcels] = useState(false)
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
  /** Which field, if any, each layer is coloured by. '' means one colour. */
  const [layerColorBy, setLayerColorBy] = useState<Record<string, string>>({})
  /**
   * The record chosen from a layer's list, and where the map should look.
   *
   * Two pieces of state rather than one because they change for different
   * reasons: the pick decides what the panel shows and stays put while the
   * map is panned, and the view carries a key so that choosing the same
   * record twice flies there again rather than being deduplicated away.
   */
  const [layerPick, setLayerPick] = useState<{ layer: string; index: number } | null>(null)
  const [layerView, setLayerView] = useState<{ center: [number, number]; zoom: number; key: number } | null>(null)
  /*
   * Sale comps this workspace collected.
   *
   * They live in the same layer machinery as anything the county publishes —
   * a card, a colour, records in the panel — but they arrive by a different
   * road. Nothing here is fetched from a listing site: the broker captures
   * what their own browser showed them and imports it, and it stays theirs.
   */
  /*
   * The county's own recorded sales, where the roll carries them.
   *
   * Kept apart from `comps` because they are a different thing with different
   * rules: these are public record, published with the market and the same for
   * everyone, while imported comps are one workspace's private collection.
   * They share the Comps square because a broker pricing a deal wants both in
   * front of them, and each record says which it is.
   */
  const [sales, setSales] = useState<{
    n: number
    cols: Record<string, (string | number)[]>
  } | null>(null)
  const [comps, setComps] = useState<Comp[] | null>(null)
  const [compsUnplaced, setCompsUnplaced] = useState(0)
  const [compsBusy, setCompsBusy] = useState(false)
  const [compsPaste, setCompsPaste] = useState('')
  const [compsNote, setCompsNote] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)
  /*
   * Saved views: this market, configured, under a name.
   *
   * `here` is where the map is looking, reported on every settle, because a
   * view has to restore the camera as well as the settings — "the county" and
   * "this block" are different views of the same point.
   */
  const [views, setViews] = useState<MapView[] | null>(null)
  const [viewName, setViewName] = useState('')
  const [viewBusy, setViewBusy] = useState(false)
  const [viewNote, setViewNote] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)
  const here = useRef<{ lat: number; lng: number; zoom: number } | null>(null)
  /** Filled by the map while it lives; the export buttons ask at click time. */
  const captureMap = useRef<(() => Promise<HTMLCanvasElement | null>) | null>(null)
  const [snapshotting, setSnapshotting] = useState<'png' | 'pdf' | null>(null)
  const [snapshotError, setSnapshotError] = useState<string | null>(null)
  /** A clicked layer feature, shown in the right-hand card. */
  const [featurePick, setFeaturePick] = useState<{ layerId: string; properties: Record<string, unknown> } | null>(null)
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
    catalogue('markets.json')
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
    setServer(null)
    setFound(null)
    setServerParcel(null)
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
    setLayerColorBy({})
    setError(null)
    catalogue(`${active}/meta.json`)
      .then(setMeta)
      .catch(() => {
        bundleIsStale().then((outdated) => (outdated ? setStale(true) : setError('Could not load that market.')))
      })
  }, [active])

  /*
   * Can the server answer for this market?
   *
   * Asked first and asked cheaply — it reads one row — because the answer
   * decides whether the next thing that happens is a query or a download.
   */
  useEffect(() => {
    if (!active) return undefined
    let cancelled = false
    api.parcels
      .market(active)
      .then((status) => {
        if (!cancelled) setServer(status)
      })
      .catch(() => {
        // An older server, or one that cannot reach its store. Either way the
        // published index still works, so say nothing and take that path.
        if (!cancelled) setServer({ ready: false, market: active })
      })
    return () => {
      cancelled = true
    }
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
    // The whole point of the store: a market it can answer for never pays for
    // this download at all. `server` being null means the question is still
    // out, and starting the download before the answer arrives would defeat it.
    if (!server || server.ready) return
    let cancelled = false
    fetch(`${CATALOG}/${active}/index.json`)
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
  }, [meta?.heavyBase, server])

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
      // A tiled layer has nothing to download. The map reads the archive by
      // range as it draws, so fetching the county here would reintroduce the
      // exact cost the tiles exist to remove.
      if (layer.tiles) continue
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

  /*
   * This market's saved views. Fetched per market, because a view belongs to
   * one — Houston's "industrial corridor" means nothing in Las Vegas.
   */
  useEffect(() => {
    if (!active) return undefined
    let cancelled = false
    setViews(null)
    setViewNote(null)
    api.views
      .list(active)
      .then((res) => {
        if (!cancelled) setViews(res.views)
      })
      .catch(() => {
        if (!cancelled) setViews([])
      })
    return () => {
      cancelled = true
    }
  }, [active])

  /*
   * The market's recorded sales, fetched the first time the square is on.
   *
   * A separate small file rather than a read of details.json, which runs to
   * sixty megabytes because it holds every field for every parcel. A market
   * that publishes no sales simply has no file, which is not an error.
   */
  useEffect(() => {
    if (!layerOn.comps || !active) return undefined
    let cancelled = false
    fetch(`${CATALOG}/${active}/sales.json`)
      .then(asJson)
      .then((doc) => {
        if (!cancelled) setSales(doc)
      })
      .catch(() => {
        // No sales published for this county. Nothing to say about it.
        if (!cancelled) setSales(null)
      })
    return () => {
      cancelled = true
    }
  }, [layerOn.comps, active])

  // A different county's sales must not linger under the new one's card.
  useEffect(() => {
    setSales(null)
  }, [active])

  /*
   * The workspace's comps, fetched the first time the square is switched on.
   *
   * Not on mount: a broker who has never imported any should not pay a round
   * trip for an empty list on every visit to the map.
   */
  useEffect(() => {
    if (!layerOn.comps || comps !== null) return undefined
    let cancelled = false
    api.comps
      .list(active ?? undefined)
      .then((res) => {
        if (cancelled) return
        setComps(res.comps)
        setCompsUnplaced(res.unplaced)
      })
      .catch(() => {
        if (!cancelled) setComps([])
      })
    return () => {
      cancelled = true
    }
  }, [layerOn.comps, comps, active])

  /*
   * The comps as a layer.
   *
   * Every comp becomes a feature, including the ones the geocoder could not
   * place — those get a null geometry, which the map skips and the record
   * list does not. That is deliberate: an address nobody can resolve is still
   * a sale the broker recorded, and dropping it from the list would make the
   * panel quietly disagree with the count on the card.
   */
  const compsGeo = useMemo((): GeoJSON.FeatureCollection | null => {
    /*
     * The county's sales and the workspace's comps, in one layer.
     *
     * A broker pricing a deal wants both in front of them, so they share the
     * square — but every record says which it is, because the two are not the
     * same kind of fact. A county sale is the recorded consideration on a
     * deed; an imported comp is whatever the broker's own source said. Mixing
     * them without saying so would make the weaker one look like the stronger.
     */
    const countySales: GeoJSON.Feature[] = []
    if (sales?.n) {
      const c = sales.cols
      for (let i = 0; i < sales.n; i += 1) {
        const x = Number(c.x?.[i])
        const y = Number(c.y?.[i])
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue
        const price = Number(c.sp?.[i]) || 0
        countySales.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [x, y] },
          properties: {
            Address: String(c.ad?.[i] ?? ''),
            Name: '',
            Price: price ? money(price) : '',
            Type: String(c.at?.[i] ?? ''),
            'Sale or lease': 'Sold',
            'Sale date': String(c.sd?.[i] ?? ''),
            Parcel: String(c.id?.[i] ?? ''),
            Source: meta?.attribution ? stripTags(meta.attribution) : 'County record',
            'On the map': '',
          },
        } as GeoJSON.Feature)
      }
    }

    if (!comps?.length) {
      return countySales.length
        ? ({ type: 'FeatureCollection', features: countySales } as GeoJSON.FeatureCollection)
        : null
    }
    /*
     * The cast covers the null geometries. GeoJSON itself calls a feature
     * with `"geometry": null` an unlocated feature and allows it — MapLibre
     * skips those when drawing — but @types/geojson models a collection as
     * holding located features only, so the compiler needs telling.
     */
    return {
      type: 'FeatureCollection',
      features: [
        // The county's own record first: it is the stronger evidence, and a
        // list that opens with it reads as a comp set rather than a scrapbook.
        ...countySales,
        ...comps.map((comp) => ({
        type: 'Feature' as const,
        geometry:
          Number.isFinite(comp.lat) && Number.isFinite(comp.lng)
            ? { type: 'Point' as const, coordinates: [comp.lng as number, comp.lat as number] }
            : null,
        properties: {
          Address: comp.address ?? '',
          Name: comp.name ?? '',
          Price: comp.priceStr ?? (comp.price != null ? money(comp.price) : ''),
          Type: comp.propType ?? '',
          'Sale or lease': comp.saleLease ?? '',
          SF: comp.sqft != null ? comp.sqft.toLocaleString() : '',
          Acres: comp.acres != null ? String(comp.acres) : '',
          Units: comp.units != null ? String(comp.units) : '',
          'Cap rate': comp.capRate != null ? `${comp.capRate}%` : '',
          'Year built': comp.yearBuilt != null ? String(comp.yearBuilt) : '',
          'Price per SF': comp.pricePerSf != null ? money(comp.pricePerSf) : '',
          Source: comp.source ?? '',
          Captured: comp.scrapedAt ? String(comp.scrapedAt).slice(0, 10) : '',
          // Said out loud, because a record that will not appear on the map
          // should explain itself rather than look like a drawing bug.
          'On the map': comp.placed === 'failed' ? 'address not found' : '',
        },
      })),
    ] as GeoJSON.Feature[],
    } as GeoJSON.FeatureCollection
  }, [comps, sales, meta])

  /**
   * The comps described the way a published layer is described, so everything
   * downstream — the card, the colour picker, colour-by-type, the record list
   * — treats them as one more layer rather than a special case.
   */
  const compsLayer = useMemo(
    (): PublishedLayer => ({
      id: 'comps',
      label: 'Comps',
      kind: 'point',
      color: '#d94c8a',
      file: '',
      count: compsGeo?.features.length ?? 0,
      note: comps?.length ? undefined : 'Import your own',
      fields: [
        'Address', 'Price', 'Sale date', 'Type', 'SF', 'Cap rate', 'Year built',
        'Sale or lease', 'Units', 'Acres', 'Price per SF', 'Parcel', 'Source',
        'Captured', 'On the map',
      ],
      attribution: 'Imported by this workspace',
    }),
    [compsGeo, comps],
  )

  /** Every layer the panel and the map treat alike: published plus comps. */
  const shownLayers = useMemo(() => [...published, compsLayer], [published, compsLayer])

  /** The same, for geometry: comps come from the workspace, not the catalog. */
  const shownData = useMemo(
    () => (compsGeo ? { ...layerData, comps: compsGeo } : layerData),
    [layerData, compsGeo],
  )

  /*
   * What each loaded layer could be coloured by, and how.
   *
   * A field earns the offer by behaving like a category: present on most
   * features, and with few enough distinct values to read as a legend. A
   * permit description is text, not a category, and offering it would paint
   * twenty thousand colours nobody can tell apart.
   */
  const layerCategories = useMemo(() => {
    const out: Record<string, { field: string; values: [string, number][] }[]> = {}
    for (const layer of shownLayers) {
      const data = shownData[layer.id]
      if (!data?.features?.length) continue
      const sample = data.features.slice(0, 4000)
      const options: { field: string; values: [string, number][] }[] = []
      const names = new Set<string>()
      for (const f of sample.slice(0, 50)) {
        for (const key of Object.keys(f.properties ?? {})) names.add(key)
      }
      for (const field of names) {
        const counts = new Map<string, number>()
        let seen = 0
        for (const f of sample) {
          const raw = (f.properties as Record<string, unknown> | null)?.[field]
          if (raw == null || raw === '') continue
          seen += 1
          const value = String(raw)
          // A value longer than a label is prose, not a class.
          if (value.length > 40) {
            counts.set('__long__', (counts.get('__long__') ?? 0) + 1)
            continue
          }
          counts.set(value, (counts.get(value) ?? 0) + 1)
        }
        if (!seen || counts.has('__long__')) continue
        if (counts.size < 2 || counts.size > 60) continue
        if (seen < sample.length * 0.5) continue
        options.push({
          field,
          values: [...counts.entries()].sort((a, b) => b[1] - a[1]),
        })
      }
      if (options.length) out[layer.id] = options.sort((a, b) => a.values.length - b.values.length)
    }
    return out
  }, [shownLayers, shownData])

  /** The colour each category gets, for the map and the legend alike. */
  const categoryPaint = useMemo(() => {
    const out: Record<string, { field: string; colors: Record<string, string>; rest: number }> = {}
    for (const [id, options] of Object.entries(layerCategories)) {
      const field = layerColorBy[id]
      if (!field) continue
      const option = options.find((o) => o.field === field)
      if (!option) continue
      const colors: Record<string, string> = {}
      option.values.slice(0, CATEGORY_LIMIT).forEach(([value], i) => {
        colors[value] = CATEGORY_COLORS[i % CATEGORY_COLORS.length]
      })
      out[id] = { field, colors, rest: Math.max(0, option.values.length - CATEGORY_LIMIT) }
    }
    return out
  }, [layerCategories, layerColorBy])

  /**
   * What the map should draw: every layer switched on, with its geometry.
   *
   * A tiled layer qualifies as soon as it is switched on, because there is
   * nothing to wait for — the archive is read as the map draws. A layer that
   * is still GeoJSON waits for its download, as it always did.
   */
  const extras = useMemo(
    () =>
      shownLayers
        .filter((layer) => layerOn[layer.id] && (layer.tiles ? true : shownData[layer.id]))
        .map((layer) => ({
          id: layer.id,
          kind: layer.kind,
          data: layer.tiles ? null : shownData[layer.id],
          // Through this origin, like the parcels and for the same reason: a
          // cross-origin refusal on a tile archive is silent.
          tiles: layer.tiles ? `${CATALOG}/${active}/${layer.tiles}` : null,
          sourceLayer: layer.sourceLayer ?? layer.id,
          minzoom: layer.minzoom ?? null,
          maxzoom: layer.maxzoom ?? null,
          color: layerStyle[layer.id]?.color ?? layer.color,
          opacity: layerStyle[layer.id]?.opacity ?? 0.7,
          fields: layer.fields,
          categories: categoryPaint[layer.id]
            ? { field: categoryPaint[layer.id].field, colors: categoryPaint[layer.id].colors }
            : null,
        })),
    [shownLayers, layerOn, shownData, layerStyle, categoryPaint, active],
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
   * The card asks for the owner names the moment a clicked parcel carries a
   * holding, whether or not the ownership layer is switched on. The names are
   * the answer to "who is this" — waiting for a layer toggle to load them is
   * how a real portfolio read as a bare id.
   */
  useEffect(() => {
    if (owners || !active || selected == null) return undefined
    // The same question of two sources: the fetched parcel where the server
    // answers, the downloaded column where it does not.
    let held = false
    if (server?.ready) {
      held = serverParcel != null && (serverParcel.po != null || serverParcel.bo != null)
    } else {
      if (!index) return undefined
      const row = rowOf.get(selected)
      if (row == null) return undefined
      held = index.cols.po?.[row] != null || index.cols.bo?.[row] != null
    }
    if (!held) return undefined
    let cancelled = false
    fetch(`${CATALOG}/${active}/owners.json`)
      .then(asJson)
      .then((doc: OwnerIndex) => {
        if (!cancelled) setOwners(doc)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [selected, owners, active, rowOf, index, server, serverParcel])

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
    if (meta?.colorBy !== 'value') return null
    // Computed once when the county was published, rather than by sorting
    // every assessed value in the browser on every market open.
    if (server?.ready && server.breaks?.length) return server.breaks
    if (!index) return null
    const values = (index.cols.mv || [])
      .map((v) => Number(v) || 0)
      .filter((v) => v > 0)
      .sort((a, b) => a - b)
    if (!values.length) return null
    const breaks: number[] = []
    for (let i = 1; i < 7; i += 1) breaks.push(values[Math.floor((i * values.length) / 7)])
    return breaks
  }, [index, meta?.colorBy, server])

  const parcel = useMemo(() => {
    if (selected == null) return null
    if (server?.ready) {
      if (!serverParcel) return null
      // `bb` is the zoom target, not a field anyone wants read out on the
      // card, so it is kept off the record the panel renders.
      const { bb: _box, ...rest } = serverParcel
      return rest as Record<string, string | number | null>
    }
    if (!index) return null
    const row = rowOf.get(selected)
    if (row == null) return null
    const out: Record<string, string | number | null> = {}
    for (const key of index.keys) out[key] = index.cols[key]?.[row] ?? null
    return out
  }, [selected, index, rowOf, server, serverParcel])

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
      // Same origin as the rest of the catalogue, for the same reason.
      fetch(`${CATALOG}/${market}/details.json`).then((r) => r.json()),
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

  /*
   * The filters, in the shape the server takes them.
   *
   * Kept as one memo so the effect below has a single dependency that changes
   * exactly when a query would give a different answer — and not, for
   * instance, every time React rebuilds the Set that holds the asset types.
   */
  const serverQuery = useMemo(() => {
    const lo = (raw: string) => {
      const trimmed = raw.trim()
      if (trimmed === '') return null
      const n = Number(trimmed)
      return Number.isFinite(n) ? n : null
    }
    return {
      query: query.trim(),
      assets: [...assets].sort(),
      valueMin: lo(value.min),
      valueMax: lo(value.max),
      acresMin: lo(acres.min),
      acresMax: lo(acres.max),
      owner: ownerPick ? { kind: ownerPick.kind, id: String(ownerPick.id) } : null,
    }
  }, [query, assets, value, acres, ownerPick])

  const queryKey = JSON.stringify(serverQuery)

  /*
   * One round trip per settled filter.
   *
   * Debounced because the search box fires on every keystroke and a county is
   * not worth querying six times while someone types an address. The delay is
   * short enough that the result still feels like typing.
   */
  useEffect(() => {
    if (!active || !server?.ready) return undefined
    let cancelled = false
    setSearching(true)
    const timer = setTimeout(() => {
      api.parcels
        .search(active, serverQuery, { limit: 200 })
        .then((result) => {
          if (!cancelled) setFound(result)
        })
        .catch(() => {
          // Leave the previous answer standing rather than blanking the panel
          // on one failed request; the next keystroke tries again.
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, 220)
    return () => {
      cancelled = true
      clearTimeout(timer)
      setSearching(false)
      clearTimeout(timer)
    }
    // serverQuery is covered by queryKey, which is its value rather than its
    // identity — the object is rebuilt on every render and would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, server?.ready, queryKey])

  /*
   * The selected parcel's full record, when the server holds it.
   *
   * In the downloaded-index path this was a lookup into arrays already in
   * memory. Here it is one row fetched on selection, which is the whole trade:
   * a request per click instead of a county per visit.
   */
  useEffect(() => {
    if (!active || !server?.ready || selected == null) {
      setServerParcel(null)
      return undefined
    }
    let cancelled = false
    api.parcels
      .one(active, selected)
      .then((res) => {
        if (!cancelled) setServerParcel(res.parcel)
      })
      .catch(() => {
        if (!cancelled) setServerParcel(null)
      })
    return () => {
      cancelled = true
    }
  }, [active, server?.ready, selected])

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
    // Counted once at publish time when the server holds this market, rather
    // than by walking every parcel in the browser.
    if (server?.ready && server.assets) {
      return server.assets.map((entry) => ({ value: entry.value, count: entry.count }))
    }
    const counts = new Map<string, number>()
    for (const row of rows) {
      const at = String(row.at || '').trim()
      if (at) counts.set(at, (counts.get(at) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count)
  }, [rows, server])

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
    // Answered by the server where it can be. `ids` is null there for exactly
    // the same reason this returns null below: nothing is filtered, so the map
    // draws the whole market rather than a list of every parcel in it.
    if (server?.ready) {
      if (!found || found.ids == null) return null
      return found.rows as Record<string, string | number | null>[]
    }
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
  }, [rows, query, assets, value, acres, ownerPick, server, found])

  /*
   * What the map highlights.
   *
   * From the server this is the whole matching set, not the page — the list
   * shows two hundred parcels but the map draws every one that matched, which
   * is the difference between a search result and a map.
   */
  const filterIds = useMemo(() => {
    if (server?.ready) return found?.ids ?? null
    return filtered ? filtered.map((row) => row.id as number | string) : null
  }, [filtered, server, found])

  /** What the current set adds up to. The report is a reading, not a second query. */
  const summary = useMemo(() => {
    // Read off the same query that produced the map, so the report and the
    // map can never describe different sets.
    if (server?.ready) {
      if (found) {
        return {
          count: found.count,
          total: found.total,
          acreage: found.acreage,
          byAsset: found.byAsset,
        }
      }
      return {
        count: server.count ?? 0,
        total: server.total ?? 0,
        acreage: server.acreage ?? 0,
        byAsset: (server.assets ?? []).map((a) => [a.value, a.count] as [string, number]),
      }
    }
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
  }, [filtered, rows, server, found])

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
    // From the server this is what the county publishes rather than what a
    // sample of loaded parcels happens to carry — the same question, answered
    // from the market's own column list instead of inferred.
    const published = server?.ready ? new Set(server.keys ?? []) : null
    const has = (key: string) =>
      published
        ? published.has(key)
        : rows.length > 0 && rows.some((row) => row[key] !== null && row[key] !== '' && row[key] !== 0)
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
  }, [rows, server])

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
    /*
     * Which groups this market actually references.
     *
     * The downloaded path could see every parcel and so could rule out a group
     * with nothing to show. The server path never holds the whole county in
     * the browser — that is the point — so it trusts owners.json instead,
     * which the pipeline derives from these same parcels and therefore cannot
     * name a group the market does not have.
     */
    const seen = server?.ready ? null : new Set<string>()
    if (seen) {
      for (const row of rows) {
        if (row.po != null) seen.add(`p:${row.po}`)
        if (row.bo != null) seen.add(`b:${row.bo}`)
      }
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
        if (seen && !seen.has(`${kind}:${id}`)) continue
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
  }, [owners, rows, server])

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
      ...shownLayers.map(
        (layer): LayerCard => ({
          id: `x:${layer.id}`,
          label: layer.label,
          state: layerOn[layer.id] ? 'on' : 'off',
          note: layerBusy[layer.id]
            ? 'Loading…'
            : layer.count
              ? layer.total && layer.total > layer.count
                // Say so plainly. A bounded layer that reports only its own
                // size reads as the whole city, and is not.
                ? `${layer.count.toLocaleString()} of ${layer.total.toLocaleString()}`
                : `${layer.count.toLocaleString()} ${layer.kind === 'point' ? 'points' : 'areas'}`
              : layer.note,
          icon: PUBLISHED_ICONS[layer.id] ?? LAYER_ICONS.parcels,
        }),
      ),
      // Still genuinely unbuilt: no public source publishes these, so they
      // stay honest rather than becoming empty cards.
      ...(published.some((l) => l.id === 'permits') ? [] : [pending('Development pipeline', LAYER_ICONS.pipeline)]),
      ...(published.some((l) => l.id === 'plan-review') ? [] : [pending('Entitlements', LAYER_ICONS.entitlements)]),
      pending('Market surveys', LAYER_ICONS.surveys),
      pending('Absorption', LAYER_ICONS.absorption),
      pending('Rent trends', LAYER_ICONS.rent),
      pending('Forecasts', LAYER_ICONS.forecasts),
    ]
  }, [showParcels, showOwners, showCensus, showZoning, coverage, meta?.count, ownerList.length, shownLayers, layerOn, layerBusy])

  /*
   * Collecting the rows an export writes.
   *
   * One path reads what is already in memory; the other pages the server,
   * because the county is no longer in the browser to slice. Both stop at the
   * same cap, so the file matches the count on the button either way.
   */
  const exportRows = async () => {
    if (!active || exporting) return
    if (!server?.ready) {
      exportCsv((filtered ?? rows).slice(0, CSV_LIMIT), active)
      return
    }
    setExporting(true)
    try {
      const collected: Record<string, string | number | null>[] = []
      const want = Math.min(summary.count, CSV_LIMIT)
      while (collected.length < want) {
        const page = await api.parcels.search(active, serverQuery, {
          limit: 1000,
          offset: collected.length,
        })
        if (!page.rows.length) break
        collected.push(...(page.rows as Record<string, string | number | null>[]))
      }
      exportCsv(collected.slice(0, want), active)
    } catch {
      setError('Could not collect the rows for that export.')
    } finally {
      setExporting(false)
    }
  }

  /** The centre of the selected parcel, from its bounding box in the index. */
  const centre = useMemo(() => {
    if (selected == null) return null
    if (server?.ready) {
      const box = serverParcel?.bb
      if (!Array.isArray(box) || box.length !== 4) return null
      const [bw, bs, be, bn] = box as number[]
      return { lat: (bs + bn) / 2, lng: (bw + be) / 2 }
    }
    if (!index?.bb) return null
    const row = rowOf.get(selected)
    if (row == null) return null
    const [w, s, e, n] = index.bb.slice(row * 4, row * 4 + 4)
    if (![w, s, e, n].every(Number.isFinite)) return null
    return { lat: (s + n) / 2, lng: (w + e) / 2 }
  }, [selected, index, rowOf, server, serverParcel])

  /*
   * The scout writes into the same filter state a person would, so the map,
   * the count, the report and the CSV agree with the answer by construction —
   * and the panel below shows exactly what was understood, ready to correct.
   */
  /*
   * Everything a view remembers.
   *
   * Written as one flat object rather than threaded through props, because
   * the whole point is that a view captures the map as it is — and a capture
   * that has to be extended by hand every time the map gains a control will
   * quietly stop capturing things.
   *
   * The camera comes from `here`, which the map reports on every settle. If
   * the map has not reported yet the market's own centre stands in, so a view
   * saved in the first second is still a usable view.
   */
  function captureView(): Record<string, unknown> {
    return {
      v: 1,
      center: here.current
        ? [here.current.lng, here.current.lat]
        : meta
          ? meta.center
          : null,
      zoom: here.current?.zoom ?? meta?.zoom ?? null,
      showParcels,
      showOwners,
      showCensus,
      showZoning,
      opacity,
      parcelRamp,
      parcelColorBy,
      censusOpacity,
      censusRamp,
      metric,
      layerOn,
      layerStyle,
      layerColorBy,
      // The filters are as much a part of a view as the colours: "industrial
      // over five acres" is the view, and the shading is how it reads.
      query,
      assets: [...assets],
      value,
      acres,
    }
  }

  /**
   * Puts a saved view back on the map.
   *
   * Every field is optional on purpose. A view saved before the map gained a
   * control does not carry that control's setting, and it should still open —
   * so anything absent is left exactly as it is rather than reset to a
   * default the broker never chose.
   */
  function applyView(view: MapView) {
    const st = view.state as Record<string, unknown>
    const bool = (key: string, set: (value: boolean) => void) => {
      if (typeof st[key] === 'boolean') set(st[key] as boolean)
    }
    const num = (key: string, set: (value: number) => void) => {
      if (typeof st[key] === 'number' && Number.isFinite(st[key])) set(st[key] as number)
    }
    const str = (key: string, set: (value: string) => void) => {
      if (typeof st[key] === 'string') set(st[key] as string)
    }

    bool('showParcels', setShowParcels)
    bool('showOwners', setShowOwners)
    bool('showCensus', setShowCensus)
    bool('showZoning', setShowZoning)
    num('opacity', setOpacity)
    num('censusOpacity', setCensusOpacity)
    str('parcelRamp', setParcelRamp)
    str('censusRamp', setCensusRamp)
    str('metric', setMetric)
    str('query', setQuery)
    if (st.parcelColorBy === 'auto' || st.parcelColorBy === 'group' || st.parcelColorBy === 'value') {
      setParcelColorBy(st.parcelColorBy)
    }
    if (st.layerOn && typeof st.layerOn === 'object') setLayerOn(st.layerOn as Record<string, boolean>)
    if (st.layerStyle && typeof st.layerStyle === 'object') {
      setLayerStyle(st.layerStyle as Record<string, { color: string; opacity: number }>)
    }
    if (st.layerColorBy && typeof st.layerColorBy === 'object') {
      setLayerColorBy(st.layerColorBy as Record<string, string>)
    }
    if (Array.isArray(st.assets)) setAssets(new Set((st.assets as unknown[]).map(String)))
    if (st.value && typeof st.value === 'object') setValue(st.value as { min: string; max: string })
    if (st.acres && typeof st.acres === 'object') setAcres(st.acres as { min: string; max: string })

    const centre = st.center as [number, number] | undefined
    if (Array.isArray(centre) && centre.length === 2 && centre.every(Number.isFinite)) {
      setLayerView({
        center: centre,
        zoom: typeof st.zoom === 'number' ? (st.zoom as number) : 12,
        // Keyed on the moment so applying the same view twice flies there
        // again rather than being deduplicated into nothing.
        key: Date.now(),
      })
    }
    // A pick from a previous layer would leave the panel describing a record
    // this view has nothing to do with.
    setLayerPick(null)
    setViewNote({ tone: 'ok', text: `Opened "${view.name}".` })
  }

  async function saveCurrentView() {
    const label = viewName.trim()
    if (!label || !active || viewBusy) return
    setViewBusy(true)
    setViewNote(null)
    try {
      await api.views.save({ market: active, name: label, state: captureView() })
      const res = await api.views.list(active)
      setViews(res.views)
      setViewName('')
      setViewNote({ tone: 'ok', text: `Saved "${label}".` })
    } catch (cause) {
      setViewNote({
        tone: 'warn',
        text: cause instanceof Error ? cause.message : 'Could not save that view.',
      })
    } finally {
      setViewBusy(false)
    }
  }

  async function removeView(id: string) {
    if (!active) return
    try {
      await api.views.remove(id)
      setViews((current) => (current ?? []).filter((view) => view.id !== id))
    } catch (cause) {
      setViewNote({
        tone: 'warn',
        text: cause instanceof Error ? cause.message : 'Could not delete that view.',
      })
    }
  }

  /**
   * Reloads the comps list from the server, so the map and the record list
   * agree with what was actually stored rather than with what was sent.
   */
  async function refreshComps() {
    const res = await api.comps.list(active ?? undefined)
    setComps(res.comps)
    setCompsUnplaced(res.unplaced)
    return res
  }

  /**
   * Geocodes the queue, one bounded pass at a time.
   *
   * The server places twenty-five per call because a single request that
   * looked up four hundred addresses would sit past the edge's timeout and
   * lose the lot. Looping here keeps that fact out of the server's shape and
   * lets the panel count down while it happens.
   */
  async function placeMoreComps() {
    if (compsBusy) return
    setCompsBusy(true)
    try {
      // Driven by what each pass reports rather than by the count this
      // closure captured: the import that queued the work has just changed
      // that number, and reading the stale one would stop before starting.
      let guard = 40
      let remaining = 0
      let placed = 0
      let failed = 0
      do {
        const pass = await api.comps.place()
        remaining = pass.remaining
        placed += pass.placed
        failed += pass.failed
        setCompsUnplaced(remaining)
        guard -= 1
      } while (remaining > 0 && guard > 0)
      await refreshComps()
      // Counted rather than announced as success. A pass where the geocoder
      // read nothing used to say "Addresses located." over an empty map,
      // which is the kind of cheerful lie that costs an afternoon.
      setCompsNote(
        placed === 0
          ? {
              tone: 'warn',
              text: `No address could be located${
                failed ? ` — ${failed} tried` : ''
              }. They are still listed below; the map cannot show them.`,
            }
          : {
              tone: 'ok',
              text: `${placed.toLocaleString()} located${
                failed ? `, ${failed.toLocaleString()} the geocoder could not read` : ''
              }.`,
            },
      )
    } catch (cause) {
      setCompsNote({
        tone: 'warn',
        text: cause instanceof Error ? cause.message : 'Could not place those addresses.',
      })
    } finally {
      setCompsBusy(false)
    }
  }

  /**
   * Reads pasted or uploaded text into records.
   *
   * JSON if it looks like JSON, delimited otherwise. Sniffing beats asking:
   * a broker with a file knows what is in it and should not have to tell the
   * app which of two formats they have.
   */
  function readListings(text: string): unknown[] | null {
    const body = text.trim()
    if (!body) return null
    if (body.startsWith('[') || body.startsWith('{')) {
      try {
        const parsed = JSON.parse(body)
        if (Array.isArray(parsed)) return parsed
        const list = Object.values(parsed as Record<string, unknown>).find(Array.isArray)
        return (list as unknown[]) ?? null
      } catch {
        return null
      }
    }
    // Delimited. The server owns the parser — quoting rules are worth having
    // in exactly one place — so the raw text goes over as-is.
    return [text]
  }

  /**
   * Stores an import, a chunk at a time.
   *
   * Chunked because a listings export is not a paste: a broker with four
   * thousand rows sends four thousand rows, and one request carrying all of
   * them is a request the edge times out on rather than an import. Each chunk
   * is a complete import in its own right, so a run interrupted halfway leaves
   * everything before the interruption stored rather than nothing.
   */
  async function sendListings(records: unknown[], asCsv: string | null) {
    const totals = { added: 0, updated: 0, dropped: 0, truncated: 0 }
    if (asCsv !== null) {
      const res = await api.comps.import({ csv: asCsv, market: active ?? undefined })
      return { ...totals, ...res }
    }
    const CHUNK = 250
    for (let at = 0; at < records.length; at += CHUNK) {
      const slice = records.slice(at, at + CHUNK)
      const res = await api.comps.import({ listings: slice, market: active ?? undefined })
      totals.added += res.added
      totals.updated += res.updated
      totals.dropped += res.dropped
      totals.truncated += res.truncated
      if (records.length > CHUNK) {
        setCompsNote({
          tone: 'ok',
          text: `Importing… ${Math.min(at + CHUNK, records.length).toLocaleString()} of ${records.length.toLocaleString()}`,
        })
      }
    }
    return totals
  }

  /** Turns a finished import into a sentence, then places what it stored. */
  async function afterImport(totals: {
    added: number
    updated: number
    dropped: number
    truncated: number
  }) {
    const parts = [
      totals.added ? `${totals.added.toLocaleString()} added` : '',
      totals.updated ? `${totals.updated.toLocaleString()} updated` : '',
      totals.dropped ? `${totals.dropped.toLocaleString()} without an address skipped` : '',
      totals.truncated ? `${totals.truncated.toLocaleString()} beyond the import limit not read` : '',
    ].filter(Boolean)
    setCompsNote({ tone: 'ok', text: `${parts.join(', ') || 'Nothing new'}. Locating addresses…` })
    const after = await refreshComps()
    setCompsBusy(false)
    // Straight on to placing them: an import that leaves every comp off the
    // map has not finished doing what the broker asked for.
    if (after.unplaced > 0) await placeMoreComps()
  }

  /**
   * Takes what the broker pasted and stores it in their workspace. The parse
   * happens here so a mis-paste is answered instantly rather than by a round
   * trip.
   */
  async function importComps() {
    if (compsBusy) return
    const records = readListings(compsPaste)
    if (!records) {
      setCompsNote({
        tone: 'warn',
        text: 'Could not read that. Paste a CSV with a header row, or the whole JSON value your capture copied.',
      })
      return
    }
    setCompsBusy(true)
    setCompsNote(null)
    try {
      const csv = records.length === 1 && typeof records[0] === 'string' ? (records[0] as string) : null
      const totals = await sendListings(records, csv)
      setCompsPaste('')
      await afterImport(totals)
      return
    } catch (cause) {
      setCompsNote({
        tone: 'warn',
        text: cause instanceof Error ? cause.message : 'Could not import those.',
      })
    }
    setCompsBusy(false)
  }

  /**
   * The same, from a file the broker chose.
   *
   * This is how listings actually arrive — a CSV out of a spreadsheet, an
   * export somebody emailed — so it is a first-class way in rather than an
   * instruction to open the file and copy its contents.
   */
  async function importCompsFile(file: File) {
    if (compsBusy) return
    setCompsBusy(true)
    setCompsNote({ tone: 'ok', text: `Reading ${file.name}…` })
    try {
      const text = await file.text()
      const records = readListings(text)
      if (!records) {
        setCompsNote({
          tone: 'warn',
          text: `${file.name} is neither a CSV with a header row nor a JSON list.`,
        })
        setCompsBusy(false)
        return
      }
      const csv = records.length === 1 && typeof records[0] === 'string' ? (records[0] as string) : null
      const totals = await sendListings(records, csv)
      await afterImport(totals)
      return
    } catch (cause) {
      setCompsNote({
        tone: 'warn',
        text: cause instanceof Error ? cause.message : 'Could not read that file.',
      })
    }
    setCompsBusy(false)
  }

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
        /*
         * The budget, once it starts to matter.
         *
         * Only shown past four fifths, and only when a model was actually
         * called — most hunts are read by the rule parser and cost nothing,
         * so mentioning a budget on those would be noise about a limit the
         * person is not approaching.
         */
        const spent =
          res.budget && res.budget.used > res.budget.cap * 0.8
            ? ` ${res.budget.used} of ${res.budget.cap} AI hunts used today.`
            : ''
        setHuntNote({
          tone: 'ok',
          text: `${res.explanation ?? 'Filters set below — adjust them freely.'}${spent}`,
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

  /**
   * The map exactly as framed, saved as a file.
   *
   * The caption band names what a bare screenshot loses: which market, when,
   * what was filtered, and what the colours mean — plus the attribution the
   * county's licence asks for. The legend lists only what is actually
   * switched on, because a key describing layers that are not in the picture
   * is a small lie in a document that will outlive the session.
   */
  const exportSnapshot = async (kind: 'png' | 'pdf') => {
    setSnapshotting(kind)
    setSnapshotError(null)
    try {
      const frame = await captureMap.current?.()
      if (!frame) throw new Error('The map is not ready to photograph yet.')
      const legend = [
        ...(showParcels ? [{ color: '#01A3A8', label: 'Assessor parcels' }] : []),
        ...extras.map((layer) => ({
          color: layer.color,
          label: shownLayers.find((l) => l.id === layer.id)?.label ?? layer.id,
        })),
        ...(choropleth ? [{ color: '#818cf8', label: 'Demographics' }] : []),
      ]
      const stamp = new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
      const composed = composeMapImage(frame, {
        title: market ? `${market.name} · ${market.region}` : 'Land Quotient',
        subtitle: `${
          filtered ? `${filtered.length.toLocaleString()} parcels matching the filter` : 'Full market'
        } · ${stamp} · Land Quotient`,
        legend,
        attribution: (meta?.attribution ?? '').replace(/&amp;/g, '&'),
      })
      const file = `${active ?? 'market'}-map-${new Date().toISOString().slice(0, 10)}`
      if (kind === 'png') await saveCanvasPng(composed, `${file}.png`)
      else await saveCanvasPdf(composed, `${file}.pdf`, composed ? `${market?.name ?? 'Market'} map` : 'Map')
    } catch (cause) {
      setSnapshotError(cause instanceof Error ? cause.message : 'The snapshot could not be saved.')
    } finally {
      setSnapshotting(null)
    }
  }

  return (
    <div className="relative h-full w-full">
      {/*
        The map is not waiting for anything.

        It used to be rendered only once the market's meta.json had arrived,
        which made a small request on another origin the gate on whether the
        product appeared at all: any hitch there and the whole view was a line
        of text where the map should be. That is a hard failure built out of a
        soft one, and it is what "the map isn't loading" turned out to mean.

        So the basemap opens immediately, at the map's own default view, and
        everything else arrives on top of it as it becomes available — the
        county's centre and its parcels when meta lands, layers when someone
        switches them on. Nothing below blocks the first paint, and a failure
        is now a notice over a working map rather than a blank page.
      */}
      <MapCanvas
          tiles={tiles}
          basemaps={basemaps}
          properties={[]}
          parcels={
            meta?.tiles && meta.heavyBase
              ? {
                  // Same origin as everything else. This used to be the
                  // absolute address out of meta.json, which put the tiles
                  // behind the data bucket's CORS policy exactly as the
                  // catalogue was: the map drew streets, no parcels, and said
                  // "County parcels could not be loaded (Failed to fetch)".
                  // The route behind this serves byte ranges, which is how a
                  // pmtiles archive is read — a few kilobytes per tile rather
                  // than the county.
                  url: `${CATALOG}/${active}/parcels.pmtiles`,
                  fillVisible: showParcels,
                  colorBy: parcelColorBy === 'auto' ? (meta.colorBy === 'value' ? 'value' : 'group') : parcelColorBy,
                  valueBreaks,
                  selectedParcelId: selected,
                  onSelectParcel: (id) => {
                    setFeaturePick(null)
                    setSelected(id)
                  },
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
          // A record chosen in the panel takes the camera; otherwise the
          // market's own centre does, keyed on the slug so switching county
          // reframes and panning around within one does not. Null until the
          // market says where it is, which leaves the map on its own opening
          // view rather than holding the map back until it can be told.
          view={layerView ?? (meta ? { center: meta.center, zoom: meta.zoom, key: active ?? '' } : null)}
          // Kept in a ref rather than state: this fires on every settle, and
          // re-rendering the map on each pan to store a number the map itself
          // already knows would be a waste for a value only saving reads.
          onViewChange={(where) => {
            here.current = where
          }}
          captureRef={captureMap}
          onExtraPick={(pick) => {
            setSelected(null)
            setFeaturePick(pick)
          }}
          choropleth={choropleth?.areas ?? null}
          choroplethOpacity={censusOpacity}
          extras={extras}
        />

      {/* Said over the map rather than instead of it. An out-of-date tab and
          an unreachable catalogue are both worth telling someone about, and
          neither is a reason to take away a map that works. */}
      {stale && (
        <div className="pointer-events-auto absolute left-1/2 top-3 z-[600] flex -translate-x-1/2 items-center gap-3 rounded-lg border border-line bg-surface/97 px-3 py-2 text-xs text-body shadow-lg backdrop-blur">
          <span>This tab is running an older version than the server.</span>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md bg-ink px-2.5 py-1 text-xs font-medium text-white"
          >
            Reload
          </button>
        </div>
      )}
      {!stale && error && (
        <div className="absolute left-1/2 top-3 z-[600] -translate-x-1/2 rounded-lg border border-line bg-surface/97 px-3 py-2 text-xs text-body shadow-lg backdrop-blur">
          {error}
        </div>
      )}
      {!stale && !error && active && !meta && (
        <div className="absolute left-1/2 top-3 z-[600] -translate-x-1/2 rounded-lg border border-line bg-surface/97 px-3 py-2 text-xs text-muted shadow-lg backdrop-blur">
          Loading the county…
        </div>
      )}

      {/*
        Held until the market list has arrived, so the tips never point at a
        panel that is still empty. Versioned in the key: changing the tour
        should show it again, and a stale "done" flag would silently swallow
        the new one.
      */}
      <Coachmarks steps={GIS_TIPS} storageKey="lq.gis.tips.v1" enabled={markets.length > 0} />

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
            <div data-tour="market">
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
                  {!(server?.ready || index) && <span> · loading detail…</span>}
                </p>
              )}
            </div>

            {/* Above the catalog, because a saved view is where you start
                rather than something you reach after configuring by hand. */}
            <div data-tour="views">
              <SavedViews
              views={views}
              name={viewName}
              busy={viewBusy}
              note={viewNote}
              onName={setViewName}
              onSave={saveCurrentView}
              onOpen={applyView}
              onDelete={removeView}
              />
            </div>

            <div className="border-t border-line pt-3" data-tour="layers">
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

            {shownLayers
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
                    {(layerCategories[layer.id]?.length ?? 0) > 0 && (
                      <div>
                        <label
                          className="mb-1 block text-[11px] font-medium text-body"
                          htmlFor={`gis-layer-${layer.id}-colorby`}
                        >
                          Colour by
                        </label>
                        <select
                          id={`gis-layer-${layer.id}-colorby`}
                          className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-ink"
                          value={layerColorBy[layer.id] ?? ''}
                          onChange={(event) =>
                            setLayerColorBy((current) => ({
                              ...current,
                              [layer.id]: event.target.value,
                            }))
                          }
                        >
                          <option value="">One colour</option>
                          {(layerCategories[layer.id] ?? []).map((option) => (
                            <option key={option.field} value={option.field}>
                              {option.field} ({option.values.length})
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    {categoryPaint[layer.id] ? (
                      <div>
                        <p className="mb-1 text-[11px] font-medium text-body">
                          {categoryPaint[layer.id].field}
                        </p>
                        <ul className="max-h-40 space-y-0.5 overflow-y-auto pr-1">
                          {Object.entries(categoryPaint[layer.id].colors).map(([value, hue]) => (
                            <li key={value} className="flex items-center gap-1.5">
                              <span
                                className="h-2.5 w-2.5 shrink-0 rounded-sm"
                                style={{ backgroundColor: hue }}
                              />
                              <span className="truncate text-[11px] text-body">{value}</span>
                            </li>
                          ))}
                        </ul>
                        {categoryPaint[layer.id].rest > 0 && (
                          <p className="mt-1 flex items-center gap-1.5 text-[11px] text-faint">
                            <span
                              className="h-2.5 w-2.5 shrink-0 rounded-sm"
                              style={{ backgroundColor: style.color }}
                            />
                            {categoryPaint[layer.id].rest.toLocaleString()} more, in the layer colour
                          </p>
                        )}
                      </div>
                    ) : (
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
                    )}
                    {layer.total && layer.count && layer.total > layer.count ? (
                      <p className="text-[11px] text-faint">
                        Showing {layer.count.toLocaleString()} of {layer.total.toLocaleString()}
                        {layer.filter ? `, ${layer.filter}` : ''}.
                      </p>
                    ) : layer.filter ? (
                      <p className="text-[11px] text-faint">All {layer.filter}.</p>
                    ) : null}
                    {layer.attribution && (
                      <p className="text-[11px] text-faint">Source: {layer.attribution}</p>
                    )}

                    {/* What the layer holds, not only how it is painted.
                        Everything above this line describes the drawing;
                        switching a layer on ought to hand over the records
                        as well, because a hundred and eight city lots with
                        asking prices are a list somebody wants to read. */}
                    {layer.id === 'comps' && (
                      <CompsImport
                        comps={comps}
                        unplaced={compsUnplaced}
                        busy={compsBusy}
                        paste={compsPaste}
                        note={compsNote}
                        onPaste={setCompsPaste}
                        onImport={importComps}
                        onFile={importCompsFile}
                        onPlace={placeMoreComps}
                      />
                    )}

                    {shownData[layer.id]?.features?.length ? (
                      <LayerRecords
                        features={shownData[layer.id].features}
                        fields={
                          layer.fields?.length
                            ? layer.fields
                            : Object.keys(shownData[layer.id].features[0]?.properties ?? {})
                        }
                        picked={layerPick?.layer === layer.id ? layerPick.index : null}
                        onPick={(index, centre) => {
                          setLayerPick(index == null ? null : { layer: layer.id, index })
                          if (centre) {
                            setLayerView({
                              center: centre,
                              // Close enough to read the building, wide
                              // enough to see what it sits next to.
                              zoom: 16.5,
                              key: Date.now(),
                            })
                          }
                        }}
                      />
                    ) : null}
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
            {!(server?.ready || index) && (
              <p className="text-[11px] text-muted">Loading the market's records…</p>
            )}
            {query.trim() !== '' && filtered && (
              <>
                <p className="text-[11px] text-muted">
                  {/*
                    * How many matched, which is not how many are listed. The
                    * server answers with a page; saying "200 matches" when a
                    * county holds four thousand would be a lie the old path
                    * could not tell because it held everything.
                    */}
                  {summary.count.toLocaleString()} match{summary.count === 1 ? '' : 'es'}
                  {summary.count > filtered.length && `, showing the first ${filtered.length}`}
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
            {!(server?.ready || index) ? (
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
                    {/*
                      * How many the filter keeps, of how many there are. From
                      * the server both numbers are counts of the whole market
                      * rather than lengths of what happens to be in memory —
                      * the page holds two hundred rows and would otherwise
                      * report a county as "200 of 200".
                      */}
                    {summary.count.toLocaleString()} of{' '}
                    {(server?.ready ? (server.count ?? 0) : rows.length).toLocaleString()}
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
            {/*
              * Ready means different things on the two paths: the whole index
              * downloaded, or the server saying it can answer. Either way the
              * numbers below are real before they are shown.
              */}
            {!(server?.ready || index) ? (
              <p className="text-[11px] text-muted">Loading the market's records…</p>
            ) : (
              <>
                <p className="text-[11px] text-muted">
                  {searching
                    ? 'Counting…'
                    : filtered
                      ? 'The parcels matching your filter.'
                      : 'Every parcel in this market.'}
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
                  disabled={exporting}
                  className="w-full rounded-md border border-line px-2 py-1.5 text-xs font-medium text-ink hover:bg-sunken disabled:opacity-60"
                  onClick={exportRows}
                >
                  {exporting
                    ? 'Collecting rows…'
                    : `Export ${Math.min(summary.count, CSV_LIMIT).toLocaleString()} rows as CSV`}
                </button>
                {summary.count > CSV_LIMIT && (
                  <p className="text-[11px] text-muted">
                    The most valuable {CSV_LIMIT.toLocaleString()} of{' '}
                    {summary.count.toLocaleString()}. Narrow the filter to export a different set.
                  </p>
                )}
                <div className="border-t border-line pt-2">
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted">
                    Map snapshot
                  </p>
                  <p className="text-[11px] leading-snug text-muted">
                    The map exactly as framed right now — layers, colours and filters — with a
                    caption naming the market and what the colours mean.
                  </p>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      className="flex-1 rounded-md border border-line px-2 py-1.5 text-xs font-medium text-ink hover:bg-sunken disabled:opacity-50"
                      disabled={snapshotting !== null}
                      onClick={() => exportSnapshot('png')}
                    >
                      {snapshotting === 'png' ? 'Saving…' : 'Save as PNG'}
                    </button>
                    <button
                      type="button"
                      className="flex-1 rounded-md border border-line px-2 py-1.5 text-xs font-medium text-ink hover:bg-sunken disabled:opacity-50"
                      disabled={snapshotting !== null}
                      onClick={() => exportSnapshot('pdf')}
                    >
                      {snapshotting === 'pdf' ? 'Saving…' : 'Save as PDF'}
                    </button>
                  </div>
                  {snapshotError ? (
                    <p className="mt-1 text-[11px] text-rose-600">{snapshotError}</p>
                  ) : null}
                </div>
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
      {/* A clicked layer feature: permit, zoning district, flood zone, school.
          The same card position and the same scroll — a record is a record. */}
      {featurePick && selected == null && (
        <div className="absolute bottom-9 right-3 z-[500] max-h-[72vh] w-80 overflow-y-auto rounded-lg border border-line bg-surface/97 p-3 shadow-xl backdrop-blur">
          <button
            type="button"
            className="float-right text-muted hover:text-ink"
            aria-label="Close record"
            onClick={() => setFeaturePick(null)}
          >
            ×
          </button>
          <p className="text-sm font-semibold text-ink">
            {shownLayers.find((l) => l.id === featurePick.layerId)?.label ?? featurePick.layerId}
          </p>
          <dl className="mt-2 space-y-1 text-xs">
            {(() => {
              const layer = shownLayers.find((l) => l.id === featurePick.layerId)
              const order = layer?.fields?.length
                ? layer.fields
                : Object.keys(featurePick.properties)
              return order
                .filter(
                  (field) =>
                    featurePick.properties[field] != null && featurePick.properties[field] !== '',
                )
                .map((field) => (
                  <Row key={field} label={field} value={String(featurePick.properties[field])} />
                ))
            })()}
          </dl>
        </div>
      )}

      {selected != null && !expanded && (
        <div className="absolute bottom-9 right-3 z-[500] max-h-[72vh] w-80 overflow-y-auto rounded-lg border border-line bg-surface/97 p-3 shadow-xl backdrop-blur">
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

              {/*
                * What the roll alone can say is four lines, and on a bare map
                * that is all a click ever returns. Rather than let the card
                * read as the whole story, it names the thing that would make
                * it longer — and opens the panel that does it, because a hint
                * you have to go and find is barely a hint.
                */}
              {!published.some((layer) => layerOn[layer.id]) && (
                <button
                  type="button"
                  onClick={() => setRail('layers')}
                  className="mt-2 w-full rounded-md border border-dashed border-line px-2 py-1.5 text-left text-[11px] text-muted hover:border-brand hover:text-body"
                >
                  Add data layers to see more about this parcel →
                </button>
              )}

              {/* Who holds it, from the pipeline's resolved groups: the
                  portfolio is one holder across spelling variants, the back
                  office one mailing address across many entity names. */}
              {(() => {
                const portfolio = parcel.po != null ? owners?.p?.[String(parcel.po)] : null
                const office = parcel.bo != null ? owners?.b?.[String(parcel.bo)] : null
                if (!portfolio && !office) return null
                return (
                  <div className="mt-3 border-t border-line pt-2">
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted">
                      Ownership
                    </p>
                    {portfolio ? (
                      <div className="text-xs">
                        <p className="font-semibold text-ink">{portfolio.n || 'Unnamed holder'}</p>
                        <p className="text-muted">
                          Portfolio · {portfolio.c.toLocaleString()} parcels · {money(portfolio.v)}
                        </p>
                        <button
                          type="button"
                          className="mt-0.5 text-[11px] font-medium text-brand hover:underline"
                          onClick={() =>
                            setOwnerPick({ kind: 'p', id: String(parcel.po) })
                          }
                        >
                          Show all holdings on the map
                        </button>
                      </div>
                    ) : null}
                    {office ? (
                      <div className={`text-xs ${portfolio ? 'mt-2' : ''}`}>
                        <p className="font-semibold text-ink">{office.a || 'Unnamed address'}</p>
                        <p className="text-muted">
                          Back office · {office.c.toLocaleString()} parcels · {money(office.v)}
                        </p>
                        <button
                          type="button"
                          className="mt-0.5 text-[11px] font-medium text-brand hover:underline"
                          onClick={() =>
                            setOwnerPick({ kind: 'b', id: String(parcel.bo) })
                          }
                        >
                          Show all holdings on the map
                        </button>
                      </div>
                    ) : null}
                  </div>
                )
              })()}

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
