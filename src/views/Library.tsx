import { useCallback, useEffect, useMemo, useState } from 'react'
import WorkspaceNav from '../components/WorkspaceNav'
import { api } from '../api'
import { navigate } from '../lib/router'
import type { Account, BillingStatus, LibraryItem, LibraryPiece } from '../types'

/*
 * The Library: the pieces of an offering memorandum, kept per parcel.
 *
 * An offering memorandum gets finished in the broker's own template. What
 * this product has that the template does not is the exhibits. So a parcel
 * sent here from the map collects them, organised the same way for every
 * parcel: the maps (the parcel, its location with a three-mile ring and the
 * landmarks in it, the retail within a mile), the data behind an OM's tables
 * (demographics, the chains nearby) as spreadsheets, and the one-page memo
 * as it was before, for when a quick PDF is all that is wanted.
 *
 * A map is drawn when it is asked for and kept until it is drawn again. Its
 * link opens without signing in, so it can be dropped into a deck or sent.
 */
const MAPS: { kind: LibraryPiece['kind']; title: string; what: string }[] = [
  { kind: 'parcel-map', title: 'Parcel map', what: 'The lot outlined on the street map, with its neighbours' },
  { kind: 'location-map', title: 'Location map', what: 'A three-mile ring with the landmarks inside it' },
  { kind: 'retail-map', title: 'Retail map', what: 'The national chains within a mile' },
]

const slugOf = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'parcel'

