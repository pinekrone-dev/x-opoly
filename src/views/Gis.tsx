import { useEffect, useMemo, useState } from 'react'
import MapCanvas from '../components/MapCanvas'
import GisRail, { CheckList, RangeInput, type RailTab } from '../components/GisRail'
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

const CATALOG_DEFAULT = 'https://prospector.realestateaistudio.com'

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

/** The land-use colours, matching what the map draws. */
const LEGEND: [string, string][] = [
  ['Commercial', '#2a78d6'],
  ['Multifamily', '#eb6834'],
  ['Vacant land', '#1baf7a'],
  ['Single family', '#9AA1B4'],
  ['Other', '#5C6377'],
]

const VALUE_RAMP = ['#EDE7FA', '#D6C6F3', '#BBA0EA', '#9D77DD', '#7F4FCB', '#6031AE', '#43208A']

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
  const [known, setKnown] = useState<{ place: Place | null; deals: Deal[] } | null>(null)
  const [saving, setSaving] = useState(false)

  const [rail, setRail] = useState<RailTab | null>('layers')
  const [showParcels, setShowParcels] = useState(true)
  const [opacity, setOpacity] = useState(0.34)
  const [query, setQuery] = useState('')
  const [assets, setAssets] = useState<Set<string>>(new Set())
  const [value, setValue] = useState({ min: '', max: '' })
  const [acres, setAcres] = useState({ min: '', max: '' })

  useEffect(() => {
    fetch(`${CATALOG}/markets.json`)
      .then((r) => r.json())
      .then((d) => {
        const live: Market[] = (d.markets || []).filter((m: Market) => m.status === 'live')
        setMarkets(live)
        setActive((current) => current || live[0]?.slug || null)
      })
      .catch(() => setError('Could not reach the parcel catalogue.'))
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
    fetch(`${CATALOG}/${active}/data/meta.json`)
      .then((r) => r.json())
      .then(setMeta)
      .catch(() => setError('Could not load that market.'))
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
      Boolean(needle) || assets.size > 0 ||
      [vMin, vMax, aMin, aMax].some((n) => n != null && Number.isFinite(n))
    if (!active || !rows.length) return null

    const out: Record<string, string | number | null>[] = []
    for (const row of rows) {
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
  }, [rows, query, assets, value, acres])

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

  /** The centre of the selected parcel, from its bounding box in the index. */
  const centre = useMemo(() => {
    if (selected == null || !index?.bb) return null
    const row = rowOf.get(selected)
    if (row == null) return null
    const [w, s, e, n] = index.bb.slice(row * 4, row * 4 + 4)
    if (![w, s, e, n].every(Number.isFinite)) return null
    return { lat: (s + n) / 2, lng: (w + e) / 2 }
  }, [selected, index, rowOf])

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
                  colorBy: meta.colorBy === 'value' ? 'value' : 'group',
                  valueBreaks,
                  selectedParcelId: selected,
                  onSelectParcel: setSelected,
                  filterIds,
                  opacity,
                }
              : null
          }
          view={{ center: meta.center, zoom: meta.zoom, key: active ?? '' }}
        />
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

            <label className="flex items-center gap-2 border-t border-line pt-3 text-xs text-body">
              <input
                type="checkbox"
                className="accent-brand"
                checked={showParcels}
                onChange={(event) => setShowParcels(event.target.checked)}
              />
              <span className="flex-1">County parcels</span>
              <span className="text-[11px] text-faint">{meta?.count?.toLocaleString() ?? ''}</span>
            </label>

            <div>
              <label className="mb-1 block text-[11px] font-medium text-body">Opacity</label>
              <input
                type="range"
                className="w-full accent-brand"
                min={0.08}
                max={0.85}
                step={0.01}
                value={opacity}
                disabled={!showParcels}
                onChange={(event) => setOpacity(Number(event.target.value))}
              />
            </div>

            {/* The legend says what the colours mean, and says plainly when a
                county publishes no land use to colour by. */}
            <div className="border-t border-line pt-2">
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
                {meta?.colorBy === 'value' ? meta.valueLabel || 'Value' : 'Land use'}
              </p>
              {meta?.colorBy === 'value' ? (
                <>
                  <div className="flex h-2 overflow-hidden rounded">
                    {VALUE_RAMP.map((hue) => (
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

      {/* The card. Opens on click and never on hover: on a map this dense the
          pointer crosses dozens of parcels on the way anywhere. Raised clear of
          the attribution control, which the basemap licences require stay
          readable. */}
      {selected != null && (
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
