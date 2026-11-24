import { useEffect, useState } from 'react'

import CoverageMap from '../components/CoverageMap'
import { AlsoOn, MarketingFooter, MarketingHeader } from '../components/MarketingChrome'
import PricingCard from '../components/Pricing'
import { compact, fetchMarkets, money, totals, type Market } from '../lib/catalogue'
import { stateOf } from '../lib/coverage'

/**
 * The public face of the product.
 *
 * Everything a stranger sees before an account exists: what the tool is, how
 * much of the country it covers today, and two doors in. It describes the
 * product as it stands (the owner, Nov 24 2026: "Update the site with latest
 * features and total markets covered, modern SaaS site ... the client facing
 * side. Like presignup"): a parcel map for site selection and brokerage, with
 * the survey and deal tools around it.
 *
 * The counts are read from the live market list when the page opens, the way
 * the Markets and audience pages read theirs, so the page cannot quote a
 * market that is not published and does not need editing when one is. Until
 * the list arrives the sentences stand without their numbers.
 */

/** What a lot card answers, in the order a broker asks it. */
const ON_A_LOT = [
  {
    title: 'Who owns it',
    body: 'The owner on the county roll and where the tax bill is mailed, with the other parcels the same owner holds. California counties publish no owner names, and the page says so.',
  },
  {
    title: 'What it is worth to the county',
    body: 'Land, building and total value, the last recorded sale where the county publishes one, acreage and year built.',
  },
  {
    title: 'What may be built',
    body: 'Zoning and land use as the city or county writes them, with opportunity zones and other boundaries drawn over the lot.',
  },
  {
    title: 'What is happening around it',
    body: 'Building permits, submitted and approved plans and code cases, where the city publishes them, each on the map and on the lot it belongs to.',
  },
  {
    title: 'What sits nearby',
    body: 'National and regional chains with the nearest store of each, the tenant mix by sector, and the colleges, hospitals, stadiums and employers that sell a site.',
  },
  {
    title: 'Who lives there',
    body: 'Census population, income and growth shaded by tract, with the figures beside the map.',
  },
]

/** One row of the example screen: a constraint, the acres it takes, and its share. */
const SCREEN = [
  { label: 'Slope over 15%', acres: '1.9', share: 15, color: '#b45309' },
  { label: 'FEMA flood hazard', acres: '2.4', share: 19, color: '#1098ad' },
  { label: 'Wetlands', acres: '0.6', share: 5, color: '#2f9e44' },
  { label: 'Protected or public land', acres: '0.0', share: 0, color: '#7c3aed' },
]

/** The layers, in the colours the map draws them in. */
const LAYERS = [
  { name: 'Zoning', color: '#d6336c' },
  { name: 'Building permits', color: '#e8590c' },
  { name: 'Submitted and approved plans', color: '#0b7285' },
  { name: 'Code cases', color: '#c92a2a' },
  { name: 'FEMA flood zones', color: '#1098ad' },
  { name: 'Opportunity zones', color: '#E64980' },
  { name: 'Transmission lines and substations', color: '#d97706' },
  { name: 'Fuel tanks and leaks', color: '#b45309' },
  { name: 'Schools and districts', color: '#1c7ed6' },
  { name: 'Traffic counts', color: '#5f3dc4' },
]

/** The work around the map, which is where the product started. */
const DEAL_WORK = [
  {
    title: 'Surveys and tours',
    body: 'Put every candidate on one map, stage them, order the tour by drive time and print the tour book.',
  },
  {
    title: 'Share links',
    body: 'Send the client one link to the live map. Move a site to LOI and the link they already have shows it.',
  },
  {
    title: 'Lists by client',
    body: 'File parcels on a list for each client or search, and come back to them from the map or your assistant.',
  },
  {
    title: 'CRM',
    body: 'Deals, people, companies and places in the same workspace, so a lot and the conversation about it stay together.',
  },
]

const INCLUDED = [
  'The parcel map in every live market',
  'Site search and feasibility screens',
  'Zoning, permits, flood and other layers where published',
  'The connector for Claude and other assistants',
  'Surveys, tours and client share links',
  'CRM, lists and teammates, no per seat charge',
]

