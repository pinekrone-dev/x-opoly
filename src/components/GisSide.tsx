/*
 * The right panel.
 *
 * Always there, like the rail on the left: a spine when collapsed, a drawer
 * when open. Two tabs, because a map asks two different questions of the
 * reader at once — what is this thing I clicked (Data) and what do the
 * colours mean (Legend) — and both used to float over the map as separate
 * cards that came and went. The panel owns neither answer; the GIS view
 * fills it, so the record and the legend read from the same state as the map.
 */

export type SideTab = 'data' | 'legend'

const TABS: { id: SideTab; label: string; icon: JSX.Element }[] = [
  {
    id: 'data',
    label: 'Data',
    icon: <><path d="M5 3h9l5 5v13H5z" /><path d="M14 3v5h5M9 12h6M9 16h6" /></>,
  },
  {
    id: 'legend',
    label: 'Legend',
    icon: <><rect x="4" y="5" width="5" height="5" rx="1" /><rect x="4" y="14" width="5" height="5" rx="1" /><path d="M12 7h8M12 16h8" /></>,
  },
]

export default function GisSide({
  open,
  tab,
  onTab,
  onToggle,
  children,
}: {
  open: boolean
  tab: SideTab
  onTab: (tab: SideTab) => void
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div className="pointer-events-none absolute right-0 top-0 z-[600] flex h-full">
      {open ? (
        <section className="pointer-events-auto flex w-96 flex-col border-l border-line bg-surface shadow-2xl">
          <header className="flex items-center border-b border-line">
            <div className="flex flex-1" role="tablist" aria-label="Map panel">
              {TABS.map((entry) => {
                const active = tab === entry.id
                return (
                  <button
                    key={entry.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold uppercase tracking-wider ${
                      active ? 'border-b-2 border-brand text-brand' : 'text-muted hover:text-body'
                    }`}
                    onClick={() => onTab(entry.id)}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      {entry.icon}
                    </svg>
                    {entry.label}
                  </button>
                )
              })}
            </div>
            <button
              type="button"
              className="px-3 py-2 text-muted hover:text-ink"
              aria-label="Collapse panel"
              title="Collapse"
              onClick={onToggle}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="m9 6 6 6-6 6" />
              </svg>
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
        </section>
      ) : (
        <nav
          className="pointer-events-auto flex w-10 shrink-0 flex-col items-center gap-1 border-l border-line bg-surface py-2"
          aria-label="Map panel"
        >
          <button
            type="button"
            className="mb-1 rounded-md p-1.5 text-muted hover:text-ink"
            aria-label="Open panel"
            title="Open"
            onClick={onToggle}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m15 6-6 6 6 6" />
            </svg>
          </button>
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`flex flex-col items-center gap-0.5 rounded-md px-1 py-1.5 text-[9px] ${
                tab === entry.id ? 'font-semibold text-brand' : 'text-muted hover:text-body'
              }`}
              title={entry.label}
              onClick={() => {
                onTab(entry.id)
                onToggle()
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                {entry.icon}
              </svg>
              {entry.label}
            </button>
          ))}
        </nav>
      )}
    </div>
  )
}
