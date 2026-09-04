import { useEffect, useState } from 'react'
import { api } from '../api'
import { navigate } from '../lib/router'
import type { Survey } from '../types'

/*
 * Pushes known buildings into a survey, and onto its tour.
 *
 * The point of keeping places at the team level: a building the broker
 * already recorded should never be retyped into the next client's search.
 * What lands in the survey is a copy — working it there never rewrites what
 * the team knows about the building.
 *
 * One building from its record page, or a whole checked list from the Places
 * tab: the same control, the same request.
 */
export default function SendPlaceToSurvey({
  placeIds,
  onSent,
}: {
  placeIds: string[]
  /** After a send lands, with how many arrived — the list clears its checks. */
  onSent?: (count: number) => void
}) {
  const [open, setOpen] = useState(false)
  const [surveys, setSurveys] = useState<Survey[]>([])
  const [surveyId, setSurveyId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<{ surveyId: string; count: number } | null>(null)

  useEffect(() => {
    if (!open) return
    api.listSurveys()
      .then(({ surveys: list }) => {
        setSurveys(list)
        setSurveyId((current) => current || (list.length ? list[0].id : ''))
      })
      .catch(() => setSurveys([]))
  }, [open])

  const send = async () => {
    if (!surveyId || placeIds.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const { properties, missing } = await api.crm.sendPlaces(surveyId, placeIds)
      setSent({ surveyId, count: properties.length })
      if (missing.length) setError(`${missing.length} of them could not be found and did not go.`)
      onSent?.(properties.length)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That could not be sent.')
    } finally {
      setBusy(false)
    }
  }

  const many = placeIds.length > 1
  const label = many ? `Send ${placeIds.length} to survey` : 'Send to survey'

  return (
    <div className="relative">
      <button
        type="button"
        className="btn-primary text-xs"
        disabled={placeIds.length === 0}
        onClick={() => setOpen((current) => !current)}
      >
        {label}
      </button>

      {open ? (
        <div className="panel absolute right-0 z-20 mt-2 w-72 p-3 text-left shadow-lg">
          {sent ? (
            <>
              <p className="text-sm text-body">
                {sent.count === 1 ? 'Added to the survey and its tour.' : `${sent.count} added to the survey and its tour.`}
              </p>
              {error ? <p className="mt-2 text-xs text-rose-600">{error}</p> : null}
              <button
                type="button"
                className="btn-primary mt-3 w-full text-xs"
                onClick={() => navigate(`/survey/${sent.surveyId}`)}
              >
                Open the map
              </button>
              <button
                type="button"
                className="btn-ghost mt-1 w-full text-xs"
                onClick={() => {
                  setSent(null)
                  setError(null)
                  setOpen(false)
                }}
              >
                Done
              </button>
            </>
          ) : surveys.length === 0 ? (
            <p className="text-sm text-muted">
              No surveys yet. Create one first, then send {many ? 'these buildings' : 'this building'} into it.
            </p>
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
                {many ? 'Each lands on the survey and on its tour.' : 'Lands on the survey and on its tour.'}
              </p>

              {error ? <p className="mt-2 text-xs text-rose-600">{error}</p> : null}

              <button type="button" className="btn-primary mt-3 w-full text-xs" disabled={busy} onClick={() => void send()}>
                {busy ? 'Sending…' : many ? `Send ${placeIds.length}` : 'Send'}
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
