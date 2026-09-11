import { useEffect, useState } from 'react'

import { AlsoOn, MarketingFooter, MarketingHeader } from '../components/MarketingChrome'
import { compact, fetchMarkets, money, totals, type Market } from '../lib/catalogue'

/**
 * The markets, read from the catalogue the map itself uses.
 *
 * Nothing here is typed in: the name, the county, the roll, the parcel count,
 * the value and which fields the county publishes all come from the same
 * `markets.json` the map opens on, so this page cannot promise a market the
 * map does not have.
 */

/** What each market publishes on top of the roll, as the catalogue lists it. */
const OVERLAYS: Record<string, string[]> = {
  'austin-tx': ['Zoning', 'Permits', 'Entitlements', 'Road projects', 'Opportunity zones', 'Schools'],
  'washington-dc': ['Permits', 'Certificates of occupancy', 'Flood zones', 'Opportunity zones', 'Schools'],
  'nashville-tn': ['Permits', 'Opportunity zones', 'Schools'],
  'orange-county-ca': ['Permits', 'Code cases', 'Business licences', 'Flood zones', 'Opportunity zones', 'Schools'],
  'fort-lauderdale-fl': ['Zoning', 'Permits', 'Traffic counts', 'Opportunity zones', 'Schools'],
  'houston-tx': ['Permits', 'TIRZ districts', 'Super neighborhoods', 'Opportunity zones', 'Schools'],
  'las-vegas-nv': ['Permits', 'Flood zones', 'Opportunity zones', 'Schools'],
  'phoenix-az': ['Zoning', 'Existing land use', 'Permits', 'Entitlements', 'Traffic counts', 'Flood zones', 'Opportunity zones', 'Schools'],
  'new-york-ny': ['Permits', 'Flood zones', 'Opportunity zones', 'Schools'],
  'jersey-city-nj': ['Zoning', 'Redevelopment areas', 'Traffic counts', 'Rail stations', 'Flood zones', 'Opportunity zones', 'Schools'],
  'denver-co': ['Existing land use', 'Zoning', 'Permits', 'Entitlements', 'Landmark districts', 'Traffic counts', 'Flood zones', 'Opportunity zones', 'Schools'],
  'tampa-fl': ['Zoning', 'Permits', 'Zoning hearings', 'Redevelopment areas', 'Traffic counts', 'Flood zones', 'Opportunity zones', 'Schools'],
  'minneapolis-mn': ['Zoning', 'Built form', 'Permits', 'Existing land use', 'Small area plans', 'Traffic counts', 'Flood zones', 'Opportunity zones', 'Schools'],
}

/** The number of markets, written out while it is small enough to read as a word. */
const COUNT_WORDS: Record<number, string> = {
  10: 'Ten', 11: 'Eleven', 12: 'Twelve', 13: 'Thirteen', 14: 'Fourteen', 15: 'Fifteen',
  16: 'Sixteen', 17: 'Seventeen', 18: 'Eighteen', 19: 'Nineteen', 20: 'Twenty',
}

const ORDER = [
  'phoenix-az',
  'denver-co',
  'tampa-fl',
  'minneapolis-mn',
  'jersey-city-nj',
  'orange-county-ca',
  'new-york-ny',
  'fort-lauderdale-fl',
  'houston-tx',
  'austin-tx',
  'las-vegas-nv',
  'washington-dc',
  'nashville-tn',
]

