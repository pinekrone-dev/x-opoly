import { lazy, type ComponentType } from 'react'

const RELOADED = 'lq:reloaded-for-bundle'

function flag(action: 'get' | 'set' | 'clear'): boolean {
  // Session storage can be blocked outright; then there is simply no guard,
  // and a failed load surfaces through the error boundary instead.
  try {
    if (action === 'set') sessionStorage.setItem(RELOADED, '1')
    else if (action === 'clear') sessionStorage.removeItem(RELOADED)
    return sessionStorage.getItem(RELOADED) === '1'
  } catch {
    return true
  }
}

/**
 * A view loaded on demand, that survives a deploy.
 *
 * Every build names its bundles after their contents, and a deploy replaces
 * them all. A tab left open across a deploy still holds the old names, so the
 * first view it opens afterwards asks for a file that is gone. That is not an
 * error the person can do anything about, and the fix is always the same:
 * load the page again, once, and pick up the new names.
 */
export function lazyView<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(() =>
    load().then(
      (module) => {
        flag('clear')
        return module
      },
      (error) => {
        if (flag('get')) throw error
        flag('set')
        window.location.reload()
        // Never settles: the page is on its way out.
        return new Promise<{ default: T }>(() => {})
      },
    ),
  )
}
