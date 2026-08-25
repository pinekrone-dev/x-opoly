import { useEffect, useMemo, useState } from 'react'
import MapCanvas from '../components/MapCanvas'
import PropertyPanel from '../components/PropertyPanel'
import { api } from '../api'
import type { AppFeatures, Demographics, Property, SharePayload } from '../types'
import { colorFor } from '../components/DemographicsPanel'
import { STAGE_META, fullAddress, displayName, rate, shortDate, sqft } from '../lib/format'

/**
 * What the client sees. No editing, no sign-in, no private notes — just the
 * broker's shortlist on a map.
 */
export default function ShareView({ token, features }: { token: string; features: AppFeatures }) {
  const [payload, setPayload] = useState<SharePayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [demographics, setDemographics] = useState<Demographics | null>(null)
  /** Phone-only: the map floats top-right as a thumbnail until tapped. */
  const [mapExpanded, setMapExpanded] = useState(false)

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

  /*
   * The broker turned demographic shading on for this report, so the client's
   * map opens already shaded — no control to find, nothing to click. Anchored
   * to the first placed site (the natural centre of a shortlist), and a
   * census outage costs only the shading, never the map.
   */
  useEffect(() => {
    if (!payload?.survey.showDemographics) return
    const anchor = payload.properties.find((property) => property.lat != null && property.lng != null)
    const point = anchor ?? (payload.survey.center ? { lat: payload.survey.center.lat, lng: payload.survey.center.lng } : null)
    if (!point?.lat || !point?.lng) return
    api
      .demographics(point.lat, point.lng)
      .then(setDemographics)
      .catch(() => undefined)
  }, [payload])

  const choropleth = useMemo(() => {
    if (!demographics) return null
    const shapes = demographics.areas.filter((area) => area.geometry)
    const values = shapes
      .map((area) => area.metrics?.population)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    if (values.length === 0) return null
    const min = Math.min(...values)
    const max = Math.max(...values)
    return shapes.map((area) => ({
      geoid: area.geoid,
      geometry: area.geometry,
      color: colorFor(area.metrics?.population, min, max),
    }))
  }, [demographics])

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
  const stages = (payload.stages ?? []).map((stage) => ({ ...stage, position: 0, hidden: false }))
  const zones = payload.zones ?? []
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

      {/* On a phone the shortlist reads full-width and the map floats in the
          top-right corner, expanding on tap; on desktop they share the row. */}
      <div className="relative min-h-0 flex-1 lg:grid lg:grid-cols-[22rem_minmax(0,1fr)]">
        <div className="scrollbar-thin h-full min-h-0 overflow-y-auto border-line bg-surface lg:border-r">
          {selected ? (
            <PropertyPanel property={selected} stages={stages} readOnly onClose={() => setSelectedId(null)} />
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

        <div
          className={`${
            mapExpanded
              ? 'absolute inset-0 z-[750]'
              : 'absolute right-2 top-2 z-[650] h-40 w-36 overflow-hidden rounded-xl border border-line shadow-lg'
          } bg-paper lg:static lg:z-auto lg:h-full lg:w-full lg:overflow-visible lg:rounded-none lg:border-0 lg:shadow-none`}
        >
          {!mapExpanded ? (
            <button
              type="button"
              className="absolute inset-0 z-[500] lg:hidden"
              aria-label="Expand the map"
              onClick={() => setMapExpanded(true)}
            />
          ) : (
            <button
              type="button"
              className="absolute right-3 top-3 z-[650] flex items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 py-2 text-sm font-semibold text-ink shadow-lg lg:hidden"
              onClick={() => setMapExpanded(false)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
              Close map
            </button>
          )}
          <MapCanvas
            stages={stages}
            zones={zones}
            properties={properties as Property[]}
            selectedId={selectedId}
            onSelect={(propertyId) => {
              setSelectedId(propertyId)
              // A tapped pin should read as details, not stay hidden under
              // the full-screen map.
              setMapExpanded(false)
            }}
            tiles={features.tiles}
            basemaps={features.basemaps}
            choropleth={choropleth}
            labelPins
            fitKey={`${properties.length}-${mapExpanded}`}
          />
        </div>
      </div>
    </div>
  )
}
