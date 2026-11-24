import { useEffect, useState } from 'react'

import { AlsoOn, MarketingFooter, MarketingHeader } from '../components/MarketingChrome'
import { LIMITS_LINE } from '../components/Pricing'

/**
 * How to connect an AI assistant to Land Quotient.
 *
 * The connector (app/lib/mcp.js, app/lib/codemode.js) lets an assistant such
 * as Claude, ChatGPT or Grok search parcels, screen sites and draw maps as the person
 * who connected it. This page is the public set of directions: the address
 * to paste, the steps for each assistant, what the approval screen asks, and
 * what to ask once it is connected.
 *
 * It names only what works today. An assistant is listed here once its
 * sign-in has been set up on our side (app/lib/oauth.js allows a return
 * address assistant by assistant); anything else is told how to ask. An
 * example prompt is listed only if every market can answer it.
 */

export const CONNECTOR_ADDRESS = 'https://landquotient.com/mcp'
export const CLASSIC_ADDRESS = 'https://landquotient.com/mcp/classic'
const CONTACT = 'kevin@realestateaistudio.com'

const ASSISTANTS = [
  {
    name: 'Claude',
    where: 'claude.ai, the desktop app and the phone app',
    steps: [
      'Open Settings, then Connectors, and choose Add custom connector.',
      'Name it Land Quotient and paste the address above.',
      'Press Connect. Sign in to Land Quotient, check what it may do, and press Allow.',
    ],
  },
  {
    name: 'Claude Code',
    where: 'the terminal',
    command: `claude mcp add --transport http land-quotient ${CONNECTOR_ADDRESS}`,
    steps: ['Run the command below.', 'In Claude Code, type /mcp, pick land-quotient and sign in.', 'Press Allow on the Land Quotient page that opens.'],
  },
  {
    // The steps are ChatGPT's own, read from OpenAI's "Connect and test"
    // page on Nov 24 2026. Whether a custom server may be added at all is
    // set by the person's plan and workspace, which the line under the name says.
    name: 'ChatGPT',
    where: 'chatgpt.com, where your plan and workspace allow custom servers',
    steps: [
      'Open chatgpt.com/plugins, press the plus button and choose Add custom MCP server.',
      'Name it Land Quotient and paste the address above as the MCP server URL.',
      'Choose OAuth for authentication, accept the warning and press Create as a plugin.',
      'Sign in to Land Quotient when it sends you here and press Allow. In a chat, type @ and pick Land Quotient.',
    ],
  },
  {
    name: 'Grok',
    where: 'grok.com',
    steps: [
      'Open the connectors settings and add a custom connector.',
      'Paste the address above.',
      'Sign in to Land Quotient when it sends you here, and press Allow.',
    ],
  },
]

const PROMPTS = [
  'Find vacant land over 20 acres in Travis County that is outside the flood zone, and rank the best eight by buildable acres.',
  'Screen this parcel for slope, flood hazard, wetlands and protected land, and draw me the map.',
  'Which national chains are within a mile of this address, and how far is the nearest Target?',
  'Give me the property, feasibility and demographics pieces for this parcel, ready to paste into my own brief.',
  'Which owners along this corridor have held their parcels for more than ten years and mail from out of state?',
  'Make a map of industrial parcels within half a mile of a transmission line and send me the link.',
]

const ABILITIES = [
  {
    name: 'Find',
    body: 'Search a county by use, acreage, value, zoning, flood zone, owner signals or distance to a layer. Read any one parcel in full, with its permits and recorded mortgages where the city publishes them.',
  },
  {
    name: 'Screen',
    body: 'Slope, FEMA flood hazard, wetlands and protected land on a lot, with the acres that pass. One lot, a short list, or search and screen in one step.',
  },
  {
    name: 'Around a site',
    body: 'National and regional chains nearby with the tenant mix, the landmarks and major employers that sell a location, and Census demographics by ring.',
  },
  {
    name: 'Hand off',
    body: 'A saved map that opens in Land Quotient, a map image for a deck, parcel outlines as GeoJSON, and unbranded pieces (text, table, source) to paste into your own brief.',
  },
]

