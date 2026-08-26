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

function Logo({ tone = 'brand' }: { tone?: 'brand' | 'inverse' }) {
  return <BrandPin size={36} tone={tone} />
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
    <div className="min-h-full overflow-y-auto bg-surface">
      <header className="sticky top-0 z-20 border-b border-line bg-paper/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-5 py-3">
          <Logo />
          {/* The mark spells the name itself, so the wordmark stands down
              on narrow screens rather than wrapping the header onto two lines. */}
          <p className="hidden text-sm font-semibold text-ink xs:block sm:block">Land Quotient</p>
          <nav className="ml-auto flex items-center gap-1.5 text-sm">
            <a className="btn-ghost hidden px-3 py-1.5 sm:inline-block" href="#how">
              How it works
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
        {/*
          The hero is the survey sheet the product is named for: a faint grid,
          and the same concentric rings the map draws around a trade area. Both
          are CSS gradients rather than an image or a canvas, so they cost
          nothing to load and stay crisp at any width.
        */}
        <section className="relative overflow-hidden bg-brand-night">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage:
                'repeating-linear-gradient(0deg, rgba(122,170,225,.07) 0 1px, transparent 1px 46px),' +
                'repeating-linear-gradient(90deg, rgba(122,170,225,.07) 0 1px, transparent 1px 46px)',
            }}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage:
                'radial-gradient(circle at 86% 22%, transparent 0 150px, rgba(1,163,168,.28) 150px 151px,' +
                ' transparent 151px 300px, rgba(1,163,168,.20) 300px 301px,' +
                ' transparent 301px 470px, rgba(1,163,168,.13) 470px 471px, transparent 471px)',
            }}
          />

          <div className="relative mx-auto max-w-5xl px-5 pt-16 sm:pt-24">
            <p className="mb-5 inline-block rounded-full border border-brand-edge px-3 py-1 font-mono text-[11px] uppercase tracking-[0.16em] text-brand-soft">
              For tenant rep brokers
            </p>
            <h1 className="max-w-3xl text-4xl font-bold leading-[1.05] tracking-tight text-white sm:text-[3.4rem]">
              Market surveys your clients actually open
            </h1>
            <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-slate-300">
              Map the sites, shade the demographics, plan the tour, and send one polished link — instead
              of a folder of flyers and a spreadsheet.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="btn rounded-lg bg-brand px-5 py-2.5 text-white hover:bg-brand-soft hover:text-brand-night"
                onClick={primaryCta}
              >
                {selfServe ? 'Start for $29/month' : 'Sign in'}
              </button>
              <a
                className="btn rounded-lg border border-brand-edge px-4 py-2.5 text-slate-200 hover:border-brand-soft hover:text-brand-soft"
                href="#how"
              >
                See what it does
              </a>
            </div>

            {/* Bleeds off the bottom edge: the product continues past the fold. */}
            <figure className="mt-14 overflow-hidden rounded-t-xl border border-brand-edge border-b-0 bg-white shadow-2xl shadow-black/40">
              <img src={HERO_SHOT.src} alt={HERO_SHOT.alt} width={1440} className="block w-full" />
            </figure>
          </div>
        </section>

        <section id="how" className="border-b border-line bg-surface">
          <div className="mx-auto max-w-5xl px-5 py-20">
            <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-brand">How it works</p>
            <h2 className="mt-3 max-w-xl text-3xl font-bold tracking-tight text-ink">
              The whole survey, one tool
            </h2>
            <p className="mt-3 max-w-lg text-[15px] leading-relaxed text-muted">
              From the first pin to the tour book the client takes home.
            </p>

            {/*
              Each step shows the corner of the interface it happens in. The rule
              running down the number column is the sequence itself — a site
              cannot be toured before it is staged, or staged before it is mapped.
            */}
            <ol className="relative mt-14 space-y-14">
              <span
                aria-hidden
                className="absolute left-[15px] top-2 hidden h-[calc(100%-2rem)] w-px bg-gradient-to-b from-brand/40 via-line to-transparent sm:block"
              />
              {STEPS.map((step, i) => (
                <li key={step.title} className="relative grid gap-x-6 gap-y-4 sm:grid-cols-[auto_minmax(0,1fr)]">
                  <span
                    className="z-10 grid h-8 w-8 shrink-0 place-items-center self-start rounded-full bg-brand font-mono text-[13px] font-medium text-white ring-4 ring-surface"
                    aria-hidden
                  >
                    {i + 1}
                  </span>
                  <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(0,4fr)_minmax(0,6fr)] lg:gap-10">
                    <div className="min-w-0">
                      <p className="text-lg font-semibold tracking-tight text-ink">{step.title}</p>
                      <p className="mt-2.5 text-[13px] leading-relaxed text-muted">{step.body}</p>
                    </div>
                    {/* Held near life size — a UI detail blown up past its own
                        scale reads as a zoom rather than a pointer at the thing. */}
                    <figure className="overflow-hidden rounded-xl border border-line bg-surface shadow-lg shadow-slate-900/[0.07] ring-1 ring-slate-900/[0.03]">
                      <img src={step.src} alt={step.alt} width={1280} loading="lazy" className="block w-full" />
                    </figure>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="border-b border-line bg-paper">
          <div className="mx-auto max-w-5xl px-5 py-20">
            <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-brand">Also included</p>
            <h2 className="mt-3 max-w-xl text-3xl font-bold tracking-tight text-ink">
              The parts that answer the client
            </h2>
            <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((feature) => (
                <div
                  key={feature.title}
                  className="rounded-xl border border-line bg-surface p-6 transition hover:border-brand/40 hover:shadow-lg hover:shadow-slate-900/[0.06]"
                >
                  <span
                    className="mb-4 grid h-10 w-10 place-items-center rounded-lg bg-brand-tint text-brand-deep ring-1 ring-brand/15"
                    aria-hidden
                  >
                    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <path d={feature.icon} />
                    </svg>
                  </span>
                  <p className="text-[15px] font-semibold text-ink">{feature.title}</p>
                  <p className="mt-2 text-[13px] leading-relaxed text-muted">{feature.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="pricing" className="bg-surface">
          <div className="mx-auto max-w-5xl px-5 py-20">
            <div className="text-center">
              <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-brand">Pricing</p>
              <h2 className="mt-3 text-3xl font-bold tracking-tight text-ink">One plan, everything included</h2>
              <p className="mx-auto mt-3 max-w-md text-[15px] text-muted">
                Cancel any time from your billing page.
              </p>
            </div>

            <div className="mx-auto mt-10 max-w-sm">
              <div className="overflow-hidden rounded-xl border border-line shadow-xl shadow-slate-900/10">
                <div className="bg-brand-night p-7 text-center">
                  <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-brand-soft">Land Quotient</p>
                  <p className="mt-3 text-5xl font-bold tracking-tight text-white">
                    $29<span className="text-base font-medium text-slate-400"> / month</span>
                  </p>
                  <p className="mt-2 text-xs text-slate-400">per workspace, teammates included</p>
                </div>
                <ul className="space-y-3 bg-surface p-7 text-sm text-body">
                  {INCLUDED.map((line) => (
                    <li key={line} className="flex items-start gap-2.5">
                      <svg
                        className="mt-0.5 shrink-0 text-brand"
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
                <div className="bg-surface px-7 pb-7">
                  {selfServe ? (
                    <>
                      <button type="button" className="btn-primary w-full py-3" onClick={onGetStarted}>
                        Subscribe — $29/month
                      </button>
                      <p className="mt-3 text-center text-[11px] leading-relaxed text-faint">
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

      <footer className="bg-brand-night">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-4 px-5 py-10 text-xs text-slate-400">
          <Logo tone="inverse" />
          <span>Land Quotient — site surveys for tenant rep brokers.</span>
          <button type="button" className="ml-auto underline hover:text-brand-soft" onClick={onSignIn}>
            Sign in
          </button>
        </div>
      </footer>
    </div>
  )
}
