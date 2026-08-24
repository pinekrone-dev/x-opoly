import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import type { DealStage, Property, Survey, TourPlan } from '../types'
import { navigate } from '../lib/router'
import { fullAddress, displayName } from '../lib/format'
import { exportTourBook } from '../lib/tourBookPdf'

/**
 * The tour book: the document a broker hands a client before the drive.
 *
 * One page per stop, in tour order, each leading with the photograph cropped
 * out of the flyer.
 *
 * Two ways out: Export PDF builds a real file in the browser with jsPDF, which
 * is what a broker emails to a client; Print goes through the browser's own
 * dialog for anyone who wants paper or different settings. Both are
 * client-side, so there is no server-side renderer to keep working.
 */

export default function TourBook({ id }: { id: string }) {
  const [survey, setSurvey] = useState<Survey | null>(null)
  const [properties, setProperties] = useState<Property[]>([])
  const [stages, setStages] = useState<DealStage[]>([])
  const [plan, setPlan] = useState<TourPlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    api
      .getSurvey(id)
      .then(({ survey: loaded, properties: list, stages: pipeline }) => {
        if (cancelled) return
        setSurvey(loaded)
        setProperties(list)
        setStages(pipeline ?? [])

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

  if (!survey) {
    return <div className="grid min-h-full place-items-center text-sm text-slate-500">Loading…</div>
  }

  return (
    <div className="min-h-full bg-ink-950 print:bg-white">
      <header className="no-print sticky top-0 z-10 flex items-center gap-3 border-b border-white/10 bg-ink-900 px-4 py-3">
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
          <p className="truncate text-sm font-semibold text-white">Tour book</p>
          <p className="truncate text-xs text-slate-500">
            {stops.length} stop{stops.length === 1 ? '' : 's'}
            {plan?.itinerary ? ` · ${plan.itinerary.startTime} — ${plan.itinerary.endTime}` : ''}
          </p>
        </div>
        <button
          type="button"
          className="btn-primary ml-auto py-1.5"
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
                summary: plan?.itinerary
                  ? {
                      startTime: plan.itinerary.startTime,
                      endTime: plan.itinerary.endTime,
                      driveLabel: plan.itinerary.driveLabel,
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
        <p className="no-print bg-rose-500/10 px-4 py-2 text-xs text-rose-300">{exportError}</p>
      ) : null}

      <div className="mx-auto max-w-[8.5in] p-6 print:p-0">
        {/* Cover */}
        <section className="book-page rounded-xl bg-white p-10 text-slate-900 shadow-xl print:rounded-none print:shadow-none">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Site tour</p>
          <h1 className="mt-3 text-4xl font-bold leading-tight">{survey.name}</h1>
          {survey.clientName ? (
            <p className="mt-2 text-lg text-slate-600">Prepared for {survey.clientName}</p>
          ) : null}

          <div className="mt-10 border-t border-slate-200 pt-6 text-sm text-slate-600">
            {survey.brokerName ? <p className="font-semibold text-slate-900">{survey.brokerName}</p> : null}
            {survey.companyName ? <p>{survey.companyName}</p> : null}
            <p className="mt-4">
              {stops.length} stop{stops.length === 1 ? '' : 's'}
              {plan?.itinerary
                ? ` · ${plan.itinerary.startTime} to ${plan.itinerary.endTime} · ${plan.itinerary.driveLabel} driving`
                : ''}
            </p>
          </div>

          <ol className="mt-8 space-y-1 text-sm text-slate-700">
            {stops.map((property, index) => (
              <li key={property.id} className="flex gap-3">
                <span className="w-5 shrink-0 text-right font-semibold text-slate-400">{index + 1}</span>
                <span className="min-w-0 flex-1 truncate">{displayName(property)}</span>
                <span className="shrink-0 tabular-nums text-slate-500">
                  {times.get(property.id)?.arrive ?? ''}
                </span>
              </li>
            ))}
          </ol>
        </section>

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
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-slate-900 text-lg font-bold text-white">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="text-2xl font-bold leading-tight">{displayName(property)}</h2>
                  <p className="text-sm text-slate-600">{fullAddress(property)}</p>
                </div>
                {stage ? (
                  <span
                    className="shrink-0 rounded-full px-3 py-1 text-xs font-semibold"
                    style={{ background: `${stage.color}22`, color: stage.color }}
                  >
                    {stage.name}
                  </span>
                ) : null}
              </div>

              {time ? (
                <p className="mt-3 text-sm text-slate-600">
                  Arrive <span className="font-semibold text-slate-900">{time.arrive}</span>
                  {time.driveMinutes > 0 ? ` after ${time.driveMinutes} min drive` : ''} · {time.stopMinutes} min
                  on site · depart {time.depart}
                </p>
              ) : null}

              {cover ? (
                <img
                  src={cover.url}
                  alt={cover.caption ?? displayName(property)}
                  className="mt-5 max-h-[3.6in] w-full rounded-lg object-cover"
                />
              ) : (
                <p className="mt-5 rounded-lg border border-dashed border-slate-300 p-8 text-center text-xs text-slate-400">
                  No photo yet — open the flyer and cut one out.
                </p>
              )}

              {extras.length > 0 ? (
                <div className="mt-3 grid grid-cols-3 gap-2">
                  {extras.map((image) => (
                    <img
                      key={image.id}
                      src={image.url}
                      alt={image.caption ?? ''}
                      className="h-24 w-full rounded-md object-cover"
                    />
                  ))}
                </div>
              ) : null}

              {property.fields?.length ? (
                <dl className="mt-6 grid grid-cols-2 gap-x-8 gap-y-2 border-t border-slate-200 pt-4 text-sm">
                  {property.fields.map((field, position) => (
                    <div key={`${field.label}-${position}`} className="flex justify-between gap-3">
                      <dt className="text-slate-500">{field.label}</dt>
                      <dd className="text-right font-medium text-slate-900">{field.value || '—'}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}

              {property.listingBroker || property.brokerEmail || property.brokerPhone ? (
                <p className="mt-6 border-t border-slate-200 pt-3 text-xs text-slate-600">
                  <span className="font-semibold text-slate-900">{property.listingBroker}</span>
                  {property.brokerEmail ? ` · ${property.brokerEmail}` : ''}
                  {property.brokerPhone ? ` · ${property.brokerPhone}` : ''}
                </p>
              ) : null}
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
