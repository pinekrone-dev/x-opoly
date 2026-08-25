import { useEffect, useState } from 'react'
import { api } from '../api'
import CheckoutPanel from '../components/CheckoutPanel'
import { BrandPin } from '../components/BrandMark'
import { navigate } from '../lib/router'
import type { Account, BillingStatus } from '../types'

/**
 * The two billing screens: the paywall a lapsed or new team lands on, and the
 * page Stripe sends the buyer back to.
 *
 * Both wear the app's own frame. Payment is part of the product, and it
 * should feel like the room next door, not a different building.
 */

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-full place-items-center overflow-y-auto bg-paper p-6">
      <div className="panel w-full max-w-lg p-7">
        <div className="mb-5 flex items-center gap-2.5">
          <BrandPin size={36} />
          <p className="text-sm font-semibold text-ink">Land Quotient</p>
        </div>
        {children}
      </div>
    </div>
  )
}

/** Signed in, but the team has no active subscription: the payment step. */
export function Paywall({
  account,
  billing,
  onActivated,
  onSignedOut,
}: {
  account: Account
  billing: BillingStatus
  onActivated: () => void
  onSignedOut: () => void
}) {
  const lapsed = billing.status !== 'none' && billing.status !== 'unmetered'

  return (
    <Frame>
      <h1 className="text-lg font-semibold text-ink">
        {lapsed ? 'Your subscription has lapsed' : 'Start your subscription'}
      </h1>
      <p className="mt-1.5 text-sm leading-relaxed text-muted">
        {lapsed
          ? `Payments for this workspace stopped going through. Renew for ${billing.priceLabel} and everything is exactly where you left it.`
          : `One plan — ${billing.priceLabel} — with unlimited surveys, demographics, tours and client links. Cancel any time.`}
      </p>
      <p className="mt-1 text-xs text-faint">Have a promo code? There&rsquo;s a field for it at checkout.</p>

      <div className="mt-5">
        <CheckoutPanel publishableKey={billing.publishableKey} />
      </div>

      <div className="mt-5 flex items-center justify-between border-t border-line pt-4 text-xs text-muted">
        <span>
          Signed in as <strong className="text-body">{account.email}</strong>
        </span>
        <span className="flex gap-3">
          <button type="button" className="underline hover:text-body" onClick={onActivated}>
            Already paid? Refresh
          </button>
          <button
            type="button"
            className="underline hover:text-body"
            onClick={() => {
              void api.signOut().finally(onSignedOut)
            }}
          >
            Sign out
          </button>
        </span>
      </div>
    </Frame>
  )
}

/** Where Stripe sends the buyer back; confirms the session server-side. */
export function BillingReturn({ onDone }: { onDone: () => void }) {
  const [state, setState] = useState<'checking' | 'active' | 'incomplete' | 'failed'>('checking')
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    const sessionId = new URLSearchParams(window.location.search).get('session_id')
    if (!sessionId) {
      setState('failed')
      setMessage('No checkout to confirm — this page only makes sense straight after payment.')
      return
    }
    api
      .confirmCheckout(sessionId)
      .then((result) => setState(result.active ? 'active' : 'incomplete'))
      .catch((cause) => {
        setState('failed')
        setMessage(cause instanceof Error ? cause.message : 'The payment could not be confirmed.')
      })
  }, [])

  return (
    <Frame>
      {state === 'checking' ? (
        <p className="py-6 text-center text-sm text-muted">Confirming your payment with Stripe…</p>
      ) : state === 'active' ? (
        <div className="py-4 text-center">
          <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-brand-tint text-brand-deep" aria-hidden>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
              <path d="m5 13 4 4L19 7" />
            </svg>
          </span>
          <h1 className="text-lg font-semibold text-ink">You&rsquo;re all set</h1>
          <p className="mt-1.5 text-sm text-muted">The subscription is active. Welcome aboard.</p>
          <button
            type="button"
            className="btn-primary mt-5"
            onClick={() => {
              navigate('/')
              onDone()
            }}
          >
            Open your surveys
          </button>
        </div>
      ) : (
        <div className="py-4 text-center">
          <h1 className="text-lg font-semibold text-ink">
            {state === 'incomplete' ? 'Payment not finished' : 'Something went wrong'}
          </h1>
          <p className="mt-1.5 text-sm text-muted">
            {state === 'incomplete'
              ? 'The checkout was not completed, so nothing has been charged.'
              : message}
          </p>
          <button
            type="button"
            className="btn-primary mt-5"
            onClick={() => {
              navigate('/')
              onDone()
            }}
          >
            Back to the app
          </button>
        </div>
      )}
    </Frame>
  )
}
