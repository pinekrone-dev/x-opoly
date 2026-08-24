import { useEffect, useMemo, useState } from 'react'
import MapCanvas from '../components/MapCanvas'
import PropertyPanel from '../components/PropertyPanel'
import { api } from '../api'
import type { AppFeatures, Property, SharePayload } from '../types'
import { STAGE_META, fullAddress, displayName, rate, shortDate, sqft } from '../lib/format'

/**
 * What the client sees. No editing, no sign-in, no private notes — just the
 * broker's shortlist on a map.
 */
export default function ShareView({ token, features }: { token: string; features: AppFeatures }) {
  const [payload, setPayload] = useState<SharePayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    api
      .getShared(token)
      .then(setPayload)
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'This link could not be opened.'))
  }, [token])

  const selected = useMemo(
    () => payload?.properties.find((property) => property.id === selectedId) ?? null,
    [payload, selectedId],
  )

  if (error) {
    return (
      <div className="grid min-h-full place-items-center p-6">
        <div className="panel max-w-md p-8 text-center">
          <h1 className="text-lg font-semibold text-ink">This map is not available</h1>
          <p className="mt-2 text-sm text-muted">{error}</p>
        </div>
      </div>
    )
  }

  if (!payload) return <div className="grid min-h-full place-items-center text-sm text-muted">Loading the map…</div>

  const { survey, properties } = payload
  const accent = survey.brandColor || '#14b8a6'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface px-5 py-3">
        <div className="flex items-center gap-3">
          <span className="grid h-9 w-9 place-items-center rounded-lg" style={{ background: `${accent}22` }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={accent} strokeWidth="2" aria-hidden>
              <path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11Z" />
              <circle cx="12" cy="10" r="2.5" />
            </svg>
          </span>
          <div>
            <h1 className="text-sm font-semibold text-ink">{survey.name}</h1>
            <p className="text-xs text-muted">
              {[survey.clientName && `Prepared for ${survey.clientName}`, survey.brokerName && `by ${survey.brokerName}`]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
        </div>
        <p className="text-xs text-muted">
          {properties.length} site{properties.length === 1 ? '' : 's'}
          {survey.expiresAt && ` · link valid to ${shortDate(survey.expiresAt)}`}
        </p>
      </header>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[22rem_minmax(0,1fr)]">
        <div className="scrollbar-thin min-h-0 overflow-y-auto border-r border-line bg-surface">
          {selected ? (
            <PropertyPanel property={selected} readOnly onClose={() => setSelectedId(null)} />
          ) : (
            <ul className="divide-y divide-line">
              {properties.map((property) => (
                <li key={property.id}>
                  <button
                    type="button"
                    className="flex w-full items-start gap-3 p-4 text-left hover:bg-sunken"
                    onClick={() => setSelectedId(property.id)}
                  >
                    {property.photoUrl ? (
                      <img src={property.photoUrl} alt="" className="h-14 w-16 shrink-0 rounded-md object-cover" />
                    ) : (
                      <span
                        className="grid h-14 w-16 shrink-0 place-items-center rounded-md"
                        style={{ background: `${STAGE_META[property.stage]?.color}1a` }}
                        aria-hidden
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={STAGE_META[property.stage]?.color} strokeWidth="1.8">
                          <path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-5h6v5" />
                        </svg>
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink">{displayName(property)}</span>
                      <span className="block truncate text-xs text-muted">{fullAddress(property)}</span>
                      <span className="mt-1 block text-xs text-muted">
                        {rate(property)} · {sqft(property.sizeSqft)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
              {properties.length === 0 && (
                <li className="p-10 text-center text-sm text-muted">No sites have been added yet.</li>
              )}
            </ul>
          )}
        </div>

        <MapCanvas
          properties={properties as Property[]}
          selectedId={selectedId}
          onSelect={setSelectedId}
          tiles={features.tiles}
                basemaps={features.basemaps}
          fitKey={properties.length}
        />
      </div>
    </div>
  )
}
