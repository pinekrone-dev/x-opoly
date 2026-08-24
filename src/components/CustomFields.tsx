import { useState } from 'react'
import type { CustomField } from '../types'

/**
 * The arbitrary rows on a site card.
 *
 * CRE listings publish whatever they publish — available SF, lease rate, NNN,
 * a suite breakdown, a zoning code — and no two agree. So rather than a fixed
 * set of columns the broker names their own rows here and drags them into the
 * order they want them read.
 */

const MAX_FIELDS = 15

/** Offered on an empty site so the common case is one click, not typing. */
const SUGGESTIONS = [
  'Available SF',
  'Lease Rate',
  'NNN',
  'Year Built',
  'Zoning',
  'Suite Options',
  'Property Type',
  'Building Size',
]

export default function CustomFields({
  fields,
  onChange,
}: {
  fields: CustomField[]
  onChange: (fields: CustomField[]) => void
}) {
  const [dragging, setDragging] = useState<number | null>(null)

  const update = (index: number, patch: Partial<CustomField>) => {
    onChange(fields.map((field, position) => (position === index ? { ...field, ...patch } : field)))
  }

  const remove = (index: number) => onChange(fields.filter((_, position) => position !== index))

  const add = (label = '') => {
    if (fields.length >= MAX_FIELDS) return
    onChange([...fields, { label, value: '' }])
  }

  const move = (from: number, to: number) => {
    if (from === to) return
    const next = [...fields]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    onChange(next)
  }

  const unused = SUGGESTIONS.filter(
    (suggestion) => !fields.some((field) => field.label.toLowerCase() === suggestion.toLowerCase()),
  )

  return (
    <div className="sm:col-span-2">
      <div className="mb-2 flex items-center gap-2">
        <span className="label mb-0">Custom</span>
        <span className="text-xs text-slate-500">
          ({fields.length}/{MAX_FIELDS})
        </span>
      </div>

      <ul className="space-y-1.5">
        {fields.map((field, index) => (
          <li
            key={index}
            className={`flex items-center gap-1.5 ${dragging === index ? 'opacity-40' : ''}`}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault()
              if (dragging != null) move(dragging, index)
              setDragging(null)
            }}
          >
            <span
              draggable
              onDragStart={() => setDragging(index)}
              onDragEnd={() => setDragging(null)}
              className="cursor-grab px-0.5 text-slate-600 active:cursor-grabbing"
              aria-hidden
            >
              <Grip />
            </span>
            <input
              className="field flex-1"
              placeholder="Label"
              aria-label={`Field ${index + 1} label`}
              value={field.label}
              onChange={(event) => update(index, { label: event.target.value })}
            />
            <input
              className="field flex-1"
              placeholder="Value"
              aria-label={`Field ${index + 1} value`}
              value={field.value ?? ''}
              onChange={(event) => update(index, { value: event.target.value })}
            />
            <button
              type="button"
              className="px-1 text-slate-600 hover:text-rose-400"
              onClick={() => remove(index)}
              aria-label={`Remove ${field.label || `field ${index + 1}`}`}
            >
              <Times />
            </button>
          </li>
        ))}
      </ul>

      {fields.length < MAX_FIELDS ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => add()}>
            + Add field
          </button>
          {unused.slice(0, 4).map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              className="rounded-md border border-white/10 px-2 py-1 text-xs text-slate-400 hover:bg-white/5 hover:text-slate-200"
              onClick={() => add(suggestion)}
            >
              + {suggestion}
            </button>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-xs text-slate-500">
          That is the maximum of {MAX_FIELDS} fields. Remove one to add another.
        </p>
      )}
    </div>
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

function Times() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  )
}
