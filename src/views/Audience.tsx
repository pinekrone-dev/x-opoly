import { useEffect, useState } from 'react'

import { AUDIENCES, ALSO_ON, type Audience as Spec, type AudienceSlug } from '../content/audiences'
import { AlsoOn, MarketingFooter, MarketingHeader } from '../components/MarketingChrome'
import PricingCard from '../components/Pricing'
import { compact, fetchMarkets, money, totals } from '../lib/catalogue'

/**
 * A public page for one kind of reader: investors, developers, investment
 * sales. The copy and pictures come from `content/audiences.ts`; this is the
 * frame they all share, deliberately the same bones as the broker landing so
 * the site reads as one product seen from four chairs.
 *
 * The numbers in the hero are read from the live catalogue rather than typed
 * in, so a new market shows up here the day it publishes.
 */

interface Totals {
  markets: number
  parcels: number
  value: number
  portfolios: number
}

/** Zoning districts are summed from the layers each market publishes; too
 *  many files to fetch for a headline, so the figure is carried here and
 *  refreshed when the markets page is. */
const ZONING_DISTRICTS = 126_900

function statValue(key: Spec['stats'][number]['key'], t: Totals | null): string {
  if (!t) return '—'
  if (key === 'parcels') return compact(t.parcels)
  if (key === 'value') return money(t.value)
  if (key === 'portfolios') return `${compact(t.portfolios)}+`
  if (key === 'markets') return String(t.markets)
  return compact(ZONING_DISTRICTS)
}

