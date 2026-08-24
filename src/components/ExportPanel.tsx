import { useEffect, useState } from 'react'
import { downloadFile, requestExport } from '../api'
import type { ExportFormat, ExportSettings } from '../types'
import { formatNumber } from '../lib/format'

interface Props {
  jobId: string
  urls: string[]
  settings: ExportSettings
  onSettingsChange: (settings: ExportSettings) => void
}

const MIME: Record<ExportFormat, string> = {
  xml: 'application/xml',
  txt: 'text/plain',
  csv: 'text/csv',
  html: 'text/html',
}

const DOWNLOADS: { format: ExportFormat; label: string; hint: string }[] = [
  { format: 'xml', label: 'sitemap.xml', hint: 'For Search Console and robots.txt' },
  { format: 'txt', label: 'sitemap.txt', hint: 'Plain list of URLs' },
  { format: 'html', label: 'sitemap.html', hint: 'A page for visitors' },
  { format: 'csv', label: 'report.csv', hint: 'Every field from the crawl' },
]

export default function ExportPanel({ jobId, urls, settings, onSettingsChange }: Props) {
  const [preview, setPreview] = useState('')
  const [robots, setRobots] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  // The preview comes from the same endpoint as the download, so what is on
  // screen is exactly what the file will contain.
  useEffect(() => {
    let cancelled = false
    setBusy(true)
    const timer = setTimeout(async () => {
      try {
        const response = await requestExport(jobId, 'xml', urls, settings)
        if (cancelled) return
        setPreview(response.files[0]?.content ?? '')
        setRobots(response.robotsLine)
        setError(null)
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not build the sitemap.')
      } finally {
        if (!cancelled) setBusy(false)
      }
    }, 350)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [jobId, urls, settings])

  const set = <K extends keyof ExportSettings>(key: K, value: ExportSettings[K]) => {
    onSettingsChange({ ...settings, [key]: value })
  }

  const copy = async (text: string, tag: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(tag)
      setTimeout(() => setCopied(null), 1800)
    } catch {
      setError('The browser blocked clipboard access.')
    }
  }

  const download = async (format: ExportFormat) => {
    try {
      const response = await requestExport(jobId, format, urls, settings)
      for (const file of response.files) downloadFile(file.name, file.content, MIME[format])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The export failed.')
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
      <div className="grid content-start gap-4">
        <section className="panel p-5">
          <h2 className="panel-title mb-4">Sitemap fields</h2>

          <div className="grid gap-4">
            <div>
              <label className="label" htmlFor="priority-mode">
                Priority
              </label>
              <div className="flex gap-2">
                <select
                  id="priority-mode"
                  className="field"
                  value={settings.priorityMode}
                  onChange={(event) => set('priorityMode', event.target.value as ExportSettings['priorityMode'])}
                >
                  <option value="depth">From page depth</option>
                  <option value="fixed">One value for all</option>
                  <option value="none">Leave out</option>
                </select>
                {settings.priorityMode === 'fixed' && (
                  <input
                    className="field w-24 font-mono"
                    type="number"
                    min={0}
                    max={1}
                    step={0.1}
                    aria-label="Priority value"
                    value={settings.fixedPriority}
                    onChange={(event) => set('fixedPriority', Number(event.target.value))}
                  />
                )}
              </div>
            </div>

            <div>
              <label className="label" htmlFor="changefreq-mode">
                Change frequency
              </label>
              <div className="flex gap-2">
                <select
                  id="changefreq-mode"
                  className="field"
                  value={settings.changefreqMode}
                  onChange={(event) => set('changefreqMode', event.target.value as ExportSettings['changefreqMode'])}
                >
                  <option value="depth">From page depth</option>
                  <option value="fixed">One value for all</option>
                  <option value="none">Leave out</option>
                </select>
                {settings.changefreqMode === 'fixed' && (
                  <select
                    className="field w-32"
                    aria-label="Change frequency value"
                    value={settings.fixedChangefreq}
                    onChange={(event) => set('fixedChangefreq', event.target.value)}
                  >
                    {['always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never'].map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </div>

            <label className="flex cursor-pointer items-start gap-2.5 text-sm">
              <input
                className="checkbox mt-0.5"
                type="checkbox"
                checked={settings.includeLastmod}
                onChange={(event) => set('includeLastmod', event.target.checked)}
              />
              <span>
                <span className="text-slate-200">Include &lt;lastmod&gt;</span>
                <span className="block text-xs text-slate-500">Taken from each page's Last-Modified header.</span>
              </span>
            </label>

            <label className="flex cursor-pointer items-start gap-2.5 text-sm">
              <input
                className="checkbox mt-0.5"
                type="checkbox"
                checked={settings.includeAlternates}
                onChange={(event) => set('includeAlternates', event.target.checked)}
              />
              <span>
                <span className="text-slate-200">Include hreflang alternates</span>
                <span className="block text-xs text-slate-500">Adds xhtml:link entries for translated pages.</span>
              </span>
            </label>
          </div>
        </section>

        <section className="panel p-5">
          <h2 className="panel-title mb-3">Download</h2>
          <div className="grid gap-2">
            {DOWNLOADS.map((entry) => (
              <button
                key={entry.format}
                type="button"
                className="btn-secondary justify-between text-left"
                onClick={() => download(entry.format)}
              >
                <span>
                  <span className="block font-mono text-xs text-slate-100">{entry.label}</span>
                  <span className="block text-[11px] font-normal text-slate-500">{entry.hint}</span>
                </span>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                  <path d="M12 4v12m0 0 4-4m-4 4-4-4M5 20h14" />
                </svg>
              </button>
            ))}
          </div>

          {robots && (
            <div className="mt-4">
              <p className="label">Add to robots.txt</p>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 rounded-lg border border-white/10 bg-ink-950/70 px-3 py-2 text-left font-mono text-[11px] text-slate-300 hover:border-white/25"
                onClick={() => copy(robots, 'robots')}
              >
                <span className="truncate">{robots}</span>
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-slate-500">
                  {copied === 'robots' ? 'copied' : 'copy'}
                </span>
              </button>
            </div>
          )}
        </section>
      </div>

      <section className="panel flex min-h-0 flex-col">
        <header className="panel-header">
          <h2 className="panel-title">
            sitemap.xml
            <span className="ml-2 font-mono text-xs font-normal text-slate-500">{formatNumber(urls.length)} URLs</span>
          </h2>
          <div className="flex items-center gap-2">
            {busy && <span className="text-xs text-slate-500">building…</span>}
            <button type="button" className="btn-ghost px-2.5 py-1 text-xs" onClick={() => copy(preview, 'xml')}>
              {copied === 'xml' ? 'Copied' : 'Copy XML'}
            </button>
          </div>
        </header>

        {error && <p className="border-b border-rose-500/20 bg-rose-500/10 px-5 py-2 text-xs text-rose-200">{error}</p>}

        <pre className="scrollbar-thin max-h-[36rem] overflow-auto p-5 font-mono text-xs leading-relaxed text-slate-300">
          {preview || (urls.length === 0 ? 'Select at least one URL to build a sitemap.' : '')}
        </pre>
      </section>
    </div>
  )
}
