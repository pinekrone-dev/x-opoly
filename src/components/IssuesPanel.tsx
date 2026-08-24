import { useState } from 'react'
import type { Issue } from '../types'
import { formatNumber, pathOf, severityTone } from '../lib/format'

interface Props {
  issues: Issue[]
}

export default function IssuesPanel({ issues }: Props) {
  const [open, setOpen] = useState<string | null>(issues[0]?.id ?? null)

  if (issues.length === 0) {
    return (
      <section className="panel p-10 text-center">
        <p className="text-sm font-semibold text-emerald-300">Nothing to flag.</p>
        <p className="mt-1 text-sm text-slate-500">Every crawled URL responded cleanly and is ready to publish.</p>
      </section>
    )
  }

  const counts = {
    error: issues.filter((issue) => issue.severity === 'error').length,
    warning: issues.filter((issue) => issue.severity === 'warning').length,
    info: issues.filter((issue) => issue.severity === 'info').length,
  }

  return (
    <section className="panel">
      <header className="panel-header">
        <h2 className="panel-title">Findings</h2>
        <div className="flex gap-1.5 text-[11px]">
          {counts.error > 0 && <span className={`pill ${severityTone('error')}`}>{counts.error} errors</span>}
          {counts.warning > 0 && <span className={`pill ${severityTone('warning')}`}>{counts.warning} warnings</span>}
          {counts.info > 0 && <span className={`pill ${severityTone('info')}`}>{counts.info} notes</span>}
        </div>
      </header>

      <ul className="divide-y divide-white/5">
        {issues.map((issue) => {
          const expanded = open === issue.id
          return (
            <li key={issue.id}>
              <button
                type="button"
                className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-white/[0.03]"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : issue.id)}
              >
                <span className={`pill ${severityTone(issue.severity)} w-14 justify-center`}>{formatNumber(issue.count)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-slate-100">{issue.label}</span>
                  <span className="block truncate text-xs text-slate-500">{issue.description}</span>
                </span>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  className={`shrink-0 text-slate-500 transition-transform ${expanded ? 'rotate-90' : ''}`}
                  aria-hidden
                >
                  <path d="m9 6 6 6-6 6" />
                </svg>
              </button>

              {expanded && (
                <div className="scrollbar-thin max-h-72 overflow-auto border-t border-white/5 bg-ink-950/40 px-5 py-3">
                  <ul className="space-y-1.5">
                    {issue.urls.map((entry) => (
                      <li key={`${issue.id}-${entry.url}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                        <a
                          className="font-mono text-xs text-slate-300 hover:text-accent"
                          href={entry.url}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          {pathOf(entry.url)}
                        </a>
                        {entry.detail && <span className="font-mono text-[11px] text-slate-500">{entry.detail}</span>}
                        {entry.from && (
                          <span className="text-[11px] text-slate-600">linked from {pathOf(entry.from)}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                  {issue.count > issue.urls.length && (
                    <p className="mt-2 text-xs text-slate-600">
                      and {formatNumber(issue.count - issue.urls.length)} more — the CSV export has the full list.
                    </p>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
