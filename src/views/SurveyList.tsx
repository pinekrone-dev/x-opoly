import { useEffect, useState } from 'react'
import AccountMenu from '../components/AccountMenu'
import { api } from '../api'
import ConfirmDelete from '../components/ConfirmDelete'
import { useCanEdit } from '../lib/access'
import type { Survey } from '../types'
import { navigate } from '../lib/router'
import { shortDate } from '../lib/format'

export default function SurveyList({
  account,
  smsConfigured,
  billing,
  embedded = false,
  onAccountChange,
  onSignedOut,
}: {
  account?: import('../types').Account | null
  smsConfigured?: boolean
  billing?: import('../types').BillingStatus | null
  /** Rendered inside the workspace shell, which already has a header. */
  embedded?: boolean
  onAccountChange?: (account: import('../types').Account) => void
  onSignedOut?: () => void
}) {
  const [surveys, setSurveys] = useState<Survey[]>([])
  const [creating, setCreating] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .listSurveys()
      .then(({ surveys: list }) => setSurveys(list))
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load your surveys.'))
      .finally(() => setLoading(false))
  }, [])

  /** Reads the map view MapCanvas remembers; {} when storage is empty or blocked. */
  const homeCenter = (): { centerLat?: number; centerLng?: number; zoom?: number } => {
    try {
      const raw = window.localStorage.getItem('sitesurvey.home')
      if (!raw) return {}
      const parsed = JSON.parse(raw)
      if (Number.isFinite(parsed?.lat) && Number.isFinite(parsed?.lng)) {
        return {
          centerLat: parsed.lat,
          centerLng: parsed.lng,
          zoom: Number.isFinite(parsed?.zoom) ? parsed.zoom : undefined,
        }
      }
    } catch {
      // Storage blocked — the survey just starts without a centre, as before.
    }
    return {}
  }

  /**
   * Deleting a survey takes its sites, flyers, tour and share link with it,
   * so it asks first, on the card itself (ConfirmDelete). A failure throws
   * back to the card, which says so.
   */
  const canEdit = useCanEdit()
  const removeSurvey = async (survey: Survey) => {
    await api.deleteSurvey(survey.id)
    setSurveys((current) => current.filter((entry) => entry.id !== survey.id))
  }

  const create = async (form: HTMLFormElement) => {
    const data = new FormData(form)
    const { survey } = await api.createSurvey({
      name: String(data.get('name') || '').trim(),
      clientName: String(data.get('clientName') || '').trim() || undefined,
      brokerName: String(data.get('brokerName') || '').trim() || undefined,
      // The broker's home market, remembered from wherever they last left a
      // map. A survey with a centre can place a flyer that names no address —
      // without one, that upload used to produce an invisible, unplaced site.
      ...homeCenter(),
    })
    navigate(`/survey/${survey.id}`)
  }

  return (
    <div className={embedded ? '' : 'mx-auto max-w-5xl px-6 py-10'}>
      <header className={`flex flex-wrap items-end justify-between gap-4 ${embedded ? 'mb-4' : 'mb-8'}`}>
        {embedded ? (
          <p className="text-sm text-muted">
            One survey per client search. Map the candidates, work the stages, send a link.
          </p>
        ) : (
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-ink">Your surveys</h1>
            <p className="mt-1 text-sm text-muted">
              One survey per client search. Map the candidates, work the stages, send a link.
            </p>
          </div>
        )}
        {canEdit ? (
          <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
            New survey
          </button>
        ) : null}
        {!embedded && account ? (
          <AccountMenu
            account={account}
            smsConfigured={Boolean(smsConfigured)}
            billing={billing}
            onChange={(next) => onAccountChange?.(next)}
            onSignedOut={() => onSignedOut?.()}
          />
        ) : null}
      </header>

      {error && <p className="panel mb-4 border-rose-500/25 bg-rose-500/10 p-4 text-sm text-rose-200">{error}</p>}

      {creating && (
        <form
          className="panel animate-fade-in mb-6 p-5"
          onSubmit={(event) => {
            event.preventDefault()
            void create(event.currentTarget)
          }}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="sm:col-span-3">
              <span className="label">Survey name</span>
              <input className="field" name="name" required autoFocus placeholder="Dental offices — north Austin" />
            </label>
            <label className="sm:col-span-2">
              <span className="label">Client</span>
              <input className="field" name="clientName" placeholder="Dr. Reyes" />
            </label>
            <label>
              <span className="label">Your name</span>
              <input className="field" name="brokerName" placeholder="Shown on the client link" />
            </label>
          </div>
          <div className="mt-4 flex gap-2">
            <button type="submit" className="btn-primary">
              Create survey
            </button>
            <button type="button" className="btn-secondary" onClick={() => setCreating(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : surveys.length === 0 ? (
        <div className="panel p-12 text-center">
          <p className="text-sm font-semibold text-ink">No surveys yet.</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted">
            Start one for your next requirement, drop the flyers in, and the map builds itself.
          </p>
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {surveys.map((survey) => (
            <li key={survey.id} className="panel flex flex-col transition hover:border-brand/40">
              <button
                type="button"
                className="w-full flex-1 p-5 pb-3 text-left"
                onClick={() => navigate(`/survey/${survey.id}`)}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate font-semibold text-ink">{survey.name}</h2>
                    {survey.clientName && <p className="truncate text-sm text-muted">for {survey.clientName}</p>}
                  </div>
                  {survey.share.enabled && <span className="pill bg-brand/15 text-brand ring-brand/30">shared</span>}
                </div>
                <p className="mt-4 flex items-center gap-3 text-xs text-muted">
                  <span className="font-mono text-body">{survey.pinCount ?? 0}</span> sites
                  <span aria-hidden>·</span>
                  updated {shortDate(survey.updatedAt)}
                </p>
              </button>
              {/* Open and Delete always show: the delete used to appear on
                  hover only, so on a phone or tablet it was never there. */}
              <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-5 py-2">
                <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={() => navigate(`/survey/${survey.id}`)}>
                  Open
                </button>
                {canEdit ? <ConfirmDelete
                  what={`"${survey.name}"${survey.pinCount ? ` and its ${survey.pinCount} site${survey.pinCount === 1 ? '' : 's'}` : ''}`}
                  className="btn-ghost px-2 py-1 text-xs text-muted hover:text-rose-700"
                  onConfirm={() => removeSurvey(survey)}
                /> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
