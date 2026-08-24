import { useState } from 'react'
import type { DealStage, Property } from '../types'

/**
 * The pipeline sidebar: sites grouped under the stages the broker named.
 *
 * Dragging a card between groups is how a site moves through the pipeline, so
 * the whole list is a drop target rather than each row having a menu. A stage
 * can be hidden, which takes its pins off the map without deleting anything —
 * useful when a survey has forty passed sites cluttering the view.
 */

interface Props {
  stages: DealStage[]
  properties: Property[]
  selectedId: string | null
  onSelect: (id: string) => void
  onMove: (propertyId: string, stageId: string | null) => void
  onToggleHidden: (stage: DealStage) => void
  onAddStage: (name: string) => void
  onRenameStage: (stage: DealStage, name: string) => void
  onDeleteStage: (stage: DealStage) => void
}

export default function StageSidebar({
  stages,
  properties,
  selectedId,
  onSelect,
  onMove,
  onToggleHidden,
  onAddStage,
  onRenameStage,
  onDeleteStage,
}: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)

  const unstaged = properties.filter(
    (property) => !property.stageId || !stages.some((stage) => stage.id === property.stageId),
  )

  const submitNew = () => {
    const name = newName.trim()
    if (name) onAddStage(name)
    setNewName('')
    setAdding(false)
  }

  // `null` as a target means the unstaged bucket.
  const dropHandlers = (target: string | null) => ({
    onDragOver: (event: React.DragEvent) => {
      event.preventDefault()
      setDragOver(target ?? '__unstaged__')
    },
    onDragLeave: () => setDragOver(null),
    onDrop: (event: React.DragEvent) => {
      event.preventDefault()
      setDragOver(null)
      const propertyId = event.dataTransfer.getData('text/property-id')
      if (propertyId) onMove(propertyId, target)
    },
  })

  const isOver = (target: string | null) => dragOver === (target ?? '__unstaged__')

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-white/5 px-3 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Sites</h2>
        <span className="ml-auto text-xs text-slate-500">{properties.length}</span>
        <button
          type="button"
          className="btn-secondary px-2 py-1 text-xs"
          onClick={() => setAdding(true)}
          aria-label="Add stage"
        >
          + Stage
        </button>
      </header>

      {adding ? (
        <div className="flex gap-2 border-b border-white/5 px-3 py-2">
          <input
            autoFocus
            className="input flex-1 py-1 text-sm"
            placeholder="Stage name"
            aria-label="New stage name"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submitNew()
              if (event.key === 'Escape') {
                setAdding(false)
                setNewName('')
              }
            }}
          />
          <button type="button" className="btn-primary px-2 py-1 text-xs" onClick={submitNew}>
            Add
          </button>
        </div>
      ) : null}

      <div className="flex-1 overflow-y-auto">
        {stages.map((stage) => {
          const sites = properties.filter((property) => property.stageId === stage.id)
          const isCollapsed = collapsed[stage.id]
          return (
            <section
              key={stage.id}
              className={`border-l-2 transition-colors ${isOver(stage.id) ? 'bg-white/[0.06]' : ''}`}
              style={{ borderLeftColor: stage.color }}
              {...dropHandlers(stage.id)}
            >
              <div className="flex items-center gap-2 px-3 py-2">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: stage.color }}
                  aria-hidden
                />
                {renaming === stage.id ? (
                  <input
                    autoFocus
                    className="input flex-1 py-0.5 text-sm"
                    defaultValue={stage.name}
                    aria-label={`Rename ${stage.name}`}
                    onBlur={(event) => {
                      onRenameStage(stage, event.target.value)
                      setRenaming(null)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur()
                      if (event.key === 'Escape') setRenaming(null)
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="truncate text-sm font-semibold text-slate-200"
                    onDoubleClick={() => setRenaming(stage.id)}
                    title="Double-click to rename"
                  >
                    {stage.name}
                  </button>
                )}
                <span className="text-xs text-slate-500">({sites.length})</span>

                <button
                  type="button"
                  className="ml-auto text-slate-500 hover:text-slate-200"
                  onClick={() => onToggleHidden(stage)}
                  aria-label={stage.hidden ? `Show ${stage.name} on the map` : `Hide ${stage.name} from the map`}
                  aria-pressed={stage.hidden}
                >
                  {stage.hidden ? <EyeOff /> : <Eye />}
                </button>
                <button
                  type="button"
                  className="text-slate-500 hover:text-slate-200"
                  onClick={() => setCollapsed((current) => ({ ...current, [stage.id]: !current[stage.id] }))}
                  aria-label={isCollapsed ? `Expand ${stage.name}` : `Collapse ${stage.name}`}
                  aria-expanded={!isCollapsed}
                >
                  <Chevron open={!isCollapsed} />
                </button>
                <button
                  type="button"
                  className="text-slate-600 hover:text-rose-400"
                  onClick={() => onDeleteStage(stage)}
                  aria-label={`Delete ${stage.name}`}
                  title="Sites in this stage become unstaged"
                >
                  <Times />
                </button>
              </div>

              {!isCollapsed ? (
                <ul className="space-y-1 px-2 pb-2">
                  {sites.map((property) => (
                    <SiteCard
                      key={property.id}
                      property={property}
                      color={stage.color}
                      dimmed={stage.hidden}
                      selected={property.id === selectedId}
                      onSelect={onSelect}
                    />
                  ))}
                  {sites.length === 0 ? (
                    <li className="px-2 py-2 text-xs text-slate-600">Drag a site here</li>
                  ) : null}
                </ul>
              ) : null}
            </section>
          )
        })}

        <section
          className={`mt-2 border-t border-white/5 transition-colors ${isOver(null) ? 'bg-white/[0.06]' : ''}`}
          {...dropHandlers(null)}
        >
          <h3 className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Unstaged</h3>
          <ul className="space-y-1 px-2 pb-4">
            {unstaged.map((property) => (
              <SiteCard
                key={property.id}
                property={property}
                color="#64748b"
                selected={property.id === selectedId}
                onSelect={onSelect}
              />
            ))}
            {unstaged.length === 0 ? (
              <li className="rounded-lg border border-dashed border-white/10 px-3 py-4 text-center text-xs text-slate-600">
                Drop here to unstage
              </li>
            ) : null}
          </ul>
        </section>
      </div>
    </div>
  )
}

