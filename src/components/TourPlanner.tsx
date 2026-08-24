import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import type { Property, TourAnchor, TourPlan } from '../types'
import { displayName, fullAddress } from '../lib/format'

/**
 * The tour configuration panel.
 *
 * A tour is a driving afternoon, so the questions it answers are when do we
 * leave, which sites are we seeing, how long at each, and what time do we get
 * there. Everything here feeds one request to the server, which does the
 * routing and the arithmetic and hands back a schedule.
 */

interface Props {
  surveyId: string
  properties: Property[]
  defaults: { startTime: string; stopMinutes: number; start: TourAnchor | null; end: TourAnchor | null }
  selectedId: string | null
  onSelect: (id: string) => void
  onOrderChange: (order: string[]) => void
  onPlan?: (plan: TourPlan | null) => void
  onClose?: () => void
}

export default function TourPlanner({
  surveyId,
  properties,
  defaults,
  selectedId,
  onSelect,
  onOrderChange,
  onPlan,
  onClose,
}: Props) {
  const located = useMemo(
    () => properties.filter((property) => property.lat != null && property.lng != null),
    [properties],
  )

  const [startTime, setStartTime] = useState(defaults.startTime || '10:00')
  const [stopMinutes, setStopMinutes] = useState(defaults.stopMinutes ?? 20)
  const [chosen, setChosen] = useState<string[]>(() => located.map((property) => property.id))
  const [order, setOrder] = useState<string[]>([])
  const [start, setStart] = useState<TourAnchor | null>(defaults.start)
  const [end, setEnd] = useState<TourAnchor | null>(defaults.end)
  const [plan, setPlan] = useState<TourPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sitesOpen, setSitesOpen] = useState(true)
  const [dragging, setDragging] = useState<number | null>(null)

  const byId = useMemo(() => new Map(located.map((property) => [property.id, property])), [located])

  // Keep the selection honest when sites are added or removed underneath.
  useEffect(() => {
    setChosen((current) => {
      const ids = new Set(located.map((property) => property.id))
      const kept = current.filter((id) => ids.has(id))
      const added = located.filter((property) => !current.includes(property.id)).map((p) => p.id)
      return [...kept, ...added]
    })
  }, [located])

  const schedule = useCallback(
    async (ids: string[], optimize: boolean) => {
      if (ids.length === 0) {
        setPlan(null)
        onPlan?.(null)
        return
      }
      setBusy(true)
      setError(null)
      try {
        const result = await api.planTour(surveyId, {
          propertyIds: ids,
          startTime,
          stopMinutes,
          optimize,
          start,
          end,
        })
        setPlan(result)
        onPlan?.(result)
        const routed = result.stops.map((stop) => stop.id)
        setOrder(routed)
        onOrderChange(routed)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not plan that tour.')
      } finally {
        setBusy(false)
      }
    },
    [surveyId, startTime, stopMinutes, start, end, onOrderChange, onPlan],
  )

  // Re-time whenever a setting changes, keeping the broker's chosen order.
  useEffect(() => {
    const ids = order.length > 0 ? order.filter((id) => chosen.includes(id)) : chosen
    void schedule(ids, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startTime, stopMinutes, start, end, chosen])

  const times = useMemo(
    () => new Map((plan?.itinerary.items ?? []).map((item) => [item.id, item])),
    [plan],
  )

  const stops = order.length > 0 ? order : chosen

  const toggle = (id: string) =>
    setChosen((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]))

  const reorder = (from: number, to: number) => {
    if (from === to) return
    const next = [...stops]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    setOrder(next)
    onOrderChange(next)
    void schedule(next, false)
  }

  const removeStop = (id: string) => {
    const next = stops.filter((entry) => entry !== id)
    setOrder(next)
    setChosen((current) => current.filter((entry) => entry !== id))
  }

  const setDwell = async (property: Property, minutes: number) => {
    await api.updateProperty(property.id, { tourMinutes: minutes })
    // The server holds the override; re-time so arrivals move with it.
    void schedule(stops, false)
  }

  const persistDefaults = () => {
    void api
      .updateSurvey(surveyId, {
        tourStartTime: startTime,
        tourStopMinutes: stopMinutes,
        tourStartAddress: start?.address ?? null,
        tourStartLat: start?.lat ?? null,
        tourStartLng: start?.lng ?? null,
        tourEndAddress: end?.address ?? null,
        tourEndLat: end?.lat ?? null,
        tourEndLng: end?.lng ?? null,
      })
      .catch(() => undefined)
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-300">Tour configuration</h2>
        {onClose ? (
          <button
            type="button"
            className="ml-auto text-slate-500 hover:text-slate-200"
            onClick={onClose}
            aria-label="Close tour planner"
          >
            <Times />
          </button>
        ) : null}
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="grid grid-cols-2 gap-3">
          <label>
            <span className="label">Start time</span>
            <input
              className="field"
              aria-label="Start time"
              value={startTime}
              onChange={(event) => setStartTime(event.target.value)}
              onBlur={persistDefaults}
              placeholder="10:00 AM"
            />
          </label>
          <label>
            <span className="label">Min per stop</span>
            <input
              className="field"
              type="number"
              min={0}
              step={5}
              aria-label="Minutes per stop"
              value={stopMinutes}
              onChange={(event) => setStopMinutes(Math.max(0, Number(event.target.value) || 0))}
              onBlur={persistDefaults}
            />
          </label>
        </div>

        <section className="mt-4">
          <button
            type="button"
            className="flex w-full items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400"
            onClick={() => setSitesOpen((open) => !open)}
            aria-expanded={sitesOpen}
          >
            Select sites ({chosen.length}/{located.length})
            <span className="ml-auto">
              <Chevron open={sitesOpen} />
            </span>
          </button>

          {sitesOpen ? (
            <ul className="mt-2 space-y-1">
              {located.map((property) => (
                <li key={property.id}>
                  <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-white/5 bg-white/[0.02] p-2 hover:bg-white/[0.05]">
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-teal-400"
                      checked={chosen.includes(property.id)}
                      onChange={() => toggle(property.id)}
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-slate-100">{displayName(property)}</span>
                      <span className="block truncate text-xs text-slate-500">{fullAddress(property)}</span>
                    </span>
                  </label>
                </li>
              ))}
              {located.length === 0 ? (
                <li className="py-3 text-xs text-slate-500">
                  No sites have coordinates yet — a tour needs somewhere to drive.
                </li>
              ) : null}
            </ul>
          ) : null}
        </section>

        <AnchorField
          label="Start"
          badge="S"
          anchor={start}
          hint={plan?.itinerary ? `Depart ${plan.itinerary.startTime}` : undefined}
          onSet={(next) => {
            setStart(next)
            persistDefaults()
          }}
        />

        <section className="mt-4">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Tour stops</h3>
            <button
              type="button"
              className="btn-secondary ml-auto px-2 py-1 text-xs"
              disabled={busy || chosen.length < 2}
              onClick={() => void schedule(chosen, true)}
            >
              {busy ? 'Working…' : 'Optimize route'}
            </button>
          </div>

          <ol className="mt-2 space-y-2">
            {stops.map((id, index) => {
              const property = byId.get(id)
              if (!property) return null
              const time = times.get(id)
              return (
                <li
                  key={id}
                  className={`rounded-lg border p-2 ${
                    selectedId === id ? 'border-teal-400/40 bg-teal-400/10' : 'border-white/5 bg-white/[0.02]'
                  } ${dragging === index ? 'opacity-40' : ''}`}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault()
                    if (dragging != null) reorder(dragging, index)
                    setDragging(null)
                  }}
                >
                  <div className="flex items-start gap-2">
                    <span
                      draggable
                      onDragStart={() => setDragging(index)}
                      onDragEnd={() => setDragging(null)}
                      className="cursor-grab pt-1 text-slate-600 active:cursor-grabbing"
                      aria-hidden
                    >
                      <Grip />
                    </span>
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-teal-400 text-xs font-bold text-ink-900">
                      {index + 1}
                    </span>
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onSelect(id)}>
                      <span className="block truncate text-sm font-medium text-slate-100">
                        {displayName(property)}
                      </span>
                      <span className="block truncate text-xs text-slate-500">{fullAddress(property)}</span>
                      {time ? (
                        <span className="mt-1 block text-xs">
                          <span className="text-teal-300">{time.driveMinutes} min drive</span>
                          <span className="text-slate-400"> · Arrive {time.arrive}</span>
                        </span>
                      ) : null}
                    </button>
                    <button
                      type="button"
                      className="text-slate-600 hover:text-rose-400"
                      onClick={() => removeStop(id)}
                      aria-label={`Remove ${displayName(property)} from the tour`}
                    >
                      <Times />
                    </button>
                  </div>

                  <label className="mt-2 flex items-center gap-2 pl-8 text-xs text-slate-400">
                    Time at stop:
                    <input
                      type="number"
                      min={0}
                      step={5}
                      className="field w-20 py-1"
                      aria-label={`Minutes at ${displayName(property)}`}
                      defaultValue={property.tourMinutes ?? stopMinutes}
                      onBlur={(event) => void setDwell(property, Math.max(0, Number(event.target.value) || 0))}
                    />
                    min
                  </label>
                </li>
              )
            })}
          </ol>

          {stops.length === 0 ? (
            <p className="mt-2 text-xs text-slate-500">Select at least one site to build a tour.</p>
          ) : null}
        </section>

        {plan?.itinerary && stops.length > 0 ? (
          <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 border-t border-white/5 pt-3 text-xs text-slate-400">
            <span>
              {plan.itinerary.items.length} stop{plan.itinerary.items.length === 1 ? '' : 's'}
            </span>
            <span>
              {plan.itinerary.startTime} — {plan.itinerary.endTime}
            </span>
            <span>Drive time: {plan.itinerary.driveLabel}</span>
            <span>Total time: {plan.itinerary.totalLabel}</span>
          </p>
        ) : null}

        {plan?.routeSource === 'estimate' && stops.length > 1 ? (
          <p className="mt-2 text-xs text-amber-400/80">
            Drive times are estimated — the routing service could not be reached, so these are
            straight-line distances with an allowance for streets.
          </p>
        ) : null}

        <AnchorField
          label="End"
          badge="E"
          anchor={end}
          onSet={(next) => {
            setEnd(next)
            persistDefaults()
          }}
        />

        {error ? <p className="mt-3 text-xs text-rose-400">{error}</p> : null}
      </div>
    </div>
  )
}

