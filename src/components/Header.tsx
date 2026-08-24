export default function Header() {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/15 ring-1 ring-inset ring-accent/30">
          <svg width="22" height="22" viewBox="0 0 32 32" fill="none" aria-hidden>
            <g stroke="#4cc2ff" strokeWidth="2" strokeLinecap="round">
              <path d="M16 9v5M9 23v-4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v4" />
            </g>
            <g fill="#4cc2ff">
              <rect x="12" y="4" width="8" height="5" rx="1.5" />
              <rect x="5" y="23" width="8" height="5" rx="1.5" />
              <rect x="19" y="23" width="8" height="5" rx="1.5" />
            </g>
          </svg>
        </span>
        <div>
          <h1 className="text-lg font-bold tracking-tight text-white">
            Sitemap<span className="text-accent">Forge</span>
          </h1>
          <p className="text-xs text-slate-500">Crawl a site, see its structure, ship the sitemap.</p>
        </div>
      </div>

      <p className="max-w-md text-xs leading-relaxed text-slate-500">
        Every crawl reads robots.txt, follows internal links and any published sitemap, then hands back an XML sitemap,
        a visual tree and a list of what needs fixing.
      </p>
    </header>
  )
}