export default function Audience({
  slug,
  selfServe,
  onSignIn,
  onGetStarted,
}: {
  slug: AudienceSlug
  selfServe: boolean
  onSignIn: () => void
  onGetStarted: () => void
}) {
  const spec = AUDIENCES[slug]
  const primaryCta = selfServe ? onGetStarted : onSignIn
  const [sums, setSums] = useState<Totals | null>(null)

  useEffect(() => {
    document.title = spec.meta.title
    let live = true
    fetchMarkets()
      .then((markets) => {
        if (live) setSums(totals(markets))
      })
      .catch(() => {
        /* The page reads fine without the numbers; they are a garnish. */
      })
    return () => {
      live = false
    }
  }, [spec])

  useEffect(() => {
    const id = window.location.hash.slice(1)
    if (!id) return
    const target = document.getElementById(id)
    if (target) target.scrollIntoView()
  }, [])

  return (
    <div className="min-h-full bg-surface">
      <MarketingHeader selfServe={selfServe} onSignIn={onSignIn} onGetStarted={onGetStarted} homeHref="/" current={`/${slug}`} />

      <main>
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
              {spec.eyebrow}
            </p>
            <h1 className="max-w-3xl text-4xl font-bold leading-[1.05] tracking-tight text-white sm:text-[3.4rem]">
              {spec.title}
            </h1>
            <p className="mt-5 max-w-2xl text-[15px] leading-relaxed text-slate-300">{spec.lede}</p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="btn rounded-lg bg-brand px-5 py-2.5 text-white hover:bg-brand-soft hover:text-brand-night"
                onClick={primaryCta}
              >
                {selfServe ? 'Start a 14-day free trial' : 'Sign in'}
              </button>
              <a
                className="btn rounded-lg border border-brand-edge px-4 py-2.5 text-slate-200 hover:border-brand-soft hover:text-brand-soft"
                href="#how"
              >
                See what it does
              </a>
            </div>

            <dl className="mt-12 grid max-w-2xl grid-cols-3 gap-6">
              {spec.stats.map((stat) => (
                <div key={stat.key}>
                  <dt className="order-2 text-[12px] leading-snug text-slate-400">{stat.label}</dt>
                  <dd className="text-2xl font-bold tracking-tight text-white sm:text-3xl">{statValue(stat.key, sums)}</dd>
                </div>
              ))}
            </dl>

            <figure className="mt-12 overflow-hidden rounded-t-xl border border-brand-edge border-b-0 bg-white shadow-2xl shadow-black/40">
              <img src={spec.hero.src} alt={spec.hero.alt} width={spec.hero.w} height={spec.hero.h} className="block w-full" />
            </figure>
          </div>
        </section>

        <section id="how" className="scroll-mt-20 border-b border-line bg-surface">
          <div className="mx-auto max-w-5xl px-5 py-20">
            <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-brand">{spec.chapter.eyebrow}</p>
            <h2 className="mt-3 max-w-xl text-3xl font-bold tracking-tight text-ink">{spec.chapter.title}</h2>
            <p className="mt-3 max-w-lg text-[15px] leading-relaxed text-muted">{spec.chapter.intro}</p>

            <div className="mt-14 space-y-6">
              {spec.steps.map((step, i) => {
                const flip = i % 2 === 1
                return (
                  <section
                    key={step.title}
                    aria-labelledby={`step-${i}`}
                    className="grid items-center gap-8 rounded-xl border border-line bg-paper p-6 sm:p-8 md:grid-cols-2"
                  >
                    <div className={flip ? 'md:order-2' : ''}>
                      <span className="font-mono text-[13px] font-medium text-brand">0{i + 1}</span>
                      <h3 id={`step-${i}`} className="mt-2 text-xl font-bold tracking-tight text-ink">
                        {step.title}
                      </h3>
                      <p className="mt-3 text-[14px] leading-relaxed text-muted">{step.body}</p>
                      {step.bullets ? (
                        <ul className="mt-4 space-y-1.5 text-[13px] text-body">
                          {step.bullets.map((b) => (
                            <li key={b} className="flex gap-2">
                              <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-brand" aria-hidden />
                              <span>{b}</span>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                    <figure className={`overflow-hidden rounded-lg border border-line bg-surface shadow-md shadow-slate-900/[0.06] ${flip ? 'md:order-1' : ''}`}>
                      <img
                        src={step.shot.src}
                        alt={step.shot.alt}
                        width={step.shot.w}
                        height={step.shot.h}
                        loading="lazy"
                        className="block max-h-[420px] w-full object-cover object-top"
                      />
                    </figure>
                  </section>
                )
              })}
            </div>
          </div>
        </section>

        <section className="border-b border-line bg-paper">
          <div className="mx-auto max-w-5xl px-5 py-20">
            <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-brand">Also included</p>
            <h2 className="mt-3 max-w-xl text-3xl font-bold tracking-tight text-ink">{spec.also.title}</h2>
            <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {spec.also.cards.map((card) => (
                <div
                  key={card.title}
                  className="rounded-xl border border-line bg-surface p-6 transition hover:border-brand/40 hover:shadow-lg hover:shadow-slate-900/[0.06]"
                >
                  <span className="mb-4 grid h-10 w-10 place-items-center rounded-lg bg-brand-tint text-brand-deep ring-1 ring-brand/15" aria-hidden>
                    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <path d={card.icon} />
                    </svg>
                  </span>
                  <p className="text-[15px] font-semibold text-ink">{card.title}</p>
                  <p className="mt-2 text-[13px] leading-relaxed text-muted">{card.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="faq" className="scroll-mt-20 border-b border-line bg-surface">
          <div className="mx-auto max-w-5xl px-5 py-20">
            <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-brand">Questions</p>
            <h2 className="mt-3 max-w-xl text-3xl font-bold tracking-tight text-ink">{spec.faq.title}</h2>
            <div className="mt-8 divide-y divide-line rounded-xl border border-line bg-paper">
              {spec.faq.items.map((item) => (
                <details key={item.q} className="group px-6 py-4">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[15px] font-semibold text-ink">
                    {item.q}
                    <span className="text-brand transition group-open:rotate-45" aria-hidden>
                      +
                    </span>
                  </summary>
                  <p className="mt-3 max-w-2xl text-[13px] leading-relaxed text-muted">{item.a}</p>
                </details>
              ))}
            </div>
            <p className="mt-6 text-[13px] text-muted">
              More in the <a className="text-brand-deep underline" href="/faq">FAQ</a>, or{' '}
              <a className="text-brand-deep underline" href="mailto:kevin@realestateaistudio.com">
                write to us
              </a>
              .
            </p>
          </div>
        </section>

        <section id="pricing" className="scroll-mt-20 bg-surface">
          <div className="mx-auto max-w-5xl px-5 py-20">
            <div className="text-center">
              <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-brand">Pricing</p>
              <h2 className="mt-3 text-3xl font-bold tracking-tight text-ink">One plan, everything included</h2>
              <p className="mx-auto mt-3 max-w-md text-[15px] text-muted">
                Every market, every layer and every feature on this page, for one workspace with teammates
                included. Cancel any time in Settings.
              </p>
            </div>
            <PricingCard included={spec.included} selfServe={selfServe} onSignIn={onSignIn} onGetStarted={onGetStarted} />
          </div>
        </section>

        <AlsoOn except={`/${slug}`} />
      </main>

      <MarketingFooter onSignIn={onSignIn} homeHref="/" />
    </div>
  )
}

export { ALSO_ON }
