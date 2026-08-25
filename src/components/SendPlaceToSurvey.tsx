import { useEffect, useState } from 'react'
import { api } from '../api'
import { navigate } from '../lib/router'
import type { Survey } from '../types'

/**
 * Pushes a known building into a survey, and onto its tour.
 *
 * The point of keeping places at the team level: a building the broker
 * already recorded should never be retyped into the next client's search.
 * What lands in the survey is a copy — working it there never rewrites what
 * the team knows about the building.
 */
export default function SendPlaceToSurvey({ placeId }: { placeId: string }) {
  const [open, setOpen] = useState(false)
  const [surveys, setSurveys] = useState<Survey[]>([])
  const [surveyId, setSurveyId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    api.listSurveys()
      .then(({ surveys: list }) => {
        setSurveys(list)
        setSurveyId(list.length ? list[0].id : '')
      })
      .catch(() => setSurveys([]))
  }, [open])

  const send = async () => {
    if (!surveyId) return
    setBusy(true)
    setError(null)
    try {
      await api.crm.sendPlace(placeId, { surveyId })
      setSent(surveyId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That could not be sent.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative">
      <button type="button" className="btn-primary text-xs" onClick={() => setOpen((current) => !current)}>
        Send to survey
      </button>

      {open ? (
        <div className="panel absolute right-0 z-20 mt-2 w-72 p-3 text-left shadow-lg">
          {sent ? (
            <>
              <p className="text-sm text-body">Added to the survey and its tour.</p>
              <button
                type="button"
                className="btn-primary mt-3 w-full text-xs"
                onClick={() => navigate(`/survey/${sent}`)}
              >
                Open the map
              </button>
              <button
                type="button"
                className="btn-ghost mt-1 w-full text-xs"
                onClick={() => {
                  setSent(null)
                  setOpen(false)
                }}
              >
                Done
              </button>
            </>
          ) : surveys.length === 0 ? (
            <p className="text-sm text-muted">No surveys yet. Create one first, then send this building into it.</p>
          ) : (
            <>
              <label className="block">
                <span className="mb-1 block text-xs text-muted">Which survey</span>
                <select
                  className="field w-full text-sm"
                  aria-label="Which survey"
                  value={surveyId}
                  onChange={(event) => setSurveyId(event.target.value)}
                >
                  {surveys.map((survey) => (
                    <option key={survey.id} value={survey.id}>
                      {survey.name}
                    </option>
                  ))}
                </select>
              </label>

              <p className="mt-2 text-[11px] text-muted">
                Lands on the survey and on its tour.
              </p>

              {error ? <p className="mt-2 text-xs text-rose-600">{error}</p> : null}

              <button type="button" className="btn-primary mt-3 w-full text-xs" disabled={busy} onClick={() => void send()}>
                {busy ? 'Sending…' : 'Send'}
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
