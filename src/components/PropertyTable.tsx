import { useMemo, useState } from 'react'
import type { DealStage, Property } from '../types'
import { count, fullAddress, displayName, money, rate, sqft } from '../lib/format'

interface Props {
  properties: Property[]
  /** The survey's pipeline: filter chips, the stage column, and its sort order. */
  stages?: DealStage[]
  selectedId?: string | null
  onSelect: (id: string) => void
  readOnly?: boolean
}

type SortKey = 'name' | 'stage' | 'rentRate' | 'sizeSqft' | 'yearBuilt'

export default function PropertyTable({ properties, stages = [], selectedId, onSelect, readOnly }: Props) {
  const [sort, setSort] = useState<{ key: SortKey; direction: 1 | -1 }>({ key: 'name', direction: 1 })
  const [stageFilter, setStageFilter] = useState<string | 'all'>('all')

  const stageOf = (property: Property) => stages.find((stage) => stage.id === property.stageId) ?? null
  const stageRank = (property: Property) => {
    const index = stages.findIndex((stage) => stage.id === property.stageId)
    return index === -1 ? stages.length : index
  }

  const rows = useMemo(() => {
    const filtered = properties.filter(
      (property) => stageFilter === 'all' || (property.stageId ?? 'unstaged') === stageFilter,
    )
    return [...filtered].sort((a, b) => {
      const { key, direction } = sort
      if (key === 'name') return displayName(a).localeCompare(displayName(b)) * direction
      if (key === 'stage') return (stageRank(a) - stageRank(b)) * direction
      const left = (a[key] as number) ?? -Infinity
      const right = (b[key] as number) ?? -Infinity
      return (left - right) * direction
    })
  }, [properties, sort, stageFilter, stages])

  const applySort = (key: SortKey) =>
    setSort((current) => (current.key === key ? { key, direction: current.direction === 1 ? -1 : 1 } : { key, direction: 1 }))

  const columns: { key: SortKey; label: string; className: string }[] = [
    { key: 'name', label: 'Site', className: 'min-w-0' },
    { key: 'stage', label: 'Stage', className: 'w-36' },
    { key: 'rentRate', label: 'Asking', className: 'w-32 text-right' },
    { key: 'sizeSqft', label: 'Size', className: 'w-28 text-right' },
    { key: 'yearBuilt', label: 'Built', className: 'hidden w-20 text-right lg:table-cell' },
  ]

  return (
    <section className="panel flex min-h-0 flex-col">
      <header className="panel-header flex-wrap">
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            className={`tab px-2.5 py-1 text-xs ${stageFilter === 'all' ? 'tab-active' : ''}`}
            onClick={() => setStageFilter('all')}
          >
            All {properties.length}
          </button>
          {stages.map((stage) => {
            const total = properties.filter((property) => property.stageId === stage.id).length
            if (total === 0) return null
            return (
              <button
                key={stage.id}
                type="button"
                className={`tab px-2.5 py-1 text-xs ${stageFilter === stage.id ? 'tab-active' : ''}`}
                onClick={() => setStageFilter(stage.id)}
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: stage.color }} aria-hidden />
                {stage.name} {total}
              </button>
            )
          })}
          {properties.some((property) => !property.stageId) && (
            <button
              type="button"
              className={`tab px-2.5 py-1 text-xs ${stageFilter === 'unstaged' ? 'tab-active' : ''}`}
              onClick={() => setStageFilter('unstaged')}
            >
              Unstaged {properties.filter((property) => !property.stageId).length}
            </button>
          )}
        </div>
      </header>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-auto">
        <table className="w-full table-fixed border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-sunken">
            <tr className="text-left text-[11px] uppercase tracking-wider text-muted">
              {columns.map((column) => (
                <th key={column.key} scope="col" className={`px-4 py-2 font-semibold ${column.className}`}>
                  <button type="button" className="inline-flex items-center gap-1 hover:text-ink" onClick={() => applySort(column.key)}>
                    {column.label}
                    {sort.key === column.key && <span aria-hidden>{sort.direction === 1 ? '↑' : '↓'}</span>}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((property) => (
              <tr
                key={property.id}
                className={`cursor-pointer border-t border-line hover:bg-sunken ${
                  property.id === selectedId ? 'bg-brand/10' : ''
                }`}
                onClick={() => onSelect(property.id)}
              >
                <td className="max-w-0 px-4 py-2">
                  <span className="block truncate font-medium text-ink">{displayName(property)}</span>
                  <span className="block truncate text-xs text-muted">{fullAddress(property)}</span>
                </td>
                <td className="px-4 py-2">
                  {(() => {
                    const stage = stageOf(property)
                    return stage ? (
                      <span className="pill" style={{ background: `${stage.color}22`, color: stage.color }}>
                        <span className="h-1.5 w-1.5 rounded-full" style={{ background: stage.color }} aria-hidden />
                        {stage.name}
                      </span>
                    ) : (
                      <span className="pill bg-sunken text-muted">Unstaged</span>
                    )
                  })()}
                </td>
                <td className="px-4 py-2 text-right text-xs text-body">
                  {rate(property)}
                  {property.nnn != null && <span className="block text-[11px] text-muted">+{money(property.nnn)} NNN</span>}
                </td>
                <td className="px-4 py-2 text-right font-mono text-xs text-body">{sqft(property.sizeSqft)}</td>
                <td className="hidden px-4 py-2 text-right font-mono text-xs text-muted lg:table-cell">
                  {count(property.yearBuilt)}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-4 py-12 text-center text-sm text-muted">
                  {readOnly ? 'No sites in this survey yet.' : 'Nothing at this stage yet.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}
