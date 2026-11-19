import { useEffect, useState } from 'react'
import { api } from '../api'
import { PanelSection } from './ParcelPanel'
import type { CrimeAnswer } from '../lib/crime'

/*
 * Reported crime round the selected lot: violent and property offenses
 * within a quarter, a half and a mile over the last twelve months the police
 * agency has published, each with where it stands among the market's own
 * parcels. A lot another agency polices is told so by name, with no figures:
 * a blank is not a zero. Shown only in markets whose agency publishes each
 * offense with a place (CRIME_MARKETS).
 */
const MILES: Record<number, string> = { 0.25: '¼ mi', 0.5: '½ mi', 1: '1 mi' }
const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' })
const TITLE: Record<string, string> = { violent: 'Violent', property: 'Property', other: 'Other' }

export default function CrimeNearby({ market, lat, lng }: { market: string; lat: number; lng: number }) {
  const [answer, setAnswer] = useState<CrimeAnswer | null | 'failed' | 'none'>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let cancelled = false
    setAnswer(null)
    api.parcels
      .crime(market, lat, lng)
      .then((a) => { if (!cancelled) setAnswer(a) })
      .catch((error: { status?: number }) => { if (!cancelled) setAnswer(error?.status === 404 ? 'none' : 'failed') })
    return () => { cancelled = true }
  }, [market, lat, lng])

  if (answer === 'none') return null
  const short = (name: string | null) => name ?? 'the police'
  return (
    <PanelSection title="Crime nearby">
      {answer === null ? (
        <p className="text-xs text-muted">Counting what was reported round this lot…</p>
      ) : answer === 'failed' ? (
        <p className="text-xs text-muted">The crime figures could not be read just now.</p>
      ) : !answer.covered ? (
        <p className="text-xs leading-snug text-body">
          {answer.elsewhere
            ? `This lot is in ${answer.elsewhere}, which has its own police. Their reported crime is not published here, so there are no figures for it.`
            : 'This lot is outside the area of the police agency whose reported crime is published here, so there are no figures for it.'}
        </p>
      ) : (
        <>
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-muted">
                <th className="py-0.5 text-left font-normal">Reported, last 12 months</th>
                {answer.rings.map((r) => (
                  <th key={r.miles} className="w-14 py-0.5 text-right font-normal">{MILES[r.miles] ?? `${r.miles} mi`}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {(['violent', 'property'] as const).map((kind) => (
                <tr key={kind}>
                  <td className="py-1 text-body">{TITLE[kind]} crime</td>
                  {answer.rings.map((r) => {
                    const above = kind === 'violent' ? r.violentAbove : r.propertyAbove
                    return (
                      <td key={r.miles} className="py-1 text-right align-top">
                        <span className="font-semibold text-ink">{r[kind].toLocaleString('en-US')}</span>
                        {above != null ? (
                          <span className="block text-[10px] text-faint" title={`More than ${above}% of the parcels ${short(answer.agency)} polices, counted the same way`}>
                            &gt; {above}%
                          </span>
                        ) : null}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {answer.rings.some((r) => r.covered < 0.98) ? (
            <p className="mt-1 text-[11px] leading-snug text-amber-700">
              Part of the {answer.rings.filter((r) => r.covered < 0.98).map((r) => MILES[r.miles] ?? `${r.miles} mi`).join(', ')} {answer.rings.filter((r) => r.covered < 0.98).length > 1 ? 'circles lie' : 'circle lies'} where another agency polices. Offenses there are not counted, so those figures run low.
            </p>
          ) : null}
          <p className="mt-1.5 text-[10px] leading-snug text-faint">
            Offenses reported to {short(answer.agency)}, {day(answer.from)} to {day(answer.to)}.
            {answer.compared ? ` The small figure is the share of the ${answer.compared.parcels.toLocaleString('en-US')} parcels compared that have fewer.` : ''}
          </p>
          {answer.categories.length ? (
            <>
              <button type="button" className="mt-1 text-[11px] font-medium text-brand hover:underline" onClick={() => setOpen((o) => !o)}>
                {open ? 'Hide the categories' : 'What was reported'}
              </button>
              {open ? (
                <>
                  <ul className="mt-1 divide-y divide-line">
                    {answer.categories.slice(0, 10).map((c) => (
                      <li key={`${c.category}:${c.kind}`} className="flex items-baseline justify-between gap-2 py-0.5 text-[11px]">
                        <span className="text-body">
                          {c.category.charAt(0) + c.category.slice(1).toLowerCase()}
                          <span className="ml-1 text-faint">{TITLE[c.kind].toLowerCase()}</span>
                        </span>
                        <span className="whitespace-nowrap text-ink">{c.counts.map((n) => n.toLocaleString('en-US')).join(' · ')}</span>
                      </li>
                    ))}
                  </ul>
                  {answer.definitions.violent ? <p className="mt-1 text-[10px] leading-snug text-faint">Violent: {answer.definitions.violent}</p> : null}
                  {answer.definitions.property ? <p className="text-[10px] leading-snug text-faint">Property: {answer.definitions.property}</p> : null}
                  {answer.notes.map((note) => (
                    <p key={note} className="text-[10px] leading-snug text-faint">{note}</p>
                  ))}
                  {answer.source?.page ? (
                    <a className="text-[10px] text-brand hover:underline" href={answer.source.page} target="_blank" rel="noreferrer">{answer.source.name}</a>
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </PanelSection>
  )
}
