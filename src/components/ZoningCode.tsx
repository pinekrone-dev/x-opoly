import { useEffect, useState } from 'react'
import { api } from '../api'
import { PanelSection } from './ParcelPanel'
import type { CodeSource, CodeStandard, ZoningCodeAnswer } from '../types'

/*
 * Highest and best use, as far as zoning decides it: what the city's own
 * published rules allow in this lot's district, and what a lot of this size
 * could carry under them.
 *
 * The district is read by AI from the rules and every figure is checked
 * against the page it came from: a figure whose quoted words are on the page
 * links to it; one where only the number could be found says "check". The
 * lot arithmetic multiplies those figures by the county's lot size and is
 * marked as an estimate. Shown only in markets whose code is indexed.
 */
const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString('en-US') : String(Math.round(n * 100) / 100))

function figure(line: CodeStandard) {
  if (line.unit === '%') return `${fmt(line.value)}%`
  if (line.key === 'far') return line.value <= 30 ? `${fmt(line.value)} : 1` : `${fmt(line.value)}%`
  return `${fmt(line.value)} ${line.unit}`
}

function Page({ source }: { source: CodeSource | null }) {
  if (!source) return null
  const label = `${source.title}${source.page ? `, p. ${source.page}` : ''}`
  return source.url ? (
    <a className="text-[10px] text-faint underline decoration-dotted hover:text-ink" href={source.url} target="_blank" rel="noreferrer">
      {label}
    </a>
  ) : (
    <span className="text-[10px] text-faint">{label}</span>
  )
}

// Markets found to have no indexed code, so a click on the next parcel
// there asks nothing. Kept for the page's life; a reload asks again.
const uncovered = new Set<string>()

