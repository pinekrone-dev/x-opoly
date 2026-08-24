import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Survey } from '../types'
import { navigate } from '../lib/router'
import { shortDate } from '../lib/format'

export default function SurveyList() {
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

  const create = async (form: HTMLFormElement) => {
    const data = new FormData(form)
    const { survey } = await api.createSurvey({
      name: String(data.get('name') || '').trim(),
      clientName: String(data.get('clientName') || '').trim() || undefined,
      brokerName: String(data.get('brokerName') || '').trim() || undefined,
    })
    navigate(`/survey/${survey.id}`)
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Your surveys</h1>
          <p className="mt-1 text-sm text-slate-500">
            One survey per client search. Map the candidates, work the stages, send a link.
          </p>
        </div>
        <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
          New survey
        </button>
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
        <p className="text-sm text-slate-500">Loading…</p>
      ) : surveys.length === 0 ? (
        <div className="panel p-12 text-center">
          <p className="text-sm font-semibold text-slate-200">No surveys yet.</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">
            Start one for your next requirement, drop the flyers in, and the map builds itself.
          </p>
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {surveys.map((survey) => (
            <li key={survey.id}>
              <button
                type="button"
                className="panel w-full p-5 text-left transition hover:border-brand/40"
                onClick={() => navigate(`/survey/${survey.id}`)}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate font-semibold text-slate-100">{survey.name}</h2>
                    {survey.clientName && <p className="truncate text-sm text-slate-500">for {survey.clientName}</p>}
                  </div>
                  {survey.share.enabled && (
                    <span className="pill bg-brand/15 text-brand ring-brand/30">shared</span>
                  )}
                </div>
                <p className="mt-4 flex items-center gap-3 text-xs text-slate-500">
                  <span className="font-mono text-slate-300">{survey.pinCount ?? 0}</span> sites
                  <span aria-hidden>·</span>
                  updated {shortDate(survey.updatedAt)}
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
