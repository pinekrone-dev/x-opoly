interface Props {
  onPick: (url: string) => void
}

const STEPS = [
  {
    title: 'Point it at a domain',
    body: 'Type any address. The crawler starts at the home page, reads robots.txt and follows internal links breadth-first.',
  },
  {
    title: 'Watch the site take shape',
    body: 'URLs stream in as they are found, folded into a tree so you can see the real hierarchy instead of a flat list.',
  },
  {
    title: 'Export what you need',
    body: 'A search-engine-ready sitemap.xml, a plain URL list, an HTML sitemap page, or the whole crawl as CSV.',
  },
]

const FEATURES = [
  'Obeys robots.txt and crawl-delay',
  'Reads any existing sitemap to catch unlinked pages',
  'Records redirects, 404s and server errors',
  'Skips noindex and canonicalised URLs automatically',
  'Per-URL priority, changefreq and lastmod',
  'Splits into a sitemap index past 50,000 URLs',
]

export default function EmptyState({ onPick }: Props) {
  return (
    <div className="animate-fade-in grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <section className="panel p-6">
        <h2 className="panel-title mb-5">How it works</h2>
        <ol className="grid gap-5 sm:grid-cols-3">
          {STEPS.map((step, index) => (
            <li key={step.title}>
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/15 font-mono text-xs font-bold text-accent ring-1 ring-inset ring-accent/25">
                {index + 1}
              </span>
              <h3 className="mt-3 text-sm font-semibold text-slate-100">{step.title}</h3>
              <p className="mt-1 text-xs leading-relaxed text-slate-500">{step.body}</p>
            </li>
          ))}
        </ol>

        <div className="mt-6 border-t border-white/5 pt-5">
          <p className="label">Try it on</p>
          <div className="flex flex-wrap gap-2">
            {['developer.mozilla.org', 'sitemaps.org', 'vitejs.dev'].map((example) => (
              <button key={example} type="button" className="btn-secondary py-1.5 font-mono text-xs" onClick={() => onPick(example)}>
                {example}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="panel p-6">
        <h2 className="panel-title mb-4">What it handles</h2>
        <ul className="grid gap-2.5">
          {FEATURES.map((feature) => (
            <li key={feature} className="flex gap-2.5 text-xs leading-relaxed text-slate-400">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="mt-0.5 shrink-0 text-accent" aria-hidden>
                <path d="m5 13 4 4L19 7" />
              </svg>
              {feature}
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
