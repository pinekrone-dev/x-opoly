import { useEffect, useState } from 'react'
import { api } from '../api'
import type { CompetitionResult, PlaceCategory, Property } from '../types'

interface Props {
  property: Property
  /** Lets the workspace draw the rings and competitor pins on the map. */
  onResult: (result: (CompetitionResult & { center: { lat: number; lng: number } }) | null) => void
}

const RADIUS_OPTIONS = [1, 3, 5]

export default function CompetitionPanel({ property, onResult }: Props) {
  const [categories, setCategories] = useState<PlaceCategory[]>([])
  const [category, setCategory] = useState('')
  const [keyword, setKeyword] = useState('')
  const [radius, setRadius] = useState(3)
  const [result, setResult] = useState<CompetitionResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .placeCategories()
      .then(({ categories: list }) => setCategories(list))
      .catch(() => setCategories([]))
  }, [])

  // Clear the map overlay when the panel is unmounted or the site changes.
  useEffect(() => {
    setResult(null)
    setError(null)
    return () => onResult(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [property.id])

  const search = async () => {
    if (property.lat == null || property.lng == null) {
      setError('Put this site on the map first — the search runs around its pin.')
      return
    }

    setBusy(true)
    setError(null)
    try {
      const found = await api.nearby({
        lat: property.lat,
        lng: property.lng,
        category: category || undefined,
        keyword: keyword.trim() || undefined,
        radius,
      })
      setResult(found)
      onResult({ ...found, center: { lat: property.lat, lng: property.lng } })
    } catch (cause) {
      setResult(null)
      onResult(null)
      setError(cause instanceof Error ? cause.message : 'The business search failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="p-4">
      <div className="grid gap-3">
        <label>
          <span className="label">Looking for</span>
          <select
            className="field"
            aria-label="Business category to search for"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            <option value="">Any named business</option>
            {categories.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span className="label">Name contains (optional)</span>
          <input
            className="field"
            aria-label="Filter results by name"
            placeholder="e.g. Aspen, Smile"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
          />
        </label>

        <div>
          <span className="label">Radius</span>
          <div className="flex gap-1">
            {RADIUS_OPTIONS.map((miles) => (
              <button
                key={miles}
                type="button"
                className={`tab flex-1 justify-center text-xs ${radius === miles ? 'tab-active' : ''}`}
                onClick={() => setRadius(miles)}
              >
                {miles} mi
              </button>
            ))}
          </div>
        </div>

        <button type="button" className="btn-primary" onClick={() => void search()} disabled={busy}>
          {busy ? 'Searching…' : 'Scope the competition'}
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-amber-500/25 bg-amber-500/10 p-3">
          <p className="text-xs leading-relaxed text-amber-200">{error}</p>
        </div>
      )}

      {result && (
        <>
          <dl className="mt-4 grid grid-cols-3 gap-2">
            {result.rings.map((ring) => (
              <div key={ring.miles} className="stat text-center">
                <dt className="text-[10px] font-semibold uppercase tracking-wider text-muted">{ring.miles} mile</dt>
                <dd className="mt-0.5 font-mono text-lg font-semibold text-ink">{ring.count}</dd>
              </div>
            ))}
          </dl>

          {result.results.length === 0 ? (
            <p className="mt-4 rounded-lg border border-dashed border-line p-6 text-center text-xs text-muted">
              Nothing matching within {result.radiusMiles} miles. Widen the radius or drop the name filter before reading
              that as a clear field — the directory only knows businesses that have been mapped.
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-line">
              {result.results.map((business) => (
                <li key={business.id} className="flex items-baseline gap-3 py-2">
                  <span className="w-12 shrink-0 font-mono text-[11px] text-brand">{business.miles} mi</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink">{business.name}</span>
                    <span className="block truncate text-[11px] capitalize text-muted">
                      {[business.category, business.address].filter(Boolean).join(' · ') || '—'}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}

          <p className="mt-3 text-[11px] leading-relaxed text-muted">
            {result.results.length} found within {result.radiusMiles} miles · {result.source}
          </p>
        </>
      )}
    </div>
  )
}
