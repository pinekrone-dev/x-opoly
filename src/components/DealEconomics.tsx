import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { computeEconomics, hasEconomics, INPUT_GROUPS, type EconomicsInputs, type EconomicsKey } from '../lib/economics'
import { downloadDealWorkbook } from '../lib/dealWorkbook'
import type { CrmRecord, Deal } from '../types'

const usd = (value: number | null) =>
  value == null ? '—' : `${value < 0 ? '-' : ''}$${Math.round(Math.abs(value)).toLocaleString('en-US')}`
const percent = (value: number | null) => (value == null ? '—' : `${(value * 100).toFixed(2)}%`)
const times = (value: number | null) => (value == null ? '—' : `${value.toFixed(2)}x`)

/**
 * What the deal makes, worked out as it is typed.
 *
 * Inputs on the left in the same groups as the spreadsheet; the returns on
 * the right recompute on every keystroke and save when a field is left.
 * Export writes the same model to Excel as live formulas, so the file a
 * client opens recalculates when they change an assumption, and so does the
 * summary of every deal exported from the deals list.
 */
export default function DealEconomics({
  deal,
  canEdit,
  onSaved,
}: {
  deal: Deal
  canEdit: boolean
  onSaved: (record: CrmRecord) => void
}) {
  const [draft, setDraft] = useState<Record<string, string>>(() => toDraft(deal.economics))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [open, setOpen] = useState(() => hasEconomics(deal.economics))
  const lastSaved = useRef(JSON.stringify(deal.economics ?? null))

  useEffect(() => {
    setDraft(toDraft(deal.economics))
    lastSaved.current = JSON.stringify(deal.economics ?? null)
  }, [deal.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const inputs = useMemo(() => fromDraft(draft), [draft])
  const result = useMemo(() => computeEconomics(inputs), [inputs])

  const save = async () => {
    const next = JSON.stringify(hasEconomics(inputs) ? inputs : null)
    if (next === lastSaved.current) return
    setSaving(true)
    setError(null)
    try {
      const { record } = await api.crm.update('deals', deal.id, { economics: inputs })
      lastSaved.current = next
      onSaved(record)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The numbers could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  const exportFile = async () => {
    setExporting(true)
    setError(null)
    try {
      await downloadDealWorkbook([{ ...deal, economics: inputs }], `${deal.name} economics.xlsx`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The spreadsheet could not be made.')
    } finally {
      setExporting(false)
    }
  }

  const hold = inputs.holdYears ?? 0
  const metrics: [string, string, string?][] = [
    ['NOI, year 1', usd(result.noi)],
    ['Cap rate', percent(result.goingInCap)],
    ['Yield on cost', percent(result.yieldOnCost)],
    ['Equity required', usd(result.equity)],
    ['Cash-on-cash', percent(result.cashOnCash)],
    ['Debt coverage', times(result.dscr)],
    ['IRR', percent(result.irr), hold > 0 ? undefined : 'Set a hold period'],
    ['Equity multiple', times(result.equityMultiple)],
    ['Total profit', usd(result.totalProfit), hold > 0 ? undefined : 'Set a hold period'],
    ['Net commission', usd(result.netCommission)],
  ]

  return (
    <section className="panel mt-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="label">Economics</p>
          <p className="mt-0.5 text-xs text-muted">How this deal makes money: returns on the investment and your commission.</p>
        </div>
        <div className="flex items-center gap-2">
          {saving ? <span className="text-[11px] text-faint">Saving…</span> : null}
          <button type="button" className="btn-secondary text-xs" onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide inputs' : canEdit ? 'Enter the numbers' : 'Show inputs'}
          </button>
          <button type="button" className="btn-primary text-xs" disabled={exporting} onClick={() => void exportFile()}>
            {exporting ? 'Building…' : 'Export to Excel'}
          </button>
        </div>
      </div>

      {error ? <p className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-2 text-xs text-rose-700">{error}</p> : null}

      <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {metrics.map(([label, value, note]) => (
          <div key={label} className="rounded-lg border border-line bg-sunken/50 px-3 py-2">
            <dt className="text-[10px] uppercase tracking-wide text-faint">{label}</dt>
            <dd className="mt-0.5 text-sm font-semibold text-ink">{value}</dd>
            {note && value === '—' ? <dd className="text-[10px] text-faint">{note}</dd> : null}
          </div>
        ))}
      </dl>

      {open ? (
        <fieldset disabled={!canEdit} className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {INPUT_GROUPS.map((group) => (
            <div key={group.title}>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">{group.title}</p>
              <div className="space-y-1.5">
                {group.inputs.map((spec) => (
                  <label key={spec.key} className="block">
                    <span className="flex items-baseline justify-between gap-2 text-xs text-muted">
                      <span>{spec.label}</span>
                      {spec.hint ? <span className="text-[10px] text-faint">{spec.hint}</span> : null}
                    </span>
                    <span className="relative mt-0.5 block">
                      {spec.unit === 'usd' ? (
                        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-faint">$</span>
                      ) : null}
                      <input
                        className={`field h-8 py-1 text-sm ${spec.unit === 'usd' ? 'pl-5' : ''} ${spec.unit === 'pct' ? 'pr-7' : ''}`}
                        type="number"
                        inputMode="decimal"
                        step="any"
                        min={spec.unit === 'years' ? 0 : undefined}
                        max={spec.key === 'holdYears' ? 30 : undefined}
                        value={draft[spec.key] ?? ''}
                        onChange={(event) => setDraft((current) => ({ ...current, [spec.key]: event.target.value }))}
                        onBlur={() => void save()}
                        aria-label={spec.label}
                      />
                      {spec.unit === 'pct' ? (
                        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-faint">%</span>
                      ) : spec.unit === 'years' ? (
                        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-faint">yrs</span>
                      ) : null}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </fieldset>
      ) : null}

      {open && result.years.length ? (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[34rem] text-right text-xs">
            <thead>
              <tr className="border-b border-line text-[10px] uppercase tracking-wide text-faint">
                <th className="px-2 py-1 text-left font-medium">Year</th>
                <th className="px-2 py-1 font-medium">NOI</th>
                <th className="px-2 py-1 font-medium">Debt service</th>
                <th className="px-2 py-1 font-medium">Sale proceeds</th>
                <th className="px-2 py-1 font-medium">Cash flow</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-line text-muted">
                <td className="px-2 py-1 text-left">0</td>
                <td className="px-2 py-1" />
                <td className="px-2 py-1" />
                <td className="px-2 py-1" />
                <td className="px-2 py-1">{usd(-result.equity)}</td>
              </tr>
              {result.years.map((row) => (
                <tr key={row.year} className="border-b border-line last:border-0">
                  <td className="px-2 py-1 text-left text-muted">{row.year}</td>
                  <td className="px-2 py-1">{usd(row.noi)}</td>
                  <td className="px-2 py-1">{usd(row.debtService)}</td>
                  <td className="px-2 py-1">{row.saleProceeds ? usd(row.saleProceeds) : ''}</td>
                  <td className="px-2 py-1 font-medium text-ink">{usd(row.cashFlow)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  )
}

function toDraft(economics: EconomicsInputs | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(economics ?? {})) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = String(value)
  }
  return out
}

function fromDraft(draft: Record<string, string>): EconomicsInputs {
  const out: EconomicsInputs = {}
  for (const [key, raw] of Object.entries(draft)) {
    const text = raw.trim().replace(/[$,%\s]/g, '')
    if (!text) continue
    const value = Number(text)
    if (Number.isFinite(value)) out[key as EconomicsKey] = value
  }
  return out
}
