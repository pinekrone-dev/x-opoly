import { useEffect, useMemo, useState } from 'react'
import MapCanvas from '../components/MapCanvas'
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
          parcels={{
            url: `${viaProxy(meta.heavyBase)}parcels.pmtiles`,
            colorBy: meta.colorBy === 'value' ? 'value' : 'group',
            valueBreaks,
            selectedParcelId: selected,
            onSelectParcel: setSelected,
          }}
          view={{ center: meta.center, zoom: meta.zoom, key: active ?? '' }}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-sm text-muted">
          {error ?? (active ? 'Loading parcels…' : 'No markets available.')}
        </div>
      )}

      {/* Market picker. Coverage is per county, so which one is a real choice. */}
      <div className="absolute left-3 top-3 z-[500] w-64 rounded-lg border border-line bg-surface/95 p-2 shadow-lg backdrop-blur">
        <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted">
          Market
        </label>
        <select
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
          <p className="mt-1.5 text-[11px] text-muted">
            {market.stats.parcels.toLocaleString()} parcels · {money(market.stats.value)}
            {!index && <span> · loading detail…</span>}
          </p>
        )}
      </div>

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
