import { useEffect, useState } from 'react'
import { api } from '../api'
import { PanelSection } from './ParcelPanel'
import type { ZoningLine, ZoningReport as Report } from '../types'

/*
 * What the zoning code allows on a City of Los Angeles lot: setbacks,
 * height, floor area, coverage and density, each line cited to its section
 * of the Municipal Code, from the lot's measured shape and neighbours. A
 * line that rests on measured data says "estimate"; one the code text does
 * not yet settle says "check" and why, rather than showing a number.
 */
const LOT_TYPE: Record<string, string> = {
  interior: 'Interior lot', corner: 'Corner lot', 'reversed corner': 'Reversed corner lot', key: 'Key lot',
  through: 'Through lot', flag: 'Flag lot', 'no street frontage': 'No street frontage found',
}

function value(line: ZoningLine) {
  if (line.value == null) return null
  const n = line.unit === 'sq ft' ? Math.round(line.value).toLocaleString('en-US') : String(line.value)
  return line.unit === '%' ? `${n}%` : `${n} ${line.unit ?? ''}`.trim()
}

export default function ZoningReport({ market, apn }: { market: string; apn: string }) {
  const [report, setReport] = useState<Report | null | 'failed'>(null)
  const [open, setOpen] = useState<Record<number, boolean>>({})
  useEffect(() => {
    let cancelled = false
    setReport(null)
    api.parcels
      .zoning(market, apn)
      .then((r) => { if (!cancelled) setReport(r) })
      .catch(() => { if (!cancelled) setReport('failed') })
    return () => { cancelled = true }
  }, [market, apn])

  if (report && report !== 'failed' && !report.covered && !report.lot) return null
  return (
    <PanelSection title="What the zoning allows">
      {report === null ? (
        <p className="text-xs text-muted">Reading the code against this lot…</p>
      ) : report === 'failed' ? (
        <p className="text-xs text-muted">The zoning report could not be built just now.</p>
      ) : (
        <>
          <p className="text-xs text-body">
            <span className="font-semibold text-ink">{report.zone}</span>
            {report.lot?.type ? <> · {LOT_TYPE[report.lot.type] ?? report.lot.type}</> : null}
            {report.lot?.width_ft && report.lot?.depth_ft ? <> · about {Math.round(report.lot.width_ft)} × {Math.round(report.lot.depth_ft)} ft</> : null}
            {report.lot?.hillside ? <> · Hillside Area</> : null}
            {report.lot?.coastal ? <> · Coastal Zone</> : null}
          </p>
          {report.lot?.why ? <p className="mt-0.5 text-[11px] text-muted">{report.lot.why}</p> : null}
          {report.lines?.length ? (
            <ul className="mt-1.5 divide-y divide-line">
              {report.lines.map((line, i) => (
                <li key={`${line.label}-${i}`} className="py-1">
                  <button type="button" className="flex w-full items-baseline justify-between gap-2 text-left"
                    onClick={() => setOpen((o) => ({ ...o, [i]: !o[i] }))}>
                    <span className="text-[11px] text-body">{line.label}</span>
                    <span className={`whitespace-nowrap text-[11px] font-semibold ${line.status === 'review' ? 'text-amber-700' : 'text-ink'}`}>
                      {line.status === 'review' ? 'check' : value(line) ?? '—'}
                      {line.status === 'estimate' ? <span className="ml-1 font-normal text-faint">est.</span> : null}
                    </span>
                  </button>
                  <p className="text-[10px] text-faint">{line.cite.section}</p>
                  {open[i] ? <p className="mt-0.5 text-[11px] leading-snug text-muted">{line.basis}</p> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {report.flags?.length ? (
            <ul className="mt-1.5 space-y-0.5">
              {report.flags.map((f) => (
                <li key={f} className="text-[11px] leading-snug text-amber-700">{f}</li>
              ))}
            </ul>
          ) : null}
          {report.note ? <p className="mt-1.5 text-[10px] leading-snug text-faint">{report.note}</p> : null}
          {report.sources?.length ? (
            <p className="mt-1 text-[10px] leading-snug text-faint">Sources: {report.sources.join('; ')}.</p>
          ) : null}
        </>
      )}
    </PanelSection>
  )
}