/** A line to copy: on the navy hero, or on a light section. Long lines wrap rather than push the page wide. */
function CopyLine({ text, label, tone = 'dark' }: { text: string; label: string; tone?: 'dark' | 'light' }) {
  const [copied, setCopied] = useState(false)
  const dark = tone === 'dark'
  return (
    <div className={`flex items-stretch overflow-hidden rounded-lg border ${dark ? 'border-brand-edge bg-brand-night/60' : 'border-line bg-surface'}`}>
      <code className={`min-w-0 flex-1 break-all px-4 py-3 font-mono text-[13px] ${dark ? 'text-white' : 'text-body'}`} data-testid={`copy-${label}`}>
        {text}
      </code>
      <button
        type="button"
        className={`shrink-0 border-l px-4 text-xs font-semibold ${dark ? 'border-brand-edge text-brand-soft hover:bg-brand-edge/40' : 'border-line text-brand-deep hover:bg-sunken'}`}
        aria-label={`Copy the ${label}`}
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1500)
          })
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

export default function ConnectPage({
  selfServe,
  onSignIn,
  onGetStarted,
}: {
  selfServe: boolean
  onSignIn: () => void
  onGetStarted: () => void
}) {
  useEffect(() => {
    document.title = 'Connect Claude, ChatGPT or Grok to Land Quotient'
  }, [])

  return (
    <div className="min-h-full bg-surface">
      <MarketingHeader selfServe={selfServe} onSignIn={onSignIn} onGetStarted={onGetStarted} homeHref="/" current="/connect" />

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
            <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-brand-soft">Connect</p>
            <h1 className="mt-3 max-w-2xl text-3xl font-bold leading-tight tracking-tight text-white sm:text-[2.6rem]">
              Put Land Quotient inside your AI assistant.
            </h1>
            <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-slate-300">
              Add one address to Claude, ChatGPT or Grok and it can search parcels, screen sites and draw maps from the same county
              records as the app. It signs in as you. There is no API key.
            </p>
            <div className="mt-8 max-w-xl">
              <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.16em] text-slate-400">The address to paste</p>
              <CopyLine text={CONNECTOR_ADDRESS} label="address" />
            </div>
            <p className="mt-4 max-w-xl text-xs leading-relaxed text-slate-400">
              You need a free Land Quotient account and an assistant that takes custom connectors.
              {selfServe ? (
                <>
                  {' '}
                  <button type="button" className="underline hover:text-brand-soft" onClick={onGetStarted}>
                    Create the account
                  </button>{' '}
                  first if you do not have one.
                </>
              ) : null}
            </p>
          </div>
        </section>

        <section className="mx-auto max-w-5xl px-5 py-14">
          <h2 className="border-t border-line pt-5 font-mono text-[11px] uppercase tracking-[0.16em] text-brand">How to connect</h2>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {ASSISTANTS.map((assistant) => (
              <div key={assistant.name} className="min-w-0 rounded-xl border border-line bg-paper p-6" data-assistant={assistant.name}>
                <h3 className="text-[15px] font-semibold text-ink">{assistant.name}</h3>
                <p className="mt-0.5 text-[12px] text-faint">{assistant.where}</p>
                <ol className="mt-4 space-y-2.5 text-[13px] leading-relaxed text-muted">
                  {assistant.steps.map((step, i) => (
                    <li key={step} className="flex gap-2.5">
                      <span className="mt-px grid h-5 w-5 shrink-0 place-items-center rounded-full bg-brand-tint text-[11px] font-semibold text-brand-deep">{i + 1}</span>
                      <span>{step}</span>
                    </li>
                  ))}
                </ol>
                {assistant.command ? (
                  <div className="mt-4">
                    <CopyLine text={assistant.command} label="command" tone="light" />
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          <p className="mt-5 max-w-3xl text-[13px] leading-relaxed text-muted">
            <span className="font-semibold text-ink">Using another assistant?</span> Signing in only sends you back to an assistant we have
            approved, so a new one is turned away with "This connection link is not valid". That page shows a return address:{' '}
            <a className="text-brand-deep underline" href={`mailto:${CONTACT}?subject=Connect%20another%20assistant%20to%20Land%20Quotient`}>
              send it to us
            </a>{' '}
            and we will add it.
          </p>
        </section>

        <section className="border-y border-line bg-paper">
          <div className="mx-auto grid max-w-5xl gap-10 px-5 py-14 md:grid-cols-2">
            <div>
              <h2 className="font-mono text-[11px] uppercase tracking-[0.16em] text-brand">What it asks you</h2>
              <p className="mt-4 text-[15px] font-semibold text-ink">You approve it once, on a Land Quotient page.</p>
              <ul className="mt-4 space-y-2.5 text-[13px] leading-relaxed text-muted">
                <li>It acts as you, with your account and nobody else's.</li>
                <li>It may search parcels and read county records, layers, permits and mortgages in your markets.</li>
                <li>It may save maps to your workspace and link you to them.</li>
                <li>Adding parcels to your CRM is a separate box, and it starts unticked.</li>
                <li>It uses your account's daily allowances, the same as the app does.</li>
                <li>Disconnect it any time in Land Quotient under Settings, Connected apps.</li>
              </ul>
            </div>
            <div>
              <h2 className="font-mono text-[11px] uppercase tracking-[0.16em] text-brand">What to ask</h2>
              <ul className="mt-4 space-y-2.5">
                {PROMPTS.map((prompt) => (
                  <li key={prompt} className="rounded-lg border border-line bg-surface px-4 py-3 text-[13px] leading-relaxed text-body">
                    {prompt}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-5xl px-5 py-14">
          <h2 className="border-t border-line pt-5 font-mono text-[11px] uppercase tracking-[0.16em] text-brand">What it can do</h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {ABILITIES.map((ability) => (
              <div key={ability.name} className="rounded-xl border border-line bg-paper p-5">
                <h3 className="text-[14px] font-semibold text-ink">{ability.name}</h3>
                <p className="mt-2 text-[12px] leading-relaxed text-muted">{ability.body}</p>
              </div>
            ))}
          </div>
          <p className="mt-5 text-[13px] text-muted">
            It reaches <a className="text-brand-deep underline" href="/markets">every county on the map</a>. Some counties can be searched by
            address, owner or parcel number only, and it says so when that is the case. Start by asking which markets it covers.
          </p>
        </section>

        <section className="border-y border-line bg-paper">
          <div className="mx-auto grid max-w-5xl gap-10 px-5 py-14 md:grid-cols-2">
            <div>
              <h2 className="font-mono text-[11px] uppercase tracking-[0.16em] text-brand">For the technical reader</h2>
              <ul className="mt-4 space-y-2.5 text-[13px] leading-relaxed text-muted">
                <li>It is a Model Context Protocol (MCP) server over streamable HTTP, with OAuth sign-in and no key to manage.</li>
                <li>
                  The assistant sees two tools. <span className="font-mono text-[12px] text-body">search</span> finds an operation and how to call
                  it; <span className="font-mono text-[12px] text-body">execute</span> runs a short script the assistant writes, so one request can
                  search, screen and compare in a single step.
                </li>
                <li>A script runs in a sandbox with no network and no access to anything but Land Quotient's own operations.</li>
                <li>
                  If your assistant does better with one named tool per operation, or scripts are unavailable, use the classic address instead. It
                  does the same things.
                </li>
              </ul>
              <div className="mt-4 max-w-md">
                <CopyLine text={CLASSIC_ADDRESS} label="classic address" tone="light" />
              </div>
            </div>
            <div>
              <h2 className="font-mono text-[11px] uppercase tracking-[0.16em] text-brand">What it is not</h2>
              <ul className="mt-4 space-y-2.5 text-[13px] leading-relaxed text-muted">
                <li>Not a bulk download. {LIMITS_LINE}</li>
                <li>Not an appraisal. Figures are the county's own, and an assessed value is a tax figure.</li>
                <li>Not a survey. A feasibility screen reads public elevation, flood, wetland and protected-area maps.</li>
                <li>Not complete everywhere. California counties publish no owner names, and each county carries what it publishes.</li>
              </ul>
            </div>
          </div>
        </section>

        {selfServe ? (
          <section className="mx-auto max-w-5xl px-5 py-14 text-center">
            <button type="button" className="btn-primary px-6 py-3" onClick={onGetStarted}>
              Create your free account
            </button>
            <p className="mt-3 text-xs text-faint">
              Already have one?{' '}
              <button type="button" className="underline hover:text-body" onClick={onSignIn}>
                Sign in
              </button>
              , then add the address to your assistant.
            </p>
          </section>
        ) : null}

        {/* The markets are linked above, which leaves the four readers in one even row. */}
        <AlsoOn except="/markets" />
      </main>

      <MarketingFooter onSignIn={onSignIn} homeHref="/" />
    </div>
  )
}
