import { useCallback, useEffect, useMemo, useState } from 'react'
import AddPropertyDialog from '../components/AddPropertyDialog'
import MapCanvas from '../components/MapCanvas'
import PropertyPanel from '../components/PropertyPanel'
import PropertyTable from '../components/PropertyTable'
import ShareSettings from '../components/ShareSettings'
import CompareSites from '../components/CompareSites'
import InviteCollaborators from '../components/InviteCollaborators'
import StageSidebar from '../components/StageSidebar'
import TourPlanner from '../components/TourPlanner'
import { api } from '../api'
import type { AppFeatures, CompetitionResult, DealStage, Demographics, Property, Survey, TourPlan } from '../types'
import { colorFor } from '../components/DemographicsPanel'
import { buildTourBookFor } from '../lib/tourBookPdf'
import { navigate } from '../lib/router'
import { STAGE_META, fullAddress, displayName, rate, sqft } from '../lib/format'

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
  const [mapCenter, setMapCenter] = useState<{ lat: number; lng: number } | null>(null)
  /** A site being given a location by clicking the map. */
  const [placing, setPlacing] = useState<string | null>(null)
  const [bookBusy, setBookBusy] = useState(false)
  const [bookError, setBookError] = useState<string | null>(null)
  const [demoView, setDemoView] = useState<{
    data: Demographics | null
    colorBy: string
    radius: number
  } | null>(null)
  const [competition, setCompetition] = useState<(CompetitionResult & { center: { lat: number; lng: number } }) | null>(null)

  useEffect(() => {
    api
      .getSurvey(id)
      .then(({ survey: loaded, properties: list, stages: pipeline }) => {
        setSurvey(loaded)
        setProperties(list)
        setStages(pipeline ?? [])
        setFitKey((key) => key + 1)
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not open that survey.'))
  }, [id])

  const selected = useMemo(
    () => properties.find((property) => property.id === selectedId) ?? null,
    [properties, selectedId],
  )

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
    return inside.map((area) => ({
      geoid: area.geoid,
      geometry: area.geometry,
      color: colorFor(area.metrics?.[view.colorBy], min, max),
    }))
  }, [demoView])

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

          <div className="flex items-center gap-2">
            <nav className="flex gap-1" aria-label="Survey views">
              {TABS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={`tab ${tab === entry.id ? 'tab-active' : ''}`}
                  onClick={() => setTab(entry.id)}
                >
                  {entry.label}
                </button>
              ))}
            </nav>
            <button type="button" className="btn-primary py-1.5" onClick={() => setAdding(true)}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
                <path d="M12 5v14M5 12h14" />
              </svg>
              Add site
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
          <div className="grid h-full min-h-0 lg:grid-cols-[22rem_minmax(0,1fr)]">
            <div className="scrollbar-thin min-h-0 overflow-y-auto border-r border-line bg-surface">{sidebar}</div>
            <div className={`relative ${dropPin || placing ? 'cursor-crosshair' : ''}`}>
              <MapCanvas
                properties={visibleProperties}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onMapClick={
                  dropPin
                    ? (lat, lng) => void addAt(lat, lng)
                    : placing
                      ? (lat, lng) => void placeAt(lat, lng)
                      : undefined
                }
                onViewChange={setMapCenter}
                tiles={features.tiles}
                basemaps={features.basemaps}
                choropleth={choropleth}
                rings={competition ? { ...competition.center, miles: competition.rings.map((ring) => ring.miles) } : null}
                competitors={competition?.results}
                fitKey={fitKey}
              />
            </div>
          </div>
        )}

        {tab === 'list' && (
          <div className="grid h-full min-h-0 gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
            <PropertyTable properties={properties} selectedId={selectedId} onSelect={setSelectedId} />
            {selected && (
              <div className="panel min-h-0 overflow-hidden">
                <PropertyPanel
                  property={selected}
                  onChange={upsert}
                  onDelete={(propertyId) => void remove(propertyId)}
                  onClose={() => setSelectedId(null)}
                  onCompetition={setCompetition}
      onDemographics={setDemoView}
                />
              </div>
            )}
          </div>
        )}

        {tab === 'tour' && (
          <div className="grid h-full min-h-0 gap-4 p-4 lg:grid-cols-[24rem_minmax(0,1fr)]">
            <TourPlanner
              surveyId={survey.id}
              properties={properties}
              defaults={survey.tour}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onOrderChange={setTourOrder}
              onPlan={setTourPlan}
            />
            <div className="panel overflow-hidden">
              <MapCanvas
                properties={visibleProperties}
                selectedId={selectedId}
                onSelect={setSelectedId}
                tiles={features.tiles}
                basemaps={features.basemaps}
                onViewChange={setMapCenter}
                routeIds={tourOrder}
                routeGeometry={tourPlan?.geometry ?? null}
                choropleth={choropleth}
                routeColor={survey.brandColor}
                fitKey={`tour-${properties.length}`}
              />
            </div>
          </div>
        )}

        {tab === 'share' && (
          <div className="h-full overflow-y-auto p-4">
            <ShareSettings survey={survey} onChange={setSurvey} />

            <CompareSites survey={survey} properties={properties} stages={stages} />

            <InviteCollaborators />

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
          }}
        />
      )}
    </div>
  )
}
