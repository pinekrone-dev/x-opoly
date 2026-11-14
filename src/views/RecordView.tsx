import { useCallback, useEffect, useRef, useState } from 'react'
import BrandMark from '../components/BrandMark'
import ConfirmDelete from '../components/ConfirmDelete'
import DealEconomics from '../components/DealEconomics'
import DealPicker, { stageWords } from '../components/DealPicker'
import SendPlaceToSurvey from '../components/SendPlaceToSurvey'
import { api } from '../api'
import { navigate } from '../lib/router'
import { useCanEdit } from '../lib/access'
import { OBJECTS, objectFor, subtitleOf, titleOf } from '../lib/crm'
import { countyCounts, describeMismatch, listingCounts, mismatches } from '../lib/listingCheck'
import type { PanelGroup } from '../components/ParcelPanel'
import type { DetailField } from '../lib/crm'
import type { ClientPin, CrmRecord, Deal, DealOn, DealParty, Place, RecordField, RecordType, Survey } from '../types'

/**
 * One CRM record, and everything attached to it.
 *
 * The profile is deliberately open: a handful of typed columns the app
 * understands, then whatever fields this broker decided matter. A deal adds
 * its parties — the people, companies and places it brings together.
 */
export default function RecordView({ recordType, id }: { recordType: RecordType; id: string }) {
  const spec = objectFor(recordType)
  const [record, setRecord] = useState<CrmRecord | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [fields, setFields] = useState<RecordField[]>([])
  // Bumped when this record is put on a deal or taken off one, so the list of
  // its deals below is read again.
  const [dealsVersion, setDealsVersion] = useState(0)

  const load = () =>
    api.crm
      .get(spec.segment, id)
      .then(({ record: found }) => {
        setRecord(found)
        setFields(found.fields ?? [])
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'That record could not be loaded.'))

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.segment, id])

  /*
   * Custom fields save on a short delay rather than per keystroke.
   *
   * Typing a twenty-character value used to send twenty requests, each
   * rewriting every field on the record. Now the latest list is held and
   * sent once typing pauses — and flushed at once when the input loses
   * focus, the window loses focus, a field is added or removed, or the view
   * unmounts, so nothing typed is ever lost to the delay.
   */
  const canEdit = useCanEdit()
  const pending = useRef<RecordField[] | null>(null)
  const timer = useRef<number | null>(null)

  const flush = useCallback(async () => {
    if (timer.current != null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
    const next = pending.current
    if (!next) return
    pending.current = null
    setSaving(true)
    try {
      const { record: updated } = await api.crm.update(spec.segment, id, {
        fields: next.filter((field) => field.label.trim()),
      })
      setRecord(updated)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That could not be saved.')
    } finally {
      setSaving(false)
    }
  }, [spec.segment, id])

  const saveFields = (next: RecordField[], { immediate = false } = {}) => {
    setFields(next)
    pending.current = next
    if (timer.current != null) window.clearTimeout(timer.current)
    if (immediate) {
      void flush()
      return
    }
    timer.current = window.setTimeout(() => void flush(), 500)
  }

  useEffect(() => {
    const onBlur = () => void flush()
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('blur', onBlur)
      // Leaving the page with an edit still pending sends it now.
      void flush()
    }
  }, [flush])

  /** One typed column, saved when the input loses focus. */
  const saveColumn = async (key: string, value: string, type?: string) => {
    setSaving(true)
    try {
      const trimmed = value.trim()
      const { record: updated } = await api.crm.update(spec.segment, id, {
        [key]: type === 'number' ? (trimmed === '' ? null : Number(trimmed)) : trimmed,
      })
      setRecord(updated)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  // A failure throws into ConfirmDelete, which says so where the button was.
  const remove = async () => {
    await api.crm.remove(spec.segment, id)
    navigate(`/${spec.segment}`)
  }

  if (error && !record) {
    return (
      <div className="grid min-h-full place-items-center bg-paper p-6">
        <div className="panel max-w-md p-8 text-center">
          <h1 className="text-lg font-semibold text-ink">Not found</h1>
          <p className="mt-2 text-sm text-muted">{error}</p>
          <button type="button" className="btn-primary mt-5 text-sm" onClick={() => navigate(`/${spec.segment}`)}>
            Back to {spec.label.toLowerCase()}
          </button>
        </div>
      </div>
    )
  }

  if (!record) return <div className="grid min-h-full place-items-center text-sm text-muted">Loading…</div>

  const deal = recordType === 'deal' ? (record as Deal) : null

  return (
    <div className="min-h-full bg-paper">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-5 py-3">
          <button type="button" onClick={() => navigate('/deals')} aria-label="Land Quotient home">
            <BrandMark />
          </button>
          <button type="button" className="btn-secondary text-xs" onClick={() => navigate(`/${spec.segment}`)}>
            Return to CRM
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-5 py-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="label">{spec.singular}</p>
            <h1 className="truncate text-xl font-semibold text-ink">{titleOf(recordType, record)}</h1>
            <p className="mt-0.5 text-sm text-muted">{subtitleOf(recordType, record) || '—'}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {deal ? <OpenSurvey deal={deal} canEdit={canEdit} onLinked={(updated) => setRecord(updated)} /> : null}
            {recordType === 'place' ? <SeeOnMap place={record as Place} /> : null}
            {recordType === 'place' && canEdit ? <SendPlaceToSurvey placeIds={[id]} /> : null}
            {recordType !== 'deal' && canEdit ? (
              // A deal can start here, with this record on it and nothing
              // else: the sites are added as they are found.
              <DealPicker
                key={`${recordType}:${id}`}
                kind={recordType}
                refId={id}
                defaultName={titleOf(recordType, record)}
                defaultRole={recordType === 'place' ? 'Candidate' : ''}
                openNewDeal
                onChanged={() => setDealsVersion((n) => n + 1)}
              />
            ) : null}
            {canEdit ? <ConfirmDelete what={`this ${spec.singular.toLowerCase()}`} onConfirm={remove} /> : null}
          </div>
        </div>

        {error ? (
          <p className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{error}</p>
        ) : null}

        {canEdit ? null : (
          <p className="mt-4 rounded-lg border border-line bg-sunken p-3 text-xs text-muted">
            View only. You can read and export this {spec.singular.toLowerCase()}; ask the workspace owner for edit access.
          </p>
        )}

        {recordType === 'place' ? <CountyCheck place={record as Place} fields={fields} /> : null}

        {deal ? <DealEconomics deal={deal} canEdit={canEdit} onSaved={(updated) => setRecord(updated)} /> : null}

        {deal ? <Parties deal={deal} canEdit={canEdit} onChanged={load} /> : null}

        {recordType === 'person' || recordType === 'company' ? <Opportunities kind={recordType} id={id} version={dealsVersion} canEdit={canEdit} /> : null}

        {recordType !== 'deal' ? <DealsOn recordType={recordType} id={id} version={dealsVersion} /> : null}

        {/* A disabled fieldset turns every input inside it read-only at once. */}
        <fieldset disabled={!canEdit} className="contents">
          <section className="panel mt-4 p-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="label">Details</p>
              {saving ? <span className="text-[11px] text-faint">Saving…</span> : null}
            </div>
            <Details record={record} spec={spec} onSave={saveColumn} />
          </section>

          <section className="panel mt-4 p-4">
            <p className="label mb-2">Custom fields</p>
            <CustomFields fields={fields} onChange={saveFields} onSettle={() => void flush()} />
          </section>
        </fieldset>
      </main>
    </div>
  )
}

const CATALOG = import.meta.env.VITE_PARCEL_CATALOG || '/catalog'

/**
 * A place saved from the map, against the county's own record of it.
 *
 * When the place's custom fields carry a unit or bedroom count ("Units",
 * "Beds") and the county publishes one, the two are compared and a
 * disagreement is said at the top of the record, where it is seen before an
 * offer rather than after. Places not linked to a parcel show nothing.
 */
function CountyCheck({ place, fields }: { place: Place; fields: RecordField[] }) {
  const [county, setCounty] = useState<{ panel: PanelGroup[]; record: Record<string, unknown> } | null>(null)
  const market = place.market ?? null
  const parcelId = place.parcelId ?? null
  useEffect(() => {
    if (!market || !parcelId) return undefined
    let cancelled = false
    Promise.all([
      fetch(`${CATALOG}/${market}/meta.json`).then((r) => (r.ok ? r.json() : null)),
      api.parcels.one(market, parcelId).then((res) => res.parcel).catch(() => null),
    ])
      .then(([meta, parcel]) => {
        if (!cancelled && meta && parcel) setCounty({ panel: meta.panel ?? [], record: parcel as Record<string, unknown> })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [market, parcelId])
  if (!county) return null
  const recorded = countyCounts(county.panel, county.record)
  if (recorded.units == null && recorded.bedrooms == null) return null
  const found = mismatches(listingCounts(fields), recorded)
  const said = [
    recorded.units != null ? `${recorded.units} ${recorded.units === 1 ? 'unit' : 'units'}` : null,
    recorded.bedrooms != null ? `${recorded.bedrooms} ${recorded.bedrooms === 1 ? 'bedroom' : 'bedrooms'}` : null,
  ]
    .filter(Boolean)
    .join(' and ')
  return found.length ? (
    <div role="alert" className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700">
      <p className="font-semibold">Doesn't match county records</p>
      {found.map((m) => (
        <p key={m.field}>{describeMismatch(m)}</p>
      ))}
      <p className="mt-1 opacity-80">Worth asking about before an offer: an unpermitted conversion, a combined lot, or a listing typo.</p>
    </div>
  ) : (
    <p className="mt-4 text-xs text-muted">
      County records {said}. Add a Units or Beds field below and it is checked against the county.
    </p>
  )
}

/**
 * Open, at the top of a deal: its survey's map, where the sites are worked.
 *
 * A deal names the survey it came from, and until this the link was stored
 * and never shown, so the map was three clicks away through another tab. A
 * deal with no survey yet picks one here, and the pick is the link.
 */
function OpenSurvey({
  deal,
  canEdit,
  onLinked,
}: {
  deal: Deal
  canEdit: boolean
  onLinked: (deal: CrmRecord) => void
}) {
  const [surveys, setSurveys] = useState<Survey[] | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => {
    if (deal.surveyId) return
    let cancelled = false
    api
      .listSurveys()
      .then(({ surveys: list }) => {
        if (!cancelled) setSurveys(list)
      })
      .catch(() => {
        if (!cancelled) setSurveys([])
      })
    return () => {
      cancelled = true
    }
  }, [deal.surveyId])

  if (deal.surveyId) {
    return (
      <button type="button" className="btn-primary text-xs" onClick={() => navigate(`/survey/${deal.surveyId}`)}>
        Open survey
      </button>
    )
  }
  if (!surveys?.length || !canEdit) return null
  return (
    <span className="inline-flex items-center gap-1.5">
      <select
        className="field h-8 w-auto py-0 text-xs"
        aria-label="Link a survey to this deal"
        value=""
        onChange={async (event) => {
          const surveyId = event.target.value
          if (!surveyId) return
          setFailed(null)
          try {
            const { record } = await api.crm.update('deals', deal.id, { surveyId })
            onLinked(record)
          } catch (cause) {
            setFailed(cause instanceof Error ? cause.message : 'That could not be linked.')
          }
        }}
      >
        <option value="">Link a survey to open…</option>
        {surveys.map((survey) => (
          <option key={survey.id} value={survey.id}>
            {survey.name}
          </option>
        ))}
      </select>
      {failed ? <span className="text-xs text-rose-700">{failed}</span> : null}
    </span>
  )
}

/**
 * The typed columns this object carries.
 *
 * Saved on blur rather than behind an edit/save mode: every field is already
 * an input, so a separate "edit" step would only add a click between the
 * broker and the change they came to make.
 */
function Details({
  record,
  spec,
  onSave,
}: {
  record: CrmRecord
  spec: { details: DetailField[] }
  onSave: (key: string, value: string, type?: string) => void
}) {
  const values = record as unknown as Record<string, unknown>
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {spec.details.map((field) => {
        const raw = values[field.key]
        const initial = raw == null ? '' : String(raw)
        return (
          <label key={field.key} className={field.type === 'textarea' ? 'sm:col-span-2' : ''}>
            <span className="mb-1 block text-xs text-muted">{field.label}</span>
            {field.type === 'textarea' ? (
              <textarea
                className="field min-h-[72px] text-sm"
                defaultValue={initial}
                placeholder={field.placeholder}
                onBlur={(event) => {
                  if (event.target.value !== initial) onSave(field.key, event.target.value)
                }}
              />
            ) : (
              <input
                className="field text-sm"
                type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
                defaultValue={initial}
                placeholder={field.placeholder}
                onBlur={(event) => {
                  if (event.target.value !== initial) onSave(field.key, event.target.value, field.type)
                }}
              />
            )}
          </label>
        )
      })}
    </div>
  )
}

/**
 * The custom profile.
 *
 * The whole list is sent on every change, so removing a field is simply a
 * field that stopped being sent — there is no second code path to keep in
 * step with the first.
 */
function CustomFields({
  fields,
  onChange,
  onSettle,
}: {
  fields: RecordField[]
  /** Every edit, as typed. `immediate` marks a discrete action to save now. */
  onChange: (next: RecordField[], options?: { immediate?: boolean }) => void
  /** The broker moved on from a field; whatever is pending should be sent. */
  onSettle?: () => void
}) {
  const [label, setLabel] = useState('')
  const [value, setValue] = useState('')

  const add = () => {
    if (!label.trim()) return
    onChange([...fields, { label: label.trim(), value: value.trim() || null }], { immediate: true })
    setLabel('')
    setValue('')
  }

  return (
    <>
      {fields.length > 0 ? (
        <dl className="mb-3 divide-y divide-line">
          {fields.map((field, index) => (
            <div key={field.id ?? `${field.label}-${index}`} className="flex items-center gap-3 py-2">
              <dt className="w-40 shrink-0 truncate text-xs text-muted">{field.label}</dt>
              <dd className="min-w-0 flex-1">
                <input
                  className="field text-sm"
                  value={field.value ?? ''}
                  aria-label={field.label}
                  onChange={(event) => {
                    const next = [...fields]
                    next[index] = { ...field, value: event.target.value }
                    onChange(next)
                  }}
                  onBlur={() => onSettle?.()}
                />
              </dd>
              <button
                type="button"
                className="btn-ghost px-1.5 py-1 text-faint hover:text-rose-600"
                aria-label={`Remove ${field.label}`}
                onClick={() => onChange(fields.filter((_, at) => at !== index), { immediate: true })}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mb-3 text-sm text-muted">
          Nothing recorded yet. Add whatever matters for this one — drive-thru, exclusivity, tenant credit.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <input
          className="field w-40"
          placeholder="Field name"
          aria-label="New field name"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
        <input
          className="field min-w-0 flex-1"
          placeholder="Value"
          aria-label="New field value"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') add()
          }}
        />
        <button type="button" className="btn-secondary text-xs" disabled={!label.trim()} onClick={add}>
          Add field
        </button>
      </div>
    </>
  )
}

/**
 * The deals this person, company or place is on.
 *
 * A deal's page lists who and what is on it; this is the same thing read
 * from the other end. It is what makes a deal that is only a contact so far
 * findable from the contact, and it says nothing at all when there are none.
 */
function DealsOn({ recordType, id, version }: { recordType: RecordType; id: string; version: number }) {
  const [deals, setDeals] = useState<DealOn[] | null>(null)

  useEffect(() => {
    let cancelled = false
    api.crm
      .dealsOf(objectFor(recordType).segment, id)
      .then(({ deals: found }) => !cancelled && setDeals(found))
      .catch(() => !cancelled && setDeals([]))
    return () => {
      cancelled = true
    }
  }, [recordType, id, version])

  if (!deals?.length) return null

  return (
    <section className="panel mt-4 p-4">
      <p className="label mb-2">Deals</p>
      <ul className="divide-y divide-line">
        {deals.map((deal) => (
          <li key={deal.id} className="flex items-center gap-3 py-2">
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left text-sm text-ink hover:text-brand-deep"
              onClick={() => navigate(`/deals/${deal.id}`)}
            >
              {deal.name}
            </button>
            {deal.partyRole ? <span className="shrink-0 text-xs text-muted">{deal.partyRole}</span> : null}
            <span className="shrink-0 rounded-full bg-sunken px-2 py-0.5 text-[11px] capitalize text-body">
              {stageWords(deal.stage)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/*
 * From a parcel's record to the parcel itself: the map, on its county, with
 * the lot open. A record that is not tied to a county's parcel but has a
 * location opens the map there instead.
 */
function SeeOnMap({ place }: { place: Place }) {
  const lat = Number(place.lat)
  const lng = Number(place.lng)
  const tied = place.market && place.parcelId
  if (!tied && !(Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0))) return null
  return (
    <button
      type="button"
      className="btn-secondary text-xs"
      data-testid="see-on-map"
      onClick={() =>
        navigate(tied ? `/gis/${place.market}?parcel=${encodeURIComponent(String(place.parcelId))}` : `/gis#17/${lat}/${lng}`)
      }
    >
      See it on the map
    </button>
  )
}

/*
 * A client's opportunities: every place pinned for them, which is every
 * place on one of their open deals. Pinned from the map, one parcel at a
 * time; listed here with the deal each sits on, and opened on the map as a
 * set.
 */
function Opportunities({ kind, id, version, canEdit }: { kind: 'person' | 'company'; id: string; version: number; canEdit: boolean }) {
  const [pins, setPins] = useState<ClientPin[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const key = `${kind}:${id}`

  const load = useCallback(() => {
    api.crm
      .pins({ client: key })
      .then(({ pins: found }) => setPins(found))
      .catch(() => setPins([]))
  }, [key])
  useEffect(() => { load() }, [load, version])

  if (pins === null) return null
  const markets = [...new Set(pins.map((p) => p.market).filter(Boolean))] as string[]

  return (
    <section className="panel mt-4 p-4" data-testid="opportunities">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="label">Opportunities{pins.length ? ` (${pins.length})` : ''}</p>
        {markets.map((market) => (
          <button key={market} type="button" className="btn-secondary text-xs" onClick={() => navigate(`/gis/${market}?client=${encodeURIComponent(key)}`)}>
            {markets.length > 1 ? `Map: ${market}` : 'Open on the map'}
          </button>
        ))}
      </div>
      {pins.length === 0 ? (
        <p className="text-sm text-muted">
          Nothing pinned yet. On the map, open a parcel and choose “Pin for client” to add it here.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {pins.map((pin) => {
            const mine = pin.clients.find((c) => `${c.kind}:${c.id}` === key)
            return (
              <li key={pin.id} className="flex items-center gap-3 py-2">
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => navigate(`/places/${pin.id}`)}>
                  <span className="block truncate text-sm text-ink hover:text-brand-deep">{pin.name || pin.address || 'Place'}</span>
                  <span className="block truncate text-xs text-muted">
                    {[pin.address && pin.name ? pin.address : null, [pin.city, pin.state].filter(Boolean).join(', ') || null, pin.acreage ? `${Number(pin.acreage).toFixed(2)} ac` : null].filter(Boolean).join(' · ')}
                  </span>
                </button>
                {mine ? (
                  <button type="button" className="shrink-0 truncate text-xs text-muted hover:text-brand-deep" onClick={() => navigate(`/deals/${mine.deal.id}`)} title={mine.deal.name}>
                    <span className="rounded-full bg-sunken px-2 py-0.5 text-[11px] capitalize text-body">{stageWords(mine.deal.stage)}</span>
                  </button>
                ) : null}
                {canEdit ? (
                  <button
                    type="button"
                    className="shrink-0 text-xs text-muted hover:text-rose-600"
                    disabled={busy !== null}
                    onClick={async () => {
                      setBusy(pin.id)
                      try {
                        await api.crm.unpin({ kind, id }, pin.id)
                        load()
                      } finally {
                        setBusy(null)
                      }
                    }}
                  >
                    {busy === pin.id ? 'Removing…' : 'Unpin'}
                  </button>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/** The parties on a deal: who and what it brings together, each in a role. */
function Parties({ deal, canEdit, onChanged }: { deal: Deal; canEdit: boolean; onChanged: () => void }) {
  const [adding, setAdding] = useState(false)
  const [kind, setKind] = useState<'person' | 'company' | 'place'>('person')
  const [options, setOptions] = useState<CrmRecord[]>([])
  const [refId, setRefId] = useState('')
  const [role, setRole] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!adding) return
    const spec = objectFor(kind)
    api.crm
      .list(spec.segment)
      .then(({ records }) => {
        setOptions(records)
        setRefId(records.length ? (records[0] as { id: string }).id : '')
      })
      .catch(() => setOptions([]))
  }, [adding, kind])

  const add = async () => {
    if (!refId) return
    setBusy(true)
    try {
      await api.crm.addParty(deal.id, { kind, refId, role: role.trim() || undefined })
      setAdding(false)
      setRole('')
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  const drop = async (party: DealParty) => {
    await api.crm.removeParty(deal.id, party.id).catch(() => undefined)
    onChanged()
  }

  const parties = deal.parties ?? []

  return (
    <section className="panel mt-4 p-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="label">Parties</p>
        {canEdit ? (
          <button type="button" className="btn-secondary text-xs" onClick={() => setAdding((open) => !open)}>
            Add party
          </button>
        ) : null}
      </div>

      {parties.length === 0 ? (
        <p className="text-sm text-muted">
          Nobody yet. A deal is people, companies and places together — add the tenant, the decision maker, the sites.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {parties.map((party) => {
            const spec = objectFor(party.kind)
            return (
              <li key={party.id} className="flex items-center gap-3 py-2">
                <span className="w-16 shrink-0 text-[11px] uppercase tracking-wide text-faint">{spec.singular}</span>
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left text-sm text-ink hover:text-brand-deep"
                  onClick={() => navigate(`/${spec.segment}/${party.record.id}`)}
                >
                  {titleOf(party.kind, party.record)}
                </button>
                {party.role ? <span className="shrink-0 text-xs text-muted">{party.role}</span> : null}
                {canEdit ? <button
                  type="button"
                  className="btn-ghost px-1.5 py-1 text-faint hover:text-rose-600"
                  aria-label={`Remove ${titleOf(party.kind, party.record)}`}
                  onClick={() => void drop(party)}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button> : null}
              </li>
            )
          })}
        </ul>
      )}

      {adding ? (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
          <select
            className="field w-32"
            aria-label="Kind of party"
            value={kind}
            onChange={(event) => setKind(event.target.value as 'person' | 'company' | 'place')}
          >
            {OBJECTS.filter((object) => object.type !== 'deal').map((object) => (
              <option key={object.type} value={object.type}>
                {object.singular}
              </option>
            ))}
          </select>
          <select
            className="field min-w-0 flex-1"
            aria-label="Which record"
            value={refId}
            onChange={(event) => setRefId(event.target.value)}
          >
            {options.length === 0 ? <option value="">None yet — create one first</option> : null}
            {options.map((option) => (
              <option key={(option as { id: string }).id} value={(option as { id: string }).id}>
                {titleOf(kind, option)}
              </option>
            ))}
          </select>
          <input
            className="field w-40"
            placeholder="Role"
            aria-label="Role on this deal"
            value={role}
            onChange={(event) => setRole(event.target.value)}
          />
          <button
            type="button"
            className="btn-primary text-xs"
            // Distinct from "Add party", which opens this row: two controls
            // both reading "Add" is ambiguous to a screen reader as well as
            // to a test.
            aria-label="Add this party to the deal"
            disabled={busy || !refId}
            onClick={() => void add()}
          >
            {busy ? 'Adding…' : 'Add'}
          </button>
        </div>
      ) : null}
    </section>
  )
}
