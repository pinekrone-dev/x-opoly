import { useEffect, useState } from 'react'
import ShareView from './views/ShareView'
import SurveyList from './views/SurveyList'
import SignIn from './views/SignIn'
import SurveyWorkspace from './views/SurveyWorkspace'
import TourBook from './views/TourBook'
import { api } from './api'
import { matchRoute, usePath } from './lib/router'
import type { Account, AppFeatures } from './types'

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

interface Session {
  user: Account | null
  setupRequired: boolean
  smsConfigured: boolean
}

export default function App() {
  const path = usePath()
  const route = matchRoute(path)
  const [features, setFeatures] = useState<AppFeatures | null>(null)
  const [session, setSession] = useState<Session | null>(null)

  useEffect(() => {
    api
      .health()
      .then((health) => setFeatures(health.features))
      .catch(() => setFeatures(FALLBACK_FEATURES))
  }, [])

  useEffect(() => {
    api
      .me()
      .then(setSession)
      // A server too old to know about accounts, or unreachable: treat the app
      // as open rather than locking someone out of their own data.
      .catch(() => setSession({ user: null, setupRequired: true, smsConfigured: false }))
  }, [])

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
   * Anyone without a session sees the sign-in screen — including on a
   * workspace nobody has claimed yet, where it becomes the form that creates
   * the first account.
   *
   * That distinction was previously wrong in a way that mattered: the guard
   * skipped this branch entirely while `setupRequired` was true, so the claim
   * form could never be reached and there was no way to create an account at
   * all. The intent had been to keep a fresh deployment recoverable, but that
   * only ever required leaving the *API* open during the setup window — which
   * the server still does — not hiding the signup.
   */
  if (!session.user) {
    return (
      <SignIn
        setupRequired={session.setupRequired}
        smsConfigured={session.smsConfigured}
        onSignedIn={(user) => setSession({ ...session, user, setupRequired: false })}
      />
    )
  }

  if (route.view === 'book' && route.id) {
    return <TourBook id={route.id} />
  }

  if (route.view === 'workspace' && route.id) {
    return <SurveyWorkspace id={route.id} features={features} />
  }

  return (
    <SurveyList
      account={session.user}
      smsConfigured={session.smsConfigured}
      onAccountChange={(user) => setSession({ ...session, user })}
      onSignedOut={() => setSession({ ...session, user: null, setupRequired: false })}
    />
  )
}
