import { useEffect, useState } from 'react'

/**
 * A minimal path router. The app has a handful of destinations, so a
 * dependency would cost more than it saves.
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
  view: 'home' | 'workspace' | 'share' | 'book' | 'billingReturn' | 'record' | 'faq' | 'gis' | 'settings'
  id?: string
  token?: string
  /** Which CRM object a `record` route is showing. */
  recordType?: 'deal' | 'person' | 'company' | 'place'
  /** Which list the home page opens on. */
  tab?: string
  /** Which market a `gis` route opens on. */
  slug?: string
}

export function matchRoute(path: string): Route {
  const shared = path.match(/^\/s\/([\w-]+)\/?$/)
  if (shared) return { view: 'share', token: shared[1] }

  // Public, and matched before anything that needs a session.
  if (/^\/faq\/?$/.test(path)) return { view: 'faq' }

  // Where Stripe sends the buyer back; the session id rides the query string.
  if (/^\/billing\/return\/?$/.test(path)) return { view: 'billingReturn' }

  // The parcel map, optionally opening straight on a market.
  const gis = path.match(/^\/gis(?:\/([\w-]+))?\/?$/)
  if (gis) return { view: 'gis', slug: gis[1] }

  // The account's own settings: default market, the team.
  if (/^\/settings\/?$/.test(path)) return { view: 'settings' }

  // Matched before the workspace, whose pattern would otherwise not reach it.
  const book = path.match(/^\/survey\/([\w-]+)\/book\/?$/)
  if (book) return { view: 'book', id: book[1] }

  const workspace = path.match(/^\/survey\/([\w-]+)\/?$/)
  if (workspace) return { view: 'workspace', id: workspace[1] }

  // A single CRM record: /deals/:id, /people/:id, /companies/:id, /places/:id
  const record = path.match(/^\/(deals|people|companies|places)\/([\w-]+)\/?$/)
  if (record) {
    const types = { deals: 'deal', people: 'person', companies: 'company', places: 'place' } as const
    return { view: 'record', recordType: types[record[1] as keyof typeof types], id: record[2] }
  }

  // The object lists live on the home page, one tab each.
  const list = path.match(/^\/(deals|people|companies|places|surveys)\/?$/)
  if (list) return { view: 'home', tab: list[1] }

  return { view: 'home', tab: 'deals' }
}