function SiteCard({
  property,
  color,
  selected,
  dimmed,
  onSelect,
}: {
  property: Property
  color: string
  selected: boolean
  dimmed?: boolean
  onSelect: (id: string) => void
}) {
  return (
    <li>
      <div
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData('text/property-id', property.id)
          event.dataTransfer.effectAllowed = 'move'
        }}
        className={`flex cursor-grab items-center gap-2 rounded-lg border px-2 py-2 text-left active:cursor-grabbing ${
          selected ? 'border-teal-400/40 bg-teal-400/10' : 'border-white/5 bg-white/[0.02] hover:bg-white/[0.05]'
        } ${dimmed ? 'opacity-50' : ''}`}
      >
        <span className="text-slate-600" aria-hidden>
          <Grip />
        </span>
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onSelect(property.id)}>
          <span className="block truncate text-sm text-slate-100">{property.name || 'Untitled site'}</span>
          <span className="block truncate text-xs text-slate-500">{property.address || 'No address'}</span>
        </button>
      </div>
    </li>
  )
}

/* Inline icons — small enough that a dependency would cost more than it saves. */

function Eye() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function EyeOff() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M2 12s3.5-7 10-7c1.7 0 3.2.5 4.5 1.2M22 12s-3.5 7-10 7c-1.7 0-3.2-.5-4.5-1.2" />
      <path d="m3 3 18 18" />
    </svg>
  )
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 120ms' }}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

function Times() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  )
}

function Grip() {
  return (
    <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden>
      <circle cx="2" cy="2" r="1.2" />
      <circle cx="8" cy="2" r="1.2" />
      <circle cx="2" cy="7" r="1.2" />
      <circle cx="8" cy="7" r="1.2" />
      <circle cx="2" cy="12" r="1.2" />
      <circle cx="8" cy="12" r="1.2" />
    </svg>
  )
}
