import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type {
  CompetitionResult,
  CustomField,
  Demographics,
  FlyerExtraction,
  Property,
  Stage,
} from '../types'
import { STAGE_META, count, fullAddress, displayName, money, rate, sqft } from '../lib/format'
import CompetitionPanel from './CompetitionPanel'
import CustomFields from './CustomFields'
import DemographicsPanel from './DemographicsPanel'
import { directionsUrl } from '../lib/directions'

/**
 * pdf.js is over a megabyte, and most sessions never open a flyer. Loading it
 * only when the flyer tab is first opened keeps that weight off the map, which
 * is the page everyone actually lands on.
 */
const FlyerViewer = lazy(() => import('./FlyerViewer'))
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
  /** Starts click-to-place for a site with no location yet. */
  onPlaceOnMap?: () => void
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
  onPlaceOnMap,
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
  const flyerInput = useRef<HTMLInputElement>(null)
  const [extracting, setExtracting] = useState(false)
  const [extraction, setExtraction] = useState<FlyerExtraction | null>(null)
  const [extractError, setExtractError] = useState<string | null>(null)
  const [clipping, setClipping] = useState(false)

  /**
   * Reads the attached flyer and fills this site in.
   *
   * Defaults to filling only what is empty; `overwrite` is offered afterwards
   * rather than up front, so a hand-corrected number is never lost to a
   * re-run the broker did not think of as destructive.
   */
  const readFlyer = async (overwrite: boolean) => {
    setExtracting(true)
    setExtractError(null)
    try {
      const { property: updated, extraction: result } = await api.extractFlyer(property.id, {
        overwrite,
      })
      onChange?.(updated)
      setFields(updated.fields ?? [])
      setExtraction(result)
    } catch (cause) {
      setExtractError(cause instanceof Error ? cause.message : 'That flyer could not be read.')
    } finally {
      setExtracting(false)
    }
  }

  useEffect(() => {
    setEditing(false)
    setDraft({})
    setFields(property.fields ?? [])
    setExtraction(null)
    setExtractError(null)
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

  const toggleHidden = async () => {
    const { property: updated } = await api.updateProperty(property.id, { hidden: !property.hidden })
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
          <h2 className="truncate text-sm font-semibold text-ink">{displayName(property)}</h2>
          <p className="truncate text-xs text-muted">{fullAddress(property)}</p>
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
              className="flex h-24 w-full items-center justify-center gap-2 border-b border-line bg-sunken text-xs text-muted hover:bg-sunken hover:text-body"
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

        <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
          {readOnly ? (
            <span className="pill" style={{ background: `${STAGE_META[property.stage]?.color}22`, color: STAGE_META[property.stage]?.color }}>
              {STAGE_META[property.stage]?.label}
            </span>
          ) : (
            <StageSelect stage={property.stage} onChange={(stage) => void setStage(stage)} />
          )}
          <div className="flex items-center gap-2">
            {property.lat != null && (
              <span className="font-mono text-[11px] text-faint">
                {property.lat.toFixed(4)}, {property.lng?.toFixed(4)}
              </span>
            )}
            {!readOnly && (
              <button
                type="button"
                className={`btn-ghost px-1.5 py-1 ${property.hidden ? 'text-amber-600' : 'text-faint hover:text-body'}`}
                onClick={() => void toggleHidden()}
                aria-pressed={Boolean(property.hidden)}
                title={
                  property.hidden
                    ? 'Hidden from the client link — click to show it'
                    : 'Shown on the client link — click to hide it'
                }
                aria-label={property.hidden ? 'Show this site to clients' : 'Hide this site from clients'}
              >
                {property.hidden ? (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                    <path d="m1 1 22 22" />
                  </svg>
                ) : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            )}
          </div>
        </div>

        {property.lat == null && !readOnly ? (
          <div className="border-b border-line bg-amber-500/10 px-4 py-3">
            <p className="text-[11px] leading-relaxed text-amber-700">
              This site has no location yet, so it cannot appear on the map or in a tour.
            </p>
            <button
              type="button"
              className="btn-primary mt-2 w-full text-xs"
              onClick={() => onPlaceOnMap?.()}
            >
              Place it on the map
            </button>
          </div>
        ) : null}

        {property.hidden && !readOnly ? (
          <p className="border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-[11px] leading-relaxed text-amber-700">
            Hidden from the client link. It stays on your map, dimmed, until you show it again.
          </p>
        ) : null}

        <nav className="flex gap-1 border-b border-line px-3 py-2" aria-label="Property sections">
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
                      <dt className="text-[10px] font-semibold uppercase tracking-wider text-muted">{stat.label}</dt>
                      <dd className="mt-0.5 truncate text-sm font-semibold text-ink" title={stat.value}>
                        {stat.value}
                      </dd>
                    </div>
                  ))}
                </dl>

                {directionsUrl(property) ? (
                  <a
                    className="btn-secondary mt-3 w-full justify-center text-xs"
                    href={directionsUrl(property) as string}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                      <path d="M3 11l19-9-9 19-2-8-8-2z" />
                    </svg>
                    Get directions
                  </a>
                ) : null}

                {property.fields?.length ? (
                  <dl className="mt-4 space-y-2 border-t border-line pt-3">
                    {property.fields.map((field, index) => (
                      <div key={`${field.label}-${index}`}>
                        <dt className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                          {field.label}
                        </dt>
                        <dd className="text-sm text-ink">{field.value || '—'}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}

                {property.listingBroker || property.brokerEmail || property.brokerPhone ? (
                  <div className="mt-4 border-t border-line pt-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Broker</p>
                    {property.listingBroker && (
                      <p className="mt-1 text-sm text-ink">{property.listingBroker}</p>
                    )}
                    <p className="text-xs text-muted">
                      {property.brokerEmail && (
                        <a className="hover:text-brand-deep" href={`mailto:${property.brokerEmail}`}>
                          {property.brokerEmail}
                        </a>
                      )}
                      {property.brokerEmail && property.brokerPhone ? ' · ' : ''}
                      {property.brokerPhone && (
                        <a className="hover:text-brand-deep" href={`tel:${property.brokerPhone}`}>
                          {property.brokerPhone}
                        </a>
                      )}
                    </p>
                  </div>
                ) : null}

                {property.notes && (
                  <p className="mt-3 whitespace-pre-wrap rounded-lg bg-sunken p-3 text-xs leading-relaxed text-body">
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
          <div className="flex min-h-0 flex-1 flex-col">
            {property.flyerUrl ? (
              <>
                <div className="flex items-center gap-2 border-b border-line px-3 py-2">
                  <a
                    className="truncate text-xs text-muted hover:text-brand-deep"
                    href={property.flyerUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {property.flyerName || 'Listing flyer'}
                  </a>
                  {!readOnly ? (
                    <>
                      <button
                        type="button"
                        className="btn-primary ml-auto px-2 py-1 text-xs"
                        disabled={extracting}
                        onClick={() => void readFlyer(false)}
                      >
                        {extracting ? 'Reading…' : 'Fill in from flyer'}
                      </button>
                      <button
                        type="button"
                        className="btn-secondary px-2 py-1 text-xs"
                        onClick={() => flyerInput.current?.click()}
                      >
                        Replace
                      </button>
                    </>
                  ) : null}
                </div>

                {extraction ? (
                  <div className="border-b border-line bg-sunken px-3 py-2 text-xs">
                    <p className="text-body">
                      Filled {extraction.filled.length} field
                      {extraction.filled.length === 1 ? '' : 's'}
                      {extraction.confidence ? ` · ${extraction.confidence} confidence` : ''}
                    </p>
                    {extraction.uncertainFields?.length ? (
                      <p className="mt-1 text-amber-400/90">
                        Worth checking: {extraction.uncertainFields.join(', ')}
                      </p>
                    ) : null}
                    {extraction.skipped.length ? (
                      <p className="mt-1 text-muted">
                        Left alone because they already had a value: {extraction.skipped.join(', ')}.{' '}
                        <button
                          type="button"
                          className="underline hover:text-body"
                          onClick={() => void readFlyer(true)}
                        >
                          Overwrite them
                        </button>
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {extractError ? (
                  <p className="border-b border-line bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                    {extractError}
                  </p>
                ) : null}
                <div className="p-4">
                  {/*
                    Clipping happens in a full-screen dialog rather than in this
                    column. A flyer page rendered into a 380px sidebar is too
                    small to see what you are cropping, let alone drag a box
                    around it accurately.
                  */}
                  <button
                    type="button"
                    className="btn-primary w-full"
                    onClick={() => setClipping(true)}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                      <path d="M6 2v14a2 2 0 002 2h14M18 22V8a2 2 0 00-2-2H2" />
                    </svg>
                    Clip photos from flyer
                  </button>

                  {property.images?.length ? (
                    <div className="mt-3">
                      <p className="label">Clipped photos ({property.images.length})</p>
                      <div className="mt-1 grid grid-cols-3 gap-2">
                        {property.images.slice(0, 6).map((image) => (
                          <img
                            key={image.id}
                            src={image.url}
                            alt={image.caption ?? ''}
                            className={`h-16 w-full rounded-md object-cover ${
                              property.coverImageId === image.id ? 'ring-2 ring-brand' : ''
                            }`}
                          />
                        ))}
                      </div>
                    </div>
                  ) : (
                    <p className="mt-3 text-xs text-muted">
                      No photos clipped yet. Open the flyer and drag a box around the building
                      shot, the site plan, or anything else the tour book should show.
                    </p>
                  )}
                </div>
              </>
            ) : (
              <div className="p-4">
                <p className="rounded-lg border border-dashed border-line p-6 text-center text-xs text-muted">
                  No flyer attached to this site.
                </p>
                {!readOnly ? (
                  <button
                    type="button"
                    className="btn-secondary mt-3 w-full text-xs"
                    onClick={() => flyerInput.current?.click()}
                  >
                    Attach a PDF flyer
                  </button>
                ) : null}
              </div>
            )}

            <input
              ref={flyerInput}
              type="file"
              accept="application/pdf,image/*"
              className="hidden"
              onChange={async (event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (!file) return
                const { property: updated } = await api.attachFlyer(property.id, file)
                onChange?.(updated)
              }}
            />
          </div>
        )}

        {clipping ? (
          <div
            className="fixed inset-0 z-50 flex flex-col bg-ink/70 p-4 sm:p-8"
            role="dialog"
            aria-modal="true"
            aria-label="Clip photos from the flyer"
            onKeyDown={(event) => {
              if (event.key === 'Escape') setClipping(false)
            }}
          >
            <div className="panel flex min-h-0 flex-1 flex-col overflow-hidden">
              <header className="flex items-center gap-3 border-b border-line px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">{displayName(property)}</p>
                  <p className="truncate text-xs text-muted">
                    Drag a box over the page to clip a photo for the tour book
                  </p>
                </div>
                <button
                  type="button"
                  className="btn-secondary ml-auto text-xs"
                  onClick={() => setClipping(false)}
                >
                  Done
                </button>
              </header>
              <div className="min-h-0 flex-1">
                <Suspense
                  fallback={<p className="p-4 text-xs text-muted">Loading the PDF viewer…</p>}
                >
                  <FlyerViewer property={property} onChange={onChange} />
                </Suspense>
              </div>
            </div>
          </div>
        ) : null}

        {tab === 'competition' && onCompetition && (
          <CompetitionPanel property={property} onResult={onCompetition} />
        )}

        {tab === 'demographics' && (
          <div className="p-4">
            {demoLoading && <p className="text-xs text-muted">Pulling census data…</p>}

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
