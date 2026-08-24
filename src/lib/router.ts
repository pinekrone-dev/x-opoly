import { useEffect, useState } from 'react'

/**
 * A minimal path router. The app has three destinations, so a dependency would
 * cost more than it saves.
 */
export function navigate(path: string): void {
  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

export function usePath(): string {
  const [path, setPath] = useState(window.location.pathname)

  useEffect(() => {
    const onChange = () => setPath(window.location.pathname)
    window.addEventListener('popstate', onChange)
    return () => window.removeEventListener('popstate', onChange)
  }, [])

  return path
}

export interface Route {
  view: 'surveys' | 'workspace' | 'share'
  id?: string
  token?: string
}

export function matchRoute(path: string): Route {
  const shared = path.match(/^\/s\/([\w-]+)\/?$/)
  if (shared) return { view: 'share', token: shared[1] }

  const workspace = path.match(/^\/survey\/([\w-]+)\/?$/)
  if (workspace) return { view: 'workspace', id: workspace[1] }

  return { view: 'surveys' }
}
