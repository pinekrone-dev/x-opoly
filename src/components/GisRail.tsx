import { useState } from 'react'
import { bySection, cardKey, sectionOf, type StartingPoint } from '../lib/layerSections'

/*
 * The left rail.
 *
 * Radius stands first: a circle on the map, up to twenty miles, and the
 * criteria inside it, all or some. Then four questions a broker arrives
 * with, in the order they get asked: what am I looking at, where is the thing I already know about, which of these are worth
 * my time, and what do I hand to someone else. Layers, Search, Filter, Report.
 *
 * The rail owns none of the answers. It is chrome around panels the GIS view
 * fills, so that filtering and the map read from one place and cannot drift
 * apart — the count in Report is the same set the map is drawing.
 */

export type RailTab = 'layers' | 'filter' | 'report'

const TABS: { id: RailTab; label: string; icon: JSX.Element }[] = [
  {
    // The query: every criterion, in categories, all or some, within a
    // radius when one is switched on. First, because it is where a site
    // search starts.
    id: 'filter',
    label: 'Query',
    icon: (
      <>
        <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
        <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
        <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4M12 5v13" />
      </>
    ),
  },
  {
    id: 'layers',
    label: 'Layers',
    icon: <path d="m12 3 9 5-9 5-9-5 9-5ZM3 13l9 5 9-5M3 17l9 5 9-5" />,
  },
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
  floating,
  children,
}: {
  /** Kept on the map beside the rail, panel open or shut: the address bar. */
  floating?: React.ReactNode
  open: boolean
  tab: RailTab
  onTab: (tab: RailTab | null) => void
  /** A count shown against a tab, when it has something to say. */
  badge?: Partial<Record<RailTab, string>>
  children: React.ReactNode
}) {
  /*
   * Two shapes from one tree. On a desktop the rail is a spine down the
   * map's left edge with its drawer beside it. On a phone the same tabs are a
   * bar along the bottom, like an app's, and the drawer is a sheet that rises
   * over the lower part of the map, leaving the top of the map to look at.
   * The panels are rendered once either way, so nothing typed into a filter
   * is lost turning the phone.
   */
  return (
    <div className="pointer-events-none absolute inset-0 z-[500] md:inset-auto md:left-0 md:top-0 md:flex md:h-full">
      <nav
        className="gis-tabbar pointer-events-auto absolute inset-x-0 bottom-0 flex items-stretch justify-around border-t border-line bg-surface md:static md:w-14 md:shrink-0 md:flex-col md:items-center md:justify-start md:gap-1 md:border-r md:border-t-0 md:py-2"
        aria-label="Map tools"
        data-tour="rail"
      >
        {TABS.map((entry) => {
          const active = open && tab === entry.id
          return (
            <button
              key={entry.id}
              type="button"
              className={`relative flex flex-1 flex-col items-center justify-center gap-0.5 rounded-md px-1 py-1.5 text-[10px] md:w-11 md:flex-none ${
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
                <span className="absolute right-1 top-0 rounded-full bg-brand px-1 text-[9px] font-semibold text-white md:right-0">
                  {badge[entry.id]}
                </span>
              )}
            </button>
          )
        })}
      </nav>

      {open && (
        <section className="gis-sheet pointer-events-auto absolute inset-x-0 flex max-h-[58%] flex-col rounded-t-2xl border-t border-line bg-surface shadow-2xl md:static md:max-h-none md:w-80 md:rounded-none md:border-r md:border-t-0 md:shadow-none">
          {/* A handle, on a phone: the sheet reads as something lifted over the map. */}
          <div className="flex justify-center pt-1.5 md:hidden" aria-hidden>
            <span className="h-1 w-10 rounded-full bg-line" />
          </div>
          <header className="flex items-center justify-between border-b border-line px-3 py-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
              {TABS.find((entry) => entry.id === tab)?.label}
            </h2>
            <button type="button" className="px-1 text-lg leading-none text-muted hover:text-ink" aria-label="Close panel" onClick={() => onTab(null)}>
              ×
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">{children}</div>
        </section>
      )}
      {floating ? (
        <div className="pointer-events-auto absolute inset-x-3 top-3 md:static md:ml-3 md:mt-3 md:self-start">{floating}</div>
      ) : null}
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
  /*
   * Still fetching what it needs to draw.
   *
   * A county-sized layer takes real seconds, and for that whole stretch a
   * card that changes nothing about itself reads as a card that did nothing
   * — the toggle looks broken precisely when it is working hardest. Busy is
   * its own visible state, not a line of small print.
   */
  busy?: boolean
  state: LayerState
  icon: JSX.Element
  /** A small control in the card's top corner (which lists, say). */
  corner?: React.ReactNode
  /** Which section of the panel it sits in (lib/layerSections.ts). */
  section?: string
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
          <div key={card.id} className="relative">
          <button
            type="button"
            disabled={!live}
            title={card.note}
            onClick={() => live && onToggle(card.id)}
            className={`flex h-full w-full flex-col items-start gap-1.5 rounded-lg border p-2 text-left transition ${
              card.state === 'on'
                ? 'border-brand bg-brand/5'
                : live
                  ? 'border-line bg-surface hover:border-muted'
                  : 'cursor-not-allowed border-dashed border-line bg-sunken/40'
            }`}
          >
            <span
              className={`relative flex h-7 w-7 items-center justify-center rounded-full ${
                card.state === 'on' ? 'bg-brand/15 text-brand' : live ? 'bg-sunken text-body' : 'bg-transparent text-faint'
              }`}
            >
              {card.busy ? (
                <span
                  aria-hidden
                  className="absolute inset-0 animate-spin rounded-full border-2 border-brand/30 border-t-brand"
                />
              ) : null}
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                {card.icon}
              </svg>
            </span>
            <span className={`text-xs font-medium leading-tight ${live ? 'text-ink' : 'text-faint'}`}>
              {card.label}
            </span>
            {card.busy ? (
              <span className="text-[10px] font-medium leading-tight text-brand" role="status">
                Loading the county's data…
              </span>
            ) : card.note ? (
              <span className="text-[10px] leading-tight text-faint">{card.note}</span>
            ) : null}
          </button>
          {card.corner ? <div className="absolute right-1.5 top-1.5">{card.corner}</div> : null}
          </div>
        )
      })}
    </div>
  )
}

const OPEN_KEY = 'lq:layer-sections-open'

function readOpen(): Record<string, boolean> | null {
  try {
    const raw = localStorage.getItem(OPEN_KEY)
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : null
  } catch {
    return null
  }
}

/*
 * The layer catalogue, in sections.
 *
 * One flat grid of every layer a market publishes had grown past twenty
 * cards. Here the cards sit under what they are for (boundaries, zoning,
 * development, market research, infrastructure, risk), each section folded
 * until it is wanted, so the panel opens short.
 *
 * Two things sit above the sections. "On now" lists what is switched on,
 * each with its own off button, because a layer that is on inside a folded
 * section would otherwise be on with nothing saying so. And the starting
 * points switch a sensible handful on in one click: a few built in, and any
 * the team has saved from its own "On now".
 */
export function LayerSections({
  cards,
  onToggle,
  points,
  onApply,
  onSavePoint,
  onRemovePoint,
}: {
  cards: LayerCard[]
  onToggle: (id: string) => void
  points: StartingPoint[]
  onApply: (point: StartingPoint) => void
  onSavePoint: (name: string, layers: string[]) => Promise<void> | void
  onRemovePoint: (point: StartingPoint) => Promise<void> | void
}) {
  const groups = bySection(cards)
  const on = cards.filter((card) => card.state === 'on')
  // Folded or not, where the person has said; otherwise a section is open
  // exactly when something in it is on.
  const [open, setOpen] = useState<Record<string, boolean>>(() => readOpen() ?? {})
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)

  const flip = (id: string, now: boolean) => {
    setOpen((current) => {
      const next = { ...current, [id]: !now }
      try { localStorage.setItem(OPEN_KEY, JSON.stringify(next)) } catch { /* private window: the fold is not remembered */ }
      return next
    })
  }
  // What a starting point would use here: the layers this market has.
  const available = new Set(cards.filter((c) => c.state === 'on' || c.state === 'off').map((c) => cardKey(c.id)))
  const usable = points.filter((point) => point.layers.some((key) => available.has(key)))
  const saveable = on.filter((card) => (card.section ?? sectionOf(card.id)) !== 'workspace')

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    const label = name.trim()
    if (!label || saving) return
    setSaving(true)
    try {
      await onSavePoint(label, saveable.map((card) => cardKey(card.id)))
      setNaming(false)
      setName('')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2.5">
      <div data-testid="layers-on-now">
        <div className="flex items-baseline justify-between">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">On now</p>
          {saveable.length ? (
            <button type="button" className="text-[10px] font-medium text-brand hover:underline" onClick={() => setNaming((v) => !v)}>
              {naming ? 'Cancel' : 'Save as starting point'}
            </button>
          ) : null}
        </div>
        {on.length ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {on.map((card) => (
              <span key={card.id} className="inline-flex items-center gap-1 rounded-full border border-brand/40 bg-brand/5 py-0.5 pl-2 pr-1 text-[11px] font-medium text-ink">
                {card.label}
                <button type="button" aria-label={`Switch off ${card.label}`} title="Switch off"
                  className="flex h-4 w-4 items-center justify-center rounded-full text-muted hover:bg-brand/15 hover:text-ink"
                  onClick={() => onToggle(card.id)}>
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : (
          <p className="mt-1 text-[11px] text-faint">Nothing switched on. Pick a starting point or open a section.</p>
        )}
        {naming ? (
          <form onSubmit={save} className="mt-1.5 flex gap-1.5">
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={40}
              placeholder="Name it, e.g. Retail pads" aria-label="Starting point name"
              className="min-w-0 flex-1 rounded border border-line bg-white px-2 py-1 text-[11px] text-ink placeholder:text-faint focus:border-ink focus:outline-none" />
            <button type="submit" disabled={!name.trim() || saving}
              className="rounded border border-line px-2 py-1 text-[11px] font-semibold text-ink hover:bg-sunken disabled:opacity-50">
              {saving ? 'Saving…' : 'Save'}
            </button>
          </form>
        ) : null}
      </div>

      {usable.length ? (
        <div data-testid="starting-points">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Starting points</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {usable.map((point) => (
              <span key={point.id ?? point.name} className="inline-flex items-center rounded-full border border-line bg-surface text-[11px] text-ink hover:border-muted">
                <button type="button" className="py-0.5 pl-2 pr-1.5 font-medium" onClick={() => onApply(point)}
                  title={point.note ?? `${point.layers.filter((key) => available.has(key)).length} layers`}>
                  {point.name}
                </button>
                {point.id ? (
                  <button type="button" aria-label={`Remove ${point.name}`} title="Remove this starting point"
                    className="mr-1 flex h-4 w-4 items-center justify-center rounded-full text-faint hover:bg-sunken hover:text-ink"
                    onClick={() => onRemovePoint(point)}>
                    ×
                  </button>
                ) : null}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div className="divide-y divide-line rounded-lg border border-line">
        {groups.map(({ section, cards: members }) => {
          const live = members.filter((c) => c.state === 'on').length
          const isOpen = open[section.id] ?? live > 0
          return (
            <div key={section.id} data-section={section.id}>
              <button type="button" aria-expanded={isOpen} onClick={() => flip(section.id, isOpen)}
                className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-sunken/50">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden
                  className={`shrink-0 text-muted transition-transform ${isOpen ? 'rotate-90' : ''}`}>
                  <path d="M9 6l6 6-6 6" />
                </svg>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-semibold text-ink">{section.label}</span>
                  {!isOpen ? <span className="block truncate text-[10px] text-faint">{section.hint}</span> : null}
                </span>
                {live ? (
                  <span className="rounded-full bg-brand/10 px-1.5 py-0.5 text-[10px] font-semibold text-brand">{live} on</span>
                ) : (
                  <span className="text-[10px] text-faint">{members.length}</span>
                )}
              </button>
              {isOpen ? (
                <div className="px-2 pb-2">
                  <LayerGrid cards={members} onToggle={onToggle} />
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
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
  ships: <><path d="M3 14h18l-3 5H6z" /><path d="M6 14V9h12v5" /><path d="M12 9V4M9 6h6" /></>,
  // A lightning bolt, for the grid: lines, substations, plants.
  power: <><path d="M13 2L5 13h6l-1 9 8-11h-6z" /></>,
  // A pylon, for the transmission lines themselves.
  pylon: <><path d="M12 2L7 22M12 2l5 20M8.5 16h7M9.7 11h4.6M5 7h14" /></>,
  // A tank in the ground: the grade line, and the tank below it.
  tank: <><path d="M2 9h20" /><rect x="5" y="12" width="14" height="7" rx="3.5" /><path d="M12 9v3" /></>,
  // A drop, for what leaked from one.
  leak: <><path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z" /><path d="M9.5 14.5a2.5 2.5 0 0 0 2.5 2.5" /></>,
  // A list: three lines with bullets, for the team's lists of places.
  lists: <><path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4.5" cy="6" r="1" /><circle cx="4.5" cy="12" r="1" /><circle cx="4.5" cy="18" r="1" /></>,
  // A road with its centre line, for traffic counts.
  traffic: <><path d="M8 3L5 21M16 3l3 18" /><path d="M12 4v3M12 10.5v3M12 17v3" /></>,
  // A trail winding past a tree, for parks and recreation.
  trail: <><path d="M5 21c0-4 7-4 7-8s-5-3-5-6" /><path d="M17 3l3.5 6h-7z" /><path d="M17 9v3" /></>,
}
