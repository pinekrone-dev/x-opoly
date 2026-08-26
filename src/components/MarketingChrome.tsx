import BrandMark, { BrandPin } from './BrandMark'

/**
 * The header and footer the public pages share.
 *
 * Landing and the FAQ wore the same chrome copied twice, which is how two
 * pages drift apart. One definition, and `homeHref` is the only difference
 * between them: on the landing the section links are plain anchors, and from
 * anywhere else they have to name the page first.
 */

export function MarketingHeader({
  selfServe,
  onSignIn,
  onGetStarted,
  /** '' on the landing itself, '/' from any other page. */
  homeHref = '',
}: {
  selfServe: boolean
  onSignIn: () => void
  onGetStarted: () => void
  homeHref?: string
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
          <a className="btn-ghost hidden px-3 py-1.5 sm:inline-block" href={`${homeHref}#how`}>
            How it works
          </a>
          <a className="btn-ghost hidden px-3 py-1.5 sm:inline-block" href={`${homeHref}#pricing`}>
            Pricing
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

export function MarketingFooter({ onSignIn, homeHref = '' }: { onSignIn: () => void; homeHref?: string }) {
  return (
    <footer className="bg-brand-night">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-4 px-5 py-10 text-xs text-slate-400">
        <BrandMark size={32} tone="inverse" />
        <span>Site surveys for tenant rep brokers.</span>
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
    </footer>
  )
}
