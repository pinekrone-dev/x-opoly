import { useMemo, useState } from 'react'
import type { Demographics, MetricDefinition, Property } from '../types'

/**
 * Trade-area figures for one site.
 *
 * All three rings are shown at once, because the question a broker is actually
 * answering — is this catchment big enough — is a comparison between them, not
 * a reading of any one. Colouring the block groups by a metric turns the same
 * numbers into where, which is what the map is for.
 */

export const METRIC_DEFINITIONS: MetricDefinition[] = [
  { key: 'population', label: 'Population', format: 'count' },
  { key: 'medianHouseholdIncome', label: 'Med. Income', format: 'money', approximate: true },
  { key: 'households', label: 'Households', format: 'count' },
  { key: 'renterShare', label: 'Renters', format: 'percent' },
  { key: 'medianAge', label: 'Med. Age', format: 'decimal', approximate: true },
  { key: 'educationShare', label: 'Bachelor’s+', format: 'percent' },
  { key: 'medianHomeValue', label: 'Home Value', format: 'money', approximate: true },
]

export function formatMetric(value: number | null | undefined, format: MetricDefinition['format']) {
  if (value == null || !Number.isFinite(value)) return '—'
  switch (format) {
    case 'money':
      return `$${Math.round(value).toLocaleString()}`
    case 'percent':
      return `${value.toFixed(1)}%`
    case 'decimal':
      return value.toFixed(1)
    default:
      return Math.round(value).toLocaleString()
  }
}

interface Props {
  property: Property
  data: Demographics | null
  loading?: boolean
  error?: string | null
  colorBy: string
  onColorBy: (key: string) => void
  activeRadius: number
  onRadius: (miles: number) => void
  onClose?: () => void
}

export default function DemographicsPanel({
  property,
  data,
  loading,
  error,
  colorBy,
  onColorBy,
  activeRadius,
  onRadius,
  onClose,
}: Props) {
  const [showApproximateNote, setShowApproximateNote] = useState(false)

  const definition = METRIC_DEFINITIONS.find((metric) => metric.key === colorBy) ?? METRIC_DEFINITIONS[0]

  /** The colour scale's endpoints, taken from the block groups on screen. */
  const range = useMemo(() => {
    const values = (data?.areas ?? [])
      .map((area) => area.metrics?.[colorBy])
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    if (values.length === 0) return null
    return { min: Math.min(...values), max: Math.max(...values) }
  }, [data, colorBy])

  const radii = data?.radii ?? []

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink">Demographics</h2>
          <p className="truncate text-xs text-muted">{property.name || 'This site'}</p>
        </div>
        {onClose ? (
          <button
            type="button"
            className="ml-auto text-muted hover:text-ink"
            onClick={onClose}
            aria-label="Close demographics"
          >
            <Times />
          </button>
        ) : null}
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        <section>
          <h3 className="label">Radius</h3>
          <div className="mt-1 flex gap-1.5">
            {(radii.length > 0 ? radii.map((ring) => ring.miles) : [1, 3, 5]).map((miles) => (
              <button
                key={miles}
                type="button"
                className={`rounded-md px-3 py-1 text-xs font-semibold ${
                  activeRadius === miles
                    ? 'bg-brand text-white'
                    : 'border border-line text-muted hover:bg-sunken'
                }`}
                onClick={() => onRadius(miles)}
                aria-pressed={activeRadius === miles}
              >
                {miles} mi
              </button>
            ))}
          </div>
        </section>

        {loading ? <p className="mt-4 text-xs text-muted">Loading census figures…</p> : null}
        {error ? <p className="mt-4 text-xs text-rose-400">{error}</p> : null}

        {data && !loading ? (
          <>
            <section className="mt-4">
              <h3 className="label">Color: {definition.label}</h3>
              {range ? (
                <>
                  <div
                    className="mt-1 h-2 rounded-full"
                    style={{ background: `linear-gradient(90deg, ${SCALE.join(', ')})` }}
                    aria-hidden
                  />
                  <div className="mt-1 flex justify-between text-[10px] text-muted">
                    <span>{formatMetric(range.min, definition.format)}</span>
                    <span>{formatMetric(range.max, definition.format)}</span>
                  </div>
                </>
              ) : (
                <p className="mt-1 text-xs text-muted">
                  No block group nearby publishes {definition.label.toLowerCase()}.
                </p>
              )}
            </section>

            <section className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="text-muted">
                    <th className="pb-1 font-medium">Metric</th>
                    {radii.map((ring) => (
                      <th key={ring.miles} className="pb-1 text-right font-medium">
                        {ring.miles} mi
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {METRIC_DEFINITIONS.map((metric) => (
                    <tr key={metric.key} className="border-t border-line">
                      <th scope="row" className="py-1.5 font-normal text-muted">
                        {metric.label}
                        {metric.approximate ? (
                          <button
                            type="button"
                            className="ml-1 text-faint hover:text-body"
                            onClick={() => setShowApproximateNote((open) => !open)}
                            aria-label={`Why is ${metric.label} approximate?`}
                          >
                            *
                          </button>
                        ) : null}
                      </th>
                      {radii.map((ring) => (
                        <td key={ring.miles} className="py-1.5 text-right tabular-nums text-ink">
                          {formatMetric(ring.metrics?.[metric.key], metric.format)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            {showApproximateNote ? (
              <p className="mt-2 rounded-lg bg-sunken p-2 text-[11px] leading-relaxed text-muted">
                A median cannot be added together. Where a ring covers several block groups, the
                starred figures are averaged and weighted by the population behind each one, so they
                are close to the true median but are not a published census value.
              </p>
            ) : null}

            <section className="mt-4">
              <h3 className="label">Color by</h3>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {METRIC_DEFINITIONS.map((metric) => (
                  <button
                    key={metric.key}
                    type="button"
                    className={`rounded-md px-2 py-1 text-[11px] ${
                      colorBy === metric.key
                        ? 'bg-brand text-white font-semibold'
                        : 'border border-line text-muted hover:bg-sunken'
                    }`}
                    onClick={() => onColorBy(metric.key)}
                    aria-pressed={colorBy === metric.key}
                  >
                    {metric.label}
                  </button>
                ))}
              </div>
            </section>

            <p className="mt-4 text-[10px] text-faint">
              {data.source}
              {radii[radii.length - 1]?.blockGroups
                ? ` · ${radii[radii.length - 1].blockGroups} block groups`
                : ''}
            </p>
          </>
        ) : null}
      </div>
    </div>
  )
}

/** Light-to-dark ramp, readable over both the street and satellite basemaps. */
export const SCALE = ['#fef3c7', '#fcd34d', '#fb923c', '#ea580c', '#b91c1c']

/** Picks a band for `value` within [min, max]. */
export function colorFor(value: number | null | undefined, min: number, max: number) {
  if (value == null || !Number.isFinite(value)) return null
  if (max <= min) return SCALE[Math.floor(SCALE.length / 2)]
  const ratio = (value - min) / (max - min)
  const index = Math.min(SCALE.length - 1, Math.max(0, Math.floor(ratio * SCALE.length)))
  return SCALE[index]
}

function Times() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  )
}
