import { useEffect, useMemo, useState } from 'react'
import SurveyList from './SurveyList'
import { api } from '../api'
import SendPlaceToSurvey from '../components/SendPlaceToSurvey'
import WorkspaceNav, { navSection } from '../components/WorkspaceNav'
import { navigate } from '../lib/router'
import { OBJECTS, objectFor, objectForSegment, subtitleOf, titleOf } from '../lib/crm'
import type { DetailField, ObjectSpec } from '../lib/crm'
import type { Account, BillingStatus, CrmRecord, RecordType } from '../types'

/**
 * The workspace home.
 *
 * A survey is one deal's map — it gets shared, worked, and eventually
 * archived. The relationships and buildings behind it are not disposable in
 * that way, so they are what greets the broker: deals, people, companies,
 * places, and the surveys they produced. Each is a table, every column a
 * filter, because a CRM is read by narrowing it.
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
  const [truncated, setTruncated] = useState(false)
  const [surveyCount, setSurveyCount] = useState(0)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  // Bumped after a save so the list and the tab counts read again.
  const [refresh, setRefresh] = useState(0)

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
    setNotice(null)
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
  }, [tab, refresh])

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
      .then(({ records: list, truncated: more }) => {
        if (cancelled) return
        setRecords(list)
        setTruncated(more)
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
  }, [spec?.segment, refresh])

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

  /*
   * Saving a new record.
   *
   * "Save" opens what was made, because the next thing is usually to fill
   * in the rest of it. "Save and add another" keeps the form: a stack of
   * business cards is entered one after the other, and the list behind the
   * form grows as each lands. "Return to CRM" closes the form without
   * saving whatever is in it.
   */
  const create = async (then: 'open' | 'another') => {
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
      const made = record as CrmRecord & { id: string }
      if (then === 'open') {
        setCreating(null)
        setDraft({})
        navigate(`/${createSpec.segment}/${made.id}`)
        return
      }
      setDraft({})
      setNotice(`Saved ${createSpec.singular.toLowerCase()} ${titleOf(createSpec.type, made)}.`)
      setRefresh((n) => n + 1)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  const startCreating = (type: RecordType) => {
    setDraft({})
    setNotice(null)
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

      <main className="mx-auto max-w-7xl px-5 py-6">
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
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {createSpec.create.map((field) => (
                    <label key={field.key} className="block">
                      <span className="mb-1 block text-xs text-muted">{field.label}</span>
                      <input
                        className="field"
                        type={field.type === 'number' ? 'number' : 'text'}
                        placeholder={field.placeholder}
                        value={draft[field.key] ?? ''}
                        onChange={(event) => setDraft((current) => ({ ...current, [field.key]: event.target.value }))}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && !busy) void create('open')
                        }}
                      />
                    </label>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button type="button" className="btn-primary text-sm" disabled={busy} onClick={() => void create('open')}>
                    {busy ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary text-sm"
                    disabled={busy}
                    onClick={() => void create('another')}
                  >
                    Save and add another
                  </button>
                  <button
                    type="button"
                    className="btn-ghost text-sm"
                    onClick={() => {
                      setCreating(null)
                      setDraft({})
                    }}
                  >
                    Return to CRM
                  </button>
                  {notice ? <span className="text-xs text-muted">{notice}</span> : null}
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
              <RecordTable
                spec={spec}
                records={records}
                truncated={truncated}
                selecting={selecting}
                checked={checked}
                onToggle={toggleChecked}
              />
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

/** A column's filter: text the cell must contain, case aside. */
const matches = (cell: string, needle: string) => !needle || cell.toLowerCase().includes(needle.toLowerCase())

/** What a cell shows: numbers with their thousands, dates as dates, else the text. */
function cellText(record: CrmRecord, field: DetailField): string {
  const raw = (record as unknown as Record<string, unknown>)[field.key]
  if (raw == null || raw === '') return ''
  if (field.type === 'number' && typeof raw === 'number') return raw.toLocaleString()
  if (field.type === 'date' && typeof raw === 'string') {
    const day = new Date(raw)
    return Number.isNaN(day.getTime()) ? raw : day.toLocaleDateString()
  }
  return String(raw)
}

/** The custom profile on one line, for a column and for a filter. */
const profileText = (record: CrmRecord) =>
  record.fields?.length ? record.fields.map((field) => `${field.label}: ${field.value ?? '—'}`).join(' · ') : ''

/**
 * One kind of record, every column a filter.
 *
 * The typed columns the profile edits are the columns here, notes aside;
 * the custom fields sit in one last column so a field only this broker
 * keeps is still something to filter on. The filters narrow what is
 * loaded, which is the whole list up to the server's page, so the
 * narrowing costs nothing and the count above the table says what it
 * left. A click on a header sorts by it; a click on a row opens it.
 */
function RecordTable({
  spec,
  records,
  truncated,
  selecting,
  checked,
  onToggle,
}: {
  spec: ObjectSpec
  records: CrmRecord[]
  truncated: boolean
  selecting: boolean
  checked: Set<string>
  onToggle: (id: string) => void
}) {
  const columns = useMemo(() => spec.details.filter((field) => field.type !== 'textarea'), [spec])
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null)
  useEffect(() => {
    setFilters({})
    setSort(null)
  }, [spec.segment])

  const rows = useMemo(() => {
    const active = Object.entries(filters).filter(([, needle]) => needle.trim())
    let out = records.filter((record) =>
      active.every(([key, needle]) => {
        if (key === '_profile') return matches(profileText(record), needle)
        const field = columns.find((column) => column.key === key)
        return field ? matches(cellText(record, field), needle) : true
      }),
    )
    if (sort) {
      const field = columns.find((column) => column.key === sort.key)
      out = [...out].sort((a, b) => {
        const left = sort.key === '_profile' ? profileText(a) : field ? rawOf(a, field) : ''
        const right = sort.key === '_profile' ? profileText(b) : field ? rawOf(b, field) : ''
        if (typeof left === 'number' && typeof right === 'number') return (left - right) * sort.dir
        return String(left ?? '').localeCompare(String(right ?? ''), undefined, { numeric: true, sensitivity: 'base' }) * sort.dir
      })
    }
    return out
  }, [records, filters, sort, columns])

  const filtering = Object.values(filters).some((needle) => needle.trim())
  const setFilter = (key: string, value: string) => setFilters((current) => ({ ...current, [key]: value }))
  const sortBy = (key: string) =>
    setSort((current) => (current?.key === key ? (current.dir === 1 ? { key, dir: -1 } : null) : { key, dir: 1 }))

  const head = (key: string, label: string) => (
    <th key={key} className="whitespace-nowrap px-3 py-2 font-medium">
      <button
        type="button"
        className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-ink"
        onClick={() => sortBy(key)}
        aria-sort={sort?.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}
      >
        {label}
        {sort?.key === key ? <span aria-hidden>{sort.dir === 1 ? '↑' : '↓'}</span> : null}
      </button>
    </th>
  )
  const filterCell = (key: string, label: string) => (
    <th key={key} className="px-2 py-1.5 font-normal">
      <input
        className="field h-7 w-full min-w-[6rem] px-2 text-xs"
        placeholder="Filter"
        aria-label={`Filter by ${label.toLowerCase()}`}
        value={filters[key] ?? ''}
        onChange={(event) => setFilter(key, event.target.value)}
      />
    </th>
  )

  return (
    <div className="panel">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2 text-xs text-muted">
        <span>
          {filtering ? `${rows.length.toLocaleString()} of ${records.length.toLocaleString()} ${spec.label.toLowerCase()}` : `${records.length.toLocaleString()} ${spec.label.toLowerCase()}`}
          {truncated ? ' · the first page; search for the rest' : ''}
        </span>
        {filtering ? (
          <button type="button" className="btn-ghost text-xs" onClick={() => setFilters({})}>
            Clear filters
          </button>
        ) : null}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm" aria-label={spec.label}>
          <thead>
            <tr className="border-b border-line text-[11px] text-faint">
              {selecting ? <th className="w-8 px-3 py-2" aria-label="Checked" /> : null}
              {columns.map((column) => head(column.key, column.label))}
              {head('_profile', 'Profile')}
            </tr>
            <tr className="border-b border-line bg-sunken/60">
              {selecting ? <th className="px-3 py-1.5" /> : null}
              {columns.map((column) => filterCell(column.key, column.label))}
              {filterCell('_profile', 'Profile')}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length + 1 + (selecting ? 1 : 0)} className="px-4 py-8 text-center text-sm text-muted">
                  Nothing matches these filters.
                </td>
              </tr>
            ) : (
              rows.map((record) => {
                const id = (record as { id: string }).id
                const isChecked = selecting && checked.has(id)
                return (
                  <tr
                    key={id}
                    className={`cursor-pointer border-b border-line last:border-0 hover:bg-sunken ${
                      isChecked ? 'bg-brand/5' : ''
                    }`}
                    aria-selected={selecting ? isChecked : undefined}
                    onClick={() => (selecting ? onToggle(id) : navigate(`/${spec.segment}/${id}`))}
                  >
                    {selecting ? (
                      <td className="px-3 py-2">
                        <input type="checkbox" readOnly tabIndex={-1} checked={isChecked} aria-label={titleOf(spec.type, record)} className="pointer-events-none" />
                      </td>
                    ) : null}
                    {columns.map((column, at) => (
                      <td
                        key={column.key}
                        className={`max-w-[16rem] truncate px-3 py-2 ${at === 0 ? 'font-semibold text-ink' : 'text-muted'}`}
                        title={cellText(record, column)}
                      >
                        {cellText(record, column) || (at === 0 ? titleOf(spec.type, record) : '')}
                      </td>
                    ))}
                    <td className="max-w-[20rem] truncate px-3 py-2 text-[11px] text-faint" title={profileText(record)}>
                      {profileText(record)}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const rawOf = (record: CrmRecord, field: DetailField): unknown =>
  (record as unknown as Record<string, unknown>)[field.key]

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
                <td className="px-4 py-2 text-[11px] text-faint">{profileText(record)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="px-4 py-2 text-[11px] text-faint">Up to eight of each kind. Narrow the search to see the rest.</p>
    </div>
  )
}
