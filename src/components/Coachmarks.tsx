import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * A short pointing tour for someone seeing a screen for the first time.
 *
 * The GIS view opens with nothing switched on, which is right — a broker
 * should build the map they want rather than dismiss the one we guessed at —
 * but an empty map is also indistinguishable from a broken one if nobody says
 * where to click. These are the sentence or two that closes that gap.
 *
 * Three rules it holds to, because onboarding that ignores them is worse than
 * none:
 *
 *   * It shows once. Dismissal is remembered, and a step whose target is not
 *     on screen is skipped rather than pointing at nothing.
 *   * It is escapable at every moment — Skip, Escape, or clicking away.
 *   * It never blocks the app. The page underneath stays live, so somebody
 *     who already knows what they are doing can simply carry on.
 */

export interface Coachmark {
  /** What it points at. A step whose target is absent is skipped. */
  target: string
  title: string
  body: string
}

/** Where a card can sit relative to its target. */
type Placement = 'right' | 'bottom'

const CARD_WIDTH = 268
const GAP = 12

/**
 * Whether this browser has seen a tour.
 *
 * Wrapped because storage throws rather than returning null in a private
 * window and in a few embedded contexts, and a thrown read here would take
 * the whole view down over a tooltip.
 */
function seen(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === 'done'
  } catch {
    // Unreadable storage means we cannot know, and showing a short tour twice
    // is a far smaller cost than a crash.
    return false
  }
}

function remember(key: string) {
  try {
    window.localStorage.setItem(key, 'done')
  } catch {
    // Nothing to do. The tour will offer itself again next time, which is
    // the harmless failure.
  }
}

export default function Coachmarks({
  steps,
  storageKey,
  enabled = true,
}: {
  steps: Coachmark[]
  /** Remembered per browser, so a tour shows once. Version it to re-show. */
  storageKey: string
  /** Held off until the screen has something to point at. */
  enabled?: boolean
}) {
  const [at, setAt] = useState(0)
  const [done, setDone] = useState(() => seen(storageKey))
  const [box, setBox] = useState<{ top: number; left: number; place: Placement } | null>(null)
  const [ring, setRing] = useState<DOMRect | null>(null)
  const card = useRef<HTMLDivElement>(null)

  const finish = useCallback(() => {
    setDone(true)
    remember(storageKey)
  }, [storageKey])

  /*
   * Find the step's target and put the card beside it.
   *
   * Measured rather than guessed, and re-measured on scroll and resize: the
   * panel this points into scrolls, and a card that stays where the target
   * used to be is worse than no card.
   */
  const place = useCallback(() => {
    const step = steps[at]
    if (!step) return
    const node = document.querySelector(step.target)
    if (!node) {
      setRing(null)
      setBox(null)
      return
    }
    const rect = node.getBoundingClientRect()
    setRing(rect)

    // To the right where there is room, underneath otherwise. On a phone
    // there is never room to the right, which is the case this handles.
    const roomRight = window.innerWidth - rect.right
    const useRight = roomRight > CARD_WIDTH + GAP * 2
    const height = card.current?.offsetHeight ?? 150
    const top = useRight
      ? Math.min(Math.max(GAP, rect.top), window.innerHeight - height - GAP)
      : Math.min(rect.bottom + GAP, window.innerHeight - height - GAP)
    const left = useRight
      ? rect.right + GAP
      : Math.min(Math.max(GAP, rect.left), window.innerWidth - CARD_WIDTH - GAP)
    setBox({ top, left, place: useRight ? 'right' : 'bottom' })
  }, [steps, at])

  useLayoutEffect(() => {
    if (done || !enabled) return undefined
    place()
    window.addEventListener('resize', place)
    // Capture, because the element that scrolls is the panel rather than the
    // window and a bubbling listener would never hear it.
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [done, enabled, place])

  /*
   * Skip a step with nothing to point at.
   *
   * A market that publishes no extra layers, a panel collapsed on a phone —
   * the screen legitimately differs, and a tooltip aimed at an element that
   * is not there would sit in the corner describing nothing.
   */
  useEffect(() => {
    if (done || !enabled) return
    if (box || !steps[at]) return
    const skip = setTimeout(() => {
      if (at + 1 >= steps.length) finish()
      else setAt((n) => n + 1)
    }, 400)
    return () => clearTimeout(skip)
  }, [box, at, steps, done, enabled, finish])

  useEffect(() => {
    if (done || !enabled) return undefined
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finish()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [done, enabled, finish])

  if (done || !enabled) return null
  const step = steps[at]
  if (!step || !box) return null
  const last = at + 1 >= steps.length

  return (
    <>
      {/*
        A ring, not a dimming overlay. An overlay would make the app look
        disabled, and the point is that it is not: anybody can ignore this
        and carry on clicking.
      */}
      {ring && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[1400] rounded-lg ring-2 ring-brand ring-offset-2 ring-offset-paper transition-all duration-150"
          style={{
            top: ring.top - 2,
            left: ring.left - 2,
            width: ring.width + 4,
            height: ring.height + 4,
          }}
        />
      )}

      <div
        ref={card}
        role="dialog"
        aria-live="polite"
        aria-label={`Tip ${at + 1} of ${steps.length}: ${step.title}`}
        className="fixed z-[1401] w-[268px] rounded-lg border border-line bg-surface p-3 shadow-lg"
        style={{ top: box.top, left: box.left }}
      >
        <p className="text-xs font-semibold text-ink">{step.title}</p>
        <p className="mt-1 text-[11px] leading-relaxed text-body">{step.body}</p>

        <div className="mt-2.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1" aria-hidden>
            {steps.map((_, i) => (
              <span
                key={i}
                className={`h-1.5 w-1.5 rounded-full ${i === at ? 'bg-brand' : 'bg-line'}`}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={finish}
              className="text-[11px] text-muted hover:text-ink"
            >
              {last ? 'Close' : 'Skip'}
            </button>
            {!last && (
              <button
                type="button"
                onClick={() => setAt((n) => n + 1)}
                className="rounded-md bg-brand px-2.5 py-1 text-[11px] font-medium text-white"
              >
                Next
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