/** Rows as a CSV file the browser downloads. Made here; nothing is stored. */
function downloadCsv(name: string, rows: (string | number | null)[][]) {
  const cell = (v: string | number | null) => {
    const text = v == null ? '' : String(v)
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const blob = new Blob([rows.map((row) => row.map(cell).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}

function Entry({ item, onChanged }: { item: LibraryItem; onChanged: () => void }) {
  const { place } = item
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const name = place.name || place.address || 'Parcel'
  const lat = Number(place.lat)
  const lng = Number(place.lng)
  const located = Boolean(place.market) && Number.isFinite(lat) && Number.isFinite(lng)
  const pieces = new Map(item.pieces.map((piece) => [piece.kind, piece]))

  const run = async (key: string, work: () => Promise<void>) => {
    setBusy(key)
    setNote(null)
    try {
      await work()
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : 'That could not be made just now.')
    } finally {
      setBusy(null)
    }
  }

  const draw = (kind: LibraryPiece['kind']) =>
    run(kind, async () => {
      // The pins on the wider maps are found here, from the same sources
      // the map uses, and handed to the drawing.
      let pins: { lat: number; lng: number; label: string }[] = []
      if (kind === 'location-map') {
        const found = await api.landmarks({ lat, lng, radius: 3 }).catch(() => null)
        pins = (found?.landmarks ?? []).slice(0, 25).map((l) => ({ lat: l.lat, lng: l.lng, label: l.name }))
      }
      if (kind === 'retail-map') {
        const found = await api.nearby({ lat, lng, category: 'chains', radius: 1 }).catch(() => null)
        pins = (found?.results ?? []).slice(0, 40).map((b) => ({ lat: b.lat, lng: b.lng, label: b.brand || b.name }))
      }
      const made = await api.library.makePiece(place.id, kind, pins)
      if (made.notes?.length) setNote(made.notes.join(' '))
      onChanged()
    })

  const demographics = () =>
    run('demographics', async () => {
      const data = await api.demographics(lat, lng)
      const keys = [...new Set(data.radii.flatMap((ring) => Object.keys(ring.metrics)))]
      downloadCsv(`${slugOf(name)}-demographics.csv`, [
        ['Measure', ...data.radii.map((ring) => `${ring.miles} mile${ring.miles === 1 ? '' : 's'}`)],
        ...keys.map((key) => [key, ...data.radii.map((ring) => ring.metrics[key] ?? null)]),
        [],
        ['Source', data.source],
      ])
    })

  const chains = () =>
    run('chains', async () => {
      const found = await api.nearby({ lat, lng, category: 'chains', radius: 1 })
      if (!found.results.length) throw new Error('No national chains were found within a mile.')
      downloadCsv(`${slugOf(name)}-chains-within-1-mile.csv`, [
        ['Name', 'Brand', 'Sector', 'Address', 'Miles'],
        ...found.results.map((b) => [b.name, b.brand, b.sector ?? null, b.address, Math.round(b.miles * 100) / 100]),
      ])
    })

  return (
    <article className="panel p-4" data-testid="library-entry">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-ink">{name}</h2>
          <p className="mt-0.5 truncate text-xs text-muted">
            {[place.address && place.name !== place.address ? place.address : null, [place.city, place.state].filter(Boolean).join(', ') || null,
              place.acreage ? `${Number(place.acreage).toFixed(2)} ac` : null, place.market].filter(Boolean).join(' · ') || 'No address on record'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {place.market && place.parcelId ? (
            <button type="button" className="btn-secondary text-xs" onClick={() => navigate(`/gis/${place.market}?parcel=${encodeURIComponent(String(place.parcelId))}`)}>
              See it on the map
            </button>
          ) : null}
          <button type="button" className="btn-secondary text-xs" onClick={() => navigate(`/places/${place.id}`)}>
            Parcel record
          </button>
          <button
            type="button"
            className="text-xs text-muted hover:text-rose-600"
            disabled={busy !== null}
            onClick={() => run('remove', async () => {
              await api.library.remove(place.id)
              onChanged()
            })}
          >
            {busy === 'remove' ? 'Removing…' : 'Remove'}
          </button>
        </div>
      </div>

      <p className="label mb-1.5 mt-4">Maps</p>
      {located ? (
        <div className="grid gap-3 sm:grid-cols-3">
          {MAPS.map((map) => {
            const piece = pieces.get(map.kind)
            const link = piece ? `${window.location.origin}${piece.path}` : ''
            return (
              <div key={map.kind} className="overflow-hidden rounded-lg border border-line" data-piece={map.kind}>
                {piece ? (
                  <a href={piece.path} target="_blank" rel="noreferrer" title="Open the full image">
                    <img src={piece.path} alt={`${map.title} of ${name}`} loading="lazy" className="aspect-[3/2] w-full bg-sunken object-cover" />
                  </a>
                ) : (
                  <div className="flex aspect-[3/2] w-full items-center justify-center bg-sunken/60 px-3 text-center text-[11px] text-faint">
                    {map.what}
                  </div>
                )}
                <div className="p-2">
                  <p className="text-xs font-semibold text-ink">{map.title}</p>
                  <p className="text-[10px] text-faint">{piece ? `Drawn ${piece.createdAt.slice(0, 10)}` : 'Not drawn yet'}</p>
                  <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] font-semibold">
                    <button type="button" className="text-brand hover:underline disabled:opacity-50" disabled={busy !== null} onClick={() => void draw(map.kind)}>
                      {busy === map.kind ? 'Drawing…' : piece ? 'Draw again' : 'Draw it'}
                    </button>
                    {piece ? (
                      <>
                        <a className="text-ink hover:underline" href={piece.path} download={`${slugOf(name)}-${map.kind}.png`}>Download</a>
                        <button
                          type="button"
                          className="text-ink hover:underline"
                          onClick={() => {
                            void navigator.clipboard?.writeText(link).then(() => {
                              setCopied(map.kind)
                              window.setTimeout(() => setCopied(null), 1500)
                            })
                          }}
                        >
                          {copied === map.kind ? 'Copied' : 'Copy link'}
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <p className="text-xs text-muted">This record is not tied to a parcel on a county map, so maps cannot be drawn for it.</p>
      )}

      <p className="label mb-1.5 mt-4">Data and documents</p>
      <div className="flex flex-wrap gap-2">
        {located ? (
          <>
            <button type="button" className="btn-secondary text-xs" disabled={busy !== null} onClick={() => void demographics()}>
              {busy === 'demographics' ? 'Reading…' : 'Demographics (CSV)'}
            </button>
            <button type="button" className="btn-secondary text-xs" disabled={busy !== null} onClick={() => void chains()}>
              {busy === 'chains' ? 'Reading…' : 'Chains within a mile (CSV)'}
            </button>
          </>
        ) : null}
        {place.market && place.parcelId ? (
          <button
            type="button"
            className="btn-secondary text-xs"
            onClick={() => window.open(`/om/${encodeURIComponent(String(place.market))}/${encodeURIComponent(String(place.parcelId))}`, '_blank', 'noopener')}
          >
            One-page memo
          </button>
        ) : null}
      </div>
      {note ? <p className="mt-2 text-xs text-amber-700">{note}</p> : null}
    </article>
  )
}

export default function Library({
  account,
  smsConfigured,
  billing,
  onAccountChange,
  onSignedOut,
}: {
  account: Account | null
  smsConfigured?: boolean
  billing?: BillingStatus | null
  onAccountChange: (account: Account) => void
  onSignedOut: () => void
}) {
  const [items, setItems] = useState<LibraryItem[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [filter, setFilter] = useState('')

  const load = useCallback(() => {
    api.library
      .all()
      .then(({ items: found }) => {
        setItems(found)
        setFailed(false)
      })
      .catch(() => setFailed(true))
  }, [])
  useEffect(() => { load() }, [load])

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!items || !needle) return items ?? []
    return items.filter(({ place }) => [place.name, place.address, place.city, place.market].some((t) => String(t ?? '').toLowerCase().includes(needle)))
  }, [items, filter])

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <WorkspaceNav current="library" account={account} smsConfigured={smsConfigured} billing={billing} onAccountChange={onAccountChange} onSignedOut={onSignedOut} />
      <main className="mx-auto w-full max-w-5xl flex-1 px-5 py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-ink">Library</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted">
              The pieces of an offering memorandum, kept per parcel: maps to drop into your own layout, the data behind its tables, and the one-page memo.
            </p>
          </div>
          {items?.length ? (
            <input className="field w-56 text-sm" placeholder="Find a parcel" aria-label="Find a parcel in the library" value={filter} onChange={(e) => setFilter(e.target.value)} />
          ) : null}
        </div>

        <div className="mt-6 space-y-4">
          {failed ? (
            <p className="text-sm text-rose-600">The library could not be read. Reload to try again.</p>
          ) : items === null ? (
            <p className="text-sm text-muted">Loading the library…</p>
          ) : items.length === 0 ? (
            <div className="panel p-6 text-sm text-muted" data-testid="library-empty">
              <p className="font-semibold text-ink">Nothing in the library yet.</p>
              <p className="mt-1">On the map, open a parcel and choose “Add to library”. Its maps and data are made here, one piece at a time.</p>
              <button type="button" className="btn-primary mt-3 text-xs" onClick={() => navigate('/gis')}>Open the map</button>
            </div>
          ) : shown.length === 0 ? (
            <p className="text-sm text-muted">No parcel in the library matches.</p>
          ) : (
            shown.map((item) => <Entry key={item.place.id} item={item} onChanged={load} />)
          )}
        </div>
      </main>
    </div>
  )
}
