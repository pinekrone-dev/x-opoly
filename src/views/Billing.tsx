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
  const trial = billing.trialDays ?? 0
  // An invite code applied before checkout: the discount goes on up front, so
  // a free invite never asks for a card. Changing it remounts the checkout.
  const [draft, setDraft] = useState('')
  const [code, setCode] = useState('')
  const [codeOpen, setCodeOpen] = useState(false)

  return (
    <Frame>
      <h1 className="text-lg font-semibold text-ink">
        {code
          ? 'Redeem your invite'
          : trial
            ? `Start your ${trial}-day free trial`
            : lapsed
              ? 'Your subscription has lapsed'
              : 'Start your subscription'}
      </h1>
      <p className="mt-1.5 text-sm leading-relaxed text-muted">
        {code
          ? `Code ${code} is applied below. If it covers the whole price, no card is needed.`
          : trial
            ? `Full access for ${trial} days. Your card is not charged until the trial ends, then ${billing.priceLabel}. Cancel any time before then in Settings and you are not charged.`
            : lapsed
              ? `Payments for this workspace stopped going through. Renew for ${billing.priceLabel} and everything is exactly where you left it.`
              : `One plan, ${billing.priceLabel}, with unlimited surveys, demographics, tours and client links. Cancel any time in Settings.`}
      </p>

      <div className="mt-2 text-xs text-faint">
        {codeOpen ? (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              setCode(draft.trim())
            }}
          >
            <input
              className="field flex-1 text-xs"
              placeholder="Invite code"
              aria-label="Invite code"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              autoFocus
            />
            <button type="submit" className="btn-secondary text-xs" disabled={!draft.trim()}>
              Apply
            </button>
            {code ? (
              <button
                type="button"
                className="underline hover:text-body"
                onClick={() => {
                  setCode('')
                  setDraft('')
                  setCodeOpen(false)
                }}
              >
                Remove
              </button>
            ) : null}
          </form>
        ) : (
          <button type="button" className="underline hover:text-body" onClick={() => setCodeOpen(true)}>
            Have an invite code?
          </button>
        )}
      </div>

      <div className="mt-5">
        <CheckoutPanel key={code || 'standard'} publishableKey={billing.publishableKey} code={code || undefined} />
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
  const [trialEnd, setTrialEnd] = useState<string | null>(null)

  useEffect(() => {
    const sessionId = new URLSearchParams(window.location.search).get('session_id')
    if (!sessionId) {
      setState('failed')
      setMessage('No checkout to confirm — this page only makes sense straight after payment.')
      return
    }
    api
      .confirmCheckout(sessionId)
      .then((result) => {
        setTrialEnd(result.status === 'trialing' ? (result.trialEnd ?? null) : null)
        setState(result.active ? 'active' : 'incomplete')
      })
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
          <p className="mt-1.5 text-sm text-muted">
            {trialEnd
              ? `Your free trial is running. Nothing is charged before ${new Date(trialEnd).toLocaleDateString()}, and you can cancel any time in Settings.`
              : 'The subscription is active. Welcome aboard.'}
          </p>
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
