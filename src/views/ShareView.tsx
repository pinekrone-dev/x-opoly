import { useEffect, useMemo, useState } from 'react'
import MapCanvas from '../components/MapCanvas'
import MapLegend from '../components/MapLegend'
import PropertyPanel from '../components/PropertyPanel'
import { api } from '../api'
import type { AppFeatures, Demographics, Property, SharePayload } from '../types'
import { areaInfoHtml, colorFor } from '../components/DemographicsPanel'
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
  /** Phone-only: the map opens full-screen from the header's Map view button. */
  const [mapExpanded, setMapExpanded] = useState(false)
  /** Stage rows the client has toggled off in the legend — local, harmless. */
  const [hiddenStageIds, setHiddenStageIds] = useState<Set<string>>(new Set())

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
    // The metric the broker chose before sharing, not always population.
    // Falling back to population keeps every link made before this shipped
    // rendering exactly as it did.
    const metric = payload?.survey.metric || 'population'
    const shapes = demographics.areas.filter((area) => area.geometry)
    const values = shapes
      .map((area) => area.metrics?.[metric])
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    if (values.length === 0) return null
    const min = Math.min(...values)
    const max = Math.max(...values)
    const sorted = [...values].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    return {
      min,
      max,
      median,
      entries: shapes.map((area) => ({
        geoid: area.geoid,
        geometry: area.geometry,
        color: colorFor(area.metrics?.[metric], min, max),
        // The client can tap any shaded area for its numbers too, with the
        // metric being shaded listed first.
        info: areaInfoHtml(area.metrics, metric),
      })),
      metric,
    }
  }, [demographics, payload?.survey.metric])

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
  const stagesWithHidden = stages.map((stage) => ({ ...stage, hidden: hiddenStageIds.has(stage.id) }))
  const visibleProperties = (properties as Property[]).filter(
    (property) => !property.stageId || !hiddenStageIds.has(property.stageId),
  )
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
        <div className="flex items-center gap-3">
          <p className="hidden text-xs text-muted sm:block">
            {properties.length} site{properties.length === 1 ? '' : 's'}
            {survey.expiresAt && ` · link valid to ${shortDate(survey.expiresAt)}`}
          </p>
          {/* The phone's door to the map: the panel reads full-width and the
              map opens on demand, full-screen, legend and all. */}
          <button
            type="button"
            className="btn-secondary flex items-center gap-1.5 px-3 py-1.5 text-xs lg:hidden"
            onClick={() => setMapExpanded((open) => !open)}
          >
            {mapExpanded ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M4 6h16 M4 12h16 M4 18h16" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M9 20l-5.5 2.5V6L9 3.5m0 16.5l6-3m-6 3V3.5m6 13.5l5.5 2.5V3l-5.5 2.5m0 11.5V5.5m-6-2l6 2" />
              </svg>
            )}
            {mapExpanded ? 'List view' : 'Map view'}
          </button>
        </div>
      </header>

      {/* On a phone the shortlist and site details read full-width; the map
          lives behind the header's "Map view" button, opening full-screen
          with the legend. On desktop they share the row. */}
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
            mapExpanded ? 'absolute inset-0 z-[750]' : 'hidden'
          } bg-paper lg:relative lg:z-auto lg:block lg:h-full lg:w-full`}
        >
          <MapLegend
            stages={stagesWithHidden}
            properties={properties as Property[]}
            zones={zones}
            readOnly
            demographics={
              choropleth
                ? {
                    colorBy: choropleth.metric,
                    radius: 5,
                    busy: false,
                    scale: { min: choropleth.min, max: choropleth.max, median: choropleth.median },
                  }
                : null
            }
            onToggleStage={(stage) =>
              setHiddenStageIds((current) => {
                const next = new Set(current)
                if (next.has(stage.id)) next.delete(stage.id)
                else next.add(stage.id)
                return next
              })
            }
            onDeleteZone={() => undefined}
          />
          <MapCanvas
            stages={stagesWithHidden}
            zones={zones}
            properties={visibleProperties}
            selectedId={selectedId}
            onSelect={(propertyId) => {
              setSelectedId(propertyId)
              // A tapped pin should read as details, not stay hidden under
              // the full-screen map.
              setMapExpanded(false)
            }}
            tiles={features.tiles}
            basemaps={features.basemaps}
            choropleth={choropleth?.entries ?? null}
            routeGeometry={payload.tourPlan?.geometry ?? null}
            routeIds={payload.tourPlan?.stopIds}
            routeColor={accent}
            labelPins
            fitKey={`${properties.length}-${mapExpanded}`}
          />
        </div>
      </div>
    </div>
  )
}
