import { useState } from 'react'

/**
 * A delete that asks first, on the page rather than in a browser dialog.
 *
 * window.confirm is silently answered "no" by some in-app browsers and
 * embedded views, so a delete behind it did nothing and said nothing. This
 * asks in place: one click arms it, the second does it, and a failure is
 * said where the button was instead of being swallowed.
 */
export default function ConfirmDelete({
  what,
  onConfirm,
  className = 'btn-secondary text-xs',
  label = 'Delete',
}: {
  /** Named in the question: "Delete this deal?" */
  what: string
  onConfirm: () => Promise<unknown>
  className?: string
  label?: string
}) {
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)

  const stop = (event: React.SyntheticEvent) => event.stopPropagation()

  if (!armed) {
    return (
      <button
        type="button"
        className={className}
        onClick={(event) => {
          stop(event)
          setFailed(null)
          setArmed(true)
        }}
      >
        {label}
      </button>
    )
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5" onClick={stop} role="group" aria-label={`Delete ${what}?`}>
      <span className="text-xs text-muted">Delete {what}?</span>
      <button
        type="button"
        className="btn-secondary border-rose-300 text-xs text-rose-700 hover:bg-rose-50"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          setFailed(null)
          try {
            await onConfirm()
            setArmed(false)
          } catch (cause) {
            setFailed(cause instanceof Error ? cause.message : 'That could not be deleted.')
          } finally {
            setBusy(false)
          }
        }}
      >
        {busy ? 'Deleting…' : 'Yes, delete'}
      </button>
      <button type="button" className="btn-ghost text-xs" disabled={busy} onClick={() => setArmed(false)}>
        Cancel
      </button>
      {failed ? <span className="text-xs text-rose-700">{failed}</span> : null}
    </span>
  )
}
