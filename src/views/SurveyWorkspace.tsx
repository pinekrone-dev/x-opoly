import { useCallback, useEffect, useMemo, useState } from 'react'
import AddPropertyDialog from '../components/AddPropertyDialog'
import MapCanvas from '../components/MapCanvas'
import PropertyPanel from '../components/PropertyPanel'
import PropertyTable from '../components/PropertyTable'
import ShareSettings from '../components/ShareSettings'
import TourPlanner from '../components/TourPlanner'
import { api } from '../api'
import type { AppFeatures, Property, Survey } from '../types'
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
  const [tab, setTab] = useState<Tab>('map')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [dropPin, setDropPin] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fitKey, setFitKey] = useState(0)
  const [tourOrder, setTourOrder] = useState<string[]>([])

  useEffect(() => {
    api
      .getSurvey(id)
      .then(({ survey: loaded, properties: list }) => {
        setSurvey(loaded)
        setProperties(list)
        setFitKey((key) => key + 1)
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not open that survey.'))
  }, [id])

  const selected = useMemo(
    () => properties.find((property) => property.id === selectedId) ?? null,
    [properties, selectedId],
  )

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

  const remove = async (propertyId: string) => {
    await api.deleteProperty(propertyId)
    setProperties((current) => current.filter((property) => property.id !== propertyId))
    setSelectedId(null)
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

  if (!survey) return <div className="grid min-h-full place-items-center text-sm text-slate-500">Loading…</div>

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
    />
  ) : (
    <ul className="divide-y divide-white/5">
      {properties.map((property) => (
        <li key={property.id}>
          <button
            type="button"
            className="flex w-full items-start gap-3 p-3 text-left hover:bg-white/[0.03]"
            onClick={() => setSelectedId(property.id)}
          >
            {property.photoUrl ? (
              <img src={property.photoUrl} alt="" className="h-12 w-14 shrink-0 rounded-md object-cover" />
            ) : (
              <span
                className="grid h-12 w-14 shrink-0 place-items-center rounded-md"
                style={{ background: `${STAGE_META[property.stage]?.color}1a` }}
                aria-hidden
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={STAGE_META[property.stage]?.color} strokeWidth="1.8">
                  <path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-5h6v5" />
                </svg>
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-slate-100">{displayName(property)}</span>
              <span className="block truncate text-xs text-slate-500">{fullAddress(property)}</span>
              <span className="mt-0.5 block truncate text-xs text-slate-400">
                {rate(property)} · {sqft(property.sizeSqft)}
              </span>
            </span>
          </button>
        </li>
      ))}
      {properties.length === 0 && (
        <li className="p-8 text-center text-sm text-slate-500">
          No sites yet. Add one by address, or drop a flyer in and let it fill itself out.
        </li>
      )}
    </ul>
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-white/10 bg-ink-900">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <button type="button" className="btn-ghost px-2 py-1" onClick={() => navigate('/')} aria-label="Back to surveys">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="m15 18-6-6 6-6" />
              </svg>
            </button>
            <div className="min-w-0">
              <input
                className="w-full truncate border-0 bg-transparent p-0 text-sm font-semibold text-white focus:outline-none"
                value={survey.name}
                aria-label="Survey name"
                onChange={(event) => setSurvey({ ...survey, name: event.target.value })}
                onBlur={(event) => void api.updateSurvey(survey.id, { name: event.target.value })}
              />
              <p className="truncate text-xs text-slate-500">
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
          <p className="flex items-center justify-between gap-3 border-t border-white/5 bg-brand/10 px-4 py-2 text-xs text-brand-soft">
            {dropPin ? 'Click the map to place the new site.' : notice}
            <button
              type="button"
              className="text-slate-400 hover:text-slate-100"
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
            <div className="scrollbar-thin min-h-0 overflow-y-auto border-r border-white/10 bg-ink-900">{sidebar}</div>
            <div className={dropPin ? 'cursor-crosshair' : ''}>
              <MapCanvas
                properties={properties}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onMapClick={dropPin ? (lat, lng) => void addAt(lat, lng) : undefined}
                tileUrl={features.tileUrl}
                tileAttribution={features.tileAttribution}
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
              selectedId={selectedId}
              onSelect={setSelectedId}
              onOrderChange={setTourOrder}
            />
            <div className="panel overflow-hidden">
              <MapCanvas
                properties={properties}
                selectedId={selectedId}
                onSelect={setSelectedId}
                tileUrl={features.tileUrl}
                tileAttribution={features.tileAttribution}
                routeIds={tourOrder}
                routeColor={survey.brandColor}
                fitKey={`tour-${properties.length}`}
              />
            </div>
          </div>
        )}

        {tab === 'share' && (
          <div className="h-full overflow-y-auto p-4">
            <ShareSettings survey={survey} onChange={setSurvey} />
          </div>
        )}
      </main>

      {adding && (
        <AddPropertyDialog
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
