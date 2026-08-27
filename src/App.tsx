import { useCallback, useEffect, useState } from 'react'
import ShareView from './views/ShareView'
import SignIn from './views/SignIn'
import SurveyWorkspace from './views/SurveyWorkspace'
import TourBook from './views/TourBook'
import Faq from './views/Faq'
import Landing from './views/Landing'
import Welcome from './views/Welcome'
import Home from './views/Home'
import RecordView from './views/RecordView'
import { BillingReturn, Paywall } from './views/Billing'
import { api } from './api'
import Gis from './views/Gis'
import TabBar from './components/TabBar'
import { matchRoute, navigate, usePath } from './lib/router'
import type { Account, AppFeatures, BillingConfig, BillingStatus } from './types'

/**
 * Used only if /api/health cannot be reached. Keyless, and a light street map
 * to match the interface — a dark fallback would flash a black slab into an
 * otherwise white page exactly when something is already going wrong.
 */
const FALLBACK_TILES = {
  provider: 'osm',
  label: 'Street map',
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '© OpenStreetMap contributors',
  maxZoom: 19,
  darkNative: false,
  placeholder: false,
}

const FALLBACK_FEATURES: AppFeatures = {
  flyerExtraction: false,
  tiles: FALLBACK_TILES,
  basemaps: [FALLBACK_TILES],
  tileUrl: FALLBACK_TILES.url,
  tileAttribution: FALLBACK_TILES.attribution,
}

const NO_BILLING: BillingConfig = { configured: false, selfServe: false, publishableKey: null }

interface Session {
  user: Account | null
  setupRequired: boolean
  smsConfigured: boolean
  billing: BillingConfig
}

