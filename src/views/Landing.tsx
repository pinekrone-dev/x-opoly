/**
 * The public face of the product.
 *
 * Everything a stranger sees before an account exists: what the tool does,
 * what it costs, and two doors in — sign in, or start a subscription. The
 * pricing card leads to the same signup the nav does; payment itself happens
 * after the email is verified, inside the app's own frame.
 */

const FEATURES = [
  {
    title: 'Every site on one map',
    body: 'Drop pins by address, paste a listing, or upload the flyer — the AI reads it and fills the site profile in for review.',
    icon: 'M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z M12 10m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
  },
  {
    title: 'Demographics that answer clients',
    body: 'Census choropleths — population, income, growth — shade the map around every site, with the numbers in a side panel.',
    icon: 'M3 3v18h18 M7 14v4 M12 9v9 M17 5v13',
  },
  {
    title: 'Pipeline stages, your labels',
    body: 'Group sites into stages with matching pin colors, toggle them from the legend, and draw non-compete radii right on the map.',
    icon: 'M4 6h16 M4 12h10 M4 18h7',
  },
  {
    title: 'Tours planned, not guessed',
    body: 'Pick the sites, get the drive order, times and directions — then hand the client a polished tour book PDF.',
    icon: 'M9 20l-5.5 2.5V6L9 3.5m0 16.5l6-3m-6 3V3.5m6 13.5l5.5 2.5V3l-5.5 2.5m0 11.5V5.5m-6-2l6 2',
  },
  {
    title: 'Share links clients open',
    body: 'One link shows the live survey map — with demographics and QR codes if you switch them on. No login, no attachment.',
    icon: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7 M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  },
  {
    title: 'Compare sites side by side',
    body: 'Rates, sizes, parking and demographics lined up across sites — on screen and in a comparison PDF.',
    icon: 'M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4 M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4 M12 3v18',
  },
]

const INCLUDED = [
  'Unlimited surveys and sites',
  'Census demographic choropleths',
  'AI flyer and listing extraction',
  'Tour planning with drive times',
  'Client share links and PDFs',
  'Team members by invitation',
]

function Logo() {
  return (
    <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand text-white" aria-hidden>
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M9 20l-5.5 2.5V6L9 3.5m0 16.5l6-3m-6 3V3.5m6 13.5l5.5 2.5V3l-5.5 2.5m0 11.5V5.5m-6-2l6 2" />
      </svg>
    </span>
  )
}

export default function Landing({
  selfServe,
  onSignIn,
  onGetStarted,
}: {
  selfServe: boolean
  onSignIn: () => void
  onGetStarted: () => void
}) {
  const primaryCta = selfServe ? onGetStarted : onSignIn

  return (
    <div className="min-h-full overflow-y-auto bg-paper">
      <header className="sticky top-0 z-20 border-b border-line bg-paper/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-5 py-3">
          <Logo />
          <p className="text-sm font-semibold text-ink">SiteSurvey CRE</p>
          <nav className="ml-auto flex items-center gap-1.5 text-sm">
            <a className="btn-ghost hidden px-3 py-1.5 sm:inline-block" href="#features">
              Features
            </a>
            <a className="btn-ghost hidden px-3 py-1.5 sm:inline-block" href="#pricing">
              Pricing
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

      <main>
        <section className="mx-auto max-w-5xl px-5 pb-14 pt-16 text-center sm:pt-24">
          <p className="mb-4 inline-block rounded-full border border-brand/30 bg-brand-tint px-3 py-1 text-xs font-medium text-brand-deep">
            For tenant rep brokers
          </p>
          <h1 className="mx-auto max-w-2xl text-3xl font-bold leading-tight text-ink sm:text-[2.6rem] sm:leading-[1.15]">
            Market surveys your clients actually open
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-[15px] leading-relaxed text-muted">
            Map the sites, shade the demographics, plan the tour, and send one polished link — instead
            of a folder of flyers and a spreadsheet.
          </p>
          <div className="mt-7 flex items-center justify-center gap-3">
            <button type="button" className="btn-primary px-5 py-2.5" onClick={primaryCta}>
              {selfServe ? 'Start for $9/month' : 'Sign in'}
            </button>
            <a className="btn-ghost px-4 py-2.5" href="#features">
              See what it does
            </a>
          </div>
        </section>

        <section id="features" className="border-t border-line bg-surface">
          <div className="mx-auto max-w-5xl px-5 py-14">
            <h2 className="text-center text-xl font-semibold text-ink">The whole survey, one tool</h2>
            <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((feature) => (
                <div key={feature.title} className="panel p-5">
                  <span className="mb-3 grid h-9 w-9 place-items-center rounded-lg bg-brand-tint text-brand-deep" aria-hidden>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <path d={feature.icon} />
                    </svg>
                  </span>
                  <p className="text-sm font-semibold text-ink">{feature.title}</p>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{feature.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="pricing" className="border-t border-line">
          <div className="mx-auto max-w-5xl px-5 py-14">
            <h2 className="text-center text-xl font-semibold text-ink">Subscription &amp; pricing</h2>
            <p className="mx-auto mt-2 max-w-md text-center text-sm text-muted">
              One plan, everything included. Cancel any time from your billing page.
            </p>

            <div className="mx-auto mt-8 max-w-sm">
              <div className="panel overflow-hidden">
                <div className="border-b border-line bg-brand-tint/60 p-6 text-center">
                  <p className="text-xs font-semibold uppercase tracking-wide text-brand-deep">SiteSurvey CRE</p>
                  <p className="mt-2 text-4xl font-bold text-ink">
                    $9<span className="text-base font-medium text-muted"> / month</span>
                  </p>
                  <p className="mt-1 text-xs text-muted">per workspace, teammates included</p>
                </div>
                <ul className="space-y-2.5 p-6 text-sm text-body">
                  {INCLUDED.map((line) => (
                    <li key={line} className="flex items-start gap-2.5">
                      <svg
                        className="mt-0.5 shrink-0 text-brand-deep"
                        width="15"
                        height="15"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.4"
                        aria-hidden
                      >
                        <path d="m5 13 4 4L19 7" />
                      </svg>
                      {line}
                    </li>
                  ))}
                </ul>
                <div className="px-6 pb-6">
                  {selfServe ? (
                    <>
                      <button type="button" className="btn-primary w-full py-2.5" onClick={onGetStarted}>
                        Subscribe — $9/month
                      </button>
                      <p className="mt-2.5 text-center text-[11px] text-faint">
                        Create your account, confirm your email, and pay securely by card. Promo codes are
                        entered at checkout. Powered by Stripe.
                      </p>
                    </>
                  ) : (
                    <p className="rounded-lg border border-line bg-sunken p-3 text-center text-xs text-muted">
                      New signups are opening soon. Already invited? Use your invitation link, or{' '}
                      <button type="button" className="font-medium text-brand-deep underline" onClick={onSignIn}>
                        sign in
                      </button>
                      .
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-5 py-6 text-xs text-faint">
          <Logo />
          <span>SiteSurvey CRE — site surveys for tenant rep brokers.</span>
          <button type="button" className="ml-auto underline hover:text-body" onClick={onSignIn}>
            Sign in
          </button>
        </div>
      </footer>
    </div>
  )
}
