import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { CompetitionResult, CustomField, Demographics, Property, Stage } from '../types'
import { STAGE_META, count, fullAddress, displayName, money, rate, sqft } from '../lib/format'
import CompetitionPanel from './CompetitionPanel'
import CustomFields from './CustomFields'
import DemographicsPanel from './DemographicsPanel'
import { StageSelect } from './StageBadge'

interface Props {
  property: Property
  readOnly?: boolean
  onChange?: (property: Property) => void
  onDelete?: (id: string) => void
  onClose?: () => void
  onCompetition?: (result: (CompetitionResult & { center: { lat: number; lng: number } }) | null) => void
  /** Fires when there are figures to shade the map with, or the view changes. */
  onDemographics?: (view: { data: Demographics | null; colorBy: string; radius: number } | null) => void
}

type Tab = 'details' | 'flyer' | 'demographics' | 'competition'

const EDITABLE: { key: keyof Property; label: string; type?: string; suffix?: string }[] = [
  { key: 'name', label: 'Property name' },
  { key: 'address', label: 'Street address' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'zip', label: 'ZIP' },
  { key: 'rentRate', label: 'Asking rate', type: 'number' },
  { key: 'rentUnit', label: 'Rate unit' },
  { key: 'nnn', label: 'NNN / opex', type: 'number' },
  { key: 'sizeSqft', label: 'Size (SF)', type: 'number' },
  { key: 'acreage', label: 'Acreage', type: 'number' },
  { key: 'parkingSpaces', label: 'Parking spaces', type: 'number' },
  { key: 'zoning', label: 'Zoning' },
  { key: 'yearBuilt', label: 'Year built', type: 'number' },
  { key: 'availability', label: 'Available' },
  { key: 'listingBroker', label: 'Listing broker' },
  { key: 'brokerEmail', label: 'Broker email' },
  { key: 'brokerPhone', label: 'Broker phone' },
]

