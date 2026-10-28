import { useEffect, useState } from 'react'
import { api } from '../api'

/*
 * The applications connected to this account with Sign in with Land
 * Quotient — the Claude connector, today — and the way to cut one off.
 *
 * Disconnecting takes effect at once on the server; Claude's own list may
 * show the connector until it next tries and is asked to sign in again.
 */
type Connection = { clientId: string; name: string; scope: string[]; since: string; lastUsed: string }

const ABOUT: Record<string, string> = {
  read: 'read parcels and records',
  maps: 'save maps',
  crm: 'add to the CRM',
}

export default function ConnectedApps() {
  const [rows, setRows] = useState<Connection[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = () =>
    api.account
      .connections()
      .then((res) => setRows(res.connections))
      .catch(() => setRows([]))

  useEffect(() => {
    void load()
  }, [])

  async function cut(clientId?: string) {
    setBusy(clientId ?? 'all')
    setError(null)
    try {
      await api.account.disconnect(clientId)
      await load()
    } catch {
      setError('Could not disconnect. Try again.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="panel mt-6 p-5">
      <h2 className="panel-title">Connected apps</h2>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        Apps you have let act as you, such as the Land Quotient connector in Claude. Changing your password
        also disconnects them all.
      </p>
      {rows === null ? (
        <p className="mt-3 text-xs text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="mt-3 text-xs text-muted">Nothing is connected.</p>
      ) : (
        <ul className="mt-3 divide-y divide-line">
          {rows.map((row) => (
            <li key={row.clientId} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="min-w-0">
                <span className="block truncate font-medium text-ink">{row.name}</span>
                <span className="block truncate text-xs text-muted">
                  Can {row.scope.map((s) => ABOUT[s] ?? s).join(', ')} · since {new Date(row.since).toLocaleDateString()}
                </span>
              </span>
              <button
                type="button"
                className="btn-secondary shrink-0 text-xs"
                disabled={busy !== null}
                onClick={() => void cut(row.clientId)}
              >
                {busy === row.clientId ? 'Disconnecting…' : 'Disconnect'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {rows && rows.length > 1 ? (
        <button type="button" className="mt-2 text-xs text-brand hover:underline" disabled={busy !== null} onClick={() => void cut()}>
          Disconnect all
        </button>
      ) : null}
      {error ? <p className="mt-2 text-xs text-rose-600">{error}</p> : null}
    </section>
  )
}
