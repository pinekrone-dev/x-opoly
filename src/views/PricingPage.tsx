import { useEffect } from 'react'

import { AlsoOn, MarketingFooter, MarketingHeader } from '../components/MarketingChrome'
import PricingCard, { LIMITS_LINE } from '../components/Pricing'

/**
 * The pricing page: it is free with an account, and what the account comes with.
 *
 * Its own address so it can be linked and shared on its own, with its own
 * preview card, rather than as an anchor halfway down the landing page. The
 * questions are the ones that decide whether someone starts a trial: is a
 * card needed, when is it charged, and how hard is it to stop.
 */

const INCLUDED = [
  'Unlimited market surveys, sites and tours',
  'The parcel map: owners, zoning and permits in 30+ counties',
  'CRM for deals, people, companies and places',
  'Census demographics around every site',
  'Client share links, tour books and PDFs',
  'Teammates included, no per seat charge',
]

const QUESTIONS = [
  {
    q: 'Is it really free?',
    a: 'Yes. Create an account and confirm your email. There is no card, no trial clock and no paid tier.',
  },
  {
    q: 'Why do I need an account?',
    a: 'The county records are the product. An account keeps them in the hands of people working deals rather than scripts copying them wholesale.',
  },
  {
    q: 'Are there limits?',
    a: LIMITS_LINE,
  },
  {
    q: 'Can my team use it?',
    a: 'Yes. Invite teammates from Settings as editors or view-only; they join your workspace at no cost.',
  },
]

export default function PricingPage({
  selfServe,
  onSignIn,
  onGetStarted,
}: {
  selfServe: boolean
  onSignIn: () => void
  onGetStarted: () => void
}) {
  useEffect(() => {
    document.title = 'Land Quotient is free with an account'
  }, [])

  return (
    <div className="min-h-full bg-surface">
      <MarketingHeader
        selfServe={selfServe}
        onSignIn={onSignIn}
        onGetStarted={onGetStarted}
        homeHref="/"
        current="/pricing"
      />

      <main>
        <section className="relative overflow-hidden border-b border-brand-edge bg-brand-night">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage:
                'repeating-linear-gradient(0deg, rgba(122,170,225,.07) 0 1px, transparent 1px 46px),' +
                'repeating-linear-gradient(90deg, rgba(122,170,225,.07) 0 1px, transparent 1px 46px)',
            }}
          />
          <div className="relative mx-auto max-w-5xl px-5 py-16 text-center sm:py-20">
            <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-brand-soft">Pricing</p>
            <h1 className="mx-auto mt-3 max-w-2xl text-3xl font-bold leading-tight tracking-tight text-white sm:text-[2.6rem]">
              Free. Everything in it. Just make an account.
            </h1>
            <p className="mx-auto mt-4 max-w-xl text-[15px] leading-relaxed text-slate-300">
              No card, no trial clock, teammates included.
            </p>
            {selfServe ? (
              <button
                type="button"
                className="btn mt-8 rounded-lg bg-brand px-6 py-3 text-white hover:bg-brand-soft hover:text-brand-night"
                onClick={onGetStarted}
              >
                Create your free account
              </button>
            ) : null}
          </div>
        </section>

        <section className="mx-auto max-w-5xl px-5 pb-6 pt-2">
          <PricingCard included={INCLUDED} selfServe={selfServe} onSignIn={onSignIn} onGetStarted={onGetStarted} />
        </section>

        <section className="mx-auto max-w-5xl px-5 py-14">
          <h2 className="border-t border-line pt-5 font-mono text-[11px] uppercase tracking-[0.16em] text-brand">
            The free account
          </h2>
          <dl className="mt-6 grid gap-4 md:grid-cols-2">
            {QUESTIONS.map((item) => (
              <div key={item.q} className="rounded-xl border border-line bg-paper p-6">
                <dt className="text-[15px] font-semibold text-ink">{item.q}</dt>
                <dd className="mt-2.5 text-[13px] leading-relaxed text-muted">{item.a}</dd>
              </div>
            ))}
          </dl>

          {selfServe ? (
            <div className="mt-12 text-center">
              <button type="button" className="btn-primary px-6 py-3" onClick={onGetStarted}>
                Create your free account
              </button>
              <p className="mt-3 text-xs text-faint">
                More questions? <a className="underline hover:text-body" href="/faq">Read the FAQ</a>.
              </p>
            </div>
          ) : null}
        </section>

        <AlsoOn except="/pricing" />
      </main>

      <MarketingFooter onSignIn={onSignIn} homeHref="/" />
    </div>
  )
}
