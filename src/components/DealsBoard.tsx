import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { navigate } from '../lib/router'
import { DEAL_STAGES, dealStage } from '../lib/crm'
import type { Deal } from '../types'

type View = 'rows' | 'pipeline'
const VIEW_KEY = 'lq:deals-view'

const money = (value: number | null | undefined) =>
  value == null || !Number.isFinite(Number(value)) ? '' : `$${Math.round(Number(value)).toLocaleString('en-US')}`
const day = (iso: string | null | undefined) => {
  if (!iso) return ''
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? String(iso) : date.toLocaleDateString()
}

/*
 * The deals a broker is working, two ways.
 *
 * Rows: every active deal on a line, in pipeline order, with the one thing
 * a pipeline is read for beside it: what happens next. Pipeline: the same
 * deals as cards under their stage, dragged from one stage to the next.
 * Stage and next step are changed where they are read, in either view, and
 * saved as they are changed; opening the deal is for everything else.
 *
 * A passed deal is not active, so it is off both views until asked for.
 */
export default function DealsBoard({
  deals,
  canEdit,
  onChange,
}: {
  deals: Deal[]
  canEdit: boolean
  /** A deal as the server holds it after a change made here. */
  onChange: (deal: Deal) => void
}) {
  const [view, setView] = useState<View>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === 'pipeline' ? 'pipeline' : 'rows'
    } catch {
      return 'rows'
    }
  })
  const [showPassed, setShowPassed] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)

  const choose = (next: View) => {
    setView(next)
    try { localStorage.setItem(VIEW_KEY, next) } catch { /* private window: the choice is not remembered */ }
  }

  const passed = deals.filter((deal) => dealStage(deal.stage) === 'passed').length
  const shown = useMemo(() => {
    const order = new Map(DEAL_STAGES.map((stage, i) => [stage.id, i]))
    return deals
      .filter((deal) => showPassed || dealStage(deal.stage) !== 'passed')
      .sort((a, b) => (order.get(dealStage(a.stage)) ?? 0) - (order.get(dealStage(b.stage)) ?? 0)
        || String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
  }, [deals, showPassed])
  const stages = DEAL_STAGES.filter((stage) => showPassed || stage.id !== 'passed')

  const save = async (deal: Deal, patch: { stage?: string; nextStep?: string | null }) => {
    setFailed(null)
    // Shown at once, and put back if the save does not land.
    onChange({ ...deal, ...patch })
    try {
      const { record } = await api.crm.update<Deal>('deals', deal.id, patch)
      onChange(record)
    } catch (cause) {
      onChange(deal)
      setFailed(cause instanceof Error ? cause.message : 'That change could not be saved.')
    }
  }

  const StageSelect = ({ deal }: { deal: Deal }) => (
    <select
      className="rounded-md border border-line bg-surface px-1.5 py-1 text-xs text-ink disabled:opacity-60"
      aria-label={`Stage of ${deal.name}`}
      value={dealStage(deal.stage)}
      disabled={!canEdit}
      onChange={(event) => void save(deal, { stage: event.target.value })}
      onClick={(event) => event.stopPropagation()}
    >
      {DEAL_STAGES.map((stage) => <option key={stage.id} value={stage.id}>{stage.label}</option>)}
    </select>
  )

  return (
    <div data-testid="deals-board">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="inline-flex overflow-hidden rounded-lg border border-line text-xs font-semibold" role="tablist" aria-label="How the deals are shown">
          {(['rows', 'pipeline'] as View[]).map((option) => (
            <button key={option} type="button" role="tab" aria-selected={view === option}
              className={`px-3 py-1.5 ${view === option ? 'bg-brand/10 text-ink' : 'bg-surface text-muted hover:text-body'}`}
              onClick={() => choose(option)}>
              {option === 'rows' ? 'Rows' : 'Pipeline'}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted">
          {shown.length.toLocaleString()} {showPassed ? 'deal' : 'active deal'}{shown.length === 1 ? '' : 's'}
          {shown.some((d) => d.value) ? ` · ${money(shown.reduce((sum, d) => sum + (Number(d.value) || 0), 0))}` : ''}
        </span>
        {passed ? (
          <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-xs text-muted">
            <input type="checkbox" checked={showPassed} onChange={(event) => setShowPassed(event.target.checked)} />
            Show {passed} passed
          </label>
        ) : null}
      </div>
      {failed ? <p className="mb-3 rounded-lg border border-rose-200 bg-rose-50 p-2 text-xs text-rose-700">{failed}</p> : null}

      {shown.length === 0 ? (
        <div className="panel p-8 text-center text-sm text-muted">No active deals. {passed ? 'Tick “Show passed” to see the rest.' : ''}</div>
      ) : view === 'rows' ? (
        <div className="panel overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Deal</th>
                <th className="px-3 py-2 font-medium">Stage</th>
                <th className="px-3 py-2 font-medium">Next step</th>
                <th className="px-3 py-2 text-right font-medium">Value</th>
                <th className="px-3 py-2 font-medium">Expected close</th>
                <th className="px-3 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {shown.map((deal) => (
                <tr key={deal.id} className="hover:bg-sunken/40" data-deal={deal.id}>
                  <td className="max-w-[18rem] px-3 py-2">
                    <button type="button" className="block w-full truncate text-left font-medium text-ink hover:text-brand-deep" onClick={() => navigate(`/deals/${deal.id}`)}>
                      {deal.name}
                    </button>
                    {deal.kind ? <span className="block truncate text-xs text-muted">{deal.kind}</span> : null}
                  </td>
                  <td className="px-3 py-2"><StageSelect deal={deal} /></td>
                  <td className="min-w-[14rem] px-3 py-2"><NextStep deal={deal} canEdit={canEdit} onSave={(value) => void save(deal, { nextStep: value })} /></td>
                  <td className="whitespace-nowrap px-3 py-2 text-right text-body">{money(deal.value)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-body">{day(deal.closeDate)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-muted">{day(deal.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(13rem, 1fr))`, overflowX: 'auto' }}>
          {stages.map((stage) => {
            const cards = shown.filter((deal) => dealStage(deal.stage) === stage.id)
            const total = cards.reduce((sum, d) => sum + (Number(d.value) || 0), 0)
            return (
              <section
                key={stage.id}
                data-stage={stage.id}
                className={`rounded-lg border p-2 ${over === stage.id ? 'border-brand bg-brand/5' : 'border-line bg-sunken/40'}`}
                onDragOver={(event) => {
                  if (!dragging) return
                  event.preventDefault()
                  setOver(stage.id)
                }}
                onDragLeave={() => setOver((current) => (current === stage.id ? null : current))}
                onDrop={(event) => {
                  event.preventDefault()
                  const deal = deals.find((d) => d.id === dragging)
                  setDragging(null)
                  setOver(null)
                  if (deal && dealStage(deal.stage) !== stage.id) void save(deal, { stage: stage.id })
                }}
              >
                <header className="mb-2 flex items-baseline justify-between gap-2 px-1">
                  <h3 className="text-xs font-semibold text-ink">{stage.label}</h3>
                  <span className="text-[11px] text-muted">{cards.length}{total ? ` · ${money(total)}` : ''}</span>
                </header>
                <div className="space-y-2">
                  {cards.map((deal) => (
                    <article
                      key={deal.id}
                      data-deal={deal.id}
                      draggable={canEdit}
                      onDragStart={() => setDragging(deal.id)}
                      onDragEnd={() => {
                        setDragging(null)
                        setOver(null)
                      }}
                      className={`rounded-md border border-line bg-surface p-2 shadow-sm ${canEdit ? 'cursor-grab' : ''} ${dragging === deal.id ? 'opacity-50' : ''}`}
                    >
                      <button type="button" className="block w-full truncate text-left text-sm font-medium text-ink hover:text-brand-deep" onClick={() => navigate(`/deals/${deal.id}`)}>
                        {deal.name}
                      </button>
                      <p className="truncate text-[11px] text-muted">{[deal.kind, money(deal.value), deal.closeDate ? `closes ${day(deal.closeDate)}` : null].filter(Boolean).join(' · ') || ' '}</p>
                      <div className="mt-1.5"><NextStep deal={deal} canEdit={canEdit} onSave={(value) => void save(deal, { nextStep: value })} /></div>
                      <div className="mt-1.5"><StageSelect deal={deal} /></div>
                    </article>
                  ))}
                  {cards.length === 0 ? <p className="px-1 py-3 text-center text-[11px] text-faint">Nothing here</p> : null}
                </div>
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** The next step, typed where it is read and saved when the box is left. */
function NextStep({ deal, canEdit, onSave }: { deal: Deal; canEdit: boolean; onSave: (value: string | null) => void }) {
  const [text, setText] = useState(deal.nextStep ?? '')
  useEffect(() => setText(deal.nextStep ?? ''), [deal.nextStep])
  if (!canEdit) return <span className="text-xs text-body">{deal.nextStep || '—'}</span>
  const commit = () => {
    const value = text.trim()
    if (value !== (deal.nextStep ?? '')) onSave(value || null)
  }
  return (
    <input
      className="w-full rounded-md border border-transparent bg-transparent px-1.5 py-1 text-xs text-ink placeholder:text-faint hover:border-line focus:border-ink focus:bg-white focus:outline-none"
      value={text}
      maxLength={160}
      placeholder="Next step…"
      aria-label={`Next step for ${deal.name}`}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
        if (event.key === 'Escape') setText(deal.nextStep ?? '')
      }}
      onClick={(event) => event.stopPropagation()}
    />
  )
}
