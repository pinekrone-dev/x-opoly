import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { usePopover } from '../lib/popover'
import { navigate } from '../lib/router'
import type { Deal, DealOn, RecordType } from '../types'
import ClientPinPicker from './ClientPinPicker'

/** A deal's stage as it is stored (`under_contract`), read as words. */
export const stageWords = (stage: string) => stage.replace(/_/g, ' ')

const SEGMENT: Record<'person' | 'company' | 'place', string> = {
  person: 'people',
  company: 'companies',
  place: 'places',
}

/*
 * Puts a person, a company or a place on a deal, from wherever it is being
 * looked at, or opens a new deal around it.
 *
 * A deal does not have to begin with a property. A broker meets someone with
 * a requirement, and the deal is that person and nothing else until the first
 * sites turn up, which may be weeks later and found on the map. So a deal is
 * started from the contact's own page with the contact already on it, and a
 * parcel is added to an open deal from the parcel card without leaving the
 * map.
 *
 * A tick puts the record on the deal and an untick takes it off. `prepare`
 * makes the CRM place when there is none yet (a parcel becomes a place the
 * first time it is filed), and is asked once.
 */
export default function DealPicker({
  kind,
  refId,
  prepare,
  defaultRole = '',
  defaultName = '',
  openNewDeal = false,
  buttonClassName = 'btn-secondary text-xs',
  label = '+ Deal',
  clients = false,
  onChanged,
}: {
  kind: 'person' | 'company' | 'place'
  refId: string | null
  prepare?: () => Promise<string>
  /** The role offered for this record on a deal; the broker can change it. */
  defaultRole?: string
  /** What a new deal opened here is called until the broker renames it. */
  defaultName?: string
  /** Go to a deal made here once it exists. Off on the map, where leaving loses the place. */
  openNewDeal?: boolean
  buttonClassName?: string
  label?: string
  /** Offer "for a client": the place goes on that client's open deal, made if there is none. */
  clients?: boolean
  onChanged?: () => void
}) {
  const [forClient, setForClient] = useState(false)
  const [open, setOpen] = useState(false)
  const pop = usePopover(open, 300)
  const [deals, setDeals] = useState<Deal[] | null>(null)
  const [on, setOn] = useState<Map<string, DealOn>>(new Map())
  const [record, setRecord] = useState<string | null>(refId)
  const [filter, setFilter] = useState('')
  const [role, setRole] = useState(defaultRole)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [making, setMaking] = useState(false)
  const [name, setName] = useState(defaultName)

  useEffect(() => setRecord(refId), [refId])
  useEffect(() => setName(defaultName), [defaultName])

  // Which deals the record is already on is worth knowing before the picker
  // is opened: the button says so.
  useEffect(() => {
    if (!record) {
      setOn(new Map())
      return
    }
    let cancelled = false
    api.crm
      .dealsOf(SEGMENT[kind], record)
      .then(({ deals: found }) => !cancelled && setOn(new Map(found.map((deal) => [deal.id, deal]))))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [kind, record])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    api.crm
      .list<Deal>('deals')
      .then(({ records }) => !cancelled && setDeals(records))
      .catch((cause) => !cancelled && setError(cause instanceof Error ? cause.message : 'The deals could not be read.'))
    return () => {
      cancelled = true
    }
  }, [open])

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!deals) return []
    if (!needle) return deals
    return deals.filter((deal) => [deal.name, deal.stage, deal.kind ?? ''].some((t) => t.toLowerCase().includes(needle)))
  }, [deals, filter])

  const ensure = async () => {
    if (record) return record
    if (!prepare) throw new Error('Save this record first.')
    const made = await prepare()
    setRecord(made)
    return made
  }

  const toggle = async (deal: Deal) => {
    setBusy(deal.id)
    setError(null)
    try {
      const id = await ensure()
      const held = on.get(deal.id)
      if (held) {
        await api.crm.removeParty(deal.id, held.partyId)
      } else {
        await api.crm.addParty(deal.id, { kind: kind as RecordType, refId: id, role: role.trim() || undefined })
      }
      const { deals: fresh } = await api.crm.dealsOf(SEGMENT[kind], id)
      setOn(new Map(fresh.map((d) => [d.id, d])))
      onChanged?.()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That could not be saved.')
    } finally {
      setBusy(null)
    }
  }

  const make = async () => {
    if (!name.trim()) return
    setBusy('new')
    setError(null)
    try {
      const id = await ensure()
      const { record: deal } = await api.crm.startDeal(name.trim(), {
        kind: kind as RecordType,
        refId: id,
        role: role.trim() || undefined,
      })
      if (openNewDeal) {
        navigate(`/deals/${deal.id}`)
        return
      }
      const [{ records }, { deals: fresh }] = await Promise.all([
        api.crm.list<Deal>('deals'),
        api.crm.dealsOf(SEGMENT[kind], id),
      ])
      setDeals(records)
      setOn(new Map(fresh.map((d) => [d.id, d])))
      setMaking(false)
      setName(defaultName)
      onChanged?.()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The deal could not be made.')
    } finally {
      setBusy(null)
    }
  }

  const count = on.size

  return (
    <div className="relative" ref={pop.anchor}>
      <button type="button" className={buttonClassName} onClick={() => setOpen((v) => !v)}>
        {count ? `On ${count} deal${count === 1 ? '' : 's'}` : label}
      </button>
      {open ? (
        <div className="panel p-3 text-left shadow-lg" style={pop.style}>
          {forClient && prepare ? (
            <>
              <button type="button" className="mb-2 text-[11px] font-semibold text-brand hover:underline" onClick={() => setForClient(false)}>
                ← All deals
              </button>
              <ClientPinPicker
                inline
                placeId={record}
                prepare={ensure}
                onChanged={async () => {
                  // The client's deal now holds the place: read both lists again.
                  const id = record ?? (await ensure())
                  const [{ records }, { deals: fresh }] = await Promise.all([api.crm.list<Deal>('deals'), api.crm.dealsOf(SEGMENT[kind], id)])
                  setDeals(records)
                  setOn(new Map(fresh.map((d) => [d.id, d])))
                  onChanged?.()
                }}
              />
            </>
          ) : (
          <>
          {/* What is being put on a deal, by its address: the thing the
              person is looking at, named before anything is asked of them. */}
          {kind === 'place' && defaultName ? (
            <p className="mb-2 truncate text-xs text-muted" title={defaultName}>
              Add <span className="font-semibold text-ink">{defaultName}</span> to a deal
            </p>
          ) : null}
          <input
            className="field mb-2 w-full text-sm"
            placeholder="Find a deal"
            aria-label="Find a deal"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            autoFocus
          />
          {deals === null ? (
            <p className="text-xs text-muted">Loading deals…</p>
          ) : shown.length === 0 && !making ? (
            <p className="text-xs text-muted">{deals.length ? 'No deal matches.' : 'No deals yet. Start the first one below.'}</p>
          ) : (
            <ul className="max-h-60 space-y-0.5 overflow-y-auto">
              {shown.map((deal) => {
                const held = on.get(deal.id)
                return (
                  <li key={deal.id}>
                    <label className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 hover:bg-sunken">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={Boolean(held)}
                        disabled={busy !== null}
                        onChange={() => void toggle(deal)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-ink">{deal.name}</span>
                        <span className="block truncate text-[11px] capitalize text-muted">
                          {[stageWords(deal.stage), held?.partyRole].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
          {/* A person or a company has a part to play on a deal, and it is
              asked for. A property is a candidate site until the deal says
              otherwise, so nothing is asked: the box read as a name for the
              property, which is its address, shown above. */}
          {kind !== 'place' ? (
            <label className="mt-2 block border-t border-line pt-2 text-[11px] text-muted">
              Role on the deal
              <input
                className="field mt-1 w-full text-sm"
                placeholder="Tenant, buyer, decision maker…"
                value={role}
                onChange={(e) => setRole(e.target.value)}
              />
            </label>
          ) : null}
          {making ? (
            <div className="mt-2 space-y-1.5">
              <input
                className="field w-full text-sm"
                placeholder="Deal name"
                aria-label="Deal name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn-primary flex-1 text-xs"
                  disabled={!name.trim() || busy !== null}
                  onClick={() => void make()}
                >
                  {busy === 'new' ? 'Saving…' : 'Start deal'}
                </button>
                <button type="button" className="btn-ghost text-xs" onClick={() => setMaking(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className={`mt-2 w-full text-left text-xs font-semibold text-brand hover:underline ${kind === 'place' ? 'border-t border-line pt-2' : ''}`}
              onClick={() => setMaking(true)}
            >
              {kind === 'place' && defaultName ? `+ New deal for ${defaultName}` : '+ New deal'}
            </button>
          )}
          {clients && kind === 'place' && !making ? (
            <button
              type="button"
              className="mt-1.5 w-full text-left text-xs font-semibold text-brand hover:underline"
              onClick={() => setForClient(true)}
              data-testid="deal-for-client"
            >
              + Deal for a client…
            </button>
          ) : null}
          {error ? <p className="mt-2 text-xs text-rose-600">{error}</p> : null}
          </>
          )}
        </div>
      ) : null}
    </div>
  )
}
