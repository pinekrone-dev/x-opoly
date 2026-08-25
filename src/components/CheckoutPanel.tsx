import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { mountEmbeddedCheckout } from '../lib/stripe'

/**
 * The payment step, inside the app's own frame.
 *
 * Stripe's embedded checkout mounts into this panel so paying feels like part
 * of the product, not an exile to another site. When it cannot mount — no
 * publishable key on the server, script blocked — the same panel offers the
 * hosted checkout link instead, so the sale never dies on a technicality.
 */
export default function CheckoutPanel({
  publishableKey,
  onBlocked,
}: {
  publishableKey: string | null
  onBlocked?: (message: string) => void
}) {
  const frame = useRef<HTMLDivElement>(null)
  const [hostedUrl, setHostedUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let checkout: { destroy: () => void } | null = null
    let cancelled = false

    const start = async () => {
      try {
        const session = await api.startCheckout()
        if (cancelled) return

        if (session.embedded && session.clientSecret && publishableKey && frame.current) {
          checkout = await mountEmbeddedCheckout(publishableKey, session.clientSecret, frame.current)
          if (cancelled) checkout.destroy()
          else setLoading(false)
          return
        }

        if (session.url) {
          setHostedUrl(session.url)
          setLoading(false)
          return
        }
        throw new Error('Checkout could not be started. Try again in a moment.')
      } catch (cause) {
        if (cancelled) return
        const message = cause instanceof Error ? cause.message : 'Checkout could not be started.'
        setError(message)
        setLoading(false)
        onBlocked?.(message)
      }
    }

    void start()
    return () => {
      cancelled = true
      checkout?.destroy()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div>
      {loading ? <p className="py-8 text-center text-sm text-muted">Preparing secure checkout…</p> : null}
      <div ref={frame} className="min-h-0 overflow-hidden rounded-xl" />
      {hostedUrl ? (
        <div className="py-6 text-center">
          <p className="mb-3 text-sm text-body">Payment opens on Stripe&rsquo;s secure checkout page.</p>
          <a className="btn-primary inline-block" href={hostedUrl}>
            Continue to checkout
          </a>
        </div>
      ) : null}
      {error ? (
        <p className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">{error}</p>
      ) : null}
    </div>
  )
}
