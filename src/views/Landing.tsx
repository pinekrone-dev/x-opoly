import { BrandPin } from '../components/BrandMark'

/**
 * The public face of the product.
 *
 * Everything a stranger sees before an account exists: what the tool does,
 * what it costs, and two doors in — sign in, or start a subscription. The
 * pricing card leads to the same signup the nav does; payment itself happens
 * after the email is verified, inside the app's own frame.
 */

/**
 * The three features a screenshot can actually show. Each shot is the product
 * itself rather than a mockup, so the caption names what is in the frame
 * instead of describing the feature a second time.
 */
const SHOWN = [
  {
    kicker: 'Map',
    title: 'Every site on one map',
    body: 'Drop pins by address, paste a listing, or upload the flyer \u2014 the AI reads it and fills the site profile in for review.',
    shot: '/shots/map.jpg',
    caption: 'Map view \u00b7 stage rail, radius ring, street map',
    alt: 'Map view with a stage rail on the left listing sites under Unqualified, Qualified/Touring, LOI, Under Contract and Passed, and two pins inside a dashed half mile radius ring.',
  },
  {
    kicker: 'Plan tour',
    title: 'Tours planned, not guessed',
    body: 'Pick the sites, get the drive order, times and directions \u2014 then hand the client a polished tour book PDF.',
    shot: '/shots/tour.jpg',
    caption: 'Plan tour \u00b7 optimized route, arrival times, tour book',
    alt: 'Plan tour view with a start address departing at 10 AM, two numbered stops showing drive time and arrival time, an adjustable time at each stop, and the route drawn on the map.',
  },
  {
    kicker: 'Compare',
    title: 'Compare sites side by side',
    body: 'Rates, sizes, parking and demographics lined up across sites \u2014 on screen and in a comparison PDF.',
    shot: '/shots/list.jpg',
    caption: 'List view \u00b7 stage, asking, size, built',
    alt: 'List view showing a table of sites with address, stage pill, asking rate, size in square feet and year built, with filter chips above it.',
  },
]

const FEATURES = [
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
    title: 'Share links clients open',
    body: 'One link shows the live survey map — with demographics and QR codes if you switch them on. No login, no attachment.',
    icon: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7 M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
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
  return <BrandPin size={36} />
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
          <p className="text-sm font-semibold text-ink">Land Quotient</p>
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
              {selfServe ? 'Start for $29/month' : 'Sign in'}
            </button>
            <a className="btn-ghost px-4 py-2.5" href="#features">
              See what it does
            </a>
          </div>
        </section>

        <section id="features" className="border-t border-line bg-surface">
          <div className="mx-auto max-w-5xl px-5 py-14">
            <h2 className="text-center text-xl font-semibold text-ink">The whole survey, one tool</h2>
            <p className="mx-auto mt-2 max-w-md text-center text-sm text-muted">
              From the first pin to the tour book the client takes home.
            </p>

            {/* The three the product can show for itself. Alternating sides so a
                run of screenshots reads as a sequence rather than a stack. */}
            <div className="mt-12 space-y-14">
              {SHOWN.map((feature, i) => (
                <div
                  key={feature.title}
                  className={`grid items-center gap-8 ${
                    // The screenshot always takes the wide track. Reordering alone
                    // would leave it in whichever column the template sized first,
                    // so the template flips with the order.
                    i % 2 === 1
                      ? 'lg:grid-cols-[minmax(0,11fr)_minmax(0,7fr)]'
                      : 'lg:grid-cols-[minmax(0,7fr)_minmax(0,11fr)]'
                  }`}
                >
                  <div className={i % 2 === 1 ? 'lg:order-2' : ''}>
                    <p className="font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-brand">
                      {feature.kicker}
                    </p>
                    <p className="mt-2 text-lg font-semibold text-ink">{feature.title}</p>
                    <p className="mt-2 text-[13px] leading-relaxed text-muted">{feature.body}</p>
                  </div>
                  <figure className={`panel overflow-hidden ${i % 2 === 1 ? 'lg:order-1' : ''}`}>
                    <img src={feature.shot} alt={feature.alt} width={1440} loading="lazy" className="block w-full" />
                    <figcaption className="border-t border-line px-4 py-2.5 font-mono text-[11px] tracking-wide text-faint">
                      {feature.caption}
                    </figcaption>
                  </figure>
                </div>
              ))}
            </div>

            <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
                  <p className="text-xs font-semibold uppercase tracking-wide text-brand-deep">Land Quotient</p>
                  <p className="mt-2 text-4xl font-bold text-ink">
                    $29<span className="text-base font-medium text-muted"> / month</span>
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
                        Subscribe — $29/month
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
          <span>Land Quotient — site surveys for tenant rep brokers.</span>
          <button type="button" className="ml-auto underline hover:text-body" onClick={onSignIn}>
            Sign in
          </button>
        </div>
      </footer>
    </div>
  )
}
