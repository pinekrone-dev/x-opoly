import { useRef, useState } from 'react'
import { api } from '../api'
import type { GeocodeResult, Property } from '../types'

interface Props {
  surveyId: string
  flyerExtractionEnabled: boolean
  /** Where the map is looking, so a flyer with no address still lands in view. */
  mapCenter?: { lat: number; lng: number } | null
  onAdded: (property: Property, message?: string) => void
  onClose: () => void
  onDropPinMode: () => void
}

type Mode = 'search' | 'flyer' | 'manual'

export default function AddPropertyDialog({
  surveyId,
  flyerExtractionEnabled,
  mapCenter,
  onAdded,
  onClose,
  onDropPinMode,
}: Props) {
  const [mode, setMode] = useState<Mode>('search')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<GeocodeResult[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const search = async () => {
    setBusy(true)
    setError(null)
    setResults([])
    try {
      const { results: found } = await api.geocode(query)
      setResults(found)
      if (found.length === 0) setError('No matches. Try a fuller address, or place the pin by hand.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The address lookup failed.')
    } finally {
      setBusy(false)
    }
  }

  const addFromResult = async (result: GeocodeResult) => {
    const { property } = await api.addProperty(surveyId, {
      name: result.address || result.label.split(',')[0],
      address: result.address,
      city: result.city,
      state: result.state,
      zip: result.zip,
      lat: result.lat,
      lng: result.lng,
    })
    onAdded(property)
  }

  const addManual = async (form: HTMLFormElement) => {
    const data = new FormData(form)
    const lat = Number(data.get('lat'))
    const lng = Number(data.get('lng'))
    const { property } = await api.addProperty(surveyId, {
      name: String(data.get('name') || '') || null,
      address: String(data.get('address') || '') || null,
      city: String(data.get('city') || '') || null,
      state: String(data.get('state') || '') || null,
      lat: Number.isFinite(lat) && lat !== 0 ? lat : null,
      lng: Number.isFinite(lng) && lng !== 0 ? lng : null,
    })
    onAdded(property)
  }

  const uploadFlyer = async (file: File) => {
    setBusy(true)
    setError(null)
    try {
      const { property, extraction } = await api.uploadFlyer(surveyId, file, mapCenter)
      const uncertain = extraction.uncertainFields?.length
        ? ` Check these fields: ${extraction.uncertainFields.join(', ')}.`
        : ''
      onAdded(property, `Read the flyer with ${extraction.confidence} confidence.${uncertain}`)
    } catch (cause) {
      // A failed read still files the flyer, so the upload is never lost.
      const body = (cause as { body?: { property?: Property } })?.body
      if (body?.property) {
        onAdded(body.property, cause instanceof Error ? cause.message : undefined)
        return
      }
      setError(cause instanceof Error ? cause.message : 'The flyer could not be read.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[1000] grid place-items-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label="Add a property">
      <div className="panel animate-fade-in w-full max-w-lg">
        <header className="panel-header">
          <h2 className="panel-title">Add a site</h2>
          <button type="button" className="btn-ghost px-2 py-1" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        <nav className="flex gap-1 border-b border-line px-3 py-2">
          {([
            ['search', 'Search address'],
            ['flyer', 'Drop a flyer'],
            ['manual', 'Enter by hand'],
          ] as [Mode, string][]).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`tab text-xs ${mode === id ? 'tab-active' : ''}`}
              onClick={() => { setMode(id); setError(null) }}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="p-4">
          {mode === 'search' && (
            <>
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (query.trim().length >= 3) void search()
                }}
              >
                <input
                  className="field"
                  placeholder="1200 S Congress Ave, Austin TX"
                  aria-label="Address to search"
                  value={query}
                  autoFocus
                  onChange={(event) => setQuery(event.target.value)}
                />
                <button type="submit" className="btn-primary" disabled={busy || query.trim().length < 3}>
                  {busy ? 'Searching…' : 'Search'}
                </button>
              </form>

              {results.length > 0 && (
                <ul className="mt-3 max-h-64 overflow-y-auto">
                  {results.map((result) => (
                    <li key={`${result.lat},${result.lng}`}>
                      <button
                        type="button"
                        className="w-full rounded-lg px-3 py-2 text-left text-xs text-body hover:bg-sunken"
                        onClick={() => void addFromResult(result)}
                      >
                        {result.label}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {mode === 'flyer' && (
            <div>
              <button
                type="button"
                className="flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-line-strong bg-sunken px-4 py-8 text-center hover:border-brand/40 hover:bg-sunken"
                onClick={() => fileInput.current?.click()}
                disabled={busy}
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="text-brand" aria-hidden>
                  <path d="M12 16V4m0 0L8 8m4-4 4 4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
                </svg>
                <span className="text-sm font-semibold text-ink">
                  {busy ? 'Reading the flyer…' : 'Choose a PDF or image'}
                </span>
                <span className="text-xs text-muted">
                  The rate, size, zoning and address are pulled out for you.
                </span>
              </button>
              <input
                ref={fileInput}
                type="file"
                accept="application/pdf,image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) void uploadFlyer(file)
                }}
              />
              {!flyerExtractionEnabled && (
                <p className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-200">
                  Automatic reading is switched off because this server has no Anthropic API key. The flyer will still be
                  filed against the site — you can fill the fields in by hand.
                </p>
              )}
            </div>
          )}

          {mode === 'manual' && (
            <form
              className="grid gap-3 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault()
                void addManual(event.currentTarget)
              }}
            >
              <label className="sm:col-span-2">
                <span className="label">Property name</span>
                <input className="field" name="name" placeholder="Parmer Business Park" autoFocus />
              </label>
              <label className="sm:col-span-2">
                <span className="label">Street address</span>
                <input className="field" name="address" placeholder="4100 Parmer Ln" />
              </label>
              <label>
                <span className="label">City</span>
                <input className="field" name="city" />
              </label>
              <label>
                <span className="label">State</span>
                <input className="field" name="state" maxLength={2} />
              </label>
              <label>
                <span className="label">Latitude</span>
                <input className="field font-mono" name="lat" type="number" step="any" placeholder="30.4014" />
              </label>
              <label>
                <span className="label">Longitude</span>
                <input className="field font-mono" name="lng" type="number" step="any" placeholder="-97.7128" />
              </label>
              <button type="submit" className="btn-primary sm:col-span-2">
                Add site
              </button>
              <button
                type="button"
                className="btn-secondary sm:col-span-2"
                onClick={() => { onDropPinMode(); onClose() }}
              >
                Or click a spot on the map instead
              </button>
            </form>
          )}

          {error && <p className="mt-3 rounded-lg border border-rose-500/25 bg-rose-500/10 p-3 text-xs text-rose-200">{error}</p>}
        </div>
      </div>
    </div>
  )
}
