import { useEffect, useState } from 'react'
import { api } from '../api'
import { PanelSection } from './ParcelPanel'
import { RESULTS, RESULT_COLORS, type Feasibility } from '../lib/feasibility'

/*
 * A first screen of whether the selected lot can be built on: slope, FEMA
 * flood hazard, mapped wetlands and protected land, and the acres left after
 * those are taken out. Asked for, not run on every click: it reads four
 * federal services for the lot, which is worth doing for a lot someone is
 * weighing and not for every lot they pass over.
 */
export type SiteScreen = Feasibility & { outline: 'parcel' | 'box'; sources?: { name: string; page: string }[] }

const pct = (share: number) => `${Math.round(share * 1000) / 10}%`

function Row({ label, value, detail, warn }: { label: string; value: string; detail?: string | null; warn?: boolean }) {
  return (
    <li className="py-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-body">{label}</span>
        <span className={`whitespace-nowrap text-[11px] font-semibold ${warn ? 'text-amber-700' : 'text-ink'}`}>{value}</span>
      </div>
      {detail ? <p className="text-[10px] leading-snug text-faint">{detail}</p> : null}
    </li>
  )
}

export default function SiteFeasibility({ market, id, onScreen }: { market: string; id: string; onScreen?: (screen: SiteScreen | null) => void }) {
  const [screen, setScreen] = useState<SiteScreen | null | 'loading' | 'failed'>(null)
  // A new lot starts unasked, and the last lot's cells come off the map.
  useEffect(() => {
    setScreen(null)
    onScreen?.(null)
    // onScreen is the map's own setter; the lot is what this follows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market, id])
  const run = () => {
    setScreen('loading')
    api.parcels
      .feasibility(market, id)
      .then((found) => {
        setScreen(found)
        // Drawn on the map as it is read here: each cell coloured by what it came to.
        onScreen?.(found)
      })
      .catch(() => setScreen('failed'))
  }

  return (
    <PanelSection title="Site feasibility">
      {screen === null || screen === 'failed' ? (
        <>
          <p className="text-xs leading-snug text-muted">
            {screen === 'failed'
              ? 'The screen could not be run just now.'
              : 'Slope, flood hazard, wetlands and protected land on this lot, and the acres that pass all four.'}
          </p>
          <button type="button" className="mt-1.5 rounded-md border border-line px-2.5 py-1 text-[11px] font-medium text-brand hover:bg-sunken" onClick={run}>
            {screen === 'failed' ? 'Try again' : 'Screen this lot'}
          </button>
        </>
      ) : screen === 'loading' ? (
        <p className="text-xs text-muted">Reading the elevation, flood, wetland and protected-area maps for this lot…</p>
      ) : (
        <>
          <p className="text-xs text-body">
            <span className="font-semibold text-ink">{screen.buildable.acres.toLocaleString('en-US')} of {screen.acres.toLocaleString('en-US')} acres</span> pass the screen ({pct(screen.buildable.share)})
          </p>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-sunken" aria-hidden>
            <div className="h-full rounded-full bg-brand" style={{ width: `${Math.round(screen.buildable.share * 100)}%` }} />
          </div>
          <ul className="mt-1.5 divide-y divide-line">
            {screen.slope.available ? (
              <Row
                label="Slope"
                value={screen.slope.shareOverLimit > 0 ? `${pct(screen.slope.shareOverLimit)} over ${screen.slope.limitPercent}%` : `All ${screen.slope.limitPercent}% or less`}
                warn={screen.slope.shareOverLimit > 0}
                detail={`Mean ${screen.slope.meanPercent}%, steepest ${screen.slope.maxPercent}%. Ground from ${screen.slope.elevationMinFeet.toLocaleString('en-US')} to ${screen.slope.elevationMaxFeet.toLocaleString('en-US')} ft.`}
              />
            ) : (
              <Row label="Slope" value="Not screened" detail={screen.slope.reason} warn />
            )}
            {screen.flood.available ? (
              <Row
                label="Flood hazard area"
                value={!screen.flood.mapped ? 'Not mapped by FEMA' : screen.flood.shareInHazardArea > 0 ? pct(screen.flood.shareInHazardArea) : 'None'}
                warn={!screen.flood.mapped || screen.flood.shareInHazardArea > 0}
                detail={
                  screen.flood.mapped
                    ? `Zone ${screen.flood.zones.map((z) => `${z.zone}${z.subtype ? ` (${z.subtype.toLowerCase()})` : ''} ${pct(z.share)}`).join(', ')}`
                    : 'No flood zone is drawn on this ground, which is not the same as no hazard.'
                }
              />
            ) : (
              <Row label="Flood hazard area" value="Not screened" detail={screen.flood.reason} warn />
            )}
            {screen.wetlands.available ? (
              <Row
                label="Mapped wetland"
                value={screen.wetlands.share > 0 ? pct(screen.wetlands.share) : 'None'}
                warn={screen.wetlands.share > 0}
                detail={screen.wetlands.types.length ? [...new Set(screen.wetlands.types.map((t) => t.type))].join(', ') : null}
              />
            ) : (
              <Row label="Mapped wetland" value="Not screened" detail={screen.wetlands.reason} warn />
            )}
            {screen.protectedLand.available ? (
              <Row
                label="Protected or public land"
                value={screen.protectedLand.share > 0 ? pct(screen.protectedLand.share) : 'None'}
                warn={screen.protectedLand.share > 0}
                detail={
                  screen.protectedLand.units.length
                    ? screen.protectedLand.units.slice(0, 3).map((u) => (u.counted ? u.name : `inside the boundary of ${u.name}`)).join('; ')
                    : null
                }
              />
            ) : (
              <Row label="Protected or public land" value="Not screened" detail={screen.protectedLand.reason} warn />
            )}
          </ul>
          <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5" aria-label="What the colours on the map mean">
            {[...new Set(screen.map.results.filter((r) => r >= 0))].sort((a, b) => a - b).map((r) => (
              <li key={r} className="flex items-center gap-1 text-[10px] text-muted">
                <span className="inline-block h-2 w-2 rounded-sm" style={{ background: RESULT_COLORS[RESULTS[r]] }} />
                {RESULTS[r]}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[10px] leading-snug text-faint">
            Each cell is drawn on the map in its colour. A screen from public maps (USGS elevation, FEMA flood, the National Wetlands Inventory, PAD-US) over {screen.cells.count} cells about {screen.cells.spacingFeet} ft apart
            {screen.outline === 'box' ? ", on the lot's bounding box" : ''}. Not a survey, an elevation certificate or a wetland delineation; zoning, access and utilities are not part of it.
          </p>
        </>
      )}
    </PanelSection>
  )
}
