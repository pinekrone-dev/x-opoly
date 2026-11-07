import { useEffect, useState } from 'react'
import { api } from '../api'
import { usePopover } from '../lib/popover'
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
  prepare,
  label: labelOverride,
  buttonClassName = 'btn-primary text-xs',
}: {
  placeIds: string[]
  /** After a send lands, with how many arrived — the list clears its checks. */
  onSent?: (count: number) => void
  /**
   * Makes the places when there are none yet: a parcel on the map becomes a
   * CRM place first, then goes to the survey, in one click.
   */
  prepare?: () => Promise<string[]>
  label?: string
  buttonClassName?: string
}) {
  const [prepared, setPrepared] = useState<string[] | null>(null)
  const ids = placeIds.length ? placeIds : prepared ?? []
  const [open, setOpen] = useState(false)
  const pop = usePopover(open, 288)
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
    if (!surveyId || ids.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const { properties, missing } = await api.crm.sendPlaces(surveyId, ids)
      setSent({ surveyId, count: properties.length })
      if (missing.length) setError(`${missing.length} of them could not be found and did not go.`)
      onSent?.(properties.length)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That could not be sent.')
    } finally {
      setBusy(false)
    }
  }

  const many = ids.length > 1
  const label = labelOverride ?? (many ? `Send ${ids.length} to survey` : 'Send to survey')

  const toggle = async () => {
    if (open) {
      setOpen(false)
      return
    }
    if (!placeIds.length && prepare && !prepared) {
      setBusy(true)
      setError(null)
      try {
        setPrepared(await prepare())
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'That could not be prepared.')
      } finally {
        setBusy(false)
      }
    }
    setOpen(true)
  }

  return (
    <div className="relative" ref={pop.anchor}>
      <button
        type="button"
        className={buttonClassName}
        disabled={(placeIds.length === 0 && !prepare) || (busy && !open)}
        onClick={() => void toggle()}
      >
        {busy && !open ? 'Preparing…' : label}
      </button>

      {open ? (
        <div className="panel p-3 text-left shadow-lg" style={pop.style}>
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
                {busy ? 'Sending…' : many ? `Send ${ids.length}` : 'Send'}
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
