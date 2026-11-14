import { useEffect, useState } from 'react'
import { api } from '../api'
import { navigate } from '../lib/router'

/*
 * Sends a parcel to the Library, or says it is there already.
 *
 * `prepare` makes the CRM place when the parcel has none yet (a parcel
 * becomes a place the first time it is filed). Once it is in the library
 * the button opens the library, where its pieces are made.
 */
export default function LibraryButton({
  placeId,
  prepare,
  className = 'btn-secondary text-xs',
}: {
  placeId: string | null
  prepare?: () => Promise<string>
  className?: string
}) {
  const [place, setPlace] = useState<string | null>(placeId)
  const [inside, setInside] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => setPlace(placeId), [placeId])
  useEffect(() => {
    if (!place) {
      setInside(false)
      return undefined
    }
    let cancelled = false
    api.library.has(place).then((res) => !cancelled && setInside(res.inLibrary)).catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [place])

  const add = async () => {
    if (inside) {
      navigate('/library')
      return
    }
    setBusy(true)
    setError(false)
    try {
      const id = place ?? (prepare ? await prepare() : null)
      if (!id) throw new Error('no place')
      setPlace(id)
      await api.library.add(id)
      setInside(true)
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <button type="button" className={className} disabled={busy} onClick={() => void add()} data-testid="library-button"
      title={inside ? 'Open the library' : 'Keep this parcel\'s maps and data in the library'}>
      {busy ? 'Adding…' : error ? 'Could not add; try again' : inside ? 'In library' : '+ Add to library'}
    </button>
  )
}
