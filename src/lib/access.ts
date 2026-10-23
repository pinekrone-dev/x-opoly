import { useSyncExternalStore } from 'react'
import type { Account } from '../types'

/*
 * Whether the person signed in may change the team's work.
 *
 * Held once here rather than passed through every view: the record page, the
 * survey workspace and the CRM tables all need it, and most of them are
 * reached by URL with no account in their props. The server is the real
 * gate (a viewer's write is refused there whatever this says); this only
 * keeps the buttons a viewer cannot use off their screen.
 */
let editable = true
const listeners = new Set<() => void>()

export function setAccess(account: Account | null | undefined) {
  const next = account?.canEdit !== false
  if (next === editable) return
  editable = next
  for (const listener of listeners) listener()
}

export function useCanEdit(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => editable,
    () => true,
  )
}
