import { useEffect, useMemo, useRef, useState } from 'react'
import CrawlForm from './components/CrawlForm'
import EmptyState from './components/EmptyState'
import ExportPanel from './components/ExportPanel'
import Header from './components/Header'
import IssuesPanel from './components/IssuesPanel'
import PageTable from './components/PageTable'
import ProgressPanel from './components/ProgressPanel'
import StatsBar from './components/StatsBar'
import TreeView from './components/TreeView'
import { fetchResult, startCrawl, stopCrawl, subscribeToCrawl } from './api'
import type { CrawlOptions, CrawlResult, CrawlSummary, ExportSettings, Page } from './types'
import { formatNumber } from './lib/format'

const DEFAULT_OPTIONS: CrawlOptions = {
  maxPages: 250,
  maxDepth: 8,
  concurrency: 5,
  delayMs: 0,
  timeoutMs: 15000,
  respectRobots: true,
  includeSubdomains: false,
  includeDocuments: true,
  stripQuery: false,
  seedFromSitemap: true,
  checkExternalLinks: false,
  includePatterns: '',
  excludePatterns: '',
}

const DEFAULT_EXPORT: ExportSettings = {
  priorityMode: 'depth',
  fixedPriority: 0.5,
  changefreqMode: 'depth',
  fixedChangefreq: 'weekly',
  includeLastmod: true,
  includeAlternates: false,
}

type Tab = 'tree' | 'pages' | 'issues' | 'export'

const TABS: { id: Tab; label: string }[] = [
  { id: 'tree', label: 'Structure' },
  { id: 'pages', label: 'URLs' },
  { id: 'issues', label: 'Findings' },
  { id: 'export', label: 'Sitemap' },
]

/** The URLs that belong in a sitemap unless someone says otherwise. */
function defaultSelection(pages: Page[]): Set<string> {
  return new Set(
    pages
      .filter(
        (page) =>
          page.ok &&
          page.status < 300 &&
          !page.redirectTo &&
          !page.noindex &&
          (!page.canonical || page.canonical === page.url),
      )
      .map((page) => page.url),
  )
}

