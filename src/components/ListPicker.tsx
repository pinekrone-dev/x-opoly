import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { usePopover } from '../lib/popover'
import type { PlaceList } from '../types'

/*
 * Puts a building on the team's lists, from wherever it is being looked at.
 *
 * Each list shows whose it is and how it is tagged, because that is how a
 * broker tells "Acme retail targets" from "Acme industrial" at a glance; a
 * tick adds, an untick removes. A new list is made here too, with its client
 * and tags, so filing a parcel never means leaving the map.
 *
 * `prepare` makes the CRM place when there is none yet (a parcel on the map
 * becomes a place the first time it is filed), and is asked once.
 */
export default function ListPicker({
  placeId,
  prepare,
  buttonClassName = 'btn-secondary text-xs',
  label = '+ List',
}: {
  placeId: string | null
  prepare?: () => Promise<string>
  buttonClassName?: string
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const pop = usePopover(open, 288)
  const [lists, setLists] = useState<PlaceList[] | null>(null)
  const [place, setPlace] = useState<string | null>(placeId)
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [making, setMaking] = useState(false)
  const [draft, setDraft] = useState({ name: '', client: '', tags: '' })

  useEffect(() => setPlace(placeId), [placeId])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    api.lists
      .all(place ?? undefined)
      .then(({ lists: found }) => !cancelled && setLists(found))
      .catch((cause) => !cancelled && setError(cause instanceof Error ? cause.message : 'The lists could not be read.'))
    return () => {
      cancelled = true
    }
  }, [open, place])

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!lists) return []
    if (!needle) return lists
    return lists.filter((l) => [l.name, l.client ?? '', ...l.tags].some((t) => t.toLowerCase().includes(needle)))
  }, [lists, filter])

  const ensure = async () => {
    if (place) return place
    if (!prepare) throw new Error('Save this building first.')
    const made = await prepare()
    setPlace(made)
    return made
  }

  const toggle = async (list: PlaceList) => {
    setBusy(list.id)
    setError(null)
    try {
      const id = await ensure()
      if (list.has) await api.lists.drop(list.id, id)
      else await api.lists.add(list.id, [id])
      setLists((all) => all?.map((l) => (l.id === list.id ? { ...l, has: !l.has, count: l.count + (l.has ? -1 : 1) } : l)) ?? null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That could not be saved.')
    } finally {
      setBusy(null)
    }
  }

  const make = async () => {
    if (!draft.name.trim()) return
    setBusy('new')
    setError(null)
    try {
      const id = await ensure()
      const { list } = await api.lists.create({ name: draft.name, client: draft.client || null, tags: draft.tags })
      await api.lists.add(list.id, [id])
      // Read back rather than patched in: saving the place first may have
      // set off a reload already, and both would list the new one twice.
      const { lists: fresh } = await api.lists.all(id)
      setLists(fresh)
      setDraft({ name: '', client: draft.client, tags: '' })
      setMaking(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The list could not be made.')
    } finally {
      setBusy(null)
    }
  }

  const onCount = lists?.filter((l) => l.has).length ?? 0

  return (
    <div className="relative" ref={pop.anchor}>
      <button type="button" className={buttonClassName} onClick={() => setOpen((v) => !v)}>
        {onCount ? `On ${onCount} list${onCount === 1 ? '' : 's'}` : label}
      </button>
      {open ? (
        <div className="panel p-3 text-left shadow-lg" style={pop.style}>
          <input
            className="field mb-2 w-full text-sm"
            placeholder="Find a list, client or tag"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            autoFocus
          />
          {lists === null ? (
            <p className="text-xs text-muted">Loading lists…</p>
          ) : shown.length === 0 && !making ? (
            <p className="text-xs text-muted">{lists.length ? 'No list matches.' : 'No lists yet. Make the first one below.'}</p>
          ) : (
            <ul className="max-h-60 space-y-0.5 overflow-y-auto">
              {shown.map((l) => (
                <li key={l.id}>
                  <label className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 hover:bg-sunken">
                    <input type="checkbox" className="mt-0.5" checked={Boolean(l.has)} disabled={busy !== null} onChange={() => void toggle(l)} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-ink">{l.name}</span>
                      <span className="block truncate text-[11px] text-muted">
                        {[l.client, ...l.tags].filter(Boolean).join(' · ') || 'No client'} · {l.count}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {making ? (
            <div className="mt-2 space-y-1.5 border-t border-line pt-2">
              <input className="field w-full text-sm" placeholder="List name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              <input className="field w-full text-sm" placeholder="Client (optional)" value={draft.client} onChange={(e) => setDraft({ ...draft, client: e.target.value })} />
              <input className="field w-full text-sm" placeholder="Tags, comma separated" value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} />
              <div className="flex gap-2">
                <button type="button" className="btn-primary flex-1 text-xs" disabled={!draft.name.trim() || busy !== null} onClick={() => void make()}>
                  {busy === 'new' ? 'Saving…' : 'Make list and add'}
                </button>
                <button type="button" className="btn-ghost text-xs" onClick={() => setMaking(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="mt-2 w-full text-left text-xs font-semibold text-brand hover:underline" onClick={() => setMaking(true)}>
              + New list
            </button>
          )}
          {error ? <p className="mt-2 text-xs text-rose-600">{error}</p> : null}
        </div>
      ) : null}
    </div>
  )
}
