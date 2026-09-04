import { useEffect, useMemo, useState } from 'react'
import SurveyList from './SurveyList'
import { api } from '../api'
import SendPlaceToSurvey from '../components/SendPlaceToSurvey'
import WorkspaceNav, { navSection } from '../components/WorkspaceNav'
import { navigate } from '../lib/router'
import { OBJECTS, objectFor, objectForSegment, subtitleOf, titleOf } from '../lib/crm'
import type { Account, BillingStatus, CrmRecord, RecordType } from '../types'

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
  const [surveyCount, setSurveyCount] = useState(0)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  /*
   * The search at the top looks across everything the team keeps, not
   * only the tab that happens to be open: "find this contact" is the
   * question, and which list they are filed under is not. Its answer is a
   * table, one row per record, typed.
   */
  const [search, setSearch] = useState('')
  const [hits, setHits] = useState<Hit[] | null>(null)
  const [searching, setSearching] = useState(false)

  /*
   * New person and New place stand at the top of every CRM tab, because
   * those two are made in the middle of other work: a card handed over, a
   * building driven past. A deal or a company is made from its own list.
   */
  const [creating, setCreating] = useState<RecordType | null>(null)
  const createSpec = creating ? objectFor(creating) : null

  /*
   * Places can be checked and sent into a survey together: the inverse of
   * the survey's own "From CRM" tab. Selection is a mode, so an ordinary
   * click still opens the record; the checks clear when the tab changes.
   */
  const [selecting, setSelecting] = useState(false)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  useEffect(() => {
    setSelecting(false)
    setChecked(new Set())
    setCreating(null)
    setDraft({})
  }, [tab])
  const toggleChecked = (id: string) =>
    setChecked((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // Counts on the tabs, so an empty workspace still says what lives where.
  // One request: this used to download all four lists, and every survey,
  // on every tab change just to count them.
  useEffect(() => {
    let cancelled = false
    api.crm
      .counts()
      .then(({ counts: found, surveys }) => {
        if (cancelled) return
        setCounts(Object.fromEntries(OBJECTS.map((object) => [object.segment, found[object.segment] ?? 0])))
        setSurveyCount(surveys)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [tab])

  // The tab's own list, for browsing.
  useEffect(() => {
    if (!spec) {
      setLoading(false)
      return undefined
    }
    let cancelled = false
    setLoading(true)
    api.crm
      .list(spec.segment)
      .then(({ records: list }) => {
        if (!cancelled) setRecords(list)
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not load these records.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [spec?.segment])

  // The search, across every kind. A short pause on typing: one request
  // per name, not per keystroke.
  useEffect(() => {
    const needle = search.trim()
    if (!needle) {
      setHits(null)
      setSearching(false)
      return undefined
    }
    let cancelled = false
    setSearching(true)
    const timer = setTimeout(() => {
      api.crm
        .search(needle)
        .then((found) => {
          if (cancelled) return
          setHits([
            ...found.people.map((record) => ({ type: 'person' as const, record })),
            ...found.companies.map((record) => ({ type: 'company' as const, record })),
            ...found.places.map((record) => ({ type: 'place' as const, record })),
            ...found.deals.map((record) => ({ type: 'deal' as const, record })),
          ])
        })
        .catch((cause) => {
          if (!cancelled) setError(cause instanceof Error ? cause.message : 'The search failed.')
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, 220)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [search])

  const create = async () => {
    if (!createSpec) return
    setBusy(true)
    setError(null)
    try {
      const payload: Record<string, unknown> = {}
      for (const field of createSpec.create) {
        const value = (draft[field.key] ?? '').trim()
        if (!value) continue
        payload[field.key] = field.type === 'number' ? Number(value) : value
      }
      const { record } = await api.crm.create(createSpec.segment, payload)
      setCreating(null)
      setDraft({})
      navigate(`/${createSpec.segment}/${(record as { id: string }).id}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That could not be created.')
    } finally {
      setBusy(false)
    }
  }

  const startCreating = (type: RecordType) => {
    setDraft({})
    setCreating((current) => (current === type ? null : type))
  }

  const ownButton = spec && spec.type !== 'person' && spec.type !== 'place' ? spec : null

  return (
    <div className="min-h-full bg-paper">
      <WorkspaceNav
        current={navSection(tab)}
        counts={counts}
        surveyCount={surveyCount}
        account={account}
        smsConfigured={smsConfigured}
        billing={billing}
        onAccountChange={onAccountChange}
        onSignedOut={onSignedOut}
      />

      <main className="mx-auto max-w-6xl px-5 py-6">
        {tab === 'surveys' ? (
          <SurveyList account={account} smsConfigured={smsConfigured} billing={billing} embedded />
        ) : spec ? (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <input
                className="field max-w-sm flex-1"
                type="search"
                placeholder="Search people, companies, places and deals"
                aria-label="Search the CRM"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <button type="button" className="btn-primary text-sm" onClick={() => startCreating('person')}>
                New person
              </button>
              <button type="button" className="btn-primary text-sm" onClick={() => startCreating('place')}>
                New place
              </button>
              {ownButton ? (
                <button type="button" className="btn-secondary text-sm" onClick={() => startCreating(ownButton.type)}>
                  New {ownButton.singular.toLowerCase()}
                </button>
              ) : null}
              {spec.type === 'place' && records.length > 0 && !search ? (
                <div className="ml-auto flex items-center gap-2">
                  {selecting ? (
                    <>
                      <span className="text-xs text-muted">
                        {checked.size === 0 ? 'Check the buildings to send' : `${checked.size} checked`}
                      </span>
                      <button
                        type="button"
                        className="btn-ghost text-xs"
                        onClick={() =>
                          setChecked((current) =>
                            current.size === records.length
                              ? new Set()
                              : new Set(records.map((record) => (record as { id: string }).id)),
                          )
                        }
                      >
                        {checked.size === records.length ? 'Clear' : 'All'}
                      </button>
                      <SendPlaceToSurvey placeIds={[...checked]} onSent={() => setChecked(new Set())} />
                      <button
                        type="button"
                        className="btn-secondary text-xs"
                        onClick={() => {
                          setSelecting(false)
                          setChecked(new Set())
                        }}
                      >
                        Done
                      </button>
                    </>
                  ) : (
                    <button type="button" className="btn-secondary text-sm" onClick={() => setSelecting(true)}>
                      Send to survey
                    </button>
                  )}
                </div>
              ) : null}
            </div>

            {createSpec ? (
              <div className="panel mb-4 p-4">
                <p className="label mb-2">New {createSpec.singular.toLowerCase()}</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {createSpec.create.map((field) => (
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
                    {busy ? 'Saving…' : `Create ${createSpec.singular.toLowerCase()}`}
                  </button>
                  <button type="button" className="btn-secondary text-sm" onClick={() => setCreating(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}

            {error ? (
              <p className="mb-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{error}</p>
            ) : null}

            {search.trim() ? (
              <SearchTable hits={hits} searching={searching} needle={search.trim()} />
            ) : loading ? (
              <p className="py-10 text-center text-sm text-muted">Loading…</p>
            ) : records.length === 0 ? (
              <div className="panel p-10 text-center">
                <p className="text-sm font-semibold text-ink">No {spec.label.toLowerCase()} yet</p>
                <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted">{spec.empty}</p>
              </div>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {records.map((record) => {
                  const id = (record as { id: string }).id
                  const subtitle = subtitleOf(spec.type, record)
                  const isChecked = selecting && checked.has(id)
                  return (
                    <li key={id}>
                      <button
                        type="button"
                        className={`panel w-full p-4 text-left hover:border-brand/40 hover:shadow-sm ${
                          isChecked ? 'border-brand bg-brand/5' : ''
                        }`}
                        aria-pressed={selecting ? isChecked : undefined}
                        onClick={() => (selecting ? toggleChecked(id) : navigate(`/${spec.segment}/${id}`))}
                      >
                        <p className="flex items-center gap-2 truncate text-sm font-semibold text-ink">
                          {selecting ? (
                            <input type="checkbox" readOnly tabIndex={-1} checked={isChecked} aria-hidden className="pointer-events-none" />
                          ) : null}
                          <span className="truncate">{titleOf(spec.type, record)}</span>
                        </p>
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

interface Hit {
  type: RecordType
  record: CrmRecord
}

/**
 * The search's answer: every matching record of every kind, one row each,
 * typed so a person and a company of the same name are told apart. A row
 * opens the record.
 */
function SearchTable({ hits, searching, needle }: { hits: Hit[] | null; searching: boolean; needle: string }) {
  const rows = useMemo(() => hits ?? [], [hits])

  if (searching && hits === null) return <p className="py-10 text-center text-sm text-muted">Searching…</p>
  if (rows.length === 0) {
    return (
      <div className="panel p-10 text-center">
        <p className="text-sm font-semibold text-ink">Nothing matches “{needle}”</p>
        <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted">Try a shorter search, or a different spelling.</p>
      </div>
    )
  }

  return (
    <div className="panel overflow-x-auto">
      <table className="w-full text-left text-sm" aria-label="Search results">
        <thead>
          <tr className="border-b border-line text-[11px] uppercase tracking-wide text-faint">
            <th className="px-4 py-2 font-medium">Type</th>
            <th className="px-4 py-2 font-medium">Name</th>
            <th className="px-4 py-2 font-medium">Details</th>
            <th className="px-4 py-2 font-medium">Profile</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ type, record }) => {
            const object = objectFor(type)
            const id = (record as { id: string }).id
            return (
              <tr
                key={`${type}-${id}`}
                className="cursor-pointer border-b border-line last:border-0 hover:bg-sunken"
                onClick={() => navigate(`/${object.segment}/${id}`)}
              >
                <td className="whitespace-nowrap px-4 py-2 text-xs text-muted">{object.singular}</td>
                <td className="px-4 py-2 font-semibold text-ink">{titleOf(type, record)}</td>
                <td className="px-4 py-2 text-xs text-muted">{subtitleOf(type, record) || '—'}</td>
                <td className="px-4 py-2 text-[11px] text-faint">
                  {record.fields?.length ? record.fields.map((field) => `${field.label}: ${field.value ?? '—'}`).join(' · ') : ''}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="px-4 py-2 text-[11px] text-faint">Up to eight of each kind. Narrow the search to see the rest.</p>
    </div>
  )
}
