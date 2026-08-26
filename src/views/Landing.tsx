import { BrandPin } from '../components/BrandMark'

/**
 * The public face of the product.
 *
 * Everything a stranger sees before an account exists: what the tool does,
 * what it costs, and two doors in — sign in, or start a subscription. The
 * pricing card leads to the same signup the nav does; payment itself happens
 * after the email is verified, inside the app's own frame.
 */

/** The product as it actually looks, once, under the fold. */
const HERO_SHOT = {
  src: '/shots/map.jpg',
  caption: 'Map view \u00b7 stage rail, radius ring, street map',
  alt: 'Map view with a stage rail on the left listing sites under Unqualified, Qualified/Touring, LOI, Under Contract and Passed, and two pins inside a dashed half mile radius ring.',
}

/**
 * The run of work, in the order a broker actually does it, each step showing
 * the corner of the interface it happens in. Numbered because it is a real
 * sequence — a site cannot be toured before it is staged, or staged before it
 * is on the map.
 */
const STEPS = [
  {
    title: 'Add the sites',
    body: 'Every candidate goes in one place. Drop a pin by address, paste a listing, or upload the flyer and let the AI fill the profile in. The views across the top are the same survey seen four ways.',
    src: '/steps/1-add.jpg',
    alt: 'The survey toolbar: Map, List, Plan tour and Share views, with an Add site button.',
  },
  {
    title: 'Draw the trade area',
    body: 'Set a radius or draw a zone around where the client actually needs to be, and see which buildings fall inside it. The ring carries its own distance, so half a mile stays half a mile for whoever opens it next.',
    src: '/steps/2-area.jpg',
    alt: 'A dashed radius ring drawn on the street map, labelled Test \u00b7 0.5 mi, with a site pin inside it.',
  },
  {
    title: 'Stage every candidate',
    body: 'Drag a site between stages and its pin recolours on the map. Hide a stage to clear the noise. The count beside each label is how you know where the search really stands.',
    src: '/steps/3-stage.jpg',
    alt: 'The stage rail showing Unqualified and Qualified/Touring groups, each with a count and a site card that can be dragged.',
  },
  {
    title: 'Compare on the numbers',
    body: 'Switch to the list when comparing matters more than locating. Stage, asking, size and year built line up in a column you can sort. Rate on request stays rate on request.',
    src: '/steps/4-compare.jpg',
    alt: 'The list view table with columns for site, stage, asking rate, size and year built.',
  },
  {
    title: 'Order the tour',
    body: 'Optimize route puts the stops in driving order and works out the arrival time at each one. Change how long you spend at a stop and everything after it moves with it.',
    src: '/steps/5-order.jpg',
    alt: 'A tour stop card showing eight minutes drive, arrive 10:08 AM, and an editable twenty minute time at stop, beside an Optimize route button.',
  },
  {
    title: 'Hand over the day',
    body: 'Tour book prints the run as a leave-behind. The share link shows the client the live map instead, so moving a site to LOI updates the link they already have.',
    src: '/steps/6-handover.jpg',
    alt: 'The tour configuration header with a Tour book button.',
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

          <figure className="panel mt-12 overflow-hidden text-left">
            <img src={HERO_SHOT.src} alt={HERO_SHOT.alt} width={1440} className="block w-full" />
            <figcaption className="border-t border-line px-4 py-2.5 font-mono text-[11px] tracking-wide text-faint">
              {HERO_SHOT.caption}
            </figcaption>
          </figure>
        </section>

        <section id="features" className="border-t border-line bg-surface">
          <div className="mx-auto max-w-5xl px-5 py-14">
            <h2 className="text-center text-xl font-semibold text-ink">The whole survey, one tool</h2>
            <p className="mx-auto mt-2 max-w-md text-center text-sm text-muted">
              From the first pin to the tour book the client takes home.
            </p>

            {/* Each step shows the corner of the interface it happens in. The
                number column is the sequence itself, so it stays put on every
                width rather than becoming decoration. */}
            <ol className="mt-12 space-y-10">
              {STEPS.map((step, i) => (
                <li key={step.title} className="grid gap-x-6 gap-y-3 sm:grid-cols-[auto_minmax(0,1fr)]">
                  <span
                    className="grid h-8 w-8 shrink-0 place-items-center self-start rounded-full bg-brand-tint font-mono text-[13px] font-medium text-brand-deep"
                    aria-hidden
                  >
                    {i + 1}
                  </span>
                  <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(0,4fr)_minmax(0,6fr)] lg:gap-8">
                    <div className="min-w-0">
                      <p className="text-base font-semibold text-ink">{step.title}</p>
                      <p className="mt-2 text-[13px] leading-relaxed text-muted">{step.body}</p>
                    </div>
                    {/* Held near life size — a UI detail blown up past its own
                        scale reads as a zoom rather than a pointer at the thing. */}
                    <figure className="panel overflow-hidden">
                      <img src={step.src} alt={step.alt} width={1280} loading="lazy" className="block w-full" />
                    </figure>
                  </div>
                </li>
              ))}
            </ol>

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
