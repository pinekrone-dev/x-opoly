import { useState } from 'react'

/*
 * The left rail.
 *
 * Four questions a broker arrives with, in the order they get asked: what am I
 * looking at, where is the thing I already know about, which of these are worth
 * my time, and what do I hand to someone else. Layers, Search, Filter, Report.
 *
 * The rail owns none of the answers. It is chrome around panels the GIS view
 * fills, so that filtering and the map read from one place and cannot drift
 * apart — the count in Report is the same set the map is drawing.
 */

export type RailTab = 'layers' | 'search' | 'filter' | 'report'

const TABS: { id: RailTab; label: string; icon: JSX.Element }[] = [
  {
    id: 'layers',
    label: 'Layers',
    icon: <path d="m12 3 9 5-9 5-9-5 9-5ZM3 13l9 5 9-5M3 17l9 5 9-5" />,
  },
  { id: 'search', label: 'Search', icon: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></> },
  { id: 'filter', label: 'Filter', icon: <path d="M3 5h18l-7 8v6l-4 2v-8L3 5Z" /> },
  {
    id: 'report',
    label: 'Report',
    icon: <><path d="M5 3h9l5 5v13H5z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></>,
  },
]

export default function GisRail({
  open,
  tab,
  onTab,
  badge,
  children,
}: {
  open: boolean
  tab: RailTab
  onTab: (tab: RailTab | null) => void
  /** A count shown against a tab, when it has something to say. */
  badge?: Partial<Record<RailTab, string>>
  children: React.ReactNode
}) {
  return (
    <div className="pointer-events-none absolute left-0 top-0 z-[500] flex h-full">
      {/* The spine is always visible; the panel slides out beside it. */}
      <nav
        className="pointer-events-auto flex w-14 shrink-0 flex-col items-center gap-1 border-r border-line bg-surface py-2"
        aria-label="Map tools"
      >
        {TABS.map((entry) => {
          const active = open && tab === entry.id
          return (
            <button
              key={entry.id}
              type="button"
              className={`relative flex w-11 flex-col items-center gap-0.5 rounded-md px-1 py-1.5 text-[10px] ${
                active ? 'bg-sunken font-semibold text-brand' : 'text-muted hover:text-body'
              }`}
              aria-pressed={active}
              onClick={() => onTab(active ? null : entry.id)}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                {entry.icon}
              </svg>
              {entry.label}
              {badge?.[entry.id] && (
                <span className="absolute right-0 top-0 rounded-full bg-brand px-1 text-[9px] font-semibold text-white">
                  {badge[entry.id]}
                </span>
              )}
            </button>
          )
        })}
      </nav>

      {open && (
        <section className="pointer-events-auto flex w-80 flex-col border-r border-line bg-surface">
          <header className="flex items-center justify-between border-b border-line px-3 py-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
              {TABS.find((entry) => entry.id === tab)?.label}
            </h2>
            <button type="button" className="text-muted hover:text-ink" aria-label="Close panel" onClick={() => onTab(null)}>
              ×
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">{children}</div>
        </section>
      )}
    </div>
  )
}

/** A labelled numeric range. Either end may be left blank. */
export function RangeInput({
  label,
  suffix,
  min,
  max,
  onChange,
}: {
  label: string
  suffix?: string
  min: string
  max: string
  onChange: (next: { min: string; max: string }) => void
}) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-medium text-body">{label}</label>
      <div className="flex items-center gap-1.5">
        <input
          className="w-full rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink"
          placeholder="Min"
          inputMode="decimal"
          value={min}
          onChange={(event) => onChange({ min: event.target.value, max })}
        />
        <span className="text-xs text-faint">to</span>
        <input
          className="w-full rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink"
          placeholder="Max"
          inputMode="decimal"
          value={max}
          onChange={(event) => onChange({ min, max: event.target.value })}
        />
        {suffix && <span className="text-[11px] text-faint">{suffix}</span>}
      </div>
    </div>
  )
}

/** A checkbox list that fits in the rail. */
export function CheckList({
  options,
  selected,
  onToggle,
}: {
  options: { value: string; count: number }[]
  selected: Set<string>
  onToggle: (value: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? options : options.slice(0, 8)
  return (
    <div className="space-y-1">
      {shown.map((option) => (
        <label key={option.value} className="flex cursor-pointer items-center gap-2 text-xs text-body">
          <input
            type="checkbox"
            className="accent-brand"
            checked={selected.has(option.value)}
            onChange={() => onToggle(option.value)}
          />
          <span className="flex-1 truncate">{option.value}</span>
          <span className="text-[11px] text-faint">{option.count.toLocaleString()}</span>
        </label>
      ))}
      {options.length > 8 && (
        <button type="button" className="text-[11px] text-brand hover:underline" onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show fewer' : `Show all ${options.length}`}
        </button>
      )}
    </div>
  )
}