export default function App() {
  const [url, setUrl] = useState('')
  const [options, setOptions] = useState<CrawlOptions>(DEFAULT_OPTIONS)
  const [exportSettings, setExportSettings] = useState<ExportSettings>(DEFAULT_EXPORT)

  const [summary, setSummary] = useState<CrawlSummary | null>(null)
  const [result, setResult] = useState<CrawlResult | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [tab, setTab] = useState<Tab>('tree')
  const [error, setError] = useState<string | null>(null)

  const unsubscribe = useRef<(() => void) | null>(null)
  const pollTimer = useRef<number | null>(null)

  const running = Boolean(summary && (summary.status === 'running' || summary.status === 'queued' || summary.status === 'stopping'))

  useEffect(
    () => () => {
      unsubscribe.current?.()
      if (pollTimer.current) window.clearInterval(pollTimer.current)
    },
    [],
  )

  const loadResult = async (id: string) => {
    try {
      const finished = await fetchResult(id)
      setResult(finished)
      setSummary(finished)
      setSelected(defaultSelection(finished.pages))
      if (finished.status === 'error' && finished.error) setError(finished.error)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The crawl finished but its results could not be loaded.')
    }
  }

  const beginCrawl = async () => {
    unsubscribe.current?.()
    if (pollTimer.current) window.clearInterval(pollTimer.current)
    setError(null)
    setResult(null)
    setSelected(new Set())
    setTab('tree')

    try {
      const { id, rootUrl } = await startCrawl(url, options)
      setSummary({
        id,
        rootUrl,
        status: 'queued',
        error: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        crawled: 0,
        queued: 1,
        active: 0,
        maxPages: options.maxPages,
        current: [],
        robots: { available: false, blocked: 0, crawlDelay: null, sitemaps: [] },
      })

      unsubscribe.current = subscribeToCrawl(id, {
        onProgress: setSummary,
        onDone: () => {
          void loadResult(id)
        },
        onError: () => {
          // The stream dropped — fall back to polling until the crawl settles.
          if (pollTimer.current) window.clearInterval(pollTimer.current)
          pollTimer.current = window.setInterval(async () => {
            try {
              const response = await fetch(`/api/crawl/${id}`)
              if (!response.ok) throw new Error('lost')
              const current: CrawlSummary = await response.json()
              setSummary(current)
              if (current.status !== 'running' && current.status !== 'queued' && current.status !== 'stopping') {
                window.clearInterval(pollTimer.current!)
                pollTimer.current = null
                void loadResult(id)
              }
            } catch {
              if (pollTimer.current) window.clearInterval(pollTimer.current)
              pollTimer.current = null
              setError('Lost contact with the crawler.')
            }
          }, 1500)
        },
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The crawl could not be started.')
      setSummary(null)
    }
  }

  const halt = async () => {
    if (!summary) return
    try {
      await stopCrawl(summary.id)
    } catch {
      setError('The crawl could not be stopped.')
    }
  }

  const toggleUrl = (target: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(target)) next.delete(target)
      else next.add(target)
      return next
    })
  }

  const toggleMany = (urls: string[], include: boolean) => {
    setSelected((current) => {
      const next = new Set(current)
      for (const entry of urls) {
        if (include) next.add(entry)
        else next.delete(entry)
      }
      return next
    })
  }

  const selectedUrls = useMemo(
    () => (result ? result.pages.filter((page) => selected.has(page.url)).map((page) => page.url) : []),
    [result, selected],
  )

  const issueCount = result?.audit.issues.reduce((total, issue) => total + (issue.severity === 'info' ? 0 : 1), 0) ?? 0

  return (
    <div className="mx-auto flex min-h-full max-w-[92rem] flex-col px-4 py-6 sm:px-6 lg:px-8">
      <Header />

      <div className="grid gap-4">
        <CrawlForm
          url={url}
          onUrlChange={setUrl}
          options={options}
          onOptionsChange={setOptions}
          onSubmit={beginCrawl}
          onStop={halt}
          running={running}
          error={error}
        />

        {summary && running && <ProgressPanel summary={summary} />}

        {!summary && !result && <EmptyState onPick={(example) => setUrl(example)} />}

        {result && (
          <>
            <StatsBar stats={result.audit.stats} selected={selected.size} />

            <div className="flex flex-wrap items-center justify-between gap-3">
              <nav className="flex gap-1" aria-label="Result views">
                {TABS.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className={`tab ${tab === entry.id ? 'tab-active' : ''}`}
                    onClick={() => setTab(entry.id)}
                  >
                    {entry.label}
                    {entry.id === 'issues' && issueCount > 0 && (
                      <span className="ml-1.5 rounded bg-amber-500/20 px-1.5 py-0.5 font-mono text-[10px] text-amber-300">
                        {issueCount}
                      </span>
                    )}
                  </button>
                ))}
              </nav>

              <p className="text-xs text-slate-500">
                {formatNumber(result.pages.length)} URLs crawled
                {result.status === 'stopped' && ' — stopped early'}
                {result.crawled >= result.maxPages && ' — page limit reached'}
                {' · '}
                <button type="button" className="text-accent hover:underline" onClick={() => setSelected(defaultSelection(result.pages))}>
                  reset selection
                </button>
              </p>
            </div>

            {tab === 'tree' && (
              <TreeView pages={result.pages} rootUrl={result.rootUrl} selected={selected} onToggle={toggleUrl} />
            )}
            {tab === 'pages' && (
              <PageTable pages={result.pages} selected={selected} onToggle={toggleUrl} onToggleMany={toggleMany} />
            )}
            {tab === 'issues' && <IssuesPanel issues={result.audit.issues} />}
            {tab === 'export' && (
              <ExportPanel
                jobId={result.id}
                urls={selectedUrls}
                settings={exportSettings}
                onSettingsChange={setExportSettings}
              />
            )}
          </>
        )}
      </div>

      <footer className="mt-8 border-t border-white/5 pt-4 text-xs text-slate-600">
        Crawl responsibly: only run this against sites you own or have permission to scan.
      </footer>
    </div>
  )
}
