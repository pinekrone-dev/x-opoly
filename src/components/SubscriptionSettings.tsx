import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { BillingStatus } from '../types'

/*
 * The subscription, on the settings page.
 *
 * Cancelling is one button and one confirmation, here, with no call and no
 * retention flow: the button is the cancellation, and the email that follows
 * confirms it. It stops the renewal rather than ending access, so a trial
 * cancelled on its second day keeps the rest of its days and is never
 * charged. Only the workspace owner sees the buttons; everyone else on the
 * team sees the state and who to ask.
 */

const day = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : null

export default function SubscriptionSettings({
  billing,
  email,
  onChanged,
}: {
  billing: BillingStatus
  email: string
  onChanged: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const section = useRef<HTMLElement>(null)

  // The account menu's "Manage subscription" lands here by hash, after the
  // page has rendered, so the browser's own jump to the anchor has missed it.
  useEffect(() => {
    if (window.location.hash === '#subscription') section.current?.scrollIntoView({ block: 'start' })
  }, [])

  const trialing = billing.status === 'trialing'
  const ends = day(billing.cancelAt)
  const trialEnds = day(billing.trialEnd ?? (trialing ? billing.periodEnd : null))
  const renews = day(billing.periodEnd)
  const subscribed = billing.active && billing.status !== 'exempt' && billing.status !== 'unmetered' && billing.status !== 'unknown'

  const summary =
    billing.status === 'exempt'
      ? 'This workspace is on the house. There is nothing to pay and nothing to cancel.'
      : !billing.active
        ? 'No active subscription.'
        : ends
          ? `Cancelled. You keep full access until ${ends}, and nothing more will be charged.`
          : trialing
            ? `Free trial${trialEnds ? `, ends ${trialEnds}` : ''}. The subscription (${billing.priceLabel}) starts then unless you cancel.`
            : `Active, ${billing.priceLabel}${renews ? `. Renews ${renews}` : ''}.`

  const run = async (action: 'cancel' | 'resume') => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      if (action === 'cancel') {
        const result = await api.cancelSubscription()
        setNotice(
          result.emailed
            ? `Done. A confirmation email is on its way to ${result.emailedTo ?? email}.`
            : 'Done. The confirmation email could not be sent, but the cancellation stands.',
        )
      } else {
        await api.resumeSubscription()
        setNotice('Resumed. The subscription carries on as before.')
      }
      setConfirming(false)
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not go through. Try again in a moment.')
    } finally {
      setBusy(false)
    }
  }

  const openPortal = async () => {
    setBusy(true)
    setError(null)
    try {
      const { url } = await api.billingPortal()
      window.location.assign(url)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The billing page could not be opened.')
      setBusy(false)
    }
  }

  return (
    <section ref={section} className="panel mt-6 p-5" id="subscription">
      <h2 className="panel-title">Subscription</h2>
      <p className="mt-1 text-sm text-body">{summary}</p>

      {subscribed && billing.canManage ? (
        <div className="mt-3">
          {ends ? (
            <button type="button" className="btn-primary" disabled={busy} onClick={() => void run('resume')}>
              {busy ? 'Resuming…' : 'Resume subscription'}
            </button>
          ) : confirming ? (
            <div className="rounded-lg border border-line bg-sunken p-3">
              <p className="text-xs leading-relaxed text-body">
                {trialing
                  ? `Cancel the trial? You keep access until ${trialEnds ?? 'the trial ends'} and your card is not charged.`
                  : `Cancel the subscription? You keep access until ${renews ?? 'the end of this period'} and are not charged again.`}{' '}
                You can resume any time before then.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn rounded-lg bg-rose-600 px-3 py-1.5 text-xs text-white hover:bg-rose-700"
                  disabled={busy}
                  onClick={() => void run('cancel')}
                >
                  {busy ? 'Cancelling…' : 'Yes, cancel'}
                </button>
                <button type="button" className="btn-secondary text-xs" disabled={busy} onClick={() => setConfirming(false)}>
                  Keep it
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-secondary text-xs" disabled={busy} onClick={() => setConfirming(true)}>
                Cancel subscription
              </button>
              {billing.portalAvailable ? (
                <button type="button" className="btn-secondary text-xs" disabled={busy} onClick={() => void openPortal()}>
                  Card and invoices
                </button>
              ) : null}
            </div>
          )}
        </div>
      ) : subscribed ? (
        <p className="mt-2 text-xs text-muted">The workspace owner manages the subscription.</p>
      ) : null}

      {notice ? <p className="mt-3 text-xs text-brand-deep">{notice}</p> : null}
      {error ? <p className="mt-3 text-xs text-rose-600">{error}</p> : null}
    </section>
  )
}