export default function ZoningCode({ market, zone, acres }: { market: string; zone: string; acres: number | null }) {
  const [state, setState] = useState<ZoningCodeAnswer | null | 'failed'>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [question, setQuestion] = useState('')
  const [asked, setAsked] = useState<{ q: string; a: ZoningCodeAnswer | null; error?: string } | null>(null)
  const [asking, setAsking] = useState(false)

  useEffect(() => {
    let cancelled = false
    setAsked(null)
    if (uncovered.has(market)) {
      setState({ covered: false })
      return
    }
    setState(null)
    api.parcels
      .zoningCode(market, { zone, acres })
      .then((r) => {
        if (!r.covered) uncovered.add(market)
        if (!cancelled) setState(r)
      })
      .catch(() => { if (!cancelled) setState('failed') })
    return () => { cancelled = true }
  }, [market, zone, acres])

  const ask = async (event: React.FormEvent) => {
    event.preventDefault()
    const q = question.trim()
    if (!q || asking) return
    setAsking(true)
    setAsked({ q, a: null })
    try {
      setAsked({ q, a: await api.parcels.zoningCode(market, { zone, question: q }) })
      setQuestion('')
    } catch (cause) {
      setAsked({ q, a: null, error: cause instanceof Error ? cause.message : 'The zoning code could not be read just now.' })
    } finally {
      setAsking(false)
    }
  }

  // A market with no indexed code shows nothing at all, not an empty box.
  if (state && state !== 'failed' && !state.covered) return null
  if (state === 'failed') return null
  const brief = state?.brief ?? null
  const about = state?.about

  return (
    <PanelSection title="Highest & best use · zoning">
      {state === null ? (
        <p className="text-xs text-muted">Reading the zoning code for {zone}…</p>
      ) : (
        <>
          <p className="text-xs text-body">
            <span className="font-semibold text-ink">{zone}</span>
            {about?.jurisdiction ? <> · {about.jurisdiction}</> : null}
          </p>
          {brief?.summary ? <p className="mt-0.5 text-[11px] leading-snug text-muted">{brief.summary}</p> : null}
          {brief?.highestUse ? (
            <p className="mt-1.5 text-[11px] text-body">
              Most intensive use by right: <span className="font-semibold text-ink">{brief.highestUse}</span>
            </p>
          ) : null}

          {state.yield?.length ? (
            <ul className="mt-1.5 divide-y divide-line rounded border border-line px-2">
              {state.yield.map((line) => (
                <li key={line.label} className="flex items-baseline justify-between gap-2 py-1">
                  <span className="text-[11px] text-body">
                    {line.label}
                    <span className="block text-[10px] text-faint">{line.basis}</span>
                  </span>
                  <span className="whitespace-nowrap text-[11px] font-semibold text-ink">
                    {fmt(line.value)} {line.unit}
                    <span className="ml-1 font-normal text-faint">{line.check ? 'check' : 'est.'}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {brief?.standards.length ? (
            <ul className="mt-1.5 divide-y divide-line">
              {brief.standards.map((line) => (
                <li key={line.key} className="py-1">
                  <button type="button" className="flex w-full items-baseline justify-between gap-2 text-left"
                    onClick={() => setOpen((o) => ({ ...o, [line.key]: !o[line.key] }))}>
                    <span className="text-[11px] text-body">{line.label}</span>
                    <span className={`whitespace-nowrap text-[11px] font-semibold ${line.status === 'check' ? 'text-amber-700' : 'text-ink'}`}>
                      {figure(line)}
                      {line.status === 'check' ? <span className="ml-1 font-normal">check</span> : null}
                    </span>
                  </button>
                  <Page source={line.source} />
                  {open[line.key] ? (
                    <p className="mt-0.5 text-[11px] leading-snug text-muted">
                      {line.quote ? <>The page says: “{line.quote}”</> : 'The figure is on the pages read, but not in the words quoted for it. Read the district’s table before relying on it.'}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}

          {brief?.uses.length ? (
            <p className="mt-1.5 text-[11px] leading-snug text-body">
              <span className="text-muted">Uses named: </span>
              {brief.uses.map((u, i) => (
                <span key={u.use}>
                  {i ? ', ' : ''}
                  {u.use}
                  {u.how !== 'by right' ? <span className="text-faint"> ({u.how})</span> : null}
                </span>
              ))}
            </p>
          ) : null}
          {brief?.notes.length ? (
            <ul className="mt-1 space-y-0.5">
              {brief.notes.map((n) => <li key={n} className="text-[11px] leading-snug text-amber-700">{n}</li>)}
            </ul>
          ) : null}

          <form onSubmit={ask} className="mt-2 flex gap-1.5">
            <input
              className="min-w-0 flex-1 rounded border border-line bg-white px-2 py-1 text-[11px] text-ink placeholder:text-faint focus:border-ink focus:outline-none"
              value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={300}
              placeholder={`Ask the code about ${zone}`} aria-label="Ask the zoning code"
            />
            <button type="submit" disabled={asking || !question.trim()}
              className="rounded border border-line px-2 py-1 text-[11px] font-semibold text-ink hover:bg-surface disabled:opacity-50">
              {asking ? 'Reading…' : 'Ask'}
            </button>
          </form>
          {asked ? (
            <div className="mt-1.5 rounded bg-surface px-2 py-1.5">
              <p className="text-[10px] text-faint">{asked.q}</p>
              {asked.error ? (
                <p className="text-[11px] text-amber-700">{asked.error}</p>
              ) : asked.a ? (
                <>
                  <p className="whitespace-pre-line text-[11px] leading-snug text-body">{asked.a.answer}</p>
                  {asked.a.sources?.length ? (
                    <p className="mt-1 space-x-2">
                      {asked.a.sources.slice(0, 4).map((s) => <Page key={s.key} source={s} />)}
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="text-[11px] text-muted">Reading the code…</p>
              )}
            </div>
          ) : null}

          {state.note ? <p className="mt-1.5 text-[10px] leading-snug text-faint">{state.note}</p> : null}
          {about ? (
            <p className="mt-1 text-[10px] leading-snug text-faint">
              Source:{' '}
              {about.url ? <a className="underline decoration-dotted" href={about.url} target="_blank" rel="noreferrer">{about.title}</a> : about.title}
              {about.publisher ? `, ${about.publisher}` : ''}
              {about.edition ? `, as amended through ${about.edition}` : ''}
              {about.asOf ? `; read ${about.asOf}` : ''}.
            </p>
          ) : null}
        </>
      )}
    </PanelSection>
  )
}
