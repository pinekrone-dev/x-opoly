/**
 * The one pricing card, shared by every public page.
 *
 * The price is the same wherever it is quoted, so the card is written once
 * and each page only chooses which included lines to list for its reader.
 */

export const PRICE_LINE = '$29'

/** The trial every new workspace starts on; the server's TRIAL_DAYS default. */
export const TRIAL_LINE = '14-day free trial'

export default function PricingCard({
  included,
  selfServe,
  onSignIn,
  onGetStarted,
}: {
  included: string[]
  selfServe: boolean
  onSignIn: () => void
  onGetStarted: () => void
}) {
  return (
    <div className="mx-auto mt-10 max-w-sm">
      <div className="overflow-hidden rounded-xl border border-line shadow-xl shadow-slate-900/10">
        <div className="bg-brand-night p-7 text-center">
          <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-brand-soft">Land Quotient</p>
          <p className="mt-3 text-5xl font-bold tracking-tight text-white">
            {PRICE_LINE}
            <span className="text-base font-medium text-slate-400"> / month</span>
          </p>
          <p className="mt-2 text-xs text-slate-400">per workspace, teammates included</p>
        </div>
        <ul className="space-y-3 bg-surface p-7 text-sm text-body">
          {included.map((line) => (
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
                Start your {TRIAL_LINE}
              </button>
              <p className="mt-3 text-center text-[11px] leading-relaxed text-faint">
                Create your account, confirm your email, and add a card. Nothing is charged until the trial ends,
                then {PRICE_LINE}/month. Cancel any time in Settings. Powered by Stripe.
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
  )
}