export default function App() {
  const path = usePath()
  const route = matchRoute(path)
  const [features, setFeatures] = useState<AppFeatures | null>(null)
  const [session, setSession] = useState<Session | null>(null)

  // What the signed-out visitor is looking at: the landing page, or a form.
  const [door, setDoor] = useState<'landing' | 'signIn' | 'signUp'>('landing')

  // The team's subscription, checked once signed in on a billing-enabled
  // instance. `null` while unknown; bumping `billingVersion` re-checks.
  const [billing, setBilling] = useState<BillingStatus | null>(null)
  const [billingVersion, setBillingVersion] = useState(0)

  // Set only by a redeemed email link. Confirming is a milestone, and the
  // person deserves to be told it worked before anything is asked of them.
  const [welcoming, setWelcoming] = useState(false)

  useEffect(() => {
    api
      .health()
      .then((health) => setFeatures(health.features))
      .catch(() => setFeatures(FALLBACK_FEATURES))
  }, [])

  useEffect(() => {
    api
      .me()
      .then((me) => setSession({ ...me, billing: me.billing ?? NO_BILLING }))
      // A server too old to know about accounts, or unreachable: treat the app
      // as open rather than locking someone out of their own data.
      .catch(() => setSession({ user: null, setupRequired: true, smsConfigured: false, billing: NO_BILLING }))
  }, [])

  useEffect(() => {
    if (!session?.user || !session.billing.configured) {
      setBilling(null)
      return
    }
    api
      .billingStatus()
      .then(setBilling)
      // If the billing endpoint itself fails, let the person in: the API's
      // own 402s still guard the data, and a broken check should not lock
      // a paying customer out.
      .catch(() => setBilling({ configured: false, publishableKey: null, active: true, status: 'unknown', periodEnd: null, portalAvailable: false, priceLabel: '$29 / month' }))
  }, [session?.user, session?.billing.configured, billingVersion])

  const signedIn = useCallback(
    (user: Account) => {
      setSession((current) => (current ? { ...current, user, setupRequired: false } : current))
      setBillingVersion((version) => version + 1)
    },
    [],
  )

  if (!features || !session) {
    return <div className="grid min-h-full place-items-center text-sm text-muted">Starting up…</div>
  }

  /*
   * Client share links are checked before the session is. Someone following a
   * link has no account and must never be asked for one — the token is the
   * credential, and it is checked server-side.
   */
  if (route.view === 'share' && route.token) {
    return <ShareView token={route.token} features={features} />
  }

  /*
   * The FAQ is public: readable without an account, and reachable while
   * signed in without dropping the session. Its two doors send the visitor
   * back to the landing page with the right form already open.
   */
  if (route.view === 'faq') {
    return (
      <Faq
        selfServe={session.billing.selfServe}
        onSignIn={() => {
          setDoor('signIn')
          navigate('/')
        }}
        onGetStarted={() => {
          setDoor('signUp')
          navigate('/')
        }}
      />
    )
  }

  /*
   * Anyone without a session sees the public face of the instance: the
   * landing page with pricing when billing is configured, or the sign-in
   * screen on a private deployment. Invite and verification links, and an
   * unclaimed workspace, always go straight to the form that handles them.
   */
  if (!session.user) {
    const params = new URLSearchParams(window.location.search)
    const hasLinkToken = params.has('invite') || params.has('verify')
    const showLanding =
      session.billing.configured && !session.setupRequired && !hasLinkToken && door === 'landing' && route.view !== 'billingReturn'

    if (showLanding) {
      return (
        <Landing
          selfServe={session.billing.selfServe}
          onSignIn={() => setDoor('signIn')}
          onGetStarted={() => setDoor('signUp')}
        />
      )
    }

    return (
      <SignIn
        setupRequired={session.setupRequired}
        smsConfigured={session.smsConfigured}
        selfServe={session.billing.selfServe}
        startMode={door === 'signUp' ? 'signUp' : 'signIn'}
        onSignedIn={signedIn}
        onVerified={(user) => {
          setWelcoming(true)
          signedIn(user)
        }}
        onBack={session.billing.configured && !session.setupRequired && !hasLinkToken ? () => setDoor('landing') : undefined}
      />
    )
  }

  /* Back from Stripe: confirm the checkout session, then into the app. */
  if (route.view === 'billingReturn') {
    return <BillingReturn onDone={() => setBillingVersion((version) => version + 1)} />
  }

  /*
   * Just confirmed: say so, then let them move on. Shown ahead of the
   * subscription gate so the first thing a new account meets is a welcome and
   * not a payment form.
   */
  if (welcoming) {
    return (
      <Welcome
        account={session.user}
        needsSubscription={session.billing.configured && !billing?.active}
        priceLabel={billing?.priceLabel}
        onContinue={() => setWelcoming(false)}
        onSignedOut={() => {
          setWelcoming(false)
          setSession({ ...session, user: null, setupRequired: false })
          setDoor('signIn')
        }}
      />
    )
  }

  /*
   * The subscription gate, mirrored client-side. The API already answers 402
   * without an active subscription; this renders the payment step instead of
   * letting every fetch fail.
   */
  if (session.billing.configured) {
    if (!billing) {
      return <div className="grid min-h-full place-items-center text-sm text-muted">Checking your subscription…</div>
    }
    if (!billing.active) {
      return (
        <Paywall
          account={session.user}
          billing={billing}
          onActivated={() => setBillingVersion((version) => version + 1)}
          onSignedOut={() => {
            setSession({ ...session, user: null, setupRequired: false })
            setDoor('landing')
          }}
        />
      )
    }
  }

  if (route.view === 'book' && route.id) {
    return <TourBook id={route.id} />
  }

  if (route.view === 'workspace' && route.id) {
    return <SurveyWorkspace id={route.id} features={features} />
  }

  /*
   * The parcel map. Full bleed, because it is a map and not a page with a map
   * on it, and the market picker and the parcel card float over it.
   */
  if (route.view === 'gis' && features) {
    return (
      <div className="flex h-screen flex-col">
        <TabBar current="gis" />
        <div className="min-h-0 flex-1">
          <Gis tiles={features.tiles} basemaps={features.basemaps} slug={route.slug} />
        </div>
      </div>
    )
  }

  /* One CRM record: a deal, person, company or place. */
  if (route.view === 'record' && route.recordType && route.id) {
    return <RecordView recordType={route.recordType} id={route.id} />
  }

  /*
   * The workspace home. A survey is one deal's map; the deals, people,
   * companies and places behind it are what the broker opens the app for, so
   * they are what greets them.
   */
  if (route.view === 'home') {
    return (
      <Home
        account={session.user}
        smsConfigured={session.smsConfigured}
        billing={billing}
        tab={route.tab ?? 'deals'}
        onAccountChange={(user) => setSession({ ...session, user })}
        onSignedOut={() => {
          setSession({ ...session, user: null, setupRequired: false })
          setDoor('landing')
        }}
      />
    )
  }

  return (
    <Home
      account={session.user}
      smsConfigured={session.smsConfigured}
      billing={billing}
      tab="deals"
      onAccountChange={(user) => setSession({ ...session, user })}
      onSignedOut={() => {
        setSession({ ...session, user: null, setupRequired: false })
        setDoor('landing')
      }}
    />
  )
}
