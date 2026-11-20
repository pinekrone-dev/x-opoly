import { useState } from 'react'

/*
 * The map's key, on the map.
 *
 * The side panels are taken: layers and filters on the left, the clicked
 * lot's record on the right, with the legend behind a tab the record covers.
 * So what the colours on the map mean is said along the map's own bottom
 * edge, between the panels, where it is in view whatever else is open. One
 * entry for each thing drawn: the layer's name, then a swatch for each of
 * its colours (the commonest few where it has many), or a ramp where it
 * shades from low to high. It folds to a single button for a map with
 * nothing in the way.
 */
export interface KeyEntry {
  id: string
  label: string
  /** How the layer draws: a dot, a filled area, a line, or a ramp from low to high. */
  kind: 'point' | 'polygon' | 'line' | 'ramp'
  /** Its one colour, where it has one. */
  color?: string
  /** Its colours by category, commonest first: [name, colour]. */
  swatches?: [string, string][]
  /** How many more categories it has than the swatches shown. */
  more?: number
  /** A ramp's colours, low to high, and what its ends are. */
  ramp?: string[]
  low?: string
  high?: string
}

const MOST = 6

function Swatch({ kind, color }: { kind: KeyEntry['kind']; color: string }) {
  if (kind === 'line') return <i className="inline-block h-0.5 w-3 shrink-0 rounded" style={{ background: color }} aria-hidden />
  return <i className={`inline-block h-2.5 w-2.5 shrink-0 ${kind === 'point' ? 'rounded-full border border-white shadow-[0_0_0_0.5px_rgba(0,0,0,0.25)]' : 'rounded-sm'}`} style={{ background: color }} aria-hidden />
}

export default function MapKey({ entries, left, right }: { entries: KeyEntry[]; /** CSS lengths: how far in from each side of the map the panels reach. */ left: string; right: string }) {
  const [open, setOpen] = useState(true)
  if (!entries.length) return null
  return (
    <div className="pointer-events-none absolute bottom-8 z-[510] hidden md:flex" style={{ left, right }} data-testid="map-key">
      <div className="pointer-events-auto flex max-w-full items-start gap-2 rounded-lg border border-line bg-surface/95 px-2.5 py-1.5 shadow-lg backdrop-blur">
        <button
          type="button"
          className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-muted hover:text-ink"
          aria-expanded={open}
          title={open ? 'Fold the legend away' : 'Show what the colours mean'}
          onClick={() => setOpen((was) => !was)}
        >
          Legend {open ? '▾' : `▸ ${entries.length}`}
        </button>
        {open ? (
          <ul className="flex max-h-24 min-w-0 flex-wrap items-center gap-x-4 gap-y-1 overflow-y-auto">
            {entries.map((entry) => (
              <li key={entry.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-body">
                <span className="font-semibold text-ink">{entry.label}</span>
                {entry.kind === 'ramp' && entry.ramp ? (
                  <span className="flex items-center gap-1 text-[10px] text-muted">
                    {entry.low}
                    <span className="flex h-2 w-16 overflow-hidden rounded" aria-hidden>
                      {entry.ramp.map((hue, i) => <i key={`${hue}:${i}`} className="flex-1" style={{ background: hue }} />)}
                    </span>
                    {entry.high}
                  </span>
                ) : entry.swatches?.length ? (
                  <>
                    {entry.swatches.slice(0, MOST).map(([name, color]) => (
                      <span key={name} className="flex items-center gap-1 whitespace-nowrap">
                        <Swatch kind={entry.kind} color={color} />
                        {name || 'Not stated'}
                      </span>
                    ))}
                    {entry.swatches.length > MOST || entry.more ? <span className="text-faint">+{Math.max(0, entry.swatches.length - MOST) + (entry.more ?? 0)} more</span> : null}
                  </>
                ) : entry.color ? (
                  <Swatch kind={entry.kind} color={entry.color} />
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  )
}
