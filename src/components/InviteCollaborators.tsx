import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Invite } from '../types'

/**
 * Inviting a colleague onto the workspace.
 *
 * The server mints a one-time link bound to the address typed here; sending it
 * is deliberately left to the broker — text, email, whatever they already use
 * with that person — so no SMTP credentials ever live on the server. The link
 * is shown once, right after minting, which is why the copy field appears
 * inline instead of in the list below.
 */
export default function InviteCollaborators() {
  const [invites, setInvites] = useState<Invite[]>([])
  const [email, setEmail] = useState('')
  const [minted, setMinted] = useState<{ email: string; url: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .listInvites()
      .then(({ invites: listed }) => setInvites(listed))
      .catch(() => undefined)
  }, [])

  const create = async () => {
    setBusy(true)
    setError(null)
    setMinted(null)
    try {
      const { invite, url } = await api.createInvite(email)
      setInvites((current) => [invite, ...current.filter((entry) => entry.email !== invite.email)])
      setMinted({ email: invite.email, url })
      setEmail('')
      setCopied(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The invitation could not be created.')
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (id: string) => {
    await api.revokeInvite(id).catch(() => undefined)
    setInvites((current) => current.filter((invite) => invite.id !== id))
  }

  const copy = async () => {
    if (!minted) return
    try {
      await navigator.clipboard.writeText(minted.url)
      setCopied(true)
    } catch {
      // The field is selectable either way.
    }
  }

  return (
    <section className="panel mt-4 p-4">
      <h3 className="panel-title">Collaborators</h3>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        Invite a partner and they can add and edit sites alongside you. Each invitation is a
        one-time link that only works for the address it was sent to.
      </p>

      <form
        className="mt-3 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (!busy && email.includes('@')) void create()
        }}
      >
        <input
          className="field"
          type="email"
          placeholder="partner@yourfirm.com"
          aria-label="Colleague's email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <button type="submit" className="btn-primary whitespace-nowrap" disabled={busy || !email.includes('@')}>
          {busy ? 'Inviting…' : 'Invite'}
        </button>
      </form>

      {minted ? (
        <div className="mt-3 rounded-lg border border-brand/30 bg-brand-tint p-3">
          <div className="flex items-start justify-between gap-2">
            <p className="text-xs text-body">
              Send this link to <strong className="text-ink">{minted.email}</strong>. It is shown only
              once and works only for them.
            </p>
            <button
              type="button"
              className="btn-ghost shrink-0 px-1.5 py-0.5 text-faint hover:text-body"
              onClick={() => setMinted(null)}
              aria-label="Dismiss this invitation link"
              title="Done — hide the link"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="mt-2 flex gap-2">
            <input className="field font-mono text-[11px]" readOnly value={minted.url} onFocus={(event) => event.target.select()} />
            <button type="button" className="btn-secondary whitespace-nowrap text-xs" onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      ) : null}

      {error ? <p className="mt-2 text-xs text-rose-600">{error}</p> : null}

      {invites.length > 0 ? (
        <ul className="mt-3 rounded-lg border border-line">
          {invites.map((invite) => {
            const expired = !invite.used && new Date(invite.expiresAt).getTime() < Date.now()
            return (
              <li key={invite.id} className="flex items-center gap-3 border-b border-line px-3 py-2 text-xs last:border-b-0">
                <span className="min-w-0 flex-1 truncate text-body">{invite.email}</span>
                {invite.used ? (
                  <span className="pill bg-brand-tint text-brand-deep">Joined</span>
                ) : expired ? (
                  <span className="pill bg-sunken text-muted">Expired</span>
                ) : (
                  <span className="pill bg-amber-500/10 text-amber-700">Invited</span>
                )}
                {!invite.used ? (
                  <button
                    type="button"
                    className="btn-ghost px-1.5 py-1 text-faint hover:text-rose-600"
                    onClick={() => void revoke(invite.id)}
                    aria-label={`Revoke the invitation for ${invite.email}`}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                      <path d="M18 6 6 18M6 6l12 12" />
                    </svg>
                  </button>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}
    </section>
  )
}
