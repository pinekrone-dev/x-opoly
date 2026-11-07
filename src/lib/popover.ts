import { useLayoutEffect, useRef, useState } from 'react'

/**
 * A pop-up that sits under its button and inside the window.
 *
 * Inside a scrolling side panel an absolutely placed pop-up is cut off at
 * the panel's edge (the parcel card's buttons are in one), so this places
 * it fixed, under the button, nudged left or right to stay on screen.
 */
export function usePopover(open: boolean, width: number) {
  const anchor = useRef<HTMLDivElement | null>(null)
  const [style, setStyle] = useState<React.CSSProperties>({ position: 'fixed', visibility: 'hidden' })
  useLayoutEffect(() => {
    if (!open || !anchor.current) return undefined
    const place = () => {
      const r = anchor.current?.getBoundingClientRect()
      if (!r) return
      const left = Math.min(Math.max(8, r.right - width), window.innerWidth - width - 8)
      setStyle({ position: 'fixed', top: r.bottom + 6, left: Math.max(8, left), width, zIndex: 1000 })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, width])
  return { anchor, style }
}
