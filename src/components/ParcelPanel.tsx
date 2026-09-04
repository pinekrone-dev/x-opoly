/*
 * Everything the county says about one parcel.
 *
 * The card on the map is a summary — enough to know whether this is the lot
 * you meant. This is the rest, and it is driven entirely by the market's own
 * panel spec rather than a fixed list of fields: Travis County publishes a
 * deed date and a subdivision, Broward a building area and a year built,
 * Orange County no owner name at all. A hardcoded panel would invent rows for
 * the counties that have none and hide the ones that are actually there.
 */

export interface PanelRow {
  k: string
  l: string
  f?: string
  always?: boolean
  yes?: string
  no?: string
}

export interface PanelGroup {
  group: string
  rows: PanelRow[]
}

type Cell = string | number | null | undefined

/**
 * A cell by key. A dotted key reaches into a nested bag: the values the
 * daily harvest folds onto a row ride under `x`, so a market's panel spec
 * names them `x.bp`, `x.hpd`, and a bag that is not there reads as empty.
 */
function pick(bag: Record<string, unknown>, key: string): Cell {
  if (!key.includes('.')) return bag[key] as Cell
  let at: unknown = bag
  for (const step of key.split('.')) {
    if (at === null || typeof at !== 'object') return undefined
    at = (at as Record<string, unknown>)[step]
  }
  return at !== null && typeof at === 'object' ? undefined : (at as Cell)
}

/** Formats one cell, or returns null when there is nothing worth a row. */
function format(row: PanelRow, value: Cell, codes: Record<string, { d?: string }>, code?: string): string | null {
  if (row.f === 'code') {
    const label = (code && codes[code]?.d) || ''
    if (!code && !label) return null
    return label ? `${code} · ${label}` : String(code)
  }
  if (row.f === 'yesno') return value ? row.yes || 'Yes' : row.no || 'No'

  const empty = value === undefined || value === null || value === '' || value === 0
  if (empty && !row.always) return null
  if (empty) return '—'

  switch (row.f) {
    case 'money':
      return `$${Math.round(Number(value)).toLocaleString()}`
    case 'acres':
      return `${Number(value).toFixed(2)} ac`
    case 'sqft':
      return `${Number(value).toLocaleString()} sq ft`
    case 'int':
      return Number(value).toLocaleString()
    case 'one':
      return Number(value).toFixed(1)
    case 'pct':
      return `${Number(value).toFixed(1)}%`
    default:
      return String(value)
  }
}

export default function ParcelPanel({
  title,
  subtitle,
  groups,
  attributes,
  details,
  codes,
  neighborhood,
  note,
  loading,
  onClose,
  embedded = false,
  children,
  extra,
}: {
  title: string
  subtitle: string
  groups: PanelGroup[]
  /** What the index knows: everything the list and filters read. */
  attributes: Record<string, Cell>
  /** What the detail file adds, once it has arrived. */
  details: Record<string, Cell> | null
  codes: Record<string, { d?: string }>
  /** Census figures for the tract this parcel sits in, when the layer has them. */
  neighborhood?: { label: string; value: string }[] | null
  /** The market's own caveat about what these numbers are. */
  note?: string
  loading?: boolean
  onClose: () => void
  /**
   * Inside a host panel rather than floating over the map on its own: the
   * GIS view's right panel supplies the frame, this supplies the record.
   */
  embedded?: boolean
  /** Leads the panel: what the broker's own records say about this parcel. */
  children?: React.ReactNode
  /**
   * Sections the switched-on layers contribute — ownership groups, a picked
   * permit or zoning district — after the county's own rows.
   */
  extra?: React.ReactNode
}) {
  const read = (key: string): Cell => {
    const own = pick(attributes, key)
    if (own !== null && own !== undefined) return own
    return details ? pick(details, key) : undefined
  }

  return (
    <aside
      className={
        embedded
          ? 'flex h-full flex-col'
          : 'absolute right-0 top-0 z-[600] flex h-full w-96 flex-col border-l border-line bg-surface shadow-2xl'
      }
    >
      <header className="flex items-start gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-ink">{title}</h2>
          <p className="truncate text-xs text-muted">{subtitle}</p>
        </div>
        <button type="button" className="text-muted hover:text-ink" aria-label="Close parcel" onClick={onClose}>
          ×
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {children}

        {groups.map((group) => {
          const cells = group.rows
            .map((row) => ({ row, text: format(row, read(row.k), codes, String(read('sc') ?? '')) }))
            .filter((entry) => entry.text !== null)
          if (!cells.length) return null
          return (
            <section key={group.group} className="mb-3 border-t border-line pt-2 first:border-t-0 first:pt-0">
              <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
                {group.group}
              </h3>
              <dl className="space-y-1 text-xs">
                {cells.map(({ row, text }) => (
                  <div key={row.k} className="flex justify-between gap-3">
                    <dt className="shrink-0 text-muted">{row.l}</dt>
                    <dd className="break-words text-right text-body">{text}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )
        })}

        {loading && <p className="text-[11px] text-muted">Loading the county's full record…</p>}

        {neighborhood && neighborhood.length > 0 && (
          <PanelSection title="Neighborhood">
            <dl className="space-y-1 text-xs">
              {neighborhood.map((entry) => (
                <div key={entry.label} className="flex justify-between gap-3">
                  <dt className="text-muted">{entry.label}</dt>
                  <dd className="text-right text-body">{entry.value}</dd>
                </div>
              ))}
            </dl>
          </PanelSection>
        )}

        {extra}

        {note && (
          <p
            className="border-t border-line pt-2 text-[11px] leading-snug text-faint [&_a]:text-brand [&_a]:underline"
            dangerouslySetInnerHTML={{ __html: note }}
          />
        )}
      </div>
    </aside>
  )
}

/** One titled block in the panel, in the same dress as the county's groups. */
export function PanelSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-3 border-t border-line pt-2 first:border-t-0 first:pt-0">
      <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">{title}</h3>
      {children}
    </section>
  )
}
