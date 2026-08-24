import { useEffect, useState } from 'react'
import ShareView from './views/ShareView'
import SurveyList from './views/SurveyList'
import SurveyWorkspace from './views/SurveyWorkspace'
import { api } from './api'
import { matchRoute, usePath } from './lib/router'
import type { AppFeatures } from './types'

/** Used only if /api/health cannot be reached; keyless and dark-native. */
const FALLBACK_TILES = {
  provider: 'carto-dark',
  label: 'Dark streets',
  url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  attribution: '© OpenStreetMap contributors, © CARTO',
  maxZoom: 20,
  darkNative: true,
  placeholder: false,
}

const FALLBACK_FEATURES: AppFeatures = {
  flyerExtraction: false,
  tiles: FALLBACK_TILES,
  basemaps: [FALLBACK_TILES],
  tileUrl: FALLBACK_TILES.url,
  tileAttribution: FALLBACK_TILES.attribution,
}

export default function App() {
  const path = usePath()
  const route = matchRoute(path)
  const [features, setFeatures] = useState<AppFeatures | null>(null)

  useEffect(() => {
    api
      .health()
      .then((health) => setFeatures(health.features))
      .catch(() => setFeatures(FALLBACK_FEATURES))
  }, [])

  if (!features) {
    return <div className="grid min-h-full place-items-center text-sm text-slate-500">Starting up…</div>
  }

  if (route.view === 'share' && route.token) {
    return <ShareView token={route.token} features={features} />
  }

  if (route.view === 'workspace' && route.id) {
    return <SurveyWorkspace id={route.id} features={features} />
  }

  return <SurveyList />
}
