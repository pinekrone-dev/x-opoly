import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AddPropertyDialog from '../components/AddPropertyDialog'
import MapCanvas from '../components/MapCanvas'
import PropertyPanel from '../components/PropertyPanel'
import PropertyTable from '../components/PropertyTable'
import ShareSettings from '../components/ShareSettings'
import CompareSites from '../components/CompareSites'
import MapLegend from '../components/MapLegend'
import StageSidebar from '../components/StageSidebar'
import TourPlanner from '../components/TourPlanner'
import { api } from '../api'
import type { AppFeatures, CompetitionResult, DealStage, Demographics, Property, Survey, TourAnchor, TourPlan, Zone } from '../types'
import { areaInfoHtml, colorFor } from '../components/DemographicsPanel'
import { buildTourBookFor } from '../lib/tourBookPdf'
import { navigate } from '../lib/router'
import { STAGE_META, fullAddress, displayName, rate, sqft } from '../lib/format'
import { autoPhotoFromFlyer } from '../lib/flyerPhoto'

type Tab = 'map' | 'list' | 'tour' | 'share'

const TABS: { id: Tab; label: string }[] = [
  { id: 'map', label: 'Map' },
  { id: 'list', label: 'List' },
  { id: 'tour', label: 'Plan tour' },
  { id: 'share', label: 'Share' },
]

