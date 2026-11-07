/*
 * An offering memorandum from one parcel, in a few seconds.
 *
 * The parcel card hands over what it shows (the record, the county's own
 * labels, the address); this page adds what a listing broker's OM carries
 * around it: the aerial, a location map with rings and the landmarks that
 * sell the site, a numbered map of the chains within a mile, and the trade
 * area's demographics. The headline, price, pitch and contact are the
 * broker's to write; everything else is filled in and sourced.
 *
 * Opened from the card in a new tab. Reloaded on its own, it fetches the
 * record itself, with the county's labels from the market's meta file.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import type { Demographics, Landmark, NearbyBusiness } from '../types'
import { panelRows, type PanelGroup } from '../components/ParcelPanel'
import { omPdf, renderOm, type OmData, type OmMaps, type OmRow } from '../lib/omPages'
import { omPptx } from '../lib/omPptx'
import { fullAddress, zipPlaces } from '../lib/address'
import { numberAmenities } from '../lib/amenityGroups'

interface Handoff {
  market: string
  marketName?: string | null
  id: string
  record: Record<string, string | number | null>
  address: string
  center: { lat: number; lng: number } | null
  rows: { group: string; rows: OmRow[] }[]
}

interface Broker {
  name: string
  email: string
  phone: string
  company: string
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US')

function readHandoff(market: string, id: string): Handoff | null {
  try {
    const raw = localStorage.getItem(`om:${market}:${id}`)
    return raw ? (JSON.parse(raw) as Handoff) : null
  } catch {
    return null
  }
}

function readBroker(): Partial<Broker> {
  try {
    return JSON.parse(localStorage.getItem('om:broker') || '{}') as Partial<Broker>
  } catch {
    return {}
  }
}

/** The cover's highlights from the record and the card's rows. */
export function highlightsOf(record: Record<string, unknown>, rows: { group: string; rows: OmRow[] }[], price: string): OmRow[] {
  const all = rows.flatMap((g) => g.rows)
  const find = (pattern: RegExp) => all.find((r) => pattern.test(r.label))?.text
  const out: OmRow[] = [{ label: 'Sale Price', text: price || 'Contact broker' }]
  const building = find(/(building|living|gross|heated|improvement|floor).*(area|sq|size|sf)|^sq\.? ?ft|square feet/i)
  if (building) out.push({ label: 'Building Size', text: building })
  const acres = Number(record.ac)
  if (Number.isFinite(acres) && acres > 0) out.push({ label: 'Land Area', text: `${acres.toFixed(acres < 1 ? 4 : 2)} AC (${fmt(acres * 43560)} SF)` })
  const year = find(/year built|built/i)
  if (year) out.push({ label: 'Year Built', text: year })
  if (record.zn) out.push({ label: 'Zoning', text: String(record.zn) })
  if (record.at) out.push({ label: 'Property Type', text: String(record.at) })
  if (record.gid) out.push({ label: 'Parcel ID', text: String(record.gid) })
  return out
}

