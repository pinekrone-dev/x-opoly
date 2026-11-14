import { useEffect, useState } from 'react'
import { api } from '../api'
import { navigate } from '../lib/router'
import { usePopover } from '../lib/popover'
import type { PlaceList } from '../types'

/** One colour per list, in list order, so a list keeps its colour between visits. */
export const LIST_COLORS = ['#d6336c', '#1c7ed6', '#2b8a3e', '#e8590c', '#7048e8', '#0c8599', '#c2255c', '#5c940d', '#ae3ec9', '#f08c00']

export function listColor(lists: { id: string }[], id: string) {
  const i = lists.findIndex((l) => l.id === id)
  return LIST_COLORS[(i < 0 ? 0 : i) % LIST_COLORS.length]
}

/*
 * The corner of the Lists layer card: which lists are on the map.
 *
 * None ticked means every list, which is what a broker wants the first time;
 * ticking one narrows the map to it, and more to several. Each list wears
 * the colour its pins are drawn in.
 */
export default function ListsLayerPicker({
  lists,
  chosen,
  onChange,
  onNone,
}: {
  lists: PlaceList[] | null
  /** The lists shown; none named means every list. */
  chosen: string[]
  onChange: (ids: string[]) => void
  /** The last list was unticked: nothing is left to show. */
  onNone?: () => void
}) {
  const [open, setOpen] = useState(false)
  const pop = usePopover(open, 260)

  useEffect(() => {
    if (!open) return undefined
    const close = (event: MouseEvent) => {
      const target = event.target as Node
      if (pop.anchor.current?.contains(target)) return
      if ((target as HTMLElement).closest?.('[data-lists-pop]')) return
      setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open, pop.anchor])

  /*
   * Every list is ticked when all are shown, so the boxes say what is on the
   * map. "All lists" used to be its own state with every list beside it
   * unticked, which read as nothing chosen, and ticking it appeared to
   * untick the one list that was. Unticking the last list leaves nothing to
   * show, which is the layer switched off.
   */
  const every = (lists ?? []).map((l) => l.id)
  const shown = chosen.length ? chosen.filter((id) => every.includes(id)) : every
  const all = every.length > 0 && shown.length === every.length
  const settle = (next: string[]) => {
    if (next.length === 0) onNone ? onNone() : onChange([])
    else onChange(next.length === every.length ? [] : next)
  }
  const toggle = (id: string) => settle(shown.includes(id) ? shown.filter((c) => c !== id) : [...shown, id])

  return (
    <div ref={pop.anchor}>
      <button
        type="button"
        className={`flex h-6 items-center gap-0.5 rounded-md border px-1.5 text-[10px] font-semibold ${
          !all && every.length ? 'border-brand/50 bg-brand/10 text-brand' : 'border-line bg-surface text-muted hover:text-ink'
        }`}
        aria-label="Choose which lists to show"
        title="Choose which lists to show"
        onClick={(event) => {
          event.stopPropagation()
          setOpen((v) => !v)
        }}
      >
        {all || !every.length ? 'All' : shown.length}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open ? (
        <div data-lists-pop className="panel p-2 text-left shadow-lg" style={pop.style}>
          <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted">Lists on the map</p>
          {lists === null ? (
            <p className="px-1 py-1 text-xs text-muted">Loading…</p>
          ) : lists.length === 0 ? (
            <p className="px-1 py-1 text-xs text-muted">No lists yet. File a parcel with “+ List” on its card.</p>
          ) : (
            <ul className="max-h-64 overflow-y-auto">
              <li>
                <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-xs hover:bg-sunken">
                  <input type="checkbox" checked={all} onChange={() => settle(all ? [] : every)} />
                  <span className="font-medium text-ink">All lists</span>
                </label>
              </li>
              {lists.map((l) => (
                <li key={l.id}>
                  <label className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 hover:bg-sunken">
                    <input type="checkbox" className="mt-0.5" checked={shown.includes(l.id)} onChange={() => toggle(l.id)} />
                    <span className="mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: listColor(lists, l.id) }} />
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
          <button type="button" className="mt-1 w-full px-1 text-left text-[11px] font-semibold text-brand hover:underline" onClick={() => navigate('/lists')}>
            Manage lists
          </button>
        </div>
      ) : null}
    </div>
  )
}
