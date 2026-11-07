import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import SendPlaceToSurvey from '../components/SendPlaceToSurvey'
import { csvCell } from '../lib/csv'
import { navigate } from '../lib/router'
import { useCanEdit } from '../lib/access'
import type { PlaceList, PlaceListDetail } from '../types'

/*
 * The team's lists, filed by client and tags.
 *
 * Lists pile up the way folders do, and a broker looks for one by whose it
 * is ("everything for Acme") or what kind ("all the industrial ones"), so
 * those are the two filters, with a search over names beside them. A list
 * opens to its buildings, which go to a survey, onto the map or out as a
 * spreadsheet from there.
 */
export default function ListsView({ id }: { id?: string }) {
  return id ? <ListDetail id={id} /> : <AllLists />
}

function AllLists() {
  const canEdit = useCanEdit()
  const [lists, setLists] = useState<PlaceList[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [client, setClient] = useState('')
  const [tag, setTag] = useState('')
  const [making, setMaking] = useState(false)
  const [draft, setDraft] = useState({ name: '', client: '', tags: '' })

  const load = () =>
    api.lists
      .all()
      .then(({ lists: found }) => setLists(found))
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'The lists could not be read.'))
  useEffect(() => {
    void load()
  }, [])

  const clients = useMemo(() => [...new Set((lists ?? []).map((l) => l.client).filter(Boolean) as string[])].sort(), [lists])
  const tags = useMemo(() => [...new Set((lists ?? []).flatMap((l) => l.tags))].sort((a, b) => a.localeCompare(b)), [lists])
  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return (lists ?? []).filter(
      (l) =>
        (!client || (client === '—' ? !l.client : l.client === client)) &&
        (!tag || l.tags.includes(tag)) &&
        (!needle || [l.name, l.client ?? '', ...l.tags].some((t) => t.toLowerCase().includes(needle))),
    )
  }, [lists, search, client, tag])

  const make = async () => {
    if (!draft.name.trim()) return
    try {
      const { list } = await api.lists.create({ name: draft.name, client: draft.client || null, tags: draft.tags })
      navigate(`/lists/${list.id}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The list could not be made.')
    }
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input className="field max-w-xs flex-1" type="search" placeholder="Search lists" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="field w-auto text-sm" aria-label="Client" value={client} onChange={(e) => setClient(e.target.value)}>
          <option value="">Every client</option>
          {clients.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
          <option value="—">No client</option>
        </select>
        {canEdit ? (
          <button type="button" className="btn-primary ml-auto text-sm" onClick={() => setMaking((v) => !v)}>
            New list
          </button>
        ) : null}
      </div>
      {tags.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {tags.map((t) => (
            <button
              key={t}
              type="button"
              className={`rounded-full border px-2.5 py-0.5 text-xs ${tag === t ? 'border-ink bg-ink text-white' : 'border-line text-muted hover:text-ink'}`}
              onClick={() => setTag(tag === t ? '' : t)}
            >
              {t}
            </button>
          ))}
        </div>
      )}
      {making && (
        <div className="panel mb-3 grid gap-2 p-3 sm:grid-cols-4">
          <input className="field" placeholder="List name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <input className="field" placeholder="Client" list="list-clients" value={draft.client} onChange={(e) => setDraft({ ...draft, client: e.target.value })} />
          <datalist id="list-clients">
            {clients.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <input className="field" placeholder="Tags, comma separated" value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} />
          <button type="button" className="btn-primary text-sm" disabled={!draft.name.trim()} onClick={() => void make()}>
            Make list
          </button>
        </div>
      )}
      {error ? <p className="mb-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{error}</p> : null}
      {lists === null ? (
        <p className="py-10 text-center text-sm text-muted">Loading…</p>
      ) : lists.length === 0 ? (
        <div className="panel p-10 text-center">
          <p className="text-sm font-semibold text-ink">No lists yet</p>
          <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted">
            Make one here, or file a parcel from the map with “+ List” on its card. Give each a client and a few tags to find it by later.
          </p>
        </div>
      ) : (
        <div className="panel overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="px-3 py-2 font-medium">List</th>
                <th className="px-3 py-2 font-medium">Client</th>
                <th className="px-3 py-2 font-medium">Tags</th>
                <th className="px-3 py-2 text-right font-medium">Places</th>
                <th className="px-3 py-2 text-right font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((l) => (
                <tr key={l.id} className="cursor-pointer border-b border-line last:border-0 hover:bg-sunken" onClick={() => navigate(`/lists/${l.id}`)}>
                  <td className="px-3 py-2 font-medium text-ink">{l.name}</td>
                  <td className="px-3 py-2 text-body">{l.client || <span className="text-faint">—</span>}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {l.tags.map((t) => (
                        <span key={t} className="rounded-full bg-sunken px-2 py-0.5 text-[11px] text-body">
                          {t}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{l.count.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right text-xs text-muted">{l.updatedAt ? new Date(l.updatedAt).toLocaleDateString() : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length === 0 && <p className="p-4 text-center text-xs text-muted">No list matches those filters.</p>}
        </div>
      )}
    </div>
  )
}

function ListDetail({ id }: { id: string }) {
  const canEdit = useCanEdit()
  const [list, setList] = useState<PlaceListDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState({ name: '', client: '', tags: '' })
  const [confirming, setConfirming] = useState(false)

  const load = () =>
    api.lists
      .get(id)
      .then(({ list: found }) => {
        setList(found)
        setDraft({ name: found.name, client: found.client ?? '', tags: found.tags.join(', ') })
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'That list could not be read.'))
  useEffect(() => {
    void load()
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <p className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{error}</p>
  if (!list) return <p className="py-10 text-center text-sm text-muted">Loading…</p>

  const save = async () => {
    try {
      await api.lists.update(id, { name: draft.name, client: draft.client || null, tags: draft.tags })
      setEditing(false)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That could not be saved.')
    }
  }

  const exportCsv = () => {
    const header = ['Name', 'Address', 'Acres', 'Market', 'Parcel ID', 'Latitude', 'Longitude', 'Notes']
    const rows = list.places.map((p) => [p.name, p.address, p.acreage, p.market, p.parcelId, p.lat, p.lng, p.notes])
    const text = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${list.name.replace(/[^\w .-]+/g, '-')}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
  }

  // The map opens on the market most of the list sits in.
  const market = (() => {
    const counts = new Map<string, number>()
    for (const p of list.places) if (p.market) counts.set(p.market, (counts.get(p.market) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  })()

  return (
    <div>
      <button type="button" className="mb-3 text-xs text-muted hover:text-ink" onClick={() => navigate('/lists')}>
        ← All lists
      </button>
      <div className="panel mb-4 p-4">
        {editing ? (
          <div className="grid gap-2 sm:grid-cols-4">
            <input className="field" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-label="Name" />
            <input className="field" placeholder="Client" value={draft.client} onChange={(e) => setDraft({ ...draft, client: e.target.value })} aria-label="Client" />
            <input className="field" placeholder="Tags, comma separated" value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} aria-label="Tags" />
            <div className="flex gap-2">
              <button type="button" className="btn-primary text-sm" onClick={() => void save()}>
                Save
              </button>
              <button type="button" className="btn-ghost text-sm" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <h1 className="text-lg font-semibold text-ink">{list.name}</h1>
              <p className="text-sm text-muted">
                {list.client ? `Client: ${list.client}` : 'No client'} · {list.count.toLocaleString()} place{list.count === 1 ? '' : 's'}
              </p>
              {list.tags.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {list.tags.map((t) => (
                    <span key={t} className="rounded-full bg-sunken px-2 py-0.5 text-[11px] text-body">
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {market && (
                <button type="button" className="btn-secondary text-xs" onClick={() => navigate(`/gis/${market}?list=${encodeURIComponent(list.id)}`)}>
                  Show on map
                </button>
              )}
              {list.places.length > 0 && <SendPlaceToSurvey placeIds={list.places.map((p) => p.id)} label="Send all to survey" buttonClassName="btn-secondary text-xs" />}
              {list.places.length > 0 && (
                <button type="button" className="btn-secondary text-xs" onClick={exportCsv}>
                  Export CSV
                </button>
              )}
              {canEdit && (
                <button type="button" className="btn-ghost text-xs" onClick={() => setEditing(true)}>
                  Edit
                </button>
              )}
              {canEdit &&
                (confirming ? (
                  <>
                    <button
                      type="button"
                      className="rounded-md bg-rose-600 px-2 py-1 text-xs font-semibold text-white"
                      onClick={async () => {
                        await api.lists.remove(id)
                        navigate('/lists')
                      }}
                    >
                      Delete list
                    </button>
                    <button type="button" className="btn-ghost text-xs" onClick={() => setConfirming(false)}>
                      Keep
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn-ghost text-xs text-rose-700" onClick={() => setConfirming(true)}>
                    Delete…
                  </button>
                ))}
            </div>
          </div>
        )}
      </div>

      {list.places.length === 0 ? (
        <div className="panel p-8 text-center text-sm text-muted">Nothing on this list yet. Add parcels from the map with “+ List” on their card.</div>
      ) : (
        <div className="panel overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="px-3 py-2 font-medium">Place</th>
                <th className="px-3 py-2 font-medium">Address</th>
                <th className="px-3 py-2 text-right font-medium">Acres</th>
                <th className="px-3 py-2 font-medium">Market</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {list.places.map((p) => (
                <tr key={p.id} className="border-b border-line last:border-0 hover:bg-sunken">
                  <td className="cursor-pointer px-3 py-2 font-medium text-ink" onClick={() => navigate(`/places/${p.id}`)}>
                    {p.name || 'Place'}
                  </td>
                  <td className="px-3 py-2 text-body">{p.address || ''}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{p.acreage ? Number(p.acreage).toFixed(2) : ''}</td>
                  <td className="px-3 py-2 text-xs text-muted">{p.market || ''}</td>
                  <td className="px-3 py-2 text-right">
                    {canEdit && (
                      <button
                        type="button"
                        className="text-xs text-muted hover:text-rose-700"
                        onClick={async () => {
                          await api.lists.drop(id, p.id)
                          await load()
                        }}
                      >
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
