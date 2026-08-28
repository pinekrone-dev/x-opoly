import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import type { BookStyle, DealStage, Property, Survey, TourPlan } from '../types'
import { navigate } from '../lib/router'
import { fullAddress, displayName } from '../lib/format'
import { exportTourBook } from '../lib/tourBookPdf'

/**
 * The tour book: the document a broker hands a client before the drive.
 *
 * The pages here mirror the PDF the Export button builds — navy cover,
 * itinerary, one page per stop — so what the broker sees is what the client
 * gets. The style panel moves the book's six levers, by hand or by telling
 * the AI what to change; either way the style saves to the survey, so the
 * book looks the same on every machine that opens it.
 */

const NIGHT = '#0c1f42'
const DEEP = '#143366'
const EDGE = '#22406f'

export default function TourBook({ id }: { id: string }) {
  const [survey, setSurvey] = useState<Survey | null>(null)
  const [properties, setProperties] = useState<Property[]>([])
  const [stages, setStages] = useState<DealStage[]>([])
  const [plan, setPlan] = useState<TourPlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [style, setStyle] = useState<BookStyle | null>(null)
  const [customizing, setCustomizing] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [restyling, setRestyling] = useState(false)
  const [styleError, setStyleError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    api
      .getSurvey(id)
      .then(({ survey: loaded, properties: list, stages: pipeline }) => {
        if (cancelled) return
        setSurvey(loaded)
        setProperties(list)
        setStages(pipeline ?? [])
        setStyle(loaded.book)

        // Times are a bonus, not a requirement: a book without a schedule is
        // still a usable book, so a routing failure must not empty the page.
        const located = list.filter((property) => property.lat != null && property.lng != null)
        if (located.length > 0) {
          api
            .planTour(id, {
              propertyIds: located.map((property) => property.id),
              optimize: false,
              startTime: loaded.tour?.startTime,
              stopMinutes: loaded.tour?.stopMinutes,
            })
            .then((result) => {
              if (!cancelled) setPlan(result)
            })
            .catch(() => undefined)
        }
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message || 'That survey could not be opened.')
      })

    return () => {
      cancelled = true
    }
  }, [id])

  /** Tour order when one has been saved, otherwise the survey's own order. */
  const stops = useMemo(() => {
    const located = properties.filter((property) => property.lat != null && property.lng != null)
    const ordered = located.filter((property) => property.tourOrder != null)
    if (ordered.length > 0) {
      return [...ordered].sort((a, b) => (a.tourOrder ?? 0) - (b.tourOrder ?? 0))
    }
    return located
  }, [properties])

  const times = useMemo(
    () => new Map((plan?.itinerary?.items ?? []).map((item) => [item.id, item])),
    [plan],
  )

  const stageOf = (property: Property) => stages.find((stage) => stage.id === property.stageId) ?? null

  /** Saves a hand-turned lever. Optimistic: the page is the preview. */
  const applyStyle = (change: Partial<BookStyle>) => {
    if (!style) return
    const next = { ...style, ...change }
    setStyle(next)
    setStyleError(null)
    api.bookStyle(id, { style: next }).then(({ book }) => setStyle(book)).catch(() => {
      setStyleError('The style could not be saved; it will reset on reload.')
    })
  }

  /** Hands the instruction to the model, which may only move the six levers. */
  const askAi = async () => {
    const ask = instruction.trim()
    if (!ask || restyling) return
    setRestyling(true)
    setStyleError(null)
    try {
      const { book } = await api.bookStyle(id, { instruction: ask })
      setStyle(book)
      setInstruction('')
    } catch (cause) {
      setStyleError(cause instanceof Error ? cause.message : 'The restyle failed.')
    } finally {
      setRestyling(false)
    }
  }

  if (error) {
    return (
      <div className="grid min-h-full place-items-center p-6">
        <div className="panel max-w-md p-8 text-center">
          <p className="text-sm text-slate-300">{error}</p>
          <button type="button" className="btn-secondary mt-4" onClick={() => navigate('/')}>
            Back to surveys
          </button>
        </div>
      </div>
    )
  }

  if (!survey || !style) {
    return <div className="grid min-h-full place-items-center text-sm text-muted">Loading…</div>
  }

  const accent = style.accent || '#01A3A8'
  const summary = plan?.itinerary ?? null

  return (
    <div className="min-h-full bg-paper print:bg-white">
      <header className="no-print sticky top-0 z-10 flex items-center gap-3 border-b border-line bg-surface px-4 py-3">
        <button
          type="button"
          className="btn-ghost px-2 py-1"
          onClick={() => navigate(`/survey/${id}`)}
          aria-label="Back to the survey"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink">Tour book</p>
          <p className="truncate text-xs text-muted">
            {stops.length} stop{stops.length === 1 ? '' : 's'}
            {summary ? ` · ${summary.startTime} — ${summary.endTime}` : ''}
          </p>
        </div>
        <button
          type="button"
          className="btn-secondary ml-auto py-1.5"
          onClick={() => setCustomizing((open) => !open)}
        >
          Customize
        </button>
        <button
          type="button"
          className="btn-primary py-1.5"
          disabled={exporting || stops.length === 0}
          onClick={async () => {
            setExporting(true)
            setExportError(null)
            try {
              await exportTourBook({
                survey,
                stops,
                stages,
                times,
                style,
                summary: summary
                  ? {
                      startTime: summary.startTime,
                      endTime: summary.endTime,
                      driveLabel: summary.driveLabel,
                    }
                  : null,
              })
            } catch (cause) {
              setExportError(
                cause instanceof Error ? cause.message : 'The PDF could not be built.',
              )
            } finally {
              setExporting(false)
            }
          }}
        >
          {exporting ? 'Building PDF…' : 'Export PDF'}
        </button>
        <button type="button" className="btn-secondary py-1.5" onClick={() => window.print()}>
          Print
        </button>
      </header>

      {exportError ? (
        <p className="no-print bg-rose-500/10 px-4 py-2 text-xs text-rose-600">{exportError}</p>
      ) : null}

      {customizing ? (
        <div className="no-print border-b border-line bg-surface px-4 py-3">
          <div className="mx-auto flex max-w-[8.5in] flex-wrap items-end gap-4">
            <label className="text-xs text-muted">
              Cover
              <select
                className="mt-1 block rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-ink"
                value={style.cover}
                onChange={(event) => applyStyle({ cover: event.target.value as BookStyle['cover'] })}
              >
                <option value="navy">Navy</option>
                <option value="light">Light</option>
              </select>
            </label>
            <label className="text-xs text-muted">
              Accent
              <input
                type="color"
                className="mt-1 block h-8 w-14 cursor-pointer rounded-md border border-line bg-surface"
                value={accent}
                onChange={(event) => applyStyle({ accent: event.target.value })}
              />
            </label>
            {(
              [
                ['showSchedule', 'Itinerary page'],
                ['showDetails', 'Property details'],
                ['showQr', 'Directions QR'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex items-center gap-1.5 pb-1.5 text-xs text-body">
                <input
                  type="checkbox"
                  checked={style[key]}
                  onChange={(event) => applyStyle({ [key]: event.target.checked })}
                />
                {label}
              </label>
            ))}
            <label className="min-w-56 flex-1 text-xs text-muted">
              A word to the client, on the cover
              <input
                type="text"
                maxLength={280}
                className="mt-1 block w-full rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-ink"
                value={style.intro ?? ''}
                placeholder="Optional"
                onChange={(event) => applyStyle({ intro: event.target.value || null })}
              />
            </label>
          </div>
          <div className="mx-auto mt-2 flex max-w-[8.5in] items-center gap-2">
            <input
              type="text"
              className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-ink"
              placeholder='Or tell the AI — "light cover, forest green accent, skip the QR codes"'
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') askAi()
              }}
            />
            <button
              type="button"
              className="btn-secondary py-1.5 text-xs"
              disabled={restyling || !instruction.trim()}
              onClick={askAi}
            >
              {restyling ? 'Restyling…' : 'Apply'}
            </button>
          </div>
          {styleError ? <p className="mx-auto mt-1 max-w-[8.5in] text-xs text-rose-600">{styleError}</p> : null}
        </div>
      ) : null}

      <div className="mx-auto max-w-[8.5in] p-6 print:p-0">
        {/* Cover — the design's navy ground, or the light variant. */}
        <section
          className="book-page relative flex min-h-[11in] flex-col overflow-hidden rounded-xl p-12 shadow-xl print:rounded-none print:shadow-none"
          style={
            style.cover === 'light'
              ? { background: '#ffffff', color: DEEP }
              : { background: NIGHT, color: '#ffffff' }
          }
        >
          {style.cover !== 'light' ? (
            <svg
              viewBox="0 0 816 1056"
              className="pointer-events-none absolute inset-0 h-full w-full"
              preserveAspectRatio="xMidYMid slice"
              aria-hidden
            >
              <path
                d="M 620 120 C 760 260, 560 420, 660 560 C 740 680, 600 820, 700 960"
                fill="none"
                stroke={EDGE}
                strokeWidth="2"
                strokeDasharray="2 8"
                strokeLinecap="round"
              />
              <circle cx="620" cy="120" r="7" fill={accent} />
              <circle cx="700" cy="960" r="7" fill={accent} />
            </svg>
          ) : null}

          <p className="relative text-[15px] font-bold tracking-tight">
            <span style={{ color: style.cover === 'light' ? DEEP : '#ffffff' }}>Land</span>{' '}
            <span style={{ color: accent }}>Quotient</span>
          </p>

          <div className="relative flex flex-1 flex-col justify-center">
            {style.cover === 'light' ? (
              <div className="mb-6 h-1.5 w-16" style={{ background: accent }} />
            ) : null}
            <p className="text-xs font-semibold tracking-[0.28em]" style={{ color: accent }}>
              SITE TOUR
            </p>
            <h1 className="mt-3 max-w-xl text-5xl font-extrabold leading-tight tracking-tight">
              {survey.name}
            </h1>
            {survey.clientName ? (
              <p
                className="mt-4 text-lg"
                style={{ color: style.cover === 'light' ? '#334155' : '#cbd5e1' }}
              >
                Prepared for {survey.clientName}
              </p>
            ) : null}
            <p className="mt-1 text-sm" style={{ color: '#64748b' }}>
              {new Date().toLocaleDateString('en-US', {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })}
            </p>
            {style.intro ? (
              <p
                className="mt-5 max-w-md text-sm leading-relaxed"
                style={{ color: style.cover === 'light' ? '#334155' : '#cbd5e1' }}
              >
                {style.intro}
              </p>
            ) : null}
          </div>

          <div
            className="relative flex items-end justify-between gap-6 border-t pt-6"
            style={{ borderColor: style.cover === 'light' ? '#e2e8f0' : EDGE }}
          >
            <div>
              {survey.brokerName ? <p className="text-[15px] font-bold">{survey.brokerName}</p> : null}
              {survey.companyName ? (
                <p className="mt-0.5 text-sm" style={{ color: '#94a3b8' }}>
                  {survey.companyName}
                </p>
              ) : null}
            </div>
            <div className="flex gap-7 text-right">
              <div>
                <p className="text-xl font-bold">{stops.length}</p>
                <p className="text-[10px] tracking-[0.08em]" style={{ color: '#64748b' }}>
                  {stops.length === 1 ? 'STOP' : 'STOPS'}
                </p>
              </div>
              {summary ? (
                <>
                  <div>
                    <p className="text-xl font-bold">
                      {summary.startTime}–{summary.endTime}
                    </p>
                    <p className="text-[10px] tracking-[0.08em]" style={{ color: '#64748b' }}>
                      TOUR WINDOW
                    </p>
                  </div>
                  <div>
                    <p className="text-xl font-bold">{summary.driveLabel}</p>
                    <p className="text-[10px] tracking-[0.08em]" style={{ color: '#64748b' }}>
                      DRIVING
                    </p>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </section>

        {/* Itinerary — the schedule as a timeline. */}
        {style.showSchedule && stops.length > 0 ? (
          <section className="book-page mt-6 rounded-xl bg-white p-12 text-slate-900 shadow-xl print:mt-0 print:rounded-none print:shadow-none">
            <div className="flex items-baseline justify-between border-b-2 pb-3" style={{ borderColor: DEEP }}>
              <div>
                <p className="text-[11px] font-semibold tracking-[0.28em]" style={{ color: accent }}>
                  ITINERARY
                </p>
                <h2 className="mt-1 text-2xl font-extrabold tracking-tight" style={{ color: DEEP }}>
                  {survey.name}
                </h2>
              </div>
              {summary ? (
                <p className="text-xs text-slate-500">
                  starts {summary.startTime} · {summary.driveLabel} driving
                </p>
              ) : null}
            </div>
            <div className="mt-6">
              {stops.map((property, index) => {
                const time = times.get(property.id)
                const stage = stageOf(property)
                const last = index === stops.length - 1
                return (
                  <div key={property.id} className="flex items-start gap-4">
                    <span className="w-14 shrink-0 pt-1 text-right font-mono text-sm font-medium text-slate-900">
                      {time?.arrive ?? ''}
                    </span>
                    <div className="flex shrink-0 flex-col items-center">
                      <span
                        className="grid h-8 w-8 place-items-center rounded-full text-[13px] font-bold text-white"
                        style={{ background: last ? accent : DEEP }}
                      >
                        {index + 1}
                      </span>
                      {!last ? <span className="h-12 w-0.5 bg-slate-200" /> : null}
                    </div>
                    <div className="min-w-0 flex-1 pt-0.5">
                      <div className="flex items-center gap-2.5">
                        <p className="truncate text-[15px] font-bold">{displayName(property)}</p>
                        {stage ? (
                          <span
                            className="shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
                            style={{ background: `${stage.color}22`, color: stage.color }}
                          >
                            {stage.name}
                          </span>
                        ) : null}
                      </div>
                      <p className="truncate text-[13px] text-slate-500">{fullAddress(property)}</p>
                      {time && time.driveMinutes > 0 && !last ? (
                        <p className="mt-1.5 text-xs text-slate-400">↓ {time.driveMinutes} min drive</p>
                      ) : null}
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        ) : null}

        {/* One page per stop */}
        {stops.map((property, index) => {
          const cover =
            property.images?.find((image) => image.id === property.coverImageId) ??
            property.images?.[0] ??
            null
          const extras = (property.images ?? []).filter((image) => image.id !== cover?.id).slice(0, 3)
          const time = times.get(property.id)
          const stage = stageOf(property)

          return (
            <section
              key={property.id}
              className="book-page mt-6 rounded-xl bg-white p-10 text-slate-900 shadow-xl print:mt-0 print:rounded-none print:shadow-none"
            >
              <div className="flex items-start gap-4">
                <span
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-lg font-extrabold text-white"
                  style={{ background: DEEP }}
                >
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="text-2xl font-extrabold leading-tight tracking-tight">
                    {displayName(property)}
                  </h2>
                  <p className="text-sm text-slate-500">{fullAddress(property)}</p>
                </div>
                {stage ? (
                  <span
                    className="mt-1 shrink-0 rounded-full px-3 py-1 text-xs font-semibold"
                    style={{ background: `${stage.color}22`, color: stage.color }}
                  >
                    {stage.name}
                  </span>
                ) : null}
              </div>

              {time ? (
                <div className="mt-4 flex items-center gap-7 rounded-[10px] bg-slate-100 px-4 py-2.5 text-[13px] text-slate-600">
                  <p>
                    Arrive <span className="font-mono font-medium text-slate-900">{time.arrive}</span>
                    {time.driveMinutes > 0 ? ` after ${time.driveMinutes} min drive` : ''}
                  </p>
                  <p>
                    <span className="font-mono font-medium text-slate-900">{time.stopMinutes} min</span> on site
                  </p>
                  <p>
                    Depart <span className="font-mono font-medium text-slate-900">{time.depart}</span>
                  </p>
                </div>
              ) : null}

              {cover ? (
                <img
                  src={cover.url}
                  alt={cover.caption ?? displayName(property)}
                  className="mt-5 max-h-[3.6in] w-full rounded-xl object-cover"
                />
              ) : (
                <p className="mt-5 rounded-xl border border-dashed border-slate-300 p-8 text-center text-xs text-slate-400">
                  No photo yet — open the flyer and cut one out.
                </p>
              )}

              {extras.length > 0 ? (
                <div className="mt-3 grid grid-cols-3 gap-2.5">
                  {extras.map((image) => (
                    <img
                      key={image.id}
                      src={image.url}
                      alt={image.caption ?? ''}
                      className="h-24 w-full rounded-lg object-cover"
                    />
                  ))}
                </div>
              ) : null}

              {style.showDetails && property.fields?.length ? (
                <dl className="mt-6 grid grid-cols-2 gap-x-12 gap-y-2 border-t border-slate-200 pt-4 text-[13.5px]">
                  {property.fields.map((field, position) => (
                    <div key={`${field.label}-${position}`} className="flex justify-between gap-3">
                      <dt className="text-slate-500">{field.label}</dt>
                      <dd className="text-right font-semibold text-slate-900">{field.value || '—'}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}

              <div className="mt-6 flex items-center justify-between gap-4 border-t border-slate-200 pt-3">
                <div className="min-w-0 text-xs text-slate-600">
                  {property.listingBroker || property.brokerEmail || property.brokerPhone ? (
                    <p>
                      <span className="font-semibold text-slate-900">{property.listingBroker}</span>
                      {property.brokerEmail ? ` · ${property.brokerEmail}` : ''}
                      {property.brokerPhone ? ` · ${property.brokerPhone}` : ''}
                    </p>
                  ) : null}
                  <p className="mt-1 text-[11px] text-slate-400">
                    Stop {index + 1} of {stops.length} · {survey.name}
                  </p>
                </div>
              </div>
            </section>
          )
        })}

        {stops.length === 0 ? (
          <p className="mt-6 rounded-xl bg-white p-10 text-center text-sm text-slate-500">
            No sites with a location yet, so there is nothing to tour.
          </p>
        ) : null}
      </div>
    </div>
  )
}
