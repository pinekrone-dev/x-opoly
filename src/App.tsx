import { useEffect, useState } from 'react'
import ShareView from './views/ShareView'
import SurveyList from './views/SurveyList'
import SurveyWorkspace from './views/SurveyWorkspace'
import { api } from './api'
import { matchRoute, usePath } from './lib/router'
import type { AppFeatures } from './types'

const OSM_TILES = {
  provider: 'osm',
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '© OpenStreetMap contributors',
  maxZoom: 19,
  darkNative: false,
  placeholder: false,
}

const FALLBACK_FEATURES: AppFeatures = {
  flyerExtraction: false,
  tiles: OSM_TILES,
  tileUrl: OSM_TILES.url,
  tileAttribution: OSM_TILES.attribution,
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
