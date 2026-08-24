import type { CrawlOptions } from '../types'

interface Props {
  options: CrawlOptions
  onChange: (options: CrawlOptions) => void
  disabled: boolean
}

const TOGGLES: { key: keyof CrawlOptions; label: string; hint: string }[] = [
  { key: 'respectRobots', label: 'Obey robots.txt', hint: 'Skip paths the site asks crawlers to leave alone.' },
  { key: 'seedFromSitemap', label: 'Read existing sitemap', hint: 'Seed the crawl from /sitemap.xml to catch unlinked pages.' },
  { key: 'includeSubdomains', label: 'Include subdomains', hint: 'Follow links to blog.example.com as well as example.com.' },
  { key: 'includeDocuments', label: 'Include documents', hint: 'List PDFs and other documents alongside pages.' },
  { key: 'stripQuery', label: 'Ignore query strings', hint: 'Treat /page?a=1 and /page as the same URL.' },
  { key: 'checkExternalLinks', label: 'Check outbound links', hint: 'Verify links to other sites. Slower, but finds dead links.' },
]

const NUMBERS: { key: keyof CrawlOptions; label: string; min: number; max: number; step: number; suffix?: string }[] = [
  { key: 'maxPages', label: 'Page limit', min: 1, max: 2000, step: 1 },
  { key: 'maxDepth', label: 'Max depth', min: 0, max: 20, step: 1 },
  { key: 'concurrency', label: 'Parallel requests', min: 1, max: 12, step: 1 },
  { key: 'delayMs', label: 'Delay between requests', min: 0, max: 5000, step: 50, suffix: 'ms' },
]

export default function OptionsPanel({ options, onChange, disabled }: Props) {
  const set = <K extends keyof CrawlOptions>(key: K, value: CrawlOptions[K]) => {
    onChange({ ...options, [key]: value })
  }

  return (
    <div className="animate-fade-in border-t border-white/10 bg-ink-950/40 p-5">
      <div className="grid gap-5 lg:grid-cols-3">
        <div>
          <h3 className="label">Crawl limits</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
            {NUMBERS.map((field) => (
              <label key={field.key} className="flex items-center justify-between gap-3 text-sm text-slate-300">
                <span>{field.label}</span>
                <span className="flex items-center gap-1.5">
                  <input
                    className="field w-24 py-1.5 text-right font-mono"
                    type="number"
                    min={field.min}
                    max={field.max}
                    step={field.step}
                    disabled={disabled}
                    value={options[field.key] as number}
                    onChange={(event) => set(field.key, Number(event.target.value) as never)}
                  />
                  {field.suffix && <span className="text-xs text-slate-500">{field.suffix}</span>}
                </span>
              </label>
            ))}
          </div>
        </div>

        <div>
          <h3 className="label">Behaviour</h3>
          <div className="grid gap-2.5">
            {TOGGLES.map((toggle) => (
              <label key={toggle.key} className="flex cursor-pointer items-start gap-2.5 text-sm">
                <input
                  className="checkbox mt-0.5"
                  type="checkbox"
                  disabled={disabled}
                  checked={Boolean(options[toggle.key])}
                  onChange={(event) => set(toggle.key, event.target.checked as never)}
                />
                <span>
                  <span className="text-slate-200">{toggle.label}</span>
                  <span className="block text-xs leading-snug text-slate-500">{toggle.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="grid content-start gap-4">
          <div>
            <label className="label" htmlFor="include-patterns">
              Only crawl URLs matching
            </label>
            <textarea
              id="include-patterns"
              className="field h-20 resize-none font-mono text-xs"
              placeholder="/blog&#10;/docs"
              disabled={disabled}
              value={options.includePatterns}
              onChange={(event) => set('includePatterns', event.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="exclude-patterns">
              Skip URLs matching
            </label>
            <textarea
              id="exclude-patterns"
              className="field h-20 resize-none font-mono text-xs"
              placeholder="/cart&#10;\\?replytocom="
              disabled={disabled}
              value={options.excludePatterns}
              onChange={(event) => set('excludePatterns', event.target.value)}
            />
          </div>
          <p className="text-xs text-slate-500">One pattern per line. Plain text or a regular expression.</p>
        </div>
      </div>
    </div>
  )
}
