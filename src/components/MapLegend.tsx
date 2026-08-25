import { useState } from 'react'
import { METRIC_DEFINITIONS, colorFor, formatMetric } from './DemographicsPanel'
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
/** The gradient bar with low, median and high in real units. */
export function DemographicScale({
  colorBy,
  scale,
}: {
  colorBy: string
  scale: { min: number; max: number; median?: number }
}) {
  const definition = METRIC_DEFINITIONS.find((metric) => metric.key === colorBy)
  const format = definition?.format ?? 'count'
  const stops = [0, 0.25, 0.5, 0.75, 1]
    .map((t) => colorFor(scale.min + t * (scale.max - scale.min), scale.min, scale.max))
    .join(', ')
  return (
    <div className="mt-1.5 px-0.5">
      <div className="h-2 rounded-full" style={{ background: `linear-gradient(to right, ${stops})` }} aria-hidden />
      <div className="mt-0.5 flex justify-between text-[10px] text-faint">
        <span>{formatMetric(scale.min, format)}</span>
        {scale.median != null ? <span className="text-body">{formatMetric(scale.median, format)} med</span> : null}
        <span>{formatMetric(scale.max, format)}</span>
      </div>
    </div>
  )
}

export default function MapLegend({
  stages,
  properties,
  zones,
  onToggleStage,
  onDeleteZone,
  demographics,
  onDemographics,
  readOnly = false,
}: {
  stages: DealStage[]
  properties: Property[]
  zones: Zone[]
  onToggleStage: (stage: DealStage) => void
  onDeleteZone: (id: string) => void
  /** The choropleth control: which metric shades the map, over what radius. */
  demographics?: {
    colorBy: string | null
    radius: number
    busy: boolean
    /** The active shading's value range, drawn as the legend's colour scale. */
    scale?: { min: number; max: number; median?: number } | null
  } | null
  onDemographics?: (colorBy: string | null, radius: number) => void
  /** The client's legend: stage toggles work, but nothing can be removed. */
  readOnly?: boolean
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

          {stages.length > 0 || unstaged > 0 ? (
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
          ) : null}

          {zones.length > 0 ? (
          <div className="mt-2 border-t border-line pt-2">
            <p className="label mb-1">Zones</p>
            {zones.map((zone) => (
              <div key={zone.id} className="flex items-center gap-2 px-1.5 py-1 text-xs">
                {/*
                  * A stroke sample rather than a dot: the map draws zones as
                  * a dashed ring with a faint fill, so the key shows that
                  * exact line — otherwise the legend claims a solid boundary
                  * the map never draws.
                  */}
                <svg width="18" height="10" viewBox="0 0 18 10" aria-hidden className="shrink-0">
                  <line
                    x1="1"
                    y1="5"
                    x2="17"
                    y2="5"
                    stroke={zone.color}
                    strokeWidth="2"
                    strokeDasharray="6 4"
                    strokeLinecap="round"
                  />
                </svg>
                <span className="min-w-0 flex-1 truncate text-body">
                  {zone.label} · {zone.radiusMiles} mi
                </span>
                {readOnly ? null : (
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
                )}
              </div>
            ))}
          </div>
          ) : null}

          {demographics && (readOnly ? demographics.colorBy : onDemographics) ? (
            <div className="mt-2 border-t border-line pt-2">
              <p className="label mb-1">Data enrichment</p>
              {readOnly ? (
                <p className="px-0.5 text-xs text-body">
                  {METRIC_DEFINITIONS.find((metric) => metric.key === demographics.colorBy)?.label ??
                    demographics.colorBy}
                </p>
              ) : (
                <>
                  <select
                    className="field w-full px-2 py-1 text-xs"
                    aria-label="Enrich the map with a census metric"
                    value={demographics.colorBy ?? ''}
                    onChange={(event) => onDemographics?.(event.target.value || null, demographics.radius)}
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
                          onClick={() => onDemographics?.(demographics.colorBy, miles)}
                        >
                          {miles} mi
                        </button>
                      ))}
                    </div>
                  ) : null}
                </>
              )}

              {/* The colour scale itself: what light-to-dark means in numbers. */}
              {demographics.colorBy && demographics.scale ? (
                <DemographicScale colorBy={demographics.colorBy} scale={demographics.scale} />
              ) : null}
              {demographics.busy ? <p className="mt-1 text-[11px] text-faint">Loading census data…</p> : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