const check = (
  <svg className="mt-0.5 shrink-0 text-brand" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden>
    <path d="m5 13 4 4L19 7" />
  </svg>
)

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
  const [markets, setMarkets] = useState<Market[] | null>(null)

  useEffect(() => {
    let live = true
    fetchMarkets()
      .then((list) => {
        if (live) setMarkets(list)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  /*
   * A link like /#pricing from another page arrives before React has rendered
   * anything, so the browser finds no such element and leaves you at the top.
   * The hash survives the navigation, so the scroll is done here instead, once
   * the sections it names actually exist.
   */
  useEffect(() => {
    const id = window.location.hash.slice(1)
    if (!id) return
    const target = document.getElementById(id)
    if (target) target.scrollIntoView()
  }, [])

  const sums = markets?.length ? totals(markets) : null
  const states = markets?.length ? new Set(markets.map((m) => stateOf(m.slug)).filter(Boolean)).size : 0

  return (
    /*
     * No overflow container here. The app shell fixes html, body and #root at
     * 100% height and lets each view scroll itself, which is right for the map
     * but wrong for a long marketing page: the wrapper grew to its content
     * instead of scrolling, so it was never the scroller, yet `sticky` still
     * resolved against it and the header rode away with the document. Letting
     * the document scroll puts the header back on the viewport.
     */
    <div className="min-h-full bg-surface">
      <MarketingHeader selfServe={selfServe} onSignIn={onSignIn} onGetStarted={onGetStarted} current="/" wide />

      <main>
        {/*
          The hero is the coverage itself: the country, the states with a live
          market filled in, a dot on each market. It is the one picture on the
          page that only this product could draw, and it is drawn from the
          list the map opens on.
        */}
        <section className="relative overflow-hidden bg-brand-night">
          <div className="mx-auto grid max-w-6xl items-center gap-10 px-5 pb-14 pt-14 sm:pt-20 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:pb-20">
            <div>
              <h1 className="text-[2.5rem] font-bold leading-[1.04] tracking-tight text-white sm:text-[3.5rem]">
                Find the lot. Know what fits on it.
              </h1>
              <p className="mt-6 max-w-lg text-[17px] leading-relaxed text-slate-300">
                Land Quotient is a parcel map built for site selection and brokerage. Every lot carries its county
                record, the layers around it, and a screen of the acres you can actually build on.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  className="btn rounded-lg bg-brand px-5 py-3 text-[15px] text-white hover:bg-brand-soft hover:text-brand-night"
                  onClick={primaryCta}
                >
                  {selfServe ? 'Create a free account' : 'Sign in'}
                </button>
                <a
                  className="btn rounded-lg border border-brand-edge px-5 py-3 text-[15px] text-slate-200 hover:border-brand-soft hover:text-brand-soft"
                  href="/markets"
                >
                  See the markets
                </a>
              </div>
              <p className="mt-5 text-[13px] text-slate-400">Free with an account. No card, no trial clock.</p>
            </div>

            <div>
              <CoverageMap markets={markets} />
              {/* The totals read as a sentence about the map above them, not as a row of trophies. */}
              <p className="mt-4 max-w-xl text-[14px] leading-relaxed text-slate-300" aria-live="polite">
                {sums ? (
                  <>
                    <span className="font-semibold text-white">{sums.markets} markets</span> in{' '}
                    <span className="font-semibold text-white">{states} states</span> are live today:{' '}
                    <span className="font-semibold text-white">{compact(sums.parcels)} parcels</span> and{' '}
                    <span className="font-semibold text-white">{money(sums.value)}</span> on the counties' rolls. Each
                    dot opens its market.
                  </>
                ) : (
                  'Each filled state has at least one live market, read from the counties’ own records.'
                )}
              </p>
            </div>
          </div>
        </section>

        <section id="how" className="scroll-mt-20 border-b border-line bg-surface">
          <div className="mx-auto max-w-6xl px-5 py-20">
            <h2 className="max-w-2xl text-3xl font-bold tracking-tight text-ink sm:text-4xl">
              Click a lot and the county record is already there
            </h2>
            <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-muted">
              No request to the assessor, no spreadsheet to join. Zoom from the country to a state, a county and then
              the parcels themselves.
            </p>

            <figure className="mt-10 overflow-hidden rounded-xl border border-line shadow-2xl shadow-slate-900/10">
              {/* On a phone the whole screen shrinks to a thumbnail, so the map itself is shown instead. */}
              <img
                src="/shots/gis-map.jpg"
                width={680}
                height={840}
                loading="lazy"
                alt="The parcel map of Austin, every lot coloured by land use."
                className="block w-full sm:hidden"
              />
              <img
                src="/shots/gis.jpg"
                width={1440}
                height={900}
                loading="lazy"
                alt="The parcel map of Austin: every lot coloured by land use, a panel of layers on the left with zoning, permits, opportunity zones and schools, and the legend on the right."
                className="hidden w-full sm:block"
              />
            </figure>

            <dl className="mt-12 grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
              {ON_A_LOT.map((item) => (
                <div key={item.title} className="border-t-2 border-ink pt-4">
                  <dt className="text-[16px] font-semibold text-ink">{item.title}</dt>
                  <dd className="mt-2 text-[14px] leading-relaxed text-muted">{item.body}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section id="feasibility" className="scroll-mt-20 border-b border-line bg-paper">
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 py-20 lg:grid-cols-2">
            <div>
              <h2 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">Screen a site before you drive it</h2>
              <p className="mt-4 text-[16px] leading-relaxed text-muted">
                Pick a lot, or five, and the screen takes out what cannot be built on: steep ground, FEMA flood hazard,
                wetlands and protected land. What is left is the acres that pass.
              </p>
              <ul className="mt-6 space-y-3 text-[15px] text-body">
                <li className="flex items-start gap-2.5">
                  {check}
                  Runs in every market, from federal elevation, flood and wetland data.
                </li>
                <li className="flex items-start gap-2.5">
                  {check}
                  Search and screen in one step: "ten acres or more, industrial, outside the floodplain", ranked by the
                  acres that pass.
                </li>
                <li className="flex items-start gap-2.5">
                  {check}
                  A first look, not an engineering study, and it says so on every result.
                </li>
              </ul>
            </div>

            {/* An example drawn as the product draws it. The figures are made up and labelled as such. */}
            <div className="rounded-xl border border-line bg-surface p-6 shadow-xl shadow-slate-900/[0.07] sm:p-8">
              <div className="flex items-baseline justify-between gap-4">
                <p className="text-[15px] font-semibold text-ink">Feasibility screen</p>
                <p className="text-[12px] text-faint">Example, with illustrative figures</p>
              </div>
              <div className="mt-5 flex items-end justify-between gap-4 border-b border-line pb-5">
                <div>
                  <p className="text-[13px] text-muted">Passes the screen</p>
                  <p className="mt-1 text-4xl font-bold tracking-tight text-ink">
                    7.7 <span className="text-lg font-semibold text-muted">of 12.6 acres</span>
                  </p>
                </div>
                <span className="rounded-full bg-brand-tint px-3 py-1 text-[13px] font-semibold text-brand-deep">61% buildable</span>
              </div>
              <div className="mt-5 flex h-3 overflow-hidden rounded-full bg-sunken" aria-hidden>
                <span style={{ width: '61%' }} className="bg-brand" />
                {SCREEN.filter((row) => row.share > 0).map((row) => (
                  <span key={row.label} style={{ width: `${row.share}%`, background: row.color }} />
                ))}
              </div>
              <table className="mt-5 w-full text-[14px]">
                <tbody>
                  {SCREEN.map((row) => (
                    <tr key={row.label} className="border-b border-line last:border-0">
                      <th scope="row" className="py-2.5 text-left font-normal text-body">
                        <span className="mr-2.5 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ background: row.color }} aria-hidden />
                        {row.label}
                      </th>
                      <td className="py-2.5 text-right tabular-nums text-ink">{row.acres} ac</td>
                      <td className="w-14 py-2.5 text-right tabular-nums text-muted">{row.share}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section id="layers" className="scroll-mt-20 border-b border-line bg-surface">
          <div className="mx-auto grid max-w-6xl gap-12 px-5 py-20 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
            <div>
              <h2 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">Layers you switch on, not files you find</h2>
              <p className="mt-4 text-[16px] leading-relaxed text-muted">
                Each market carries what its city, county and state publish, already clipped and drawn. A layer can
                also be a search condition: within a mile of a transmission line, inside an opportunity zone, outside
                the floodplain.
              </p>
              <p className="mt-4 text-[14px] leading-relaxed text-muted">
                What is published differs by market, and the <a className="font-semibold text-brand-deep underline" href="/markets">Markets page</a>{' '}
                lists it for each one.
              </p>
            </div>
            {/* A legend, because that is what this list is. */}
            <ul className="grid content-start gap-x-8 gap-y-3 text-[15px] text-ink sm:grid-cols-2">
              {LAYERS.map((layer) => (
                <li key={layer.name} className="flex items-center gap-3 border-b border-line pb-3">
                  <span className="h-3.5 w-3.5 shrink-0 rounded-[3px]" style={{ background: layer.color }} aria-hidden />
                  {layer.name}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="assistant" className="scroll-mt-20 bg-brand-night">
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 py-20 lg:grid-cols-2">
            <div>
              <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">Ask your assistant instead</h2>
              <p className="mt-4 text-[16px] leading-relaxed text-slate-300">
                Connect Land Quotient to Claude and the same records answer in a conversation. It searches parcels,
                screens sites, lists the chains nearby, saves a map you can open, and files what you keep on a client
                list. You sign in with your Land Quotient account. There is no key to copy.
              </p>
              <a
                className="btn mt-7 inline-block rounded-lg border border-brand-edge px-5 py-3 text-[15px] text-slate-200 hover:border-brand-soft hover:text-brand-soft"
                href="/connect"
              >
                How to connect it
              </a>
            </div>
            <div className="rounded-xl border border-brand-edge bg-[#0a1a38] p-6 sm:p-8">
              <p className="text-[13px] text-slate-400">You ask</p>
              <p className="mt-2 text-[17px] leading-relaxed text-white">
                Find industrial sites over ten acres in Travis County that stay out of the floodplain, and map the top
                five.
              </p>
              <p className="mt-6 text-[13px] text-slate-400">It answers with</p>
              <ul className="mt-2 space-y-2 text-[15px] text-slate-200">
                <li>The matches, ranked by the acres that pass the screen</li>
                <li>Each lot's owner, value and zoning from the county</li>
                <li>A link that opens the map in Land Quotient</li>
              </ul>
              <p className="mt-6 break-all border-t border-brand-edge pt-4 font-mono text-[13px] text-brand-soft">
                https://landquotient.com/mcp
              </p>
            </div>
          </div>
        </section>

        <section id="pieces" className="scroll-mt-20 border-b border-line bg-surface">
          <div className="mx-auto max-w-6xl px-5 py-20">
            <div className="grid gap-12 lg:grid-cols-2">
              <div>
                <h2 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">Pieces for your brief, under your brand</h2>
                <p className="mt-4 text-[16px] leading-relaxed text-muted">
                  We do not write the brief. Land Quotient hands you the parts of one: the feasibility map and table,
                  the property record, demographics, the retail around a site. Copy a table or download a map and
                  paste it into the deck that already carries your logo.
                </p>
                <ul className="mt-6 space-y-3 text-[15px] text-body">
                  <li className="flex items-start gap-2.5">
                    {check}
                    Maps download as images, ready for a slide or a page.
                  </li>
                  <li className="flex items-start gap-2.5">
                    {check}
                    Tables copy into Word, PowerPoint, Excel and Google Docs with their columns intact.
                  </li>
                  <li className="flex items-start gap-2.5">
                    {check}
                    Parcels export with their real outlines for your own GIS.
                  </li>
                </ul>
              </div>
              <div>
                <h3 className="text-xl font-bold tracking-tight text-ink">And the deal work around the map</h3>
                <dl className="mt-5 grid gap-x-8 gap-y-6 sm:grid-cols-2">
                  {DEAL_WORK.map((item) => (
                    <div key={item.title}>
                      <dt className="text-[15px] font-semibold text-ink">{item.title}</dt>
                      <dd className="mt-1.5 text-[14px] leading-relaxed text-muted">{item.body}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>

            <figure className="mt-12 overflow-hidden rounded-xl border border-line shadow-xl shadow-slate-900/[0.07]">
              <img
                src="/shots/map.jpg"
                width={1440}
                height={660}
                loading="lazy"
                alt="A survey map with a stage rail on the left listing sites under Unqualified, Qualified/Touring, LOI, Under Contract and Passed, and two pins inside a dashed half mile radius ring."
                className="block w-full"
              />
            </figure>
          </div>
        </section>

        <section id="pricing" className="scroll-mt-20 bg-paper">
          <div className="mx-auto max-w-6xl px-5 py-20">
            <div className="text-center">
              <h2 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">Free, everything included</h2>
              <p className="mx-auto mt-3 max-w-md text-[16px] text-muted">
                Make an account and confirm your email. No card, no trial clock.
              </p>
            </div>

            <PricingCard included={INCLUDED} selfServe={selfServe} onSignIn={onSignIn} onGetStarted={onGetStarted} />
          </div>
        </section>

        <AlsoOn except="/" wide />
      </main>

      <MarketingFooter onSignIn={onSignIn} wide />
    </div>
  )
}
