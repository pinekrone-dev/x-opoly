import { useState } from 'react'
import { api } from '../api'
import type { Survey } from '../types'
import { shortDate } from '../lib/format'

interface Props {
  survey: Survey
  onChange: (survey: Survey) => void
}

export default function ShareSettings({ survey, onChange }: Props) {
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)

  const link = survey.share.token ? `${window.location.origin}/s/${survey.share.token}` : ''

  const update = async (input: { enabled?: boolean; expiresAt?: string | null; regenerate?: boolean }) => {
    setBusy(true)
    try {
      const { survey: updated } = await api.updateShare(survey.id, input)
      onChange(updated)
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      /* clipboard blocked — the field is selectable as a fallback */
    }
  }

  const expired = survey.share.expiresAt ? new Date(survey.share.expiresAt).getTime() < Date.now() : false

  return (
    <section className="panel mx-auto w-full max-w-2xl">
      <header className="panel-header">
        <h2 className="panel-title">Client link</h2>
        <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-body">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-line-strong bg-paper text-brand"
            checked={survey.share.enabled}
            disabled={busy}
            onChange={(event) => void update({ enabled: event.target.checked })}
          />
          Sharing {survey.share.enabled ? 'on' : 'off'}
        </label>
      </header>

      <div className="p-5">
        <p className="text-sm leading-relaxed text-muted">
          Send this to your client and they see the map, the pins and the flyers — read-only, with your name on it and no
          sign-in. Your private notes stay in here.
        </p>

        <div className="mt-4">
          <span className="label">Shareable link</span>
          <div className="flex gap-2">
            <input
              className="field font-mono text-xs"
              readOnly
              value={link}
              aria-label="Shareable link"
              onFocus={(event) => event.currentTarget.select()}
            />
            <button type="button" className="btn-secondary shrink-0 text-xs" onClick={() => void copy()} disabled={!link}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          {!survey.share.enabled && (
            <p className="mt-2 text-xs text-amber-300/80">Sharing is off, so this link will not open for anyone.</p>
          )}
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label>
            <span className="label">Expires</span>
            <input
              className="field"
              type="date"
              disabled={busy}
              value={survey.share.expiresAt ? survey.share.expiresAt.slice(0, 10) : ''}
              onChange={(event) => void update({ expiresAt: event.target.value || null })}
            />
            <span className="mt-1 block text-[11px] text-muted">
              {survey.share.expiresAt
                ? expired
                  ? `Expired ${shortDate(survey.share.expiresAt)} — the link no longer opens.`
                  : `Stops working after ${shortDate(survey.share.expiresAt)}.`
                : 'No expiry — the link works until you turn sharing off.'}
            </span>
          </label>

          <div className="grid content-start gap-2">
            <span className="label">Link security</span>
            <button
              type="button"
              className="btn-secondary text-xs"
              disabled={busy}
              onClick={() => void update({ regenerate: true })}
            >
              Issue a new link
            </button>
            <button
              type="button"
              className="btn-danger text-xs"
              disabled={busy || !survey.share.enabled}
              onClick={() => void update({ enabled: false })}
            >
              Turn sharing off
            </button>
            <span className="text-[11px] leading-relaxed text-muted">
              A new link immediately breaks the old one, wherever it was forwarded.
            </span>
          </div>
        </div>

        {survey.share.enabled && link && (
          <a className="btn-secondary mt-4 w-full text-xs" href={link} target="_blank" rel="noreferrer noopener">
            Preview what the client sees
          </a>
        )}
      </div>
    </section>
  )
}
