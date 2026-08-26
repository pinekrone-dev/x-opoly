import { MarketingFooter, MarketingHeader } from '../components/MarketingChrome'

/**
 * The questions a broker asks before they will put a live requirement in
 * someone else's tool.
 *
 * Answers describe what the product does and what it costs. They deliberately
 * do not describe how any of it is built — which models read a flyer, which
 * provider returns a drive time, how the data is assembled. That is the part
 * worth having, and a FAQ is not where it gets handed over.
 */

const GROUPS = [
  {
    label: 'The basics',
    items: [
      {
        q: 'What is Land Quotient?',
        a: 'A place to run a market survey end to end. Candidate buildings go on one map, move through the stages of your deal, get compared on the numbers, and come out the other side as a tour the client can follow. It replaces the folder of flyers and the spreadsheet that usually sits beside it.',
      },
      {
        q: 'Who is it for?',
        a: 'Tenant rep brokers running live requirements. It assumes you are working a shortlist for someone, not browsing inventory.',
      },
      {
        q: 'What does it cost?',
        a: 'Twenty nine dollars a month per workspace, with your teammates included. Every feature is in that price. There is no per seat charge and no upsell tier.',
      },
      {
        q: 'Do I have to install anything?',
        a: 'No. It runs in the browser, on a laptop or a phone. There is nothing to download and nothing for IT to approve.',
      },
    ],
  },
  {
    label: 'Working with clients',
    items: [
      {
        q: 'Do my clients need an account?',
        a: 'No. A share link opens the live survey map for anyone you send it to, with no login and no attachment. Nothing is emailed as a file that goes stale the moment you change something.',
      },
      {
        q: 'Can I control what the client sees?',
        a: 'Yes. You choose which stages appear on a share link, so the sites you have passed on stay on your side of it. Demographics and QR codes are switches you turn on rather than defaults.',
      },
      {
        q: 'What do I hand over at the end of a tour?',
        a: 'A tour book PDF with the stops in order, or a comparison PDF lining the sites up against each other. Both are generated from the same survey, so neither can disagree with the map.',
      },
      {
        q: 'Can my team work in the same survey?',
        a: 'Yes. Teammates are invited into the workspace and are included in the subscription.',
      },
    ],
  },
  {
    label: 'The data',
    items: [
      {
        q: 'Where do the demographics come from?',
        a: 'US Census data, shaded around each site and summarised in a side panel. It is the same public source a research team would cite, presented so you can answer a question in a meeting rather than after it.',
      },
      {
        q: 'What happens when I upload a flyer?',
        a: 'The fields come back filled in for you to check, and nothing saves until you confirm it. Treat it as a fast first draft of the site profile, not as a source of record.',
      },
      {
        q: 'How accurate are the drive times?',
        a: 'They are real road routing rather than straight line estimates, which is enough to build a schedule that holds up. They are not a live traffic feed, so treat a tour plan as a good plan rather than a guarantee.',
      },
      {
        q: 'What if a building is not in the data?',
        a: 'Add it by address and fill in what you know. Nothing in a survey depends on a building already existing in a database somewhere.',
      },
    ],
  },
  {
    label: 'Your account',
    items: [
      {
        q: 'Who can see my surveys?',
        a: 'Your workspace and the people you invite into it. A survey is only visible outside that when you create a share link for it, and you can stop sharing at any point.',
      },
      {
        q: 'Can I cancel?',
        a: 'Any time, from your billing page. No call, no retention flow.',
      },
      {
        q: 'How do I pay?',
        a: 'By card at checkout, handled by Stripe. Promo codes are entered there. Card details never touch our own systems.',
      },
    ],
  },
]

export default function Faq({
  selfServe,
  onSignIn,
  onGetStarted,
}: {
  selfServe: boolean
  onSignIn: () => void
  onGetStarted: () => void
}) {
  return (
    <div className="min-h-full bg-surface">
      <MarketingHeader
        selfServe={selfServe}
        onSignIn={onSignIn}
        onGetStarted={onGetStarted}
        homeHref="/"
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
          <div className="relative mx-auto max-w-5xl px-5 py-16 sm:py-20">
            <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-brand-soft">
              Questions
            </p>
            <h1 className="mt-3 max-w-2xl text-3xl font-bold leading-tight tracking-tight text-white sm:text-[2.6rem]">
              What brokers ask before they move a live requirement
            </h1>
            <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-slate-300">
              If yours is not here, <a className="text-brand-soft underline" href="mailto:kevin@realestateaistudio.com">write to us</a>{' '}
              and we will answer it properly.
            </p>
          </div>
        </section>

        <div className="mx-auto max-w-5xl px-5 py-16">
          <div className="space-y-14">
            {GROUPS.map((group) => (
              <section key={group.label} aria-labelledby={`faq-${group.label}`}>
                <h2
                  id={`faq-${group.label}`}
                  className="border-t border-line pt-5 font-mono text-[11px] uppercase tracking-[0.16em] text-brand"
                >
                  {group.label}
                </h2>
                <dl className="mt-6 grid gap-4 md:grid-cols-2">
                  {group.items.map((item) => (
                    <div key={item.q} className="rounded-xl border border-line bg-paper p-6">
                      <dt className="text-[15px] font-semibold text-ink">{item.q}</dt>
                      <dd className="mt-2.5 text-[13px] leading-relaxed text-muted">{item.a}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>

          <div className="mt-16 rounded-xl border border-line bg-paper p-8 text-center">
            <p className="text-lg font-semibold text-ink">Ready to put a requirement on the map?</p>
            <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-muted">
              One plan, everything included, cancel any time.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              {selfServe ? (
                <button type="button" className="btn-primary px-5 py-2.5" onClick={onGetStarted}>
                  Start for $29/month
                </button>
              ) : null}
              <a className="btn border border-line-strong px-4 py-2.5 text-body hover:border-muted" href="/#how">
                See how it works
              </a>
            </div>
          </div>
        </div>
      </main>

      <MarketingFooter onSignIn={onSignIn} homeHref="/" />
    </div>
  )
}
