import { useMemo, useState } from 'react'
import type { Page } from '../types'
import { formatMs, formatNumber, pathOf, statusLabel, statusTone, truncate } from '../lib/format'

interface Props {
  pages: Page[]
  selected: Set<string>
  onToggle: (url: string) => void
  onToggleMany: (urls: string[], include: boolean) => void
}

type SortKey = 'url' | 'status' | 'depth' | 'title' | 'wordCount' | 'internalLinks' | 'responseMs'
type Filter = 'all' | 'included' | 'excluded' | 'problems' | 'redirects' | 'noindex'

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'included', label: 'In sitemap' },
  { id: 'excluded', label: 'Left out' },
  { id: 'problems', label: 'Errors' },
  { id: 'redirects', label: 'Redirects' },
  { id: 'noindex', label: 'Noindex' },
]

const COLUMNS: { key: SortKey; label: string; className: string; numeric?: boolean }[] = [
  { key: 'status', label: 'Status', className: 'w-20' },
  { key: 'url', label: 'URL', className: 'min-w-0' },
  { key: 'title', label: 'Title', className: 'hidden lg:table-cell w-64' },
  { key: 'depth', label: 'Depth', className: 'w-16 text-right', numeric: true },
  { key: 'wordCount', label: 'Words', className: 'hidden sm:table-cell w-20 text-right', numeric: true },
  { key: 'internalLinks', label: 'Links', className: 'hidden sm:table-cell w-16 text-right', numeric: true },
  { key: 'responseMs', label: 'Time', className: 'hidden md:table-cell w-20 text-right', numeric: true },
]

const PAGE_SIZE = 250

export default function PageTable({ pages, selected, onToggle, onToggleMany }: Props) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [sort, setSort] = useState<{ key: SortKey; direction: 1 | -1 }>({ key: 'url', direction: 1 })
  const [limit, setLimit] = useState(PAGE_SIZE)

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()

    const filtered = pages.filter((page) => {
      if (needle && !page.url.toLowerCase().includes(needle) && !(page.title || '').toLowerCase().includes(needle)) {
        return false
      }
      switch (filter) {
        case 'included':
          return selected.has(page.url)
        case 'excluded':
          return !selected.has(page.url)
        case 'problems':
          return page.status === 0 || page.status >= 400
        case 'redirects':
          return Boolean(page.redirectTo)
        case 'noindex':
          return page.noindex
        default:
          return true
      }
    })

    const { key, direction } = sort
    return filtered.sort((a, b) => {
      const left = a[key] ?? ''
      const right = b[key] ?? ''
      if (typeof left === 'number' && typeof right === 'number') return (left - right) * direction
      return String(left).localeCompare(String(right)) * direction
    })
  }, [pages, query, filter, sort, selected])

  const shown = visible.slice(0, limit)
  const allShownSelected = shown.length > 0 && shown.every((page) => selected.has(page.url))

  const applySort = (key: SortKey) => {
    setSort((current) => (current.key === key ? { key, direction: current.direction === 1 ? -1 : 1 } : { key, direction: 1 }))
  }

  return (
    <section className="panel">
      <header className="panel-header flex-wrap">
        <div className="flex flex-wrap items-center gap-1">
          {FILTERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`tab px-2.5 py-1 text-xs ${filter === entry.id ? 'tab-active' : ''}`}
              onClick={() => {
                setFilter(entry.id)
                setLimit(PAGE_SIZE)
              }}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-slate-500">{formatNumber(visible.length)} URLs</span>
          <input
            className="field w-44 py-1.5 text-xs"
            type="search"
            placeholder="Filter by URL or title"
            aria-label="Filter URLs"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setLimit(PAGE_SIZE)
            }}
          />
        </div>
      </header>

      <div className="scrollbar-thin max-h-[36rem] overflow-auto">
        <table className="w-full table-fixed border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-ink-850/95 backdrop-blur">
            <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500">
              <th scope="col" className="w-10 px-3 py-2">
                <input
                  className="checkbox"
                  type="checkbox"
                  checked={allShownSelected}
                  aria-label="Select every URL shown"
                  onChange={() => onToggleMany(shown.map((page) => page.url), !allShownSelected)}
                />
              </th>
              {COLUMNS.map((column) => (
                <th key={column.key} scope="col" className={`px-3 py-2 font-semibold ${column.className}`}>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 hover:text-slate-200"
                    onClick={() => applySort(column.key)}
                  >
                    {column.label}
                    {sort.key === column.key && <span aria-hidden>{sort.direction === 1 ? '↑' : '↓'}</span>}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((page) => (
              <tr key={page.url} className="border-t border-white/5 align-middle hover:bg-white/[0.03]">
                <td className="px-3 py-1.5">
                  <input
                    className="checkbox"
                    type="checkbox"
                    checked={selected.has(page.url)}
                    aria-label={`Include ${page.url} in the sitemap`}
                    onChange={() => onToggle(page.url)}
                  />
                </td>
                <td className="px-3 py-1.5">
                  <span className={`pill ${statusTone(page.status)}`}>{statusLabel(page.status)}</span>
                </td>
                <td className="max-w-0 px-3 py-1.5">
                  <a
                    className="block truncate font-mono text-xs text-slate-300 hover:text-accent"
                    href={page.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    title={page.url}
                  >
                    {pathOf(page.url)}
                  </a>
                  {page.redirectTo && (
                    <span className="block truncate font-mono text-[11px] text-amber-300/80" title={page.redirectTo}>
                      → {pathOf(page.redirectTo)}
                    </span>
                  )}
                  {page.error && <span className="block truncate text-[11px] text-rose-300/80">{page.error}</span>}
                </td>
                <td className="hidden max-w-0 px-3 py-1.5 text-xs text-slate-400 lg:table-cell">
                  <span className="block truncate" title={page.title || ''}>
                    {truncate(page.title, 48)}
                  </span>
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-xs text-slate-400">{page.depth}</td>
                <td className="hidden px-3 py-1.5 text-right font-mono text-xs text-slate-400 sm:table-cell">
                  {page.wordCount ? formatNumber(page.wordCount) : '—'}
                </td>
                <td className="hidden px-3 py-1.5 text-right font-mono text-xs text-slate-400 sm:table-cell">
                  {page.internalLinks || '—'}
                </td>
                <td className="hidden px-3 py-1.5 text-right font-mono text-xs text-slate-400 md:table-cell">
                  {formatMs(page.responseMs)}
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length + 1} className="px-3 py-10 text-center text-sm text-slate-500">
                  No URLs match this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {visible.length > shown.length && (
          <div className="border-t border-white/5 p-3 text-center">
            <button type="button" className="btn-secondary text-xs" onClick={() => setLimit((value) => value + PAGE_SIZE)}>
              Show {formatNumber(Math.min(PAGE_SIZE, visible.length - shown.length))} more
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
