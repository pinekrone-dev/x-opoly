import { useState } from 'react'
import type { DealStage, Property, Survey } from '../types'
import { displayName, fullAddress } from '../lib/format'

/**
 * Picks the finalists for the side-by-side PDF.
 *
 * Capped at four: five columns on landscape letter turns every cell into an
 * ellipsis, and a comparison a client cannot read settles nothing.
 */
const MAX_COMPARED = 4

export default function CompareSites({
  survey,
  properties,
  stages,
}: {
  survey: Survey
  properties: Property[]
  stages: DealStage[]
}) {
  const [picked, setPicked] = useState<string[]>([])
  const [radius, setRadius] = useState(3)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = (id: string) => {
    setPicked((current) =>
      current.includes(id)
        ? current.filter((entry) => entry !== id)
        : current.length >= MAX_COMPARED
          ? current
          : [...current, id],
    )
  }

  const generate = async () => {
    setBusy(true)
    setError(null)
    try {
      // Columns come out in the order they were picked — the broker's
      // preference order, not the list's.
      const chosen = picked
        .map((id) => properties.find((property) => property.id === id))
        .filter((property): property is Property => Boolean(property))
      const { exportComparison } = await import('../lib/comparePdf')
      await exportComparison({ survey, properties: chosen, stages, radius })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The comparison could not be built.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel mt-4 p-4">
      <h3 className="panel-title">Compare sites</h3>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        Up to four finalists side by side — rate, size and terms in one table, with the trade-area
        demographics for each underneath.
      </p>

      <ul className="scrollbar-thin mt-3 max-h-56 overflow-y-auto rounded-lg border border-line">
        {properties.map((property) => {
          const active = picked.includes(property.id)
          const full = !active && picked.length >= MAX_COMPARED
          return (
            <li key={property.id} className="border-b border-line last:border-b-0">
              <label
                className={`flex cursor-pointer items-center gap-3 px-3 py-2 text-xs hover:bg-sunken ${
                  full ? 'cursor-not-allowed opacity-50' : ''
                }`}
              >
                <input
                  type="checkbox"
                  className="accent-brand"
                  checked={active}
                  disabled={full}
                  onChange={() => toggle(property.id)}
                />
                <span className="min-w-0">
                  <span className="block truncate font-medium text-ink">{displayName(property)}</span>
                  <span className="block truncate text-muted">{fullAddress(property)}</span>
                </span>
                {active ? (
                  <span className="ml-auto font-mono text-[10px] text-brand-deep">
                    #{picked.indexOf(property.id) + 1}
                  </span>
                ) : null}
              </label>
            </li>
          )
        })}
        {properties.length === 0 ? (
          <li className="px-3 py-4 text-center text-xs text-muted">Add some sites first.</li>
        ) : null}
      </ul>

      <div className="mt-3 flex items-center gap-2">
        <span className="text-xs text-muted">Trade area:</span>
        {[1, 3, 5].map((miles) => (
          <button
            key={miles}
            type="button"
            className={`tab px-2 py-1 text-xs ${radius === miles ? 'tab-active' : ''}`}
            aria-pressed={radius === miles}
            onClick={() => setRadius(miles)}
          >
            {miles} mi
          </button>
        ))}
      </div>

      <button
        type="button"
        className="btn-primary mt-3 w-full"
        disabled={busy || picked.length < 2}
        onClick={() => void generate()}
      >
        {busy
          ? 'Building the comparison…'
          : picked.length < 2
            ? 'Pick at least two sites'
            : `Download comparison (${picked.length} sites)`}
      </button>
      {error ? <p className="mt-2 text-xs text-rose-600">{error}</p> : null}
    </section>
  )
}