export default function OfferingMemo({ market, id }: { market: string; id: string }) {
  const [handoff, setHandoff] = useState<Handoff | null>(() => readHandoff(market, id))
  const [failed, setFailed] = useState<string | null>(null)
  const [demographics, setDemographics] = useState<Demographics | null>(null)
  const [chains, setChains] = useState<NearbyBusiness[] | null>(null)
  const [chainsNote, setChainsNote] = useState<string | null>(null)
  const [chainsTry, setChainsTry] = useState(0)
  const [landmarks, setLandmarks] = useState<Landmark[] | null>(null)
  const [headline, setHeadline] = useState('')
  const [price, setPrice] = useState('Contact broker')
  const [description, setDescription] = useState<string | null>(null)
  const [broker, setBroker] = useState<Broker>(() => ({ name: '', email: '', phone: '', company: '', ...readBroker() }))
  const [pages, setPages] = useState<HTMLCanvasElement[]>([])
  const [maps, setMaps] = useState<OmMaps | null>(null)
  const [drawing, setDrawing] = useState(false)
  const [busy, setBusy] = useState(false)

  // The record, when the card did not hand it over (a reload, a pasted link).
  useEffect(() => {
    if (handoff) return
    let cancelled = false
    Promise.all([
      api.parcels.one(market, id),
      fetch(`/catalog/${encodeURIComponent(market)}/meta.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ])
      .then(([{ parcel }, meta]) => {
        if (cancelled) return
        const record = parcel as unknown as Record<string, string | number | null> & { bb?: number[]; rest?: Record<string, unknown> }
        const bb = Array.isArray(record.bb) && record.bb.length === 4 ? record.bb.map(Number) : null
        const { bb: _bb, rest, ...flat } = record
        const panel = ((meta as { panel?: PanelGroup[] } | null)?.panel ?? []) as PanelGroup[]
        setHandoff({
          market,
          id,
          record: flat as Record<string, string | number | null>,
          address: String(flat.ad ?? `Parcel ${flat.gid ?? id}`),
          center: bb ? { lat: (bb[1] + bb[3]) / 2, lng: (bb[0] + bb[2]) / 2 } : null,
          rows: panelRows(panel, flat, (rest as Record<string, unknown>) ?? null, {}),
        })
      })
      .catch((error) => setFailed(error instanceof Error ? error.message : 'That parcel could not be read.'))
    return () => {
      cancelled = true
    }
  }, [handoff, market, id])

  // Who is sending it, from the account, unless they have written it in before.
  useEffect(() => {
    api.me()
      .then(({ user }) => {
        if (!user) return
        setBroker((b) => ({ ...b, name: b.name || user.name || '', email: b.email || user.email || '' }))
      })
      .catch(() => undefined)
  }, [])

  const center = handoff?.center ?? null
  useEffect(() => {
    if (!center) return
    let cancelled = false
    api.demographics(center.lat, center.lng).then((d) => !cancelled && setDemographics(d)).catch(() => undefined)
    setChainsNote(null)
    api.nearby({ lat: center.lat, lng: center.lng, category: 'chains', radius: 1, logos: true })
      .then((r) => !cancelled && setChains(r.results))
      .catch((error) => {
        if (cancelled) return
        setChains([])
        setChainsNote(error instanceof Error ? error.message : 'The store directory could not be reached.')
      })
    api.landmarks({ lat: center.lat, lng: center.lng, radius: 3 })
      .then((r) => !cancelled && setLandmarks(r.landmarks))
      .catch(() => !cancelled && setLandmarks([]))
    return () => {
      cancelled = true
    }
  }, [center?.lat, center?.lng, chainsTry]) // eslint-disable-line react-hooks/exhaustive-deps

  // The town comes from the ZIP table, which loads on its own.
  const [fullLine, setFullLine] = useState<string | null>(null)
  useEffect(() => {
    if (!handoff) return
    zipPlaces()
      .then((table) => setFullLine(fullAddress(handoff.record, market, table).full || null))
      .catch(() => undefined)
  }, [handoff, market])

  const [street, cityLine] = useMemo(() => {
    const full = fullLine ?? handoff?.address ?? ''
    const comma = full.indexOf(',')
    return comma > 0 ? [full.slice(0, comma).trim(), full.slice(comma + 1).trim()] : [full, '']
  }, [fullLine, handoff?.address])

  const amenities = useMemo(() => numberAmenities(chains ?? []), [chains])

  // A factual first draft of the pitch, until the broker writes their own.
  const draft = useMemo(() => {
    if (!handoff) return ''
    const r = handoff.record
    const acres = Number(r.ac)
    const kind = r.at ? String(r.at).toLowerCase() : 'property'
    const parts = [
      `${Number.isFinite(acres) && acres > 0 ? `A ${acres.toFixed(acres < 1 ? 2 : 1)}-acre ` : 'A '}${kind} site${r.zn ? ` zoned ${r.zn}` : ''}${cityLine ? ` in ${cityLine.split(',')[0]}` : ''}.`,
    ]
    if (amenities.length) {
      const brands = amenities.slice().sort((a, b) => a.miles - b.miles).slice(0, 4).map((a) => a.brand || a.name)
      parts.push(`${amenities.length} national and regional retailers within a mile, including ${brands.join(', ')}.`)
    }
    const big = (landmarks ?? []).find((l) => l.kind === 'colleges' || l.kind === 'hospitals' || l.kind === 'stadiums')
    if (big) parts.push(`${big.name} is ${big.miles} miles away.`)
    const pop = demographics?.radii?.find((x) => x.miles === 3)?.metrics?.population
    if (pop) parts.push(`${fmt(pop)} people live within three miles.`)
    return parts.join(' ')
  }, [handoff, cityLine, amenities, landmarks, demographics])

  const data: OmData | null = useMemo(() => {
    if (!handoff || !center) return null
    return {
      headline: headline || `${handoff.record.at ? String(handoff.record.at) : 'Property'} for sale`,
      price,
      description: description ?? draft,
      address: street,
      cityLine,
      lat: center.lat,
      lng: center.lng,
      highlights: highlightsOf(handoff.record, handoff.rows, price),
      broker,
      record: handoff.rows,
      amenities,
      amenitiesFailed: Boolean(chainsNote),
      landmarks: landmarks ?? [],
      demographics,
      sources: [
        'Parcel record: the county assessor, as published to Land Quotient.',
        demographics?.source ? `Demographics: ${demographics.source}, block groups within each ring.` : 'Demographics: US Census ACS.',
        'Retailers: OpenStreetMap contributors (stores tagged with a national or regional brand).',
        'Landmarks: Wikidata (enrolment, seats, passengers and employee counts as recorded there).',
        'Maps: Esri, Maxar, Earthstar Geographics and the GIS user community.',
      ],
    }
  }, [handoff, center, headline, price, description, draft, street, cityLine, broker, amenities, chainsNote, landmarks, demographics])

  // Redrawn a moment after the last edit, not on every keystroke.
  const ready = Boolean(data && chains !== null && landmarks !== null)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!data || !ready) return
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      setDrawing(true)
      renderOm(data)
        .then((made) => {
          setPages(made.pages)
          setMaps(made.maps)
        })
        .finally(() => setDrawing(false))
    }, 500)
    return () => window.clearTimeout(timer.current)
  }, [data, ready])

  useEffect(() => {
    try {
      localStorage.setItem('om:broker', JSON.stringify(broker))
    } catch {
      // Not remembered; typed again next time.
    }
  }, [broker])

  // Plain ASCII separators: Chrome drops a download name with an em dash in
  // it and saves the file as "download".
  const filename = `${street || 'Offering memorandum'} - OM`.replace(/[\\/:*?"<>|]/g, '').replace(/[^\x20-\x7e]/g, '-')
  const downloadPptx = async () => {
    if (!data || !maps) return
    setBusy(true)
    try {
      await omPptx(data, maps, `${filename}.pptx`)
    } finally {
      setBusy(false)
    }
  }
  const downloadPdf = async () => {
    setBusy(true)
    try {
      await omPdf(pages, `${filename}.pdf`)
    } finally {
      setBusy(false)
    }
  }
  const downloadPng = (i: number) => {
    const a = document.createElement('a')
    a.href = pages[i].toDataURL('image/png')
    a.download = `${filename} - page ${i + 1}.png`
    a.click()
  }

  if (failed) {
    return <div className="grid min-h-full place-items-center p-8 text-sm text-muted">{failed}</div>
  }

  const field = 'field w-full text-sm'
  return (
    <div className="min-h-full bg-sunken">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-line bg-surface px-4 py-2">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold text-ink">Offering memorandum · {street || 'Loading…'}</h1>
          <p className="truncate text-xs text-muted">
            {!ready ? 'Gathering the record, retailers, landmarks and demographics…' : drawing ? 'Drawing the pages…' : `${pages.length} pages`}
          </p>
        </div>
        <button type="button" className="btn-ghost text-xs" disabled={!pages.length || busy || drawing} onClick={() => void downloadPdf()}>
          PDF
        </button>
        <button type="button" className="btn-primary text-xs" disabled={!maps || busy || drawing} onClick={() => void downloadPptx()}>
          {busy ? 'Building…' : 'Download PowerPoint'}
        </button>
      </header>

      <div className="mx-auto grid max-w-6xl gap-4 p-4 lg:grid-cols-[300px_1fr]">
        <aside className="panel h-fit space-y-3 p-4 text-sm lg:sticky lg:top-16">
          <label className="block">
            <span className="mb-1 block text-xs text-muted">Headline</span>
            <input className={field} value={headline} placeholder={data?.headline ?? ''} onChange={(e) => setHeadline(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted">Price</span>
            <input className={field} value={price} onChange={(e) => setPrice(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted">Description</span>
            <textarea className={`${field} h-32`} value={description ?? draft} onChange={(e) => setDescription(e.target.value)} />
            {description !== null && (
              <button type="button" className="mt-1 text-[11px] text-brand hover:underline" onClick={() => setDescription(null)}>
                Use the drafted description
              </button>
            )}
          </label>
          <fieldset className="space-y-2 border-t border-line pt-3">
            <legend className="text-xs font-semibold text-ink">Prepared by</legend>
            {(['name', 'company', 'phone', 'email'] as const).map((key) => (
              <input key={key} className={field} placeholder={key[0].toUpperCase() + key.slice(1)} value={broker[key]} onChange={(e) => setBroker({ ...broker, [key]: e.target.value })} />
            ))}
          </fieldset>
          {chainsNote && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-800">
              The store directory did not answer ({chainsNote}), so page 3 has no retailers yet.{' '}
              <button
                type="button"
                className="font-semibold underline"
                onClick={() => {
                  setChains(null)
                  setChainsTry((n) => n + 1)
                }}
              >
                Try again
              </button>
            </div>
          )}
          <p className="text-[11px] leading-snug text-faint">
            Everything else is filled in from the county record, OpenStreetMap, Wikidata and the Census, with the sources on the last page. Check it before it goes out.
          </p>
        </aside>

        <main className="space-y-4">
          {!pages.length && (
            <div className="panel grid aspect-[11/8.5] place-items-center text-sm text-muted">{ready ? 'Drawing the pages…' : 'Gathering the data…'}</div>
          )}
          {pages.map((canvas, i) => (
            <figure key={i} className="panel overflow-hidden">
              <img src={canvas.toDataURL('image/jpeg', 0.92)} alt={`Page ${i + 1}`} className="block w-full" />
              <figcaption className="flex justify-end border-t border-line px-3 py-1.5">
                <button type="button" className="text-[11px] font-semibold text-brand hover:underline" onClick={() => downloadPng(i)}>
                  Download page {i + 1} as PNG
                </button>
              </figcaption>
            </figure>
          ))}
        </main>
      </div>
    </div>
  )
}
