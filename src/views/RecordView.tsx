import { useCallback, useEffect, useRef, useState } from 'react'
import BrandMark from '../components/BrandMark'
import SendPlaceToSurvey from '../components/SendPlaceToSurvey'
import { api } from '../api'
import { navigate } from '../lib/router'
import { OBJECTS, objectFor, subtitleOf, titleOf } from '../lib/crm'
import type { DetailField } from '../lib/crm'
import type { CrmRecord, Deal, DealParty, RecordField, RecordType } from '../types'

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

  const remove = async () => {
    if (!window.confirm(`Delete this ${spec.singular.toLowerCase()}? This cannot be undone.`)) return
    await api.crm.remove(spec.segment, id).catch(() => undefined)
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
            All {spec.label.toLowerCase()}
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
          <div className="flex gap-2">
            {recordType === 'place' ? <SendPlaceToSurvey placeId={id} /> : null}
            <button type="button" className="btn-secondary text-xs" onClick={() => void remove()}>
              Delete
            </button>
          </div>
        </div>

        {error ? (
          <p className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{error}</p>
        ) : null}

        {deal ? <Parties deal={deal} onChanged={load} /> : null}

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
      </main>
    </div>
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

/** The parties on a deal: who and what it brings together, each in a role. */
function Parties({ deal, onChanged }: { deal: Deal; onChanged: () => void }) {
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
        <button type="button" className="btn-secondary text-xs" onClick={() => setAdding((open) => !open)}>
          Add party
        </button>
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
                <button
                  type="button"
                  className="btn-ghost px-1.5 py-1 text-faint hover:text-rose-600"
                  aria-label={`Remove ${titleOf(party.kind, party.record)}`}
                  onClick={() => void drop(party)}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
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
