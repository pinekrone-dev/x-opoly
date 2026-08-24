import { useEffect, useState } from 'react'
import type { CrawlSummary } from '../types'
import { elapsed, formatNumber, pathOf } from '../lib/format'

interface Props {
  summary: CrawlSummary
}

export default function ProgressPanel({ summary }: Props) {
  // Re-render once a second so the elapsed timer keeps moving between events.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (summary.finishedAt) return
    const timer = setInterval(() => setTick((value) => value + 1), 1000)
    return () => clearInterval(timer)
  }, [summary.finishedAt])

  const percent = Math.min(100, Math.round((summary.crawled / Math.max(1, summary.maxPages)) * 100))
  const stopping = summary.status === 'stopping'

  return (
    <section className="panel animate-fade-in p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <div className="flex items-center gap-2.5">
          <span className="relative flex h-2.5 w-2.5" aria-hidden>
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/70" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent" />
          </span>
          <h2 className="text-sm font-semibold text-slate-100">
            {stopping ? 'Finishing current requests…' : 'Crawling'} {summary.rootUrl.replace(/^https?:\/\//, '')}
          </h2>
        </div>
        <dl className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-xs text-slate-400">
          <div>
            <dt className="inline text-slate-500">found </dt>
            <dd className="inline text-slate-200">{formatNumber(summary.crawled)}</dd>
          </div>
          <div>
            <dt className="inline text-slate-500">queued </dt>
            <dd className="inline text-slate-200">{formatNumber(summary.queued)}</dd>
          </div>
          <div>
            <dt className="inline text-slate-500">in flight </dt>
            <dd className="inline text-slate-200">{summary.active}</dd>
          </div>
          <div>
            <dt className="inline text-slate-500">elapsed </dt>
            <dd className="inline text-slate-200">{elapsed(summary.startedAt, summary.finishedAt)}</dd>
          </div>
        </dl>
      </div>

      <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full bg-gradient-to-r from-accent-deep via-accent to-accent-soft transition-[width] duration-500"
          style={{ width: `${Math.max(3, percent)}%` }}
          role="progressbar"
          aria-valuenow={summary.crawled}
          aria-valuemin={0}
          aria-valuemax={summary.maxPages}
          aria-label="Pages crawled"
        />
      </div>

      <ul className="mt-3 space-y-1 font-mono text-xs text-slate-500">
        {summary.current.slice(0, 3).map((url) => (
          <li key={url} className="truncate">
            <span className="text-accent/70">GET</span> {pathOf(url)}
          </li>
        ))}
        {summary.current.length === 0 && <li className="text-slate-600">waiting for responses…</li>}
      </ul>

      {summary.robots.available && (
        <p className="mt-3 text-xs text-slate-500">
          robots.txt found
          {summary.robots.blocked > 0 && ` — ${formatNumber(summary.robots.blocked)} URLs skipped by its rules`}
          {summary.robots.crawlDelay ? ` — honouring a ${summary.robots.crawlDelay}s crawl delay` : ''}
        </p>
      )}
    </section>
  )
}
