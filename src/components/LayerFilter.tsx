import { useEffect, useMemo, useState } from 'react'

/**
 * A zoning layer's pivot, as the pipeline counts it: every city on the
 * layer, the categories inside it, the codes inside those. Counts are
 * districts.
 */
export interface PivotCity {
  city: string
  count: number
  categories: { category: string; count: number; codes: [string, number][] }[]
}

/**
 * One code under one city. The same code in two cities is two keys. The
 * separator is a control character no code contains, and the map's filter
 * builds the same key from each feature's City and Zoning.
 */
export const pivotKey = (city: string, code: string) => `${city}\u001f${code}`

/**
 * The filter on a zoning layer, worked like a pivot table.
 *
 * Thirteen cities' codes side by side are not one list: C-2 in Phoenix and
 * C-2 in Mesa are different districts with the same letters. So the tree is
 * city first, then category, then the codes, each with its count, and a
 * tick at any level takes everything under it. Nothing ticked means
 * everything drawn; the first tick narrows the map to what is ticked, and
 * "Show everything" puts it back.
 */
export default function LayerFilter({
  label,
  pivot,
  selected,
  colors,
  onChange,
  onClose,
}: {
  label: string
  pivot: PivotCity[]
  /** The keys drawn, or null for all of them. */
  selected: Set<string> | null
  /** The code's colour on the map, when the layer has a palette. */
  colors?: Record<string, string>
  onChange: (next: Set<string> | null) => void
  onClose: () => void
}) {
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState<Set<string>>(() => new Set(pivot.length === 1 ? [pivot[0].city] : []))

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const everyKey = useMemo(() => {
    const out: string[] = []
    for (const city of pivot) for (const cat of city.categories) for (const [code] of cat.codes) out.push(pivotKey(city.city, code))
    return out
  }, [pivot])

  const needle = search.trim().toLowerCase()
  const has = (key: string) => selected === null || selected.has(key)

  /** Tick or untick a set of keys together. */
  const toggle = (keys: string[], on: boolean) => {
    if (on) {
      if (selected === null) return
      const next = new Set(selected)
      for (const key of keys) next.add(key)
      onChange(next.size >= everyKey.length ? null : next)
      return
    }
    const next = new Set(selected ?? everyKey)
    for (const key of keys) next.delete(key)
    onChange(next)
  }
  /** Ticking from "everything" narrows to just these. */
  const only = (keys: string[]) => onChange(new Set(keys))

  const state = (keys: string[]): 'all' | 'none' | 'some' => {
    if (selected === null) return 'all'
    let n = 0
    for (const key of keys) if (selected.has(key)) n += 1
    return n === 0 ? 'none' : n === keys.length ? 'all' : 'some'
  }
  const shown = selected === null ? everyKey.length : selected.size

  const Box = ({ keys, name }: { keys: string[]; name: string }) => {
    const st = state(keys)
    return (
      <input
        type="checkbox"
        aria-label={name}
        className="h-3.5 w-3.5 shrink-0 accent-brand"
        checked={st === 'all'}
        ref={(el) => {
          if (el) el.indeterminate = st === 'some'
        }}
        onClick={(event) => event.stopPropagation()}
        onChange={() => {
          if (selected === null) only(keys)
          else toggle(keys, st !== 'all')
        }}
      />
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Filter ${label}`}
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-xl flex-col rounded-xl border border-line bg-surface shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-ink">Filter {label.toLowerCase()}</p>
            <p className="text-[11px] text-muted">
              {shown === everyKey.length
                ? `Every code in ${pivot.length} ${pivot.length === 1 ? 'city' : 'cities'} is drawn.`
                : `${shown.toLocaleString()} of ${everyKey.length.toLocaleString()} codes drawn.`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {selected !== null ? (
              <button type="button" className="btn-secondary text-xs" onClick={() => onChange(null)}>
                Show everything
              </button>
            ) : null}
            <button type="button" className="btn-primary text-xs" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
        <div className="border-b border-line px-4 py-2">
          <input
            className="field h-8 text-xs"
            type="search"
            placeholder="Find a code: C-2, R1-6, PAD"
            aria-label="Find a zoning code"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          {pivot.map((city) => {
            const cityKeys = city.categories.flatMap((cat) => cat.codes.map(([code]) => pivotKey(city.city, code)))
            const isOpen = open.has(city.city) || Boolean(needle)
            const cats = needle
              ? city.categories
                  .map((cat) => ({ ...cat, codes: cat.codes.filter(([code]) => code.toLowerCase().includes(needle)) }))
                  .filter((cat) => cat.codes.length)
              : city.categories
            if (needle && cats.length === 0) return null
            const drawn = selected === null ? cityKeys.length : cityKeys.filter((key) => selected.has(key)).length
            return (
              <section key={city.city} className="mb-1 rounded-lg border border-line">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-sunken"
                  onClick={() =>
                    setOpen((current) => {
                      const next = new Set(current)
                      if (next.has(city.city)) next.delete(city.city)
                      else next.add(city.city)
                      return next
                    })
                  }
                  aria-expanded={isOpen}
                >
                  <Box keys={cityKeys} name={`${city.city}, every code`} />
                  <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">{city.city || 'Unnamed'}</span>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted">
                    {drawn === cityKeys.length ? `${cityKeys.length} codes` : `${drawn} of ${cityKeys.length} codes`} · {city.count.toLocaleString()} districts
                  </span>
                  <span aria-hidden className="text-faint">{isOpen ? '▾' : '▸'}</span>
                </button>
                {isOpen ? (
                  <div className="space-y-1.5 border-t border-line px-2 py-2">
                    {cats.map((cat) => {
                      const catKeys = cat.codes.map(([code]) => pivotKey(city.city, code))
                      return (
                        <div key={cat.category}>
                          <label className="flex items-center gap-2 text-[11px] font-medium text-body">
                            <Box keys={catKeys} name={`${city.city}, ${cat.category}`} />
                            <span className="min-w-0 flex-1 truncate">{cat.category}</span>
                            <span className="shrink-0 tabular-nums text-faint">{cat.count.toLocaleString()}</span>
                          </label>
                          <ul className="ml-5 mt-1 flex flex-wrap gap-1">
                            {cat.codes.map(([code, count]) => {
                              const key = pivotKey(city.city, code)
                              const on = has(key)
                              return (
                                <li key={code}>
                                  <button
                                    type="button"
                                    aria-pressed={on}
                                    onClick={() => (selected === null ? only([key]) : toggle([key], !on))}
                                    className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] ${
                                      on ? 'border-brand/40 bg-brand/5 text-ink' : 'border-line text-faint line-through'
                                    }`}
                                    title={`${code}: ${count.toLocaleString()} districts`}
                                  >
                                    <span
                                      className="h-2 w-2 shrink-0 rounded-sm"
                                      style={{ backgroundColor: colors?.[code] ?? '#94a3b8', opacity: on ? 1 : 0.4 }}
                                    />
                                    {code}
                                    <span className="tabular-nums text-faint">{count.toLocaleString()}</span>
                                  </button>
                                </li>
                              )
                            })}
                          </ul>
                        </div>
                      )
                    })}
                  </div>
                ) : null}
              </section>
            )
          })}
        </div>
        <p className="border-t border-line px-4 py-2 text-[11px] text-faint">
          Tick a city or a category to take everything under it. The first tick narrows the map to that alone.
        </p>
      </div>
    </div>
  )
}
