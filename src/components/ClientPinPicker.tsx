import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { usePopover } from '../lib/popover'
import type { ClientPin, Company, Person } from '../types'

type ClientKind = 'person' | 'company'
interface Client { kind: ClientKind; id: string; name: string; detail: string }

const personName = (p: Person) => [p.firstName, p.lastName].filter(Boolean).join(' ') || p.email || 'Unnamed contact'

/*
 * Pins a parcel for a client, from the parcel's card.
 *
 * A client looking for sites gets them one at a time, as they are found on
 * the map. A tick here puts the parcel on that client's open deal (opening
 * one for them the first time), which is what makes it a pin on the map's
 * Client pins layer and an opportunity on the client's own page. An untick
 * takes it off. A client who is not in the CRM yet is added by name here,
 * without leaving the map.
 *
 * `prepare` makes the CRM place when the parcel has none yet, and is asked
 * once.
 */
export default function ClientPinPicker({
  placeId,
  prepare,
  buttonClassName = 'btn-secondary text-xs',
  onChanged,
  inline = false,
}: {
  placeId: string | null
  prepare: () => Promise<string>
  buttonClassName?: string
  onChanged?: (pins: ClientPin[]) => void
  /** Only the chooser itself, to sit inside another picker (the deal picker). */
  inline?: boolean
}) {
  const [open, setOpen] = useState(inline)
  const pop = usePopover(open, 300)
  const [place, setPlace] = useState<string | null>(placeId)
  const [clients, setClients] = useState<Client[] | null>(null)
  const [pinned, setPinned] = useState<Map<string, string>>(new Map())
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => setPlace(placeId), [placeId])

  const read = (pins: ClientPin[]) =>
    setPinned(new Map((pins[0]?.clients ?? []).map((c) => [`${c.kind}:${c.id}`, c.deal.name])))

  // Who the parcel is already pinned for is worth knowing before the picker
  // is opened: the button says so.
  useEffect(() => {
    if (!place) {
      setPinned(new Map())
      return undefined
    }
    let cancelled = false
    api.crm.pins({ place }).then(({ pins }) => !cancelled && read(pins)).catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [place])

  useEffect(() => {
    if (!open || clients) return undefined
    let cancelled = false
    Promise.all([api.crm.list<Person>('people', '', { limit: 300 }), api.crm.list<Company>('companies', '', { limit: 300 })])
      .then(([people, companies]) => {
        if (cancelled) return
        setClients([
          ...people.records.map((p) => ({ kind: 'person' as const, id: p.id, name: personName(p), detail: p.email || 'Contact' })),
          ...companies.records.map((c) => ({ kind: 'company' as const, id: c.id, name: c.name, detail: 'Company' })),
        ])
      })
      .catch((cause) => !cancelled && setError(cause instanceof Error ? cause.message : 'The clients could not be read.'))
    return () => {
      cancelled = true
    }
  }, [open, clients])

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const all = clients ?? []
    // Whoever it is already pinned for stays at the top.
    const ranked = [...all].sort((a, b) => Number(pinned.has(`${b.kind}:${b.id}`)) - Number(pinned.has(`${a.kind}:${a.id}`)))
    return (needle ? ranked.filter((c) => `${c.name} ${c.detail}`.toLowerCase().includes(needle)) : ranked).slice(0, 60)
  }, [clients, filter, pinned])

  const ensure = async () => {
    if (place) return place
    const made = await prepare()
    setPlace(made)
    return made
  }

  const toggle = async (client: Client) => {
    const key = `${client.kind}:${client.id}`
    setBusy(key)
    setError(null)
    try {
      const id = await ensure()
      const { pins } = pinned.has(key)
        ? await api.crm.unpin({ kind: client.kind, id: client.id }, id)
        : await api.crm.pin({ kind: client.kind, id: client.id }, id)
      read(pins)
      onChanged?.(pins)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That could not be saved.')
    } finally {
      setBusy(null)
    }
  }

  // A client who is not in the CRM yet: made from the name typed, then pinned.
  const add = async (kind: ClientKind) => {
    const name = filter.trim()
    if (!name) return
    setBusy('new')
    setError(null)
    try {
      const [first, ...rest] = name.split(/\s+/)
      const made = kind === 'person'
        ? await api.crm.create<Person>('people', { firstName: first, lastName: rest.join(' ') || null })
        : await api.crm.create<Company>('companies', { name })
      const client: Client = { kind, id: made.record.id, name, detail: kind === 'person' ? 'Contact' : 'Company' }
      setClients((current) => [client, ...(current ?? [])])
      setFilter('')
      const id = await ensure()
      const { pins } = await api.crm.pin({ kind, id: client.id }, id)
      read(pins)
      onChanged?.(pins)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That client could not be added.')
    } finally {
      setBusy(null)
    }
  }

  const count = pinned.size
  const typed = filter.trim()
  const exact = typed && (clients ?? []).some((c) => c.name.toLowerCase() === typed.toLowerCase())

  const chooser = (
    <>
          <input
            className="field mb-2 w-full text-sm"
            placeholder="Find a client, or type a new name"
            aria-label="Find a client"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            autoFocus
          />
          {clients === null ? (
            <p className="text-xs text-muted">Loading clients…</p>
          ) : shown.length === 0 ? (
            <p className="text-xs text-muted">{clients.length ? 'No client matches.' : 'No clients in the CRM yet. Type a name to add the first.'}</p>
          ) : (
            <ul className="max-h-60 space-y-0.5 overflow-y-auto">
              {shown.map((client) => {
                const key = `${client.kind}:${client.id}`
                const deal = pinned.get(key)
                return (
                  <li key={key}>
                    <label className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 hover:bg-sunken">
                      <input type="checkbox" className="mt-0.5" checked={Boolean(deal)} disabled={busy !== null} onChange={() => void toggle(client)} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-ink">{client.name}</span>
                        <span className="block truncate text-[11px] text-muted">{deal ? `On ${deal}` : client.detail}</span>
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
          {typed && !exact ? (
            <div className="mt-2 border-t border-line pt-2">
              <p className="text-[11px] text-muted">Add “{typed}” and pin for them:</p>
              <div className="mt-1 flex gap-2">
                <button type="button" className="btn-secondary flex-1 text-xs" disabled={busy !== null} onClick={() => void add('person')}>
                  {busy === 'new' ? 'Saving…' : 'As a person'}
                </button>
                <button type="button" className="btn-secondary flex-1 text-xs" disabled={busy !== null} onClick={() => void add('company')}>
                  As a company
                </button>
              </div>
            </div>
          ) : null}
          <p className="mt-2 text-[10px] leading-snug text-faint">
            A pin puts this parcel on the client’s open deal, so it shows on the Client pins layer and on their CRM page.
          </p>
          {error ? <p className="mt-2 text-xs text-rose-600">{error}</p> : null}
    </>
  )
  if (inline) return chooser

  return (
    <div className="relative" ref={pop.anchor}>
      <button type="button" className={buttonClassName} onClick={() => setOpen((v) => !v)} data-testid="client-pin-button">
        {count ? `Pinned for ${count} client${count === 1 ? '' : 's'}` : '+ Pin for client'}
      </button>
      {open ? (
        <div className="panel p-3 text-left shadow-lg" style={pop.style}>
          {chooser}
        </div>
      ) : null}
    </div>
  )
}