export default function Markets({
  selfServe,
  onSignIn,
  onGetStarted,
}: {
  selfServe: boolean
  onSignIn: () => void
  onGetStarted: () => void
}) {
  const [markets, setMarkets] = useState<Market[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    document.title = 'Land Quotient markets — every parcel on the roll, county by county'
    let live = true
    fetchMarkets()
      .then((list) => {
        if (!live) return
        const rank = (m: Market) => (ORDER.includes(m.slug) ? ORDER.indexOf(m.slug) : ORDER.length)
        list.sort((a, b) => rank(a) - rank(b))
        setMarkets(list)
      })
      .catch(() => live && setFailed(true))
    return () => {
      live = false
    }
  }, [])

  const sums = markets ? totals(markets) : null

  return (
    <div className="min-h-full bg-surface">
      <MarketingHeader selfServe={selfServe} onSignIn={onSignIn} onGetStarted={onGetStarted} homeHref="/" current="/markets" />

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
            <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-brand-soft">Markets</p>
            <h1 className="mt-3 max-w-2xl text-3xl font-bold leading-tight tracking-tight text-white sm:text-[2.6rem]">
              {sums ? `${COUNT_WORDS[sums.markets] ?? sums.markets} counties` : 'Every county'}, every parcel on the roll
            </h1>
            <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-slate-300">
              Each market is one county’s own appraisal or assessment roll, loaded whole: every parcel, its
              owner of record where the county publishes one, its value, and the city’s zoning and permit
              layers on top. One subscription opens all of them.
            </p>
            <dl className="mt-10 grid max-w-2xl grid-cols-3 gap-6">
              {[
                ['Markets', sums ? String(sums.markets) : '—'],
                ['Parcels', sums ? compact(sums.parcels) : '—'],
                ['Assessed value', sums ? money(sums.value) : '—'],
              ].map(([label, value]) => (
                <div key={label}>
                  <dd className="text-2xl font-bold tracking-tight text-white sm:text-3xl">{value}</dd>
                  <dt className="text-[12px] text-slate-400">{label}</dt>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <div className="mx-auto max-w-5xl px-5 py-16">
          {failed ? (
            <p className="rounded-xl border border-line bg-paper p-6 text-sm text-muted">
              The market list could not be read just now. The map at{' '}
              <a className="text-brand-deep underline" href="/gis">
                /gis
              </a>{' '}
              carries the same list.
            </p>
          ) : null}

          <div className="grid gap-4 md:grid-cols-2">
            {(markets ?? []).map((m) => {
              const s = m.stats
              const fields = (s.fields ?? []).filter((f) => f.pct >= 30)
              const groups = Object.entries(s.groups ?? {})
                .sort((a, b) => b[1] - a[1])
                .slice(0, 4)
              return (
                <article key={m.slug} className="flex flex-col rounded-xl border border-line bg-paper p-6">
                  <div className="flex items-baseline justify-between gap-3">
                    <h2 className="text-xl font-bold tracking-tight text-ink">{m.name}</h2>
                    <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-brand">{m.roll ?? 'current roll'}</span>
                  </div>
                  <p className="text-[13px] text-muted">{m.region}</p>
                  <p className="mt-3 text-[13px] leading-relaxed text-body">{m.blurb}</p>

                  <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-line pt-4">
                    <div>
                      <dd className="text-lg font-bold text-ink">{compact(s.parcels)}</dd>
                      <dt className="text-[11px] text-muted">parcels</dt>
                    </div>
                    <div>
                      <dd className="text-lg font-bold text-ink">{money(s.value)}</dd>
                      <dt className="text-[11px] text-muted">assessed</dt>
                    </div>
                    <div>
                      <dd className="text-lg font-bold text-ink">{s.portfolios ? compact(s.portfolios) : '—'}</dd>
                      <dt className="text-[11px] text-muted">{s.portfolios ? 'portfolios' : 'no owner names'}</dt>
                    </div>
                  </dl>

                  {groups.length ? (
                    <p className="mt-3 text-[12px] text-muted">
                      {groups.map(([g, n]) => `${g} ${compact(n)}`).join(' · ')}
                    </p>
                  ) : null}

                  <div className="mt-4 flex flex-wrap gap-1.5">
                    {fields.map((f) => (
                      <span key={f.k} className="rounded-full bg-brand-tint px-2.5 py-0.5 text-[11px] font-medium text-brand-deep" title={`${f.pct}% of parcels`}>
                        {f.l}
                      </span>
                    ))}
                    {(OVERLAYS[m.slug] ?? []).map((o) => (
                      <span key={o} className="rounded-full border border-line px-2.5 py-0.5 text-[11px] text-body">
                        {o}
                      </span>
                    ))}
                  </div>

                  <a className="mt-5 text-[13px] font-medium text-brand-deep underline" href={`/gis/${m.slug}`}>
                    Open {m.name} on the map
                  </a>
                </article>
              )
            })}
            {!markets && !failed
              ? Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-64 animate-pulse rounded-xl border border-line bg-paper" aria-hidden />
                ))
              : null}
          </div>

          <div className="mt-16 rounded-xl border border-line bg-paper p-8 text-center">
            <p className="text-lg font-semibold text-ink">Every market, one subscription</p>
            <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-muted">
              $29 a month per workspace, teammates included, cancel any time. A market that is not here yet is
              a note away.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              {selfServe ? (
                <button type="button" className="btn-primary px-5 py-2.5" onClick={onGetStarted}>
                  Start for $29/month
                </button>
              ) : null}
              <a className="btn border border-line-strong px-4 py-2.5 text-body hover:border-muted" href="mailto:kevin@realestateaistudio.com?subject=A%20market%20for%20Land%20Quotient">
                Ask for a market
              </a>
            </div>
          </div>
        </div>

        <AlsoOn except="/markets" />
      </main>

      <MarketingFooter onSignIn={onSignIn} homeHref="/" />
    </div>
  )
}
