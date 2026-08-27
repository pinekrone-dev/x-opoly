import { useEffect, useMemo, useState } from 'react'
import AccountMenu from '../components/AccountMenu'
import SurveyList from './SurveyList'
import BrandMark from '../components/BrandMark'
import { api } from '../api'
import { navigate } from '../lib/router'
import { OBJECTS, objectForSegment, subtitleOf, titleOf } from '../lib/crm'
import type { Account, BillingStatus, CrmRecord, Survey } from '../types'

/**
 * The workspace home.
 *
 * A survey is one deal's map — it gets shared, worked, and eventually
 * archived. The relationships and buildings behind it are not disposable in
 * that way, so they are what greets the broker: deals, people, companies,
 * places, and the surveys they produced.
 */
export default function Home({
  account,
  smsConfigured,
  billing,
  tab,
  onAccountChange,
  onSignedOut,
}: {
  account?: Account | null
  smsConfigured?: boolean
  billing?: BillingStatus | null
  tab: string
  onAccountChange?: (account: Account) => void
  onSignedOut?: () => void
}) {
  const spec = objectForSegment(tab)
  const [records, setRecords] = useState<CrmRecord[]>([])
  const [surveys, setSurveys] = useState<Survey[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  // Counts on the tabs, so an empty workspace still says what lives where.
  useEffect(() => {
    let cancelled = false
    Promise.all(
      OBJECTS.map((object) =>
        api.crm
          .list(object.segment)
          .then(({ records: list }) => [object.segment, list.length] as const)
          .catch(() => [object.segment, 0] as const),
      ),
    )
      .then((pairs) => {
        if (!cancelled) setCounts(Object.fromEntries(pairs))
      })
      .catch(() => undefined)
    api
      .listSurveys()
      .then(({ surveys: list }) => {
        if (!cancelled) setSurveys(list)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [tab])

  useEffect(() => {
    if (!spec) {
      setLoading(false)
      return undefined
    }
    let cancelled = false
    setLoading(true)
    // A short debounce: typing a name should not fire a request per keystroke.
    const timer = setTimeout(() => {
      api.crm
        .list(spec.segment, search)
        .then(({ records: list }) => {
          if (!cancelled) setRecords(list)
        })
        .catch((cause) => {
          if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not load these records.')
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }, search ? 220 : 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [spec?.segment, search])

  const create = async () => {
    if (!spec) return
    setBusy(true)
    setError(null)
    try {
      const payload: Record<string, unknown> = {}
      for (const field of spec.create) {
        const value = (draft[field.key] ?? '').trim()
        if (!value) continue
        payload[field.key] = field.type === 'number' ? Number(value) : value
      }
      const { record } = await api.crm.create(spec.segment, payload)
      setCreating(false)
      setDraft({})
      navigate(`/${spec.segment}/${(record as { id: string }).id}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That could not be created.')
    } finally {
      setBusy(false)
    }
  }

  /*
   * GIS leads, because it is where work starts: a broker finds the parcel
   * before there is a deal, a company or a contact to file it under. It is a
   * destination rather than a list, so it carries no count and navigates out
   * of this view entirely.
   */
  const tabs = useMemo(
    () => [
      { segment: 'gis', label: 'GIS' },
      ...OBJECTS.map((object) => ({ segment: object.segment, label: object.label })),
      { segment: 'surveys', label: 'Surveys' },
    ],
    [],
  )

  return (
    <div className="min-h-full bg-paper">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-3">
          <button type="button" onClick={() => navigate('/deals')} aria-label="Land Quotient home">
            <BrandMark />
          </button>
          {account ? (
            <AccountMenu
              account={account}
              smsConfigured={Boolean(smsConfigured)}
              billing={billing}
              onChange={(next) => onAccountChange?.(next)}
              onSignedOut={() => onSignedOut?.()}
            />
          ) : null}
        </div>

        <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-5" aria-label="Workspace">
          {tabs.map((entry) => (
            <button
              key={entry.segment}
              type="button"
              className={`shrink-0 border-b-2 px-3 py-2 text-sm ${
                tab === entry.segment
                  ? 'border-brand font-semibold text-ink'
                  : 'border-transparent text-muted hover:text-body'
              }`}
              aria-current={tab === entry.segment ? 'page' : undefined}
              onClick={() => navigate(`/${entry.segment}`)}
            >
              {entry.label}
              {entry.segment !== 'gis' && (
                <span className="ml-1.5 text-xs text-faint">
                  {entry.segment === 'surveys' ? surveys.length : counts[entry.segment] ?? ''}
                </span>
              )}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-5 py-6">
        {tab === 'surveys' ? (
          <SurveyList account={account} smsConfigured={smsConfigured} billing={billing} embedded />
        ) : spec ? (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <input
                className="field max-w-xs flex-1"
                type="search"
                placeholder={`Search ${spec.label.toLowerCase()}`}
                aria-label={`Search ${spec.label.toLowerCase()}`}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <button type="button" className="btn-primary text-sm" onClick={() => setCreating((open) => !open)}>
                New {spec.singular.toLowerCase()}
              </button>
            </div>

            {creating ? (
              <div className="panel mb-4 p-4">
                <p className="label mb-2">New {spec.singular.toLowerCase()}</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {spec.create.map((field) => (
                    <label key={field.key} className="block">
                      <span className="mb-1 block text-xs text-muted">{field.label}</span>
                      <input
                        className="field"
                        type={field.type === 'number' ? 'number' : 'text'}
                        placeholder={field.placeholder}
                        value={draft[field.key] ?? ''}
                        onChange={(event) => setDraft((current) => ({ ...current, [field.key]: event.target.value }))}
                      />
                    </label>
                  ))}
                </div>
                <div className="mt-3 flex gap-2">
                  <button type="button" className="btn-primary text-sm" disabled={busy} onClick={() => void create()}>
                    {busy ? 'Saving…' : `Create ${spec.singular.toLowerCase()}`}
                  </button>
                  <button type="button" className="btn-secondary text-sm" onClick={() => setCreating(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}

            {error ? (
              <p className="mb-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{error}</p>
            ) : null}

            {loading ? (
              <p className="py-10 text-center text-sm text-muted">Loading…</p>
            ) : records.length === 0 ? (
              <div className="panel p-10 text-center">
                <p className="text-sm font-semibold text-ink">
                  {search ? `Nothing matches “${search}”` : `No ${spec.label.toLowerCase()} yet`}
                </p>
                <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted">{search ? 'Try a shorter search.' : spec.empty}</p>
              </div>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {records.map((record) => {
                  const id = (record as { id: string }).id
                  const subtitle = subtitleOf(spec.type, record)
                  return (
                    <li key={id}>
                      <button
                        type="button"
                        className="panel w-full p-4 text-left hover:border-brand/40 hover:shadow-sm"
                        onClick={() => navigate(`/${spec.segment}/${id}`)}
                      >
                        <p className="truncate text-sm font-semibold text-ink">{titleOf(spec.type, record)}</p>
                        {subtitle ? <p className="mt-0.5 truncate text-xs text-muted">{subtitle}</p> : null}
                        {record.fields?.length ? (
                          <p className="mt-2 truncate text-[11px] text-faint">
                            {record.fields.map((field) => `${field.label}: ${field.value ?? '—'}`).join(' · ')}
                          </p>
                        ) : null}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </>
        ) : null}
      </main>
    </div>
  )
}
