import { useState } from 'react'
import { METRIC_DEFINITIONS } from './DemographicsPanel'
import type { DealStage, Property, Zone } from '../types'

/**
 * The map's legend, and the home of zones.
 *
 * Reads like a paper map's key — each stage with its colour and count — and
 * each row toggles that stage's pins, the same state as the sidebar's eye
 * icons, so the two controls never disagree. Zones (non-compete circles) are
 * created and removed here too, because a boundary belongs to the map, not
 * to any one site.
 */
export default function MapLegend({
  stages,
  properties,
  zones,
  onToggleStage,
  onDeleteZone,
  demographics,
  onDemographics,
}: {
  stages: DealStage[]
  properties: Property[]
  zones: Zone[]
  onToggleStage: (stage: DealStage) => void
  onDeleteZone: (id: string) => void
  /** The choropleth control: which metric shades the map, over what radius. */
  demographics?: { colorBy: string | null; radius: number; busy: boolean } | null
  onDemographics?: (colorBy: string | null, radius: number) => void
}) {
  // Collapsed by default on a phone: an open legend covers half the map.
  const [open, setOpen] = useState(() => typeof window === 'undefined' || window.innerWidth >= 1024)

  const countFor = (stage: DealStage) =>
    properties.filter((property) => property.stageId === stage.id).length
  const unstaged = properties.filter((property) => !property.stageId).length

  return (
    <div className="absolute bottom-6 left-3 z-[500]">
      {!open ? (
        <button
          type="button"
          className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-semibold text-body shadow-sm hover:bg-sunken"
          onClick={() => setOpen(true)}
        >
          Legend
        </button>
      ) : (
        <div className="panel w-60 p-3 shadow-lg">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-ink">Legend</p>
            <button
              type="button"
              className="btn-ghost px-1.5 py-0.5 text-xs"
              onClick={() => setOpen(false)}
              aria-label="Collapse the legend"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
          </div>

          <ul className="mt-2">
            {stages.map((stage) => (
              <li key={stage.id}>
                <button
                  type="button"
                  className={`flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-sunken ${
                    stage.hidden ? 'opacity-45' : ''
                  }`}
                  onClick={() => onToggleStage(stage)}
                  aria-pressed={!stage.hidden}
                  title={stage.hidden ? 'Show these pins' : 'Hide these pins'}
                >
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: stage.color }} aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-body">{stage.name}</span>
                  <span className="text-faint">{countFor(stage)}</span>
                </button>
              </li>
            ))}
            {unstaged > 0 ? (
              <li className="flex items-center gap-2 px-1.5 py-1 text-xs text-muted">
                <span className="h-2.5 w-2.5 rounded-full bg-slate-400" aria-hidden />
                <span className="flex-1">Unstaged</span>
                <span className="text-faint">{unstaged}</span>
              </li>
            ) : null}
          </ul>

          <div className="mt-2 border-t border-line pt-2">
            <p className="label mb-1">Zones</p>
            {zones.map((zone) => (
              <div key={zone.id} className="flex items-center gap-2 px-1.5 py-1 text-xs">
                <span
                  className="h-2.5 w-2.5 rounded-full border-2 border-dashed"
                  style={{ borderColor: zone.color }}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate text-body">
                  {zone.label} · {zone.radiusMiles} mi
                </span>
                <button
                  type="button"
                  className="btn-ghost px-1 py-0.5 text-faint hover:text-rose-600"
                  onClick={() => onDeleteZone(zone.id)}
                  aria-label={`Remove the ${zone.label} zone`}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}

          </div>

          {demographics && onDemographics ? (
            <div className="mt-2 border-t border-line pt-2">
              <p className="label mb-1">Demographics</p>
              <select
                className="field w-full px-2 py-1 text-xs"
                aria-label="Shade the map by a census metric"
                value={demographics.colorBy ?? ''}
                onChange={(event) => onDemographics(event.target.value || null, demographics.radius)}
              >
                <option value="">Off</option>
                {METRIC_DEFINITIONS.map((metric) => (
                  <option key={metric.key} value={metric.key}>
                    {metric.label}
                  </option>
                ))}
              </select>
              {demographics.colorBy ? (
                <div className="mt-1.5 flex gap-1">
                  {[1, 3, 5].map((miles) => (
                    <button
                      key={miles}
                      type="button"
                      className={`tab px-2 py-0.5 text-xs ${demographics.radius === miles ? 'tab-active' : ''}`}
                      onClick={() => onDemographics(demographics.colorBy, miles)}
                    >
                      {miles} mi
                    </button>
                  ))}
                </div>
              ) : null}
              {demographics.busy ? <p className="mt-1 text-[11px] text-faint">Loading census data…</p> : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
