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
        data-tour="rail"
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

/*
 * The layer catalogue.
 *
 * A grid of what can go on the map, so the answer to "what else can this show
 * me" is something you look at rather than something you have to already know.
 *
 * Every card says plainly whether it is available. A card that looks live and
 * does nothing is worse than no card: it makes the map look like it is hiding
 * data it does not have. Where a layer exists for some markets and not others
 * — zoning is published by Nashville and by almost nobody else — the card says
 * that for the market currently open, not in general.
 */
export type LayerState = 'on' | 'off' | 'unavailable' | 'soon'

export interface LayerCard {
  id: string
  label: string
  /** Why it cannot be switched on, when it cannot. One short line. */
  note?: string
  state: LayerState
  icon: JSX.Element
}

export function LayerGrid({
  cards,
  onToggle,
}: {
  cards: LayerCard[]
  onToggle: (id: string) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {cards.map((card) => {
        const live = card.state === 'on' || card.state === 'off'
        return (
          <button
            key={card.id}
            type="button"
            disabled={!live}
            title={card.note}
            onClick={() => live && onToggle(card.id)}
            className={`flex flex-col items-start gap-1.5 rounded-lg border p-2 text-left transition ${
              card.state === 'on'
                ? 'border-brand bg-brand/5'
                : live
                  ? 'border-line bg-surface hover:border-muted'
                  : 'cursor-not-allowed border-dashed border-line bg-sunken/40'
            }`}
          >
            <span
              className={`flex h-7 w-7 items-center justify-center rounded-full ${
                card.state === 'on' ? 'bg-brand/15 text-brand' : live ? 'bg-sunken text-body' : 'bg-transparent text-faint'
              }`}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                {card.icon}
              </svg>
            </span>
            <span className={`text-xs font-medium leading-tight ${live ? 'text-ink' : 'text-faint'}`}>
              {card.label}
            </span>
            {card.note && <span className="text-[10px] leading-tight text-faint">{card.note}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** Line art for the catalogue, kept here so the cards stay declarative. */
export const LAYER_ICONS = {
  parcels: <><path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z" /><path d="M9 3v15M15 6v15" /></>,
  ownership: <><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /><circle cx="12" cy="10" r="2.2" /><path d="M8.4 16a4 4 0 0 1 7.2 0" /></>,
  demographics: <><circle cx="9" cy="8" r="3" /><path d="M3 19a6 6 0 0 1 12 0" /><path d="M17 6.5a3 3 0 0 1 0 5.5M18 19a6 6 0 0 0-2-4.4" /></>,
  zoning: <><path d="M12 21s7-5.4 7-11a7 7 0 1 0-14 0c0 5.6 7 11 7 11z" /><circle cx="12" cy="10" r="2.5" /></>,
  surveys: <><path d="M4 20V9M10 20V4M16 20v-7M22 20H2" /></>,
  comps: <><path d="M3 21V8l6-4v17M9 21V11l6-3v13M15 21v-8l6-2v10" /><path d="M2 21h20" /></>,
  absorption: <><path d="M3 17l5-5 4 3 8-8" /><path d="M15 7h6v6" /></>,
  rent: <><path d="M12 3v18" /><path d="M16 7a3.5 3.5 0 0 0-4-1.5C9.5 6 9 9 12 10s3 4 .5 4.7A3.5 3.5 0 0 1 8 13" /></>,
  pipeline: <><path d="M4 21h16M6 21V7l10-3v17" /><path d="M6 7L3 8M16 8l4 2v11" /></>,
  forecasts: <><path d="M3 18l5-6 4 3 5-7" /><path d="M13 8h4v4" /><path d="M3 21h18" /></>,
  entitlements: <><path d="M6 3h9l4 4v14H6z" /><path d="M15 3v4h4" /><circle cx="12" cy="14" r="2.5" /><path d="M12 16.5V19" /></>,
}