export default function SurveyWorkspace({ id, features }: { id: string; features: AppFeatures }) {
  const [survey, setSurvey] = useState<Survey | null>(null)
  const [properties, setProperties] = useState<Property[]>([])
  const [stages, setStages] = useState<DealStage[]>([])
  const [tab, setTab] = useState<Tab>('map')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [dropPin, setDropPin] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fitKey, setFitKey] = useState(0)
  const [tourOrder, setTourOrder] = useState<string[]>([])
  const [tourPlan, setTourPlan] = useState<TourPlan | null>(null)
  const [tourAnchors, setTourAnchors] = useState<{
    start: TourAnchor | null
    end: TourAnchor | null
  } | null>(null)
  const [mapCenter, setMapCenter] = useState<{ lat: number; lng: number } | null>(null)
  /** A site being given a location by clicking the map. */
  const [placing, setPlacing] = useState<string | null>(null)
  const [zones, setZones] = useState<Zone[]>([])
  /** Armed: the next map click centres a new zone. Placed: the form is open. */
  const [zoneMode, setZoneMode] = useState<'off' | 'armed'>('off')
  const [pendingZone, setPendingZone] = useState<{ lat: number; lng: number } | null>(null)
  const [bookBusy, setBookBusy] = useState(false)
  const [bookError, setBookError] = useState<string | null>(null)
  const [demoView, setDemoView] = useState<{
    data: Demographics | null
    colorBy: string
    radius: number
  } | null>(null)
  /**
   * The phone layout's map. Below `lg` the pipeline and site details own the
   * screen; the header's Map button — or arming any action that needs a map
   * click — opens the map full-screen. On desktop this state is inert.
   */
  const [mapExpanded, setMapExpanded] = useState(false)
  /** Census pull for the legend's demographics control, cached per survey. */
  const mapDemoData = useRef<Demographics | null>(null)
  const [mapDemoBusy, setMapDemoBusy] = useState(false)
  const [competition, setCompetition] = useState<(CompetitionResult & { center: { lat: number; lng: number } }) | null>(null)

  useEffect(() => {
    api
      .getSurvey(id)
      .then(({ survey: loaded, properties: list, stages: pipeline, zones: circles }) => {
        setSurvey(loaded)
        setProperties(list)
        setStages(pipeline ?? [])
        setZones(circles ?? [])
        setFitKey((key) => key + 1)
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not open that survey.'))
  }, [id])

  const selected = useMemo(
    () => properties.find((property) => property.id === selectedId) ?? null,
    [properties, selectedId],
  )

  // Anything that needs a map click gets the full map; anything that needs
  // reading — a tapped pin's details, the just-placed zone's form — collapses
  // it back to the corner so the content is legible again.
  useEffect(() => {
    if (dropPin || placing || zoneMode === 'armed') setMapExpanded(true)
  }, [dropPin, placing, zoneMode])
  useEffect(() => {
    if (selectedId || pendingZone) setMapExpanded(false)
  }, [selectedId, pendingZone])
  useEffect(() => {
    setMapExpanded(false)
  }, [tab])
  // Growing from thumbnail to full screen deserves a re-fit: the bounds that
  // suited a 9rem box are wrong for the whole tab.
  useEffect(() => {
    if (mapExpanded) setFitKey((key) => key + 1)
  }, [mapExpanded])

  /**
   * Pins the map should draw.
   *
   * Hiding a stage is how a broker clears forty passed sites out of the way,
   * so it has to reach the map, not just the sidebar list.
   */
  const visibleProperties = useMemo(() => {
    const hidden = new Set(stages.filter((stage) => stage.hidden).map((stage) => stage.id))
    if (hidden.size === 0) return properties
    return properties.filter((property) => !property.stageId || !hidden.has(property.stageId))
  }, [properties, stages])

  /**
   * Block groups paired with the colour they should be drawn in.
   *
   * The scale spans only the groups inside the selected ring — scaling against
   * the whole five-mile pull would flatten a one-mile view into a single band.
   */
  const choropleth = useMemo(() => {
    const view = demoView
    if (!view?.data) return null

    const inside = view.data.areas.filter((area) => area.miles <= view.radius && area.geometry)
    const values = inside
      .map((area) => area.metrics?.[view.colorBy])
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    if (values.length === 0) return null

    const min = Math.min(...values)
    const max = Math.max(...values)
    return {
      // The scale rides along so the legend can say what the colours mean.
      min,
      max,
      entries: inside.map((area) => ({
        geoid: area.geoid,
        geometry: area.geometry,
        color: colorFor(area.metrics?.[view.colorBy], min, max),
        // Tapping a shaded block group shows its actual numbers.
        info: areaInfoHtml(area.metrics, view.colorBy),
      })),
    }
  }, [demoView])

  /**
   * The legend's demographics control: shading is one pick away, up front,
   * before any site is opened. One census pull (the widest radius) serves
   * every metric and ring choice after it.
   */
  const setMapDemographics = async (colorBy: string | null, radius: number) => {
    if (!colorBy) {
      setDemoView(null)
      return
    }
    if (mapDemoData.current) {
      setDemoView({ data: mapDemoData.current, colorBy, radius })
      return
    }
    const placed = properties.find((property) => property.lat != null && property.lng != null)
    const anchor =
      selected?.lat != null && selected?.lng != null
        ? { lat: selected.lat, lng: selected.lng }
        : placed?.lat != null && placed?.lng != null
          ? { lat: placed.lat, lng: placed.lng }
          : mapCenter
    if (!anchor) {
      setError('Add a site or move the map first — demographics shade around a point.')
      return
    }
    setMapDemoBusy(true)
    try {
      const data = await api.demographics(anchor.lat, anchor.lng)
      mapDemoData.current = data
      setDemoView({ data, colorBy, radius })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Census data could not be loaded.')
    } finally {
      setMapDemoBusy(false)
    }
  }

  const upsert = useCallback((property: Property) => {
    setProperties((current) => {
      const index = current.findIndex((entry) => entry.id === property.id)
      if (index === -1) return [...current, property]
      const next = [...current]
      next[index] = property
      return next
    })
  }, [])

  const addAt = async (lat: number, lng: number) => {
    const { property } = await api.addProperty(id, { name: 'New site', lat, lng })
    upsert(property)
    setSelectedId(property.id)
    setDropPin(false)
    setNotice('Pin dropped — give it a name and the details.')
  }

  const saveZone = async (input: { label: string; radiusMiles: number }) => {
    if (!pendingZone) return
    try {
      const { zone } = await api.createZone(id, { ...input, ...pendingZone })
      setZones((current) => [...current, zone])
      setNotice(`${zone.label} drawn — ${zone.radiusMiles} mi.`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The zone could not be saved.')
    } finally {
      setPendingZone(null)
      setZoneMode('off')
    }
  }

  const removeZone = async (zoneId: string) => {
    await api.deleteZone(zoneId).catch(() => undefined)
    setZones((current) => current.filter((zone) => zone.id !== zoneId))
  }

  /** Gives an existing, unplaced site the clicked location. */
  const placeAt = async (lat: number, lng: number) => {
    if (!placing) return
    const { property } = await api.updateProperty(placing, { lat, lng })
    upsert(property)
    setSelectedId(property.id)
    setPlacing(null)
    setFitKey((key) => key + 1)
    setNotice(`${property.name ?? 'The site'} is on the map now.`)
  }

  const remove = async (propertyId: string) => {
    await api.deleteProperty(propertyId)
    setProperties((current) => current.filter((property) => property.id !== propertyId))
    setSelectedId(null)
  }

  const moveToStage = async (propertyId: string, stageId: string | null) => {
    // Update locally first: dragging a card should feel instant, and the
    // server is only confirming what the broker already sees.
    setProperties((current) =>
      current.map((property) => (property.id === propertyId ? { ...property, stageId } : property)),
    )
    try {
      const { property } = await api.updateProperty(propertyId, { stageId })
      upsert(property)
    } catch {
      setError('Could not move that site. Reload to see where it actually is.')
    }
  }

  const toggleStageHidden = async (stage: DealStage) => {
    const hidden = !stage.hidden
    setStages((current) => current.map((entry) => (entry.id === stage.id ? { ...entry, hidden } : entry)))
    await api.updateStage(stage.id, { hidden }).catch(() => undefined)
  }

  const addStage = async (name: string) => {
    const { stage } = await api.addStage(id, { name })
    setStages((current) => [...current, stage])
  }

  const renameStage = async (stage: DealStage, name: string) => {
    const trimmed = name.trim()
    if (!trimmed || trimmed === stage.name) return
    setStages((current) => current.map((entry) => (entry.id === stage.id ? { ...entry, name: trimmed } : entry)))
    await api.updateStage(stage.id, { name: trimmed }).catch(() => undefined)
  }

  const removeStage = async (stage: DealStage) => {
    await api.deleteStage(stage.id)
    setStages((current) => current.filter((entry) => entry.id !== stage.id))
    // Its sites are unstaged rather than deleted, so reflect that here too.
    setProperties((current) =>
      current.map((property) => (property.stageId === stage.id ? { ...property, stageId: null } : property)),
    )
  }

  if (error) {
    return (
      <div className="grid min-h-full place-items-center p-6">
        <div className="panel max-w-md p-8 text-center">
          <p className="text-sm text-body">{error}</p>
          <button type="button" className="btn-secondary mt-4" onClick={() => navigate('/')}>
            Back to surveys
          </button>
        </div>
      </div>
    )
  }

  if (!survey) return <div className="grid min-h-full place-items-center text-sm text-muted">Loading…</div>

  const counts = properties.reduce<Record<string, number>>((totals, property) => {
    totals[property.stage] = (totals[property.stage] ?? 0) + 1
    return totals
  }, {})

  const sidebar = selected ? (
    <PropertyPanel
      property={selected}
      stages={stages}
      onChange={upsert}
      onDelete={(propertyId) => void remove(propertyId)}
      onClose={() => setSelectedId(null)}
      onCompetition={setCompetition}
      onDemographics={setDemoView}
      onPlaceOnMap={() => {
        setPlacing(selected.id)
        setTab('map')
        setNotice('Click the spot on the map where this site sits.')
      }}
    />
  ) : (
    <StageSidebar
      stages={stages}
      properties={properties}
      selectedId={selectedId}
      zones={zones}
      onDeleteZone={(zoneId) => void removeZone(zoneId)}
      demographics={{
        colorBy: demoView?.colorBy ?? null,
        radius: demoView?.radius ?? 3,
        busy: mapDemoBusy,
      }}
      onDemographics={(colorBy, radius) => void setMapDemographics(colorBy, radius)}
      onStartZone={() => setZoneMode('armed')}
      pendingZone={pendingZone}
      onSaveZone={(zone) => void saveZone(zone)}
      onCancelZone={() => {
        setPendingZone(null)
        setZoneMode('off')
      }}
      onSelect={setSelectedId}
      onMove={(propertyId, stageId) => void moveToStage(propertyId, stageId)}
      onToggleHidden={(stage) => void toggleStageHidden(stage)}
      onAddStage={(name) => void addStage(name)}
      onRenameStage={(stage, name) => void renameStage(stage, name)}
      onDeleteStage={(stage) => void removeStage(stage)}
    />
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-line bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <button type="button" className="btn-ghost px-2 py-1" onClick={() => navigate('/')} aria-label="Back to surveys">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="m15 18-6-6 6-6" />
              </svg>
            </button>
            <div className="min-w-0">
              <input
                className="w-full truncate border-0 bg-transparent p-0 text-sm font-semibold text-ink focus:outline-none"
                value={survey.name}
                aria-label="Survey name"
                onChange={(event) => setSurvey({ ...survey, name: event.target.value })}
                onBlur={(event) => void api.updateSurvey(survey.id, { name: event.target.value })}
              />
              <p className="truncate text-xs text-muted">
                {survey.clientName ? `for ${survey.clientName} · ` : ''}
                {properties.length} site{properties.length === 1 ? '' : 's'}
                {Object.entries(counts)
                  .filter(([stage]) => stage !== 'prospect')
                  .map(([stage, total]) => ` · ${total} ${STAGE_META[stage as keyof typeof STAGE_META]?.label.toLowerCase()}`)
                  .join('')}
              </p>
            </div>
          </div>

          <div className="flex min-w-0 items-center gap-2">
            <nav className="scrollbar-thin flex gap-1 overflow-x-auto" aria-label="Survey views">
              {TABS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={`tab shrink-0 ${tab === entry.id ? 'tab-active' : ''}`}
                  onClick={() => setTab(entry.id)}
                >
                  {entry.label}
                </button>
              ))}
            </nav>
            {tab === 'map' || tab === 'tour' ? (
              <button
                type="button"
                className="btn-secondary flex shrink-0 items-center gap-1.5 px-3 py-1.5 text-xs lg:hidden"
                aria-label={mapExpanded ? 'Back to the list' : 'Open the map'}
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
                {mapExpanded ? 'List view' : 'Map'}
              </button>
            ) : null}
            <button type="button" className="btn-primary shrink-0 py-1.5" onClick={() => setAdding(true)} aria-label="Add site">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
                <path d="M12 5v14M5 12h14" />
              </svg>
              <span className="hidden sm:inline">Add site</span>
            </button>
          </div>
        </div>

        {(notice || dropPin) && (
          <p className="flex items-center justify-between gap-3 border-t border-line bg-brand/10 px-4 py-2 text-xs text-brand-soft">
            {dropPin ? 'Click the map to place the new site.' : notice}
            <button
              type="button"
              className="text-muted hover:text-ink"
              onClick={() => { setNotice(null); setDropPin(false) }}
            >
              Dismiss
            </button>
          </p>
        )}
      </header>

      <main className="min-h-0 flex-1">
        {tab === 'map' && (
          <div className="relative h-full min-h-0 lg:grid lg:grid-cols-[22rem_minmax(0,1fr)]">
            {/* The pipeline or the selected site's details: the main phone
                surface, and the left column on desktop. */}
            <div className="scrollbar-thin h-full min-h-0 overflow-y-auto border-line bg-surface lg:border-r">
              {sidebar}
            </div>

            {/* The map: the right column on desktop; on a phone it lives
                behind the header's Map button, opening full-screen. */}
            <div
              className={`${mapExpanded ? 'absolute inset-0 z-[750]' : 'hidden'} bg-paper lg:relative lg:z-auto lg:block lg:h-full lg:w-full ${
                dropPin || placing || zoneMode === 'armed' ? 'cursor-crosshair' : ''
              }`}
            >
              {/* The floating legend only exists where the sidebar's data
                  catalog is not on screen: the phone's full-screen map. On
                  desktop the left panel already says all of this. When the
                  demographics layer is shaded, the legend carries its scale. */}
              {mapExpanded ? (
                <MapLegend
                  stages={stages}
                  properties={properties}
                  zones={zones}
                  onToggleStage={(stage) => void toggleStageHidden(stage)}
                  onDeleteZone={(zoneId) => void removeZone(zoneId)}
                  demographics={{
                    colorBy: demoView?.colorBy ?? null,
                    radius: demoView?.radius ?? 3,
                    busy: mapDemoBusy,
                    scale: choropleth ? { min: choropleth.min, max: choropleth.max } : null,
                  }}
                  onDemographics={(colorBy, radius) => void setMapDemographics(colorBy, radius)}
                />
              ) : choropleth && demoView ? (
                <div className="hidden lg:block">
                  <MapLegend
                    stages={[]}
                    properties={[]}
                    zones={[]}
                    onToggleStage={() => undefined}
                    onDeleteZone={() => undefined}
                    readOnly
                    demographics={{
                      colorBy: demoView.colorBy,
                      radius: demoView.radius,
                      busy: false,
                      scale: { min: choropleth.min, max: choropleth.max },
                    }}
                  />
                </div>
              ) : null}
              <MapCanvas
                stages={stages}
                zones={zones}
                properties={visibleProperties}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onMapClick={
                  dropPin
                    ? (lat, lng) => void addAt(lat, lng)
                    : placing
                      ? (lat, lng) => void placeAt(lat, lng)
                      : zoneMode === 'armed'
                        ? (lat, lng) => setPendingZone({ lat, lng })
                        : undefined
                }
                onViewChange={setMapCenter}
                tiles={features.tiles}
                basemaps={features.basemaps}
                choropleth={choropleth?.entries ?? null}
                rings={competition ? { ...competition.center, miles: competition.rings.map((ring) => ring.miles) } : null}
                competitors={competition?.results}
                fitKey={fitKey}
              />
            </div>
          </div>
        )}

        {tab === 'list' && (
          <div className="grid h-full min-h-0 gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
            <PropertyTable properties={properties} stages={stages} selectedId={selectedId} onSelect={setSelectedId} />
            <div className="scrollbar-thin min-h-0 overflow-y-auto">
              {selected && (
                <div className="panel mb-4 overflow-hidden">
                  <PropertyPanel
                    property={selected}
                    stages={stages}
                    onChange={upsert}
                    onDelete={(propertyId) => void remove(propertyId)}
                    onClose={() => setSelectedId(null)}
                    onCompetition={setCompetition}
                    onDemographics={setDemoView}
                  />
                </div>
              )}
              {/* Side-by-side lives with the list: pick finalists from the
                  table, compare them right here. (It stays on Share too.) */}
              <CompareSites survey={survey} properties={properties} stages={stages} />
            </div>
          </div>
        )}

        {tab === 'tour' && (
          <div className="relative h-full min-h-0 lg:grid lg:grid-cols-[24rem_minmax(0,1fr)] lg:gap-4 lg:p-4">
            {/* The planner is the phone's main surface; the route map lives
                behind the header's Map button, as on the map tab. */}
            <div className="h-full min-h-0 overflow-y-auto lg:overflow-visible">
              <TourPlanner
                surveyId={survey.id}
                properties={properties}
                defaults={survey.tour}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onOrderChange={setTourOrder}
                onPlan={setTourPlan}
                onAnchors={setTourAnchors}
              />
            </div>
            <div
              className={`${
                mapExpanded ? 'absolute inset-0 z-[750]' : 'hidden'
              } bg-paper lg:static lg:z-auto lg:block lg:h-full lg:w-full lg:overflow-hidden lg:rounded-xl lg:border lg:border-line lg:bg-surface lg:shadow-sm`}
            >
              <MapCanvas
                stages={stages}
                properties={visibleProperties}
                selectedId={selectedId}
                onSelect={setSelectedId}
                tiles={features.tiles}
                basemaps={features.basemaps}
                onViewChange={setMapCenter}
                anchors={
                  tourAnchors
                    ? {
                        start: tourAnchors.start
                          ? { lat: tourAnchors.start.lat, lng: tourAnchors.start.lng, label: tourAnchors.start.address ?? undefined }
                          : null,
                        end: tourAnchors.end
                          ? { lat: tourAnchors.end.lat, lng: tourAnchors.end.lng, label: tourAnchors.end.address ?? undefined }
                          : null,
                      }
                    : null
                }
                routeIds={tourOrder}
                routeGeometry={tourPlan?.geometry ?? null}
                choropleth={choropleth?.entries ?? null}
                routeColor={survey.brandColor}
                fitKey={`tour-${properties.length}-${fitKey}`}
              />
            </div>
          </div>
        )}

        {tab === 'share' && (
          <div className="h-full overflow-y-auto p-4">
            <ShareSettings survey={survey} onChange={setSurvey} />

            {/*
              The other half of sharing. A link is for a client at a desk; the
              book is what gets emailed the night before and read in the car,
              so it belongs beside the link rather than a tab away.
            */}
            <section className="panel mt-4 p-4">
              <h3 className="panel-title">Tour book</h3>
              <p className="mt-1 text-xs leading-relaxed text-muted">
                A PDF in driving order — the photos clipped from each flyer, the address and
                details, arrival times, and a QR on every stop so a client can pull up directions
                without typing anything.
              </p>

              <button
                type="button"
                className="btn-primary mt-3 w-full"
                disabled={bookBusy}
                onClick={async () => {
                  setBookBusy(true)
                  setBookError(null)
                  try {
                    await buildTourBookFor({
                      surveyId: survey.id,
                      survey,
                      properties,
                      stages,
                    })
                  } catch (cause) {
                    setBookError(
                      cause instanceof Error ? cause.message : 'The tour book could not be built.',
                    )
                  } finally {
                    setBookBusy(false)
                  }
                }}
              >
                {bookBusy ? 'Building the PDF…' : 'Download tour book (PDF)'}
              </button>

              <button
                type="button"
                className="btn-secondary mt-2 w-full text-xs"
                onClick={() => navigate(`/survey/${survey.id}/book`)}
              >
                Preview it first
              </button>

              {bookError ? <p className="mt-2 text-xs text-rose-600">{bookError}</p> : null}
            </section>
          </div>
        )}
      </main>

      {adding && (
        <AddPropertyDialog
          mapCenter={mapCenter}
          surveyId={survey.id}
          flyerExtractionEnabled={features.flyerExtraction}
          onClose={() => setAdding(false)}
          onDropPinMode={() => setDropPin(true)}
          onAdded={(property, message) => {
            upsert(property)
            setSelectedId(property.id)
            setAdding(false)
            setFitKey((key) => key + 1)
            if (message) setNotice(message)
            // A flyer-born site gets its card photo from the flyer's first
            // page, in the background — no cropping required.
            void autoPhotoFromFlyer(property).then((updated) => {
              if (updated) upsert(updated)
            })
          }}
        />
      )}
    </div>
  )
}
