import BrandMark from '../components/BrandMark'
import { api } from '../api'
import type { Account } from '../types'

/**
 * Where a confirmed email lands.
 *
 * Redeeming the link already signed this browser in, but arriving straight on
 * a payment form reads as a dead end — the person clicked "confirm" and wants
 * to be told it worked. So: say it worked, say what happens next, and give one
 * obvious button. Nothing here can fail, which is the point.
 */
export default function Welcome({
  account,
  needsSubscription,
  priceLabel,
  onContinue,
  onSignedOut,
}: {
  account: Account
  needsSubscription: boolean
  priceLabel?: string
  onContinue: () => void
  onSignedOut: () => void
}) {
  const firstName = (account.name || '').trim().split(/\s+/)[0]

  return (
    <div className="grid min-h-full place-items-center overflow-y-auto bg-paper p-6">
      <div className="panel w-full max-w-lg p-7 text-center">
        <span className="mx-auto mb-5 flex justify-center">
          <BrandMark />
        </span>

        <span
          className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-brand-tint text-brand-deep"
          aria-hidden
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
            <path d="m5 13 4 4L19 7" />
          </svg>
        </span>

        <h1 className="text-lg font-semibold text-ink">
          {firstName ? `You're in, ${firstName}` : "You're in"}
        </h1>
        <p className="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-muted">
          Your email is confirmed and <strong className="text-body">{account.email}</strong> is signed in on this
          device.
        </p>

        <div className="mt-5 rounded-xl border border-line bg-sunken p-4 text-left">
          <p className="label mb-2">What you can do</p>
          <ul className="space-y-1.5 text-sm text-body">
            <li>Map every site on a survey, with demographics on the block group.</li>
            <li>Plan a driving tour and hand the client a live link.</li>
            <li>Drop in an offering memorandum and let it fill the site profile.</li>
          </ul>
        </div>

        {needsSubscription ? (
          <p className="mt-4 text-xs text-faint">
            Next: start your subscription{priceLabel ? ` — ${priceLabel}` : ''}. Have a promo code? There&rsquo;s a
            field for it at checkout.
          </p>
        ) : null}

        <button type="button" className="btn-primary mt-5 w-full" onClick={onContinue}>
          {needsSubscription ? 'Continue' : 'Open your surveys'}
        </button>

        <p className="mt-4 border-t border-line pt-4 text-xs text-muted">
          Not you?{' '}
          <button
            type="button"
            className="underline hover:text-body"
            onClick={() => {
              void api.signOut().finally(onSignedOut)
            }}
          >
            Sign in as someone else
          </button>
        </p>
      </div>
    </div>
  )
}
