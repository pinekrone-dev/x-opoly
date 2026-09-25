import BrandMark, { BrandPin } from './BrandMark'
import { ALSO_ON } from '../content/audiences'

/**
 * The header and footer the public pages share.
 *
 * Landing and the FAQ wore the same chrome copied twice, which is how two
 * pages drift apart. One definition, and `homeHref` is the only difference
 * between them: on the landing the section links are plain anchors, and from
 * anywhere else they have to name the page first.
 *
 * `current` is the path of the page being shown, so the audience menu can
 * mark it. Links between public pages are plain anchors on purpose: each page
 * is its own HTML entry so crawlers get its own title and preview, and a full
 * navigation is what loads that entry.
 */

const AUDIENCE_LINKS = ALSO_ON.filter((l) => l.href !== '/markets')

export function MarketingHeader({
  selfServe,
  onSignIn,
  onGetStarted,
  /** '' on the landing itself, '/' from any other page. */
  homeHref = '',
  current = '/',
}: {
  selfServe: boolean
  onSignIn: () => void
  onGetStarted: () => void
  homeHref?: string
  current?: string
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-paper/90 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center gap-3 px-5 py-3">
        <a href={homeHref || '#top'} className="flex items-center gap-3">
          <BrandPin size={36} />
          {/* The mark spells the name itself, so the wordmark stands down on
              narrow screens rather than wrapping the header onto two lines. */}
          <span className="hidden text-sm font-semibold text-ink sm:block">Land Quotient</span>
        </a>
        <nav className="ml-auto flex items-center gap-1.5 text-sm">
          {/* A native disclosure: no script, closes itself on navigation, and
              reads as a menu to a keyboard and a screen reader alike. */}
          <details className="group relative hidden sm:block">
            <summary className="btn-ghost flex cursor-pointer list-none items-center gap-1 px-3 py-1.5">
              Who it is for
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden className="transition group-open:rotate-180">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </summary>
            <div className="absolute right-0 mt-2 w-64 overflow-hidden rounded-xl border border-line bg-surface p-1.5 shadow-xl shadow-slate-900/10">
              {AUDIENCE_LINKS.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  aria-current={current === link.href ? 'page' : undefined}
                  className={`block rounded-lg px-3 py-2 hover:bg-sunken ${current === link.href ? 'bg-brand-tint' : ''}`}
                >
                  <span className="block text-[13px] font-semibold text-ink">{link.name}</span>
                  <span className="block text-[12px] text-muted">{link.body}</span>
                </a>
              ))}
            </div>
          </details>
          <a
            className={`btn-ghost hidden px-3 py-1.5 sm:inline-block ${current === '/markets' ? 'text-ink' : ''}`}
            href="/markets"
            aria-current={current === '/markets' ? 'page' : undefined}
          >
            Markets
          </a>
          <a className="btn-ghost hidden px-3 py-1.5 sm:inline-block" href="/faq">
            FAQ
          </a>
          <button type="button" className="btn-ghost px-3 py-1.5" onClick={onSignIn}>
            Sign in
          </button>
          {selfServe ? (
            <button type="button" className="btn-primary px-3.5 py-1.5" onClick={onGetStarted}>
              Get started
            </button>
          ) : null}
        </nav>
      </div>
    </header>
  )
}

/** The cross-links at the foot of a public page, every page but the one shown. */
export function AlsoOn({ except }: { except: string }) {
  const links = ALSO_ON.filter((l) => l.href !== except)
  return (
    <section className="border-t border-line bg-paper">
      <div className="mx-auto max-w-5xl px-5 py-16">
        <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-brand">Built for the whole deal</p>
        <h2 className="mt-3 text-2xl font-bold tracking-tight text-ink">Also on Land Quotient</h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="rounded-xl border border-line bg-surface p-5 transition hover:border-brand/40 hover:shadow-lg hover:shadow-slate-900/[0.06]"
            >
              <span className="block text-[14px] font-semibold text-ink">{link.name}</span>
              <span className="mt-1 block text-[12px] leading-relaxed text-muted">{link.body}</span>
            </a>
          ))}
        </div>
      </div>
    </section>
  )
}

export function MarketingFooter({ onSignIn, homeHref = '' }: { onSignIn: () => void; homeHref?: string }) {
  return (
    <footer className="bg-brand-night">
      <div className="mx-auto max-w-5xl px-5 py-10 text-xs text-slate-400">
        <div className="flex flex-wrap items-center gap-4">
          <BrandMark size={32} tone="inverse" />
          <span>Real estate intelligence for commercial brokers, developers and investors.</span>
          <a className="underline hover:text-brand-soft" href="/faq">
            FAQ
          </a>
          <a className="underline hover:text-brand-soft" href={`${homeHref}#pricing`}>
            Pricing
          </a>
          <button type="button" className="ml-auto underline hover:text-brand-soft" onClick={onSignIn}>
            Sign in
          </button>
        </div>
        <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-brand-edge pt-5">
          {ALSO_ON.map((link) => (
            <a key={link.href} className="hover:text-brand-soft" href={link.href}>
              {link.name}
            </a>
          ))}
          <span className="ml-auto">
            A product of{' '}
            <a className="underline hover:text-brand-soft" href="https://realestateaistudio.com">
              Real Estate AI Studio
            </a>
            , Costa Mesa, California.
          </span>
        </div>
      </div>
    </footer>
  )
}
