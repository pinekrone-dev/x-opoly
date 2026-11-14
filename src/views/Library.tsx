import { useCallback, useEffect, useMemo, useState } from 'react'
import WorkspaceNav from '../components/WorkspaceNav'
import { api } from '../api'
import { navigate } from '../lib/router'
import {
  MAP_PIECES, PACKAGE_MARKET, PIECE_SPECS, chainsRows, cleanPieces, csv, demographicsRows, employmentRows, packages,
  type Package, type PieceId,
} from '../lib/libraryPieces'
import { zip, type ZipEntry } from '../lib/zip'
import type { Account, BillingStatus, Deal, LibraryItem, LibraryPiece } from '../types'

/*
 * The Library: the pieces of an offering memorandum, kept per parcel.
 *
 * An offering memorandum gets finished in the broker's own template. What
 * this product has that the template does not is the exhibits. So a parcel
 * sent here from the map can have them made: maps (the parcel, its location
 * with a three-mile ring and the landmarks in it, the retail within a mile)
 * and the data behind an OM's tables (demographics, employment, the chains
 * nearby).
 *
 * It works by package. A package is a pick of pieces, set up once at the
 * top of the page: a built-in one, or the team's own, saved by name. Every
 * parcel then exports that package as one download, with any map not drawn
 * yet drawn on the way. A piece can still be made or downloaded on its own.
 *
 * A map is kept until it is drawn again, and its link opens without signing
 * in, so it can be dropped into a deck or sent.
 */
const PICK_KEY = 'lq:library-pick'
const slugOf = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'parcel'
const same = (a: PieceId[], b: PieceId[]) => a.length === b.length && a.every((id) => b.includes(id))

