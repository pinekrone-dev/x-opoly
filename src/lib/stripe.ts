/**
 * Stripe's embedded checkout, loaded only when someone is about to pay.
 *
 * js.stripe.com must be loaded from Stripe (PCI terms forbid bundling it),
 * so the script tag is injected on first use and reused after. Everything
 * here degrades: if the script cannot load — an ad blocker, a network — the
 * caller falls back to Stripe's hosted page via the URL the server returns.
 */

interface StripeEmbeddedCheckout {
  mount: (selector: string | HTMLElement) => void
  unmount: () => void
  destroy: () => void
}

interface StripeClient {
  initEmbeddedCheckout: (options: { clientSecret: string }) => Promise<StripeEmbeddedCheckout>
}

declare global {
  interface Window {
    Stripe?: (publishableKey: string) => StripeClient
  }
}

let loading: Promise<void> | null = null

function loadScript(): Promise<void> {
  if (window.Stripe) return Promise.resolve()
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = 'https://js.stripe.com/v3/'
      script.async = true
      script.onload = () => resolve()
      script.onerror = () => {
        loading = null
        reject(new Error('The payment form could not load. Check for content blockers, or use the checkout link.'))
      }
      document.head.appendChild(script)
    })
  }
  return loading
}

export async function mountEmbeddedCheckout(
  publishableKey: string,
  clientSecret: string,
  container: HTMLElement,
): Promise<StripeEmbeddedCheckout> {
  await loadScript()
  if (!window.Stripe) throw new Error('The payment form could not load.')
  const checkout = await window.Stripe(publishableKey).initEmbeddedCheckout({ clientSecret })
  checkout.mount(container)
  return checkout
}