export default function PropertyPanel({
  property,
  readOnly = false,
  onChange,
  onDelete,
  onClose,
  onCompetition,
  onDemographics,
}: Props) {
  const [tab, setTab] = useState<Tab>('details')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Partial<Property>>({})
  const [fields, setFields] = useState<CustomField[]>([])
  const [demographics, setDemographics] = useState<Demographics | null>(null)
  const [demoError, setDemoError] = useState<string | null>(null)
  const [demoLoading, setDemoLoading] = useState(false)
  const [colorBy, setColorBy] = useState('population')
  const [radius, setRadius] = useState(3)
  const photoInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setEditing(false)
    setDraft({})
    setFields(property.fields ?? [])
    setDemographics(null)
    setDemoError(null)
    onDemographics?.(null)
    setTab('details')
  }, [property.id])

  const save = async () => {
    const fieldsChanged = JSON.stringify(fields) !== JSON.stringify(property.fields ?? [])
    if (Object.keys(draft).length === 0 && !fieldsChanged) {
      setEditing(false)
      return
    }
    // Fields ride along with the column patch, so one save is one request.
    const payload = fieldsChanged ? { ...draft, fields } : draft
    const { property: updated } = await api.updateProperty(property.id, payload)
    onChange?.(updated)
    setDraft({})
    setFields(updated.fields ?? [])
    setEditing(false)
  }

  const setStage = async (stage: Stage) => {
    const { property: updated } = await api.updateProperty(property.id, { stage })
    onChange?.(updated)
  }

  const loadDemographics = async () => {
    if (property.lat == null || property.lng == null) {
      setDemoError('Drop this property on the map first.')
      return
    }
    setDemoLoading(true)
    setDemoError(null)
    try {
      const data = await api.demographics(property.lat, property.lng)
      setDemographics(data)
      onDemographics?.({ data, colorBy, radius })
    } catch (error) {
      setDemoError(error instanceof Error ? error.message : 'Could not load demographics.')
    } finally {
      setDemoLoading(false)
    }
  }

  const uploadPhoto = async (file: File) => {
    const { property: updated } = await api.uploadPhoto(property.id, file)
    onChange?.(updated)
  }

  const stats = [
    { label: 'Asking', value: rate(property) },
    { label: 'NNN', value: property.nnn == null ? '—' : money(property.nnn) },
    { label: 'Size', value: sqft(property.sizeSqft) },
    { label: 'Acreage', value: property.acreage == null ? '—' : `${property.acreage} ac` },
    { label: 'Parking', value: count(property.parkingSpaces) },
    { label: 'Zoning', value: property.zoning || '—' },
    { label: 'Built', value: property.yearBuilt ? String(property.yearBuilt) : '—' },
    { label: 'Available', value: property.availability || '—' },
  ]

  return (
    <aside className="flex h-full min-h-0 flex-col">
      <header className="panel-header">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-slate-100">{displayName(property)}</h2>
          <p className="truncate text-xs text-slate-500">{fullAddress(property)}</p>
        </div>
        {onClose && (
          <button type="button" className="btn-ghost px-2 py-1" onClick={onClose} aria-label="Close property details">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        )}
      </header>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {property.photoUrl ? (
          <img src={property.photoUrl} alt={displayName(property)} className="h-36 w-full object-cover" />
        ) : (
          !readOnly && (
            <button
              type="button"
              className="flex h-24 w-full items-center justify-center gap-2 border-b border-white/5 bg-ink-850 text-xs text-slate-500 hover:bg-ink-800 hover:text-slate-300"
              onClick={() => photoInput.current?.click()}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                <rect x="3" y="5" width="18" height="14" rx="2" />
                <circle cx="9" cy="11" r="2" />
                <path d="m5 17 4.5-4 3.5 3 3-2.5L19 17" />
              </svg>
              Add a photo
            </button>
          )
        )}
        <input
          ref={photoInput}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void uploadPhoto(file)
          }}
        />

        <div className="flex items-center justify-between gap-2 border-b border-white/5 px-4 py-3">
          {readOnly ? (
            <span className="pill" style={{ background: `${STAGE_META[property.stage]?.color}22`, color: STAGE_META[property.stage]?.color }}>
              {STAGE_META[property.stage]?.label}
            </span>
          ) : (
            <StageSelect stage={property.stage} onChange={(stage) => void setStage(stage)} />
          )}
          {property.lat != null && (
            <span className="font-mono text-[11px] text-slate-600">
              {property.lat.toFixed(4)}, {property.lng?.toFixed(4)}
            </span>
          )}
        </div>

        <nav className="flex gap-1 border-b border-white/5 px-3 py-2" aria-label="Property sections">
          {((readOnly ? ['details', 'flyer', 'demographics'] : ['details', 'flyer', 'demographics', 'competition']) as Tab[]).map((entry) => (
            <button
              key={entry}
              type="button"
              className={`tab px-2 py-1 text-xs capitalize ${tab === entry ? 'tab-active' : ''}`}
              onClick={() => {
                setTab(entry)
                if (entry === 'demographics' && !demographics && !demoError) void loadDemographics()
              }}
            >
              {entry}
            </button>
          ))}
        </nav>

        {tab === 'details' && (
          <div className="p-4">
            {editing ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {EDITABLE.map((field) => (
                  <label key={String(field.key)} className={field.key === 'name' || field.key === 'address' ? 'sm:col-span-2' : ''}>
                    <span className="label">{field.label}</span>
                    <input
                      className="field"
                      type={field.type || 'text'}
                      step={field.type === 'number' ? 'any' : undefined}
                      defaultValue={(property[field.key] as string | number | null) ?? ''}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          [field.key]: field.type === 'number' ? (event.target.value === '' ? null : Number(event.target.value)) : event.target.value,
                        }))
                      }
                    />
                  </label>
                ))}
                <CustomFields fields={fields} onChange={setFields} />
                <label className="sm:col-span-2">
                  <span className="label">Notes</span>
                  <textarea
                    className="field h-24 resize-none"
                    defaultValue={property.notes ?? ''}
                    onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))}
                  />
                </label>
                <div className="flex gap-2 sm:col-span-2">
                  <button type="button" className="btn-primary flex-1" onClick={() => void save()}>
                    Save changes
                  </button>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => {
                      setEditing(false)
                      setDraft({})
                      setFields(property.fields ?? [])
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <dl className="grid grid-cols-2 gap-2">
                  {stats.map((stat) => (
                    <div key={stat.label} className="stat">
                      <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{stat.label}</dt>
                      <dd className="mt-0.5 truncate text-sm font-semibold text-slate-100" title={stat.value}>
                        {stat.value}
                      </dd>
                    </div>
                  ))}
                </dl>

                {property.fields?.length ? (
                  <dl className="mt-4 space-y-2 border-t border-white/5 pt-3">
                    {property.fields.map((field, index) => (
                      <div key={`${field.label}-${index}`}>
                        <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                          {field.label}
                        </dt>
                        <dd className="text-sm text-slate-100">{field.value || '—'}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}

                {property.listingBroker || property.brokerEmail || property.brokerPhone ? (
                  <div className="mt-4 border-t border-white/5 pt-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Broker</p>
                    {property.listingBroker && (
                      <p className="mt-1 text-sm text-slate-100">{property.listingBroker}</p>
                    )}
                    <p className="text-xs text-slate-400">
                      {property.brokerEmail && (
                        <a className="hover:text-teal-300" href={`mailto:${property.brokerEmail}`}>
                          {property.brokerEmail}
                        </a>
                      )}
                      {property.brokerEmail && property.brokerPhone ? ' · ' : ''}
                      {property.brokerPhone && (
                        <a className="hover:text-teal-300" href={`tel:${property.brokerPhone}`}>
                          {property.brokerPhone}
                        </a>
                      )}
                    </p>
                  </div>
                ) : null}

                {property.notes && (
                  <p className="mt-3 whitespace-pre-wrap rounded-lg bg-ink-850 p-3 text-xs leading-relaxed text-slate-300">
                    {property.notes}
                  </p>
                )}

                {!readOnly && (
                  <div className="mt-4 flex gap-2">
                    <button type="button" className="btn-secondary flex-1 text-xs" onClick={() => setEditing(true)}>
                      Edit details
                    </button>
                    {onDelete && (
                      <button type="button" className="btn-danger text-xs" onClick={() => onDelete(property.id)}>
                        Remove
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {tab === 'flyer' && (
          <div className="p-4">
            {property.flyerUrl ? (
              <div className="grid gap-3">
                <a className="btn-secondary justify-between" href={property.flyerUrl} target="_blank" rel="noreferrer noopener">
                  <span className="truncate">{property.flyerName || 'Listing flyer'}</span>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                    <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
                  </svg>
                </a>
                <object data={property.flyerUrl} type="application/pdf" className="h-96 w-full rounded-lg border border-white/10 bg-ink-850">
                  <img src={property.flyerUrl} alt="Listing flyer" className="w-full rounded-lg" />
                </object>
              </div>
            ) : (
              <p className="rounded-lg border border-dashed border-white/10 p-6 text-center text-xs text-slate-500">
                No flyer attached to this site.
              </p>
            )}
          </div>
        )}

        {tab === 'competition' && onCompetition && (
          <CompetitionPanel property={property} onResult={onCompetition} />
        )}

        {tab === 'demographics' && (
          <div className="p-4">
            {demoLoading && <p className="text-xs text-slate-500">Pulling census data…</p>}

            {demoError && (
              <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-3">
                <p className="text-xs leading-relaxed text-amber-200">{demoError}</p>
                <button type="button" className="btn-secondary mt-3 w-full text-xs" onClick={() => void loadDemographics()}>
                  Try again
                </button>
              </div>
            )}

            {demographics && (
              <DemographicsPanel
                property={property}
                data={demographics}
                colorBy={colorBy}
                onColorBy={(key) => {
                  setColorBy(key)
                  onDemographics?.({ data: demographics, colorBy: key, radius })
                }}
                activeRadius={radius}
                onRadius={(miles) => {
                  setRadius(miles)
                  onDemographics?.({ data: demographics, colorBy, radius: miles })
                }}
              />
            )}
          </div>
        )}
      </div>
    </aside>
  )
}
