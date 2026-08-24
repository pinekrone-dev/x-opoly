import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Property, TourPlan } from '../types'
import { STAGE_META, duration, fullAddress, displayName } from '../lib/format'

interface Props {
  surveyId: string
  properties: Property[]
  selectedId: string | null
  onSelect: (id: string) => void
  onOrderChange: (order: string[]) => void
}

export default function TourPlanner({ surveyId, properties, selectedId, onSelect, onOrderChange }: Props) {
  const [plan, setPlan] = useState<TourPlan | null>(null)
  const [order, setOrder] = useState<string[]>([])
  const [startId, setStartId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)

  const located = properties.filter((property) => property.lat != null && property.lng != null)

  // Seed from any saved order, otherwise the current list order.
  useEffect(() => {
    const existing = located.filter((property) => property.tourOrder != null).map((property) => property.id)
    const next = existing.length > 0 ? existing : located.map((property) => property.id)
    setOrder(next)
    onOrderChange(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [properties.length])

  const optimize = async () => {
    setBusy(true)
    try {
      const result = await api.planTour(surveyId, startId)
      setPlan(result)
      const ids = result.stops.map((stop) => stop.id)
      setOrder(ids)
      onOrderChange(ids)
      setSaved(false)
    } finally {
      setBusy(false)
    }
  }

  const move = (index: number, delta: number) => {
    const next = [...order]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    setOrder(next)
    onOrderChange(next)
    setSaved(false)
  }

  const save = async () => {
    await api.saveTourOrder(surveyId, order)
    setSaved(true)
  }

  const byId = new Map(properties.map((property) => [property.id, property]))
  const stops = order.map((id) => byId.get(id)).filter((property): property is Property => Boolean(property))
  const legMiles = new Map(plan?.legs.map((leg) => [leg.toId, leg.miles]) ?? [])
  const unlocated = properties.filter((property) => property.lat == null || property.lng == null)

  return (
    <section className="panel flex min-h-0 flex-col">
      <header className="panel-header flex-wrap gap-2">
        <h2 className="panel-title">Tour route</h2>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-slate-400">
            Start at
            <select
              className="field py-1 text-xs"
              value={startId ?? ''}
              onChange={(event) => setStartId(event.target.value || null)}
            >
              <option value="">Best guess</option>
              {located.map((property) => (
                <option key={property.id} value={property.id}>
                  {displayName(property)}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn-primary py-1.5 text-xs" onClick={() => void optimize()} disabled={busy || located.length < 2}>
            {busy ? 'Planning…' : 'Optimize order'}
          </button>
          <button type="button" className="btn-secondary py-1.5 text-xs" onClick={() => void save()} disabled={order.length === 0}>
            {saved ? 'Saved' : 'Save order'}
          </button>
        </div>
      </header>

      {plan && (
        <div className="grid grid-cols-3 gap-2 border-b border-white/5 p-3">
          <div className="stat">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Stops</p>
            <p className="mt-0.5 font-mono text-lg font-semibold text-slate-100">{plan.stops.length}</p>
          </div>
          <div className="stat">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Driving</p>
            <p className="mt-0.5 font-mono text-lg font-semibold text-slate-100">{plan.miles} mi</p>
          </div>
          <div className="stat">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Allow</p>
            <p className="mt-0.5 font-mono text-lg font-semibold text-brand">{duration(plan.minutes)}</p>
          </div>
        </div>
      )}

      <ol className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-3">
        {stops.map((property, index) => (
          <li key={property.id}>
            <div
              className={`group flex items-center gap-3 rounded-lg px-2 py-2 ${
                property.id === selectedId ? 'bg-brand/10' : 'hover:bg-white/[0.03]'
              }`}
            >
              <span
                className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold text-ink-950"
                style={{ background: STAGE_META[property.stage]?.color }}
              >
                {index + 1}
              </span>
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onSelect(property.id)}>
                <span className="block truncate text-sm text-slate-100">{displayName(property)}</span>
                <span className="block truncate text-xs text-slate-500">{fullAddress(property)}</span>
              </button>
              {legMiles.has(property.id) && (
                <span className="shrink-0 font-mono text-[11px] text-slate-500">+{legMiles.get(property.id)} mi</span>
              )}
              <span className="flex shrink-0 flex-col opacity-0 transition group-hover:opacity-100">
                <button type="button" className="px-1 text-slate-500 hover:text-slate-200" onClick={() => move(index, -1)} aria-label={`Move ${displayName(property)} earlier`}>
                  ▲
                </button>
                <button type="button" className="px-1 text-slate-500 hover:text-slate-200" onClick={() => move(index, 1)} aria-label={`Move ${displayName(property)} later`}>
                  ▼
                </button>
              </span>
            </div>
          </li>
        ))}

        {stops.length === 0 && (
          <li className="px-2 py-10 text-center text-sm text-slate-500">
            Add sites with a location to plan a tour.
          </li>
        )}
      </ol>

      {unlocated.length > 0 && (
        <p className="border-t border-white/5 px-4 py-2.5 text-xs text-slate-500">
          {unlocated.length} site{unlocated.length === 1 ? '' : 's'} not on the map yet, so left out of the route.
        </p>
      )}
    </section>
  )
}