function save(name: string, data: Uint8Array | string, type: string) {
  const blob = new Blob([data as BlobPart], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}

function Entry({ item, picked, packageName, onChanged }: { item: LibraryItem; picked: PieceId[]; packageName: string; onChanged: () => void }) {
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

  /** Draws one map and hands back the piece. The pins on the wider maps are found here. */
  const drawMap = async (kind: LibraryPiece['kind']): Promise<LibraryPiece> => {
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
    return made.piece
  }

  /** One data piece as CSV text, from the same sources the map reads. */
  const table = async (id: PieceId): Promise<string> => {
    if (id === 'demographics') return csv(demographicsRows(await api.demographics(lat, lng)))
    if (id === 'employment') {
      const [data, found] = await Promise.all([
        api.demographics(lat, lng).catch(() => null),
        api.landmarks({ lat, lng, radius: 5, kinds: ['headquarters'] }).catch(() => null),
      ])
      if (!data && !found) throw new Error('Neither the Census nor the employer directory could be reached.')
      return csv(employmentRows(data, found?.landmarks ?? []))
    }
    const found = await api.nearby({ lat, lng, category: 'chains', radius: 1 })
    return csv(chainsRows(found.results))
  }

  const one = (id: PieceId) =>
    run(id, async () => {
      if ((MAP_PIECES as PieceId[]).includes(id)) {
        await drawMap(id as LibraryPiece['kind'])
        onChanged()
        return
      }
      save(`${slugOf(name)}-${id}.csv`, await table(id), 'text/csv;charset=utf-8')
    })

  /*
   * The package for this parcel, as one download. A map that has not been
   * drawn is drawn first; a piece that cannot be made is left out and
   * named, so one unreachable source does not cost the whole package.
   */
  const exportPackage = () =>
    run('package', async () => {
      const files: ZipEntry[] = []
      const missed: string[] = []
      const encoder = new TextEncoder()
      let drew = false
      for (const spec of PIECE_SPECS.filter((p) => picked.includes(p.id))) {
        try {
          if (spec.group === 'Maps') {
            let piece = pieces.get(spec.id as LibraryPiece['kind'])
            if (!piece) {
              piece = await drawMap(spec.id as LibraryPiece['kind'])
              drew = true
            }
            const answer = await fetch(piece.path)
            if (!answer.ok) throw new Error('not found')
            files.push({ name: spec.file, data: new Uint8Array(await answer.arrayBuffer()) })
          } else {
            files.push({ name: spec.file, data: encoder.encode(await table(spec.id)) })
          }
        } catch {
          missed.push(spec.label)
        }
      }
      if (drew) onChanged()
      if (!files.length) throw new Error('None of the package\'s pieces could be made just now.')
      save(`${slugOf(name)}-${slugOf(packageName)}.zip`, zip(files), 'application/zip')
      setNote(missed.length ? `Exported without: ${missed.join(', ')}. Those could not be made just now.` : null)
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
          {located ? (
            <button type="button" className="btn-primary text-xs" disabled={busy !== null || picked.length === 0} onClick={() => void exportPackage()} data-testid="export-package"
              title={picked.length ? `Download ${picked.length} piece${picked.length === 1 ? '' : 's'} as one file` : 'Pick at least one piece above'}>
              {busy === 'package' ? 'Making the package…' : `Export ${packageName} (${picked.length})`}
            </button>
          ) : null}
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

      {item.deals.length ? (
        <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
          On
          {item.deals.map((d) => (
            <button key={d.id} type="button" className="rounded-full bg-sunken px-2 py-0.5 font-medium text-body hover:text-brand-deep" onClick={() => navigate(`/deals/${d.id}`)}>
              {d.name}
            </button>
          ))}
        </p>
      ) : null}

      {located ? (
        <>
          <p className="label mb-1.5 mt-4">Maps</p>
          <div className="grid gap-3 sm:grid-cols-3">
            {PIECE_SPECS.filter((p) => p.group === 'Maps').map((spec) => {
              const piece = pieces.get(spec.id as LibraryPiece['kind'])
              const link = piece ? `${window.location.origin}${piece.path}` : ''
              const inPackage = picked.includes(spec.id)
              return (
                <div key={spec.id} className={`overflow-hidden rounded-lg border ${inPackage ? 'border-brand/50' : 'border-line opacity-70'}`} data-piece={spec.id}>
                  {piece ? (
                    <a href={piece.path} target="_blank" rel="noreferrer" title="Open the full image">
                      <img src={piece.path} alt={`${spec.label} of ${name}`} loading="lazy" className="aspect-[3/2] w-full bg-sunken object-cover" />
                    </a>
                  ) : (
                    <div className="flex aspect-[3/2] w-full items-center justify-center bg-sunken/60 px-3 text-center text-[11px] text-faint">
                      {spec.what}
                    </div>
                  )}
                  <div className="p-2">
                    <p className="text-xs font-semibold text-ink">{spec.label}{inPackage ? <span className="ml-1.5 text-[10px] font-medium text-brand">in package</span> : null}</p>
                    <p className="text-[10px] text-faint">{piece ? `Drawn ${piece.createdAt.slice(0, 10)}` : 'Not drawn yet'}</p>
                    <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] font-semibold">
                      <button type="button" className="text-brand hover:underline disabled:opacity-50" disabled={busy !== null} onClick={() => void one(spec.id)}>
                        {busy === spec.id ? 'Drawing…' : piece ? 'Draw again' : 'Draw it'}
                      </button>
                      {piece ? (
                        <>
                          <a className="text-ink hover:underline" href={piece.path} download={`${slugOf(name)}-${spec.id}.png`}>Download</a>
                          <button
                            type="button"
                            className="text-ink hover:underline"
                            onClick={() => {
                              void navigator.clipboard?.writeText(link).then(() => {
                                setCopied(spec.id)
                                window.setTimeout(() => setCopied(null), 1500)
                              })
                            }}
                          >
                            {copied === spec.id ? 'Copied' : 'Copy link'}
                          </button>
                        </>
                      ) : null}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          <p className="label mb-1.5 mt-4">Data</p>
          <div className="grid gap-2 sm:grid-cols-3">
            {PIECE_SPECS.filter((p) => p.group === 'Data').map((spec) => {
              const inPackage = picked.includes(spec.id)
              return (
                <div key={spec.id} className={`rounded-lg border p-2 ${inPackage ? 'border-brand/50' : 'border-line opacity-70'}`} data-piece={spec.id}>
                  <p className="text-xs font-semibold text-ink">{spec.label}{inPackage ? <span className="ml-1.5 text-[10px] font-medium text-brand">in package</span> : null}</p>
                  <p className="mt-0.5 text-[10px] leading-snug text-faint">{spec.what}</p>
                  <button type="button" className="mt-1.5 text-[11px] font-semibold text-brand hover:underline disabled:opacity-50" disabled={busy !== null} onClick={() => void one(spec.id)}>
                    {busy === spec.id ? 'Reading…' : 'Download CSV'}
                  </button>
                </div>
              )
            })}
          </div>
        </>
      ) : (
        <p className="mt-3 text-xs text-muted">This record is not tied to a parcel on a county map, so its pieces cannot be made.</p>
      )}

      {place.market && place.parcelId ? (
        <p className="mt-3 text-[11px] text-muted">
          Need a quick PDF instead?{' '}
          <button type="button" className="font-semibold text-brand hover:underline"
            onClick={() => window.open(`/om/${encodeURIComponent(String(place.market))}/${encodeURIComponent(String(place.parcelId))}`, '_blank', 'noopener')}>
            Open the one-page memo
          </button>
        </p>
      ) : null}
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

  /*
   * The package: which pieces an export carries. Picked once here, kept in
   * this browser, and applied to every parcel below. The team's own
   * packages are saved views under a market of their own, like the map's
   * starting points, so they are shared and follow the person.
   */
  const [picked, setPicked] = useState<PieceId[]>(() => {
    try {
      const kept = cleanPieces(JSON.parse(localStorage.getItem(PICK_KEY) ?? 'null'))
      return kept.length ? kept : cleanPieces(['parcel-map', 'location-map'])
    } catch {
      return cleanPieces(['parcel-map', 'location-map'])
    }
  })
  const [own, setOwn] = useState<Package[]>([])
  const [naming, setNaming] = useState(false)
  const [packName, setPackName] = useState('')
  const choose = (next: PieceId[]) => {
    const clean = cleanPieces(next)
    setPicked(clean)
    try { localStorage.setItem(PICK_KEY, JSON.stringify(clean)) } catch { /* private window: the pick is not remembered */ }
  }
  const loadPackages = useCallback(() => {
    api.views
      .list(PACKAGE_MARKET)
      .then((res) => setOwn(res.views.map((view) => ({ id: view.id, name: view.name, pieces: cleanPieces(view.state?.pieces) })).filter((p) => p.pieces.length > 0)))
      .catch(() => setOwn([]))
  }, [])
  useEffect(() => { loadPackages() }, [loadPackages])
  const all = useMemo(() => packages(own), [own])
  const current = all.find((p) => same(p.pieces, picked)) ?? null
  const packageName = current?.name ?? 'package'

  /*
   * A deal is a folder: the parcels on it, with their pieces. The folder is
   * named in the address (?deal=<id>), which is how a deal's own page opens
   * it, and it also lists the deal's parcels that are not in the library
   * yet, to be added in one click.
   */
  const [folder, setFolder] = useState<string>(() => new URLSearchParams(window.location.search).get('deal') ?? '')
  const [deal, setDeal] = useState<Deal | null>(null)
  const [adding, setAdding] = useState(false)
  useEffect(() => {
    const url = new URL(window.location.href)
    if (folder) url.searchParams.set('deal', folder)
    else url.searchParams.delete('deal')
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
    if (!folder) {
      setDeal(null)
      return undefined
    }
    let cancelled = false
    api.crm.get<Deal>('deals', folder).then(({ record }) => !cancelled && setDeal(record)).catch(() => !cancelled && setDeal(null))
    return () => {
      cancelled = true
    }
  }, [folder])

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

  const folders = useMemo(() => {
    const seen = new Map<string, string>()
    for (const item of items ?? []) for (const d of item.deals) seen.set(d.id, d.name)
    if (deal) seen.set(deal.id, deal.name)
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [items, deal])

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    return (items ?? [])
      .filter((item) => !folder || item.deals.some((d) => d.id === folder))
      .filter(({ place }) => !needle || [place.name, place.address, place.city, place.market].some((t) => String(t ?? '').toLowerCase().includes(needle)))
  }, [items, filter, folder])

  // The folder's deal has parcels that are not in the library yet.
  const missing = useMemo(() => {
    if (!deal || deal.id !== folder) return []
    const inside = new Set((items ?? []).map((item) => item.place.id))
    return (deal.parties ?? []).filter((party) => party.kind === 'place' && !inside.has(party.record.id))
  }, [deal, folder, items])
  const addMissing = async () => {
    setAdding(true)
    try {
      for (const party of missing) await api.library.add(party.record.id)
      load()
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <WorkspaceNav current="library" account={account} smsConfigured={smsConfigured} billing={billing} onAccountChange={onAccountChange} onSignedOut={onSignedOut} />
      <main className="mx-auto w-full max-w-5xl flex-1 px-5 py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-ink">Library</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted">
              The pieces of an offering memorandum, kept per parcel. Pick the pieces a package carries, then export it for any parcel as one download.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {folders.length ? (
              <select className="field w-56 text-sm" aria-label="Folder" value={folder} onChange={(e) => setFolder(e.target.value)} data-testid="library-folder">
                <option value="">All parcels</option>
                {folders.map((f) => <option key={f.id} value={f.id}>Deal: {f.name}</option>)}
              </select>
            ) : null}
            {items?.length ? (
              <input className="field w-56 text-sm" placeholder="Find a parcel" aria-label="Find a parcel in the library" value={filter} onChange={(e) => setFilter(e.target.value)} />
            ) : null}
          </div>
        </div>

        <section className="panel mt-5 p-4" data-testid="library-package">
          <div className="flex flex-wrap items-center gap-2">
            <p className="label mr-1">Package</p>
            {all.map((pack) => (
              <span key={pack.id ?? pack.name} className={`inline-flex items-center rounded-full border text-xs ${same(pack.pieces, picked) ? 'border-brand bg-brand/10 text-ink' : 'border-line bg-surface text-body hover:border-muted'}`}>
                <button type="button" className="py-1 pl-2.5 pr-2 font-medium" onClick={() => choose(pack.pieces)} title={pack.pieces.map((id) => PIECE_SPECS.find((p) => p.id === id)?.label).join(', ')}>
                  {pack.name}
                </button>
                {pack.id ? (
                  <button type="button" aria-label={`Remove the ${pack.name} package`} title="Remove this package"
                    className="mr-1 flex h-4 w-4 items-center justify-center rounded-full text-faint hover:bg-sunken hover:text-ink"
                    onClick={() => void api.views.remove(pack.id as string).then(loadPackages)}>
                    ×
                  </button>
                ) : null}
              </span>
            ))}
            {!current && picked.length ? (
              naming ? (
                <form className="flex items-center gap-1.5" onSubmit={(event) => {
                  event.preventDefault()
                  const label = packName.trim()
                  if (!label) return
                  void api.views.save({ market: PACKAGE_MARKET, name: label, state: { v: 1, pieces: picked } }).then(() => {
                    setNaming(false)
                    setPackName('')
                    loadPackages()
                  })
                }}>
                  <input autoFocus className="field h-7 w-40 px-2 text-xs" placeholder="Name this package" aria-label="Package name" maxLength={40} value={packName} onChange={(e) => setPackName(e.target.value)} />
                  <button type="submit" className="btn-secondary h-7 px-2 py-0 text-xs" disabled={!packName.trim()}>Save</button>
                  <button type="button" className="text-xs text-muted hover:text-ink" onClick={() => setNaming(false)}>Cancel</button>
                </form>
              ) : (
                <button type="button" className="text-xs font-semibold text-brand hover:underline" onClick={() => setNaming(true)}>Save this pick as a package</button>
              )
            ) : null}
          </div>
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
            {PIECE_SPECS.map((spec) => (
              <label key={spec.id} className="flex cursor-pointer items-center gap-1.5 text-xs text-body" title={spec.what}>
                <input type="checkbox" checked={picked.includes(spec.id)} onChange={() => choose(picked.includes(spec.id) ? picked.filter((id) => id !== spec.id) : [...picked, spec.id])} />
                {spec.label}
              </label>
            ))}
          </div>
        </section>

        {folder && deal ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-3" data-testid="library-deal">
            <p className="text-sm text-body">
              Folder for the deal{' '}
              <button type="button" className="font-semibold text-ink hover:text-brand-deep" onClick={() => navigate(`/deals/${deal.id}`)}>{deal.name}</button>
              {missing.length ? `: ${missing.length} of its parcels ${missing.length === 1 ? 'is' : 'are'} not in the library yet.` : '.'}
            </p>
            <div className="flex items-center gap-2">
              {missing.length ? (
                <button type="button" className="btn-primary text-xs" disabled={adding} onClick={() => void addMissing()}>
                  {adding ? 'Adding…' : `Add ${missing.length === 1 ? 'it' : `all ${missing.length}`} to the library`}
                </button>
              ) : null}
              <button type="button" className="btn-secondary text-xs" onClick={() => navigate(`/deals/${deal.id}`)}>Open the deal</button>
            </div>
          </div>
        ) : null}

        <div className="mt-4 space-y-4">
          {failed ? (
            <p className="text-sm text-rose-600">The library could not be read. Reload to try again.</p>
          ) : items === null ? (
            <p className="text-sm text-muted">Loading the library…</p>
          ) : folder && shown.length === 0 ? (
            <p className="text-sm text-muted">
              {missing.length ? 'Add the deal\'s parcels above to start its folder.' : 'This deal has no parcels on it yet. Add one from the map with “+ Deal”.'}
            </p>
          ) : items.length === 0 ? (
            <div className="panel p-6 text-sm text-muted" data-testid="library-empty">
              <p className="font-semibold text-ink">Nothing in the library yet.</p>
              <p className="mt-1">On the map, open a parcel and choose “Add to library”. Its maps and data are made here, by the package or one piece at a time.</p>
              <button type="button" className="btn-primary mt-3 text-xs" onClick={() => navigate('/gis')}>Open the map</button>
            </div>
          ) : shown.length === 0 ? (
            <p className="text-sm text-muted">No parcel in the library matches.</p>
          ) : (
            shown.map((item) => <Entry key={item.place.id} item={item} picked={picked} packageName={packageName} onChanged={load} />)
          )}
        </div>
      </main>
    </div>
  )
}