/**
 * A start or end point.
 *
 * Typed as an address and geocoded, because a tour rarely begins at one of the
 * sites — it begins at the office, or the client's hotel.
 */
function AnchorField({
  label,
  badge,
  anchor,
  hint,
  onSet,
}: {
  label: string
  badge: string
  anchor: TourAnchor | null
  hint?: string
  onSet: (anchor: TourAnchor | null) => void
}) {
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const lookup = async () => {
    const trimmed = query.trim()
    if (!trimmed) return
    setBusy(true)
    setError(null)
    try {
      const { results } = await api.geocode(trimmed)
      if (results.length === 0) {
        setError('No match for that address.')
        return
      }
      const [first] = results
      onSet({ address: first.label, lat: first.lat, lng: first.lng })
      setQuery('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not look that up.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-4">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">{label}</h3>
      {anchor ? (
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-teal-400/30 bg-teal-400/5 p-2">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-teal-400 text-xs font-bold text-ink-900">
            {badge}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-slate-100">{anchor.address || 'Pinned location'}</span>
            {hint ? <span className="block text-xs text-slate-500">{hint}</span> : null}
          </span>
          <button
            type="button"
            className="text-slate-500 hover:text-rose-400"
            onClick={() => onSet(null)}
            aria-label={`Clear ${label.toLowerCase()} location`}
          >
            <Times />
          </button>
        </div>
      ) : (
        <div className="mt-2 flex gap-2">
          <input
            className="field flex-1"
            placeholder="Type an address"
            aria-label={`${label} address`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void lookup()
            }}
          />
          <button type="button" className="btn-secondary px-2 text-xs" disabled={busy} onClick={() => void lookup()}>
            {busy ? '…' : 'Set'}
          </button>
        </div>
      )}
      {error ? <p className="mt-1 text-xs text-rose-400">{error}</p> : null}
    </section>
  )
}

function Times() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  )
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 120ms' }}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

function Grip() {
  return (
    <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden>
      <circle cx="2" cy="2" r="1.2" />
      <circle cx="8" cy="2" r="1.2" />
      <circle cx="2" cy="7" r="1.2" />
      <circle cx="8" cy="7" r="1.2" />
      <circle cx="2" cy="12" r="1.2" />
      <circle cx="8" cy="12" r="1.2" />
    </svg>
  )
}
