import { useEffect, useState } from 'react'
import ShareView from './views/ShareView'
import SurveyList from './views/SurveyList'
import SurveyWorkspace from './views/SurveyWorkspace'
import { api } from './api'
import { matchRoute, usePath } from './lib/router'
import type { AppFeatures } from './types'

const FALLBACK_FEATURES: AppFeatures = {
  flyerExtraction: false,
  tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  tileAttribution: '© OpenStreetMap contributors',
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
