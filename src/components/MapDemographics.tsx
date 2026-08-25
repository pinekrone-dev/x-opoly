import { useState } from 'react'
import { api } from '../api'
import type { Demographics, Property } from '../types'
import { METRIC_DEFINITIONS, SCALE, formatMetric } from './DemographicsPanel'

/**
 * The demographics overlay, controlled from the map itself.
 *
 * This used to live only inside a property's side panel, which read as
 * "demographics is a sub-feature of one site" — and because the shading was
 * wired to the tour canvas, it looked like part of the tour planner. It is
 * neither: it is a map layer. So it gets a map control, like the basemap
 * picker, anchored to whichever site is selected or to wherever the map is
 * looking when none is.
 */
export default function MapDemographics({
  selected,
  mapCenter,
  onView,
}: {
  selected: Property | null
  mapCenter: { lat: number; lng: number } | null
  onView: (view: { data: Demographics | null; colorBy: string; radius: number } | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<Demographics | null>(null)
  const [colorBy, setColorBy] = useState('population')
  const [radius, setRadius] = useState(3)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [anchorLabel, setAnchorLabel] = useState<string | null>(null)

  const anchor =
    selected?.lat != null && selected?.lng != null
      ? { lat: selected.lat, lng: selected.lng, label: selected.name ?? 'the selected site' }
      : mapCenter
        ? { ...mapCenter, label: 'the middle of this view' }
        : null

  const load = async () => {
    if (!anchor) {
      setError('Move the map to the area you want first.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const loaded = await api.demographics(anchor.lat, anchor.lng)
      setData(loaded)
      setAnchorLabel(anchor.label)
      onView({ data: loaded, colorBy, radius })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Census data could not be loaded.')
    } finally {
      setBusy(false)
    }
  }

  const update = (next: { colorBy?: string; radius?: number }) => {
    const view = { colorBy: next.colorBy ?? colorBy, radius: next.radius ?? radius }
    if (next.colorBy) setColorBy(next.colorBy)
    if (next.radius) setRadius(next.radius)
    if (data) onView({ data, ...view })
  }

  const clear = () => {
    setData(null)
    setAnchorLabel(null)
    onView(null)
  }

  const metric = METRIC_DEFINITIONS.find((entry) => entry.key === colorBy) ?? METRIC_DEFINITIONS[0]
  const ring = data?.radii.find((entry) => entry.miles === radius)

  return (
    <div className="absolute left-14 top-3 z-[500]">
      {!open ? (
        <button
          type="button"
          className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-semibold text-body shadow-sm hover:bg-sunken"
          onClick={() => setOpen(true)}
        >
          <span
            className="h-3 w-3 rounded-sm"
            style={{ background: data ? SCALE[3] : 'transparent', border: data ? 'none' : '1.5px solid currentColor' }}
            aria-hidden
          />
          Demographics
          {data ? <span className="text-muted">· {metric.label}</span> : null}
        </button>
      ) : (
        <div className="panel w-64 p-3 shadow-lg">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-ink">Demographic overlay</p>
            <button type="button" className="btn-ghost px-1.5 py-0.5 text-xs" onClick={() => setOpen(false)} aria-label="Collapse">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="m18 15-6-6-6 6" />
              </svg>
            </button>
          </div>

          <div className="mt-2 flex flex-wrap gap-1">
            {METRIC_DEFINITIONS.map((entry) => (
              <button
                key={entry.key}
                type="button"
                className={`tab px-2 py-0.5 text-[11px] ${colorBy === entry.key ? 'tab-active' : ''}`}
                aria-pressed={colorBy === entry.key}
                onClick={() => update({ colorBy: entry.key })}
              >
                {entry.label}
              </button>
            ))}
          </div>

          <div className="mt-2 flex items-center gap-1">
            <span className="text-[11px] text-muted">Ring:</span>
            {[1, 3, 5].map((miles) => (
              <button
                key={miles}
                type="button"
                className={`tab px-2 py-0.5 text-[11px] ${radius === miles ? 'tab-active' : ''}`}
                aria-pressed={radius === miles}
                onClick={() => update({ radius: miles })}
              >
                {miles} mi
              </button>
            ))}
          </div>

          {data && ring ? (
            <div className="mt-2 rounded-lg bg-sunken p-2">
              <div className="h-2 w-full rounded-full" style={{ background: `linear-gradient(to right, ${SCALE.join(',')})` }} aria-hidden />
              <p className="mt-1.5 text-[11px] text-body">
                {metric.label} within {radius} mi of {anchorLabel}:{' '}
                <strong className="text-ink">{formatMetric(ring.metrics?.[colorBy], metric.format)}</strong>
              </p>
              <p className="text-[10px] text-muted">{data.source}</p>
            </div>
          ) : null}

          <div className="mt-2 flex gap-2">
            <button type="button" className="btn-primary flex-1 text-xs" disabled={busy || !anchor} onClick={() => void load()}>
              {busy ? 'Loading…' : data ? `Reload around ${selected ? 'the site' : 'this view'}` : 'Shade the map'}
            </button>
            {data ? (
              <button type="button" className="btn-secondary text-xs" onClick={clear}>
                Clear
              </button>
            ) : null}
          </div>
          {error ? <p className="mt-2 text-[11px] leading-snug text-rose-600">{error}</p> : null}
        </div>
      )}
    </div>
  )
}
