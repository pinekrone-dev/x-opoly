import { useEffect, useState } from 'react'
import { api } from '../api'
import InviteCollaborators from '../components/InviteCollaborators'
import WorkspaceNav from '../components/WorkspaceNav'
import type { Account, BillingStatus, TeamMember } from '../types'

/*
 * The settings page.
 *
 * The account menu is for the things done in a moment — a code, a card, a
 * sign-out. This page is for the choices that outlive a session: which
 * market the map opens on, and who is on the team. Reached from the menu's
 * Settings button, and nothing here floats over a map.
 */

const CATALOG = import.meta.env.VITE_PARCEL_CATALOG || '/catalog'

interface MarketEntry {
  slug: string
  name: string
  region: string
  status: string
}

export default function Settings({
  account,
  smsConfigured,
  billing,
  onAccountChange,
  onSignedOut,
}: {
  account: Account
  smsConfigured: boolean
  billing: BillingStatus | null
  onAccountChange: (account: Account) => void
  onSignedOut: () => void
}) {
  const [markets, setMarkets] = useState<MarketEntry[]>([])
  const [marketsError, setMarketsError] = useState(false)
  const [choice, setChoice] = useState<string>(account.defaultMarket ?? '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [members, setMembers] = useState<TeamMember[] | null>(null)

  // The same catalogue the map reads, filtered the same way: a market that
  // is not live cannot be chosen as the one to open on.
  useEffect(() => {
    fetch(`${CATALOG}/markets.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { markets?: MarketEntry[] }) => setMarkets((d.markets ?? []).filter((m) => m.status === 'live')))
      .catch(() => setMarketsError(true))
  }, [])

  useEffect(() => {
    api.account
      .team()
      .then(({ members: listed }) => setMembers(listed))
      .catch(() => setMembers([]))
  }, [])

  const save = async () => {
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const { user } = await api.account.updateSettings({ defaultMarket: choice || null })
      onAccountChange(user)
      setSaved(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The setting could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  const dirty = (account.defaultMarket ?? '') !== choice

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <WorkspaceNav
        current="settings"
        account={account}
        smsConfigured={smsConfigured}
        billing={billing}
        onAccountChange={onAccountChange}
        onSignedOut={onSignedOut}
      />

      <main className="mx-auto w-full max-w-3xl flex-1 px-5 py-8">
        <h1 className="text-xl font-semibold text-ink">Settings</h1>
        <p className="mt-1 text-sm text-muted">
          Signed in as <strong className="text-ink">{account.email}</strong>
          {account.name ? ` · ${account.name}` : ''}
        </p>

        <section className="panel mt-6 p-5">
          <h2 className="panel-title">Default market</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            The county the GIS map opens on. A market named in the address bar still wins, so a shared link
            opens where it points.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <select
              className="field max-w-md"
              aria-label="Default market"
              value={choice}
              onChange={(event) => {
                setChoice(event.target.value)
                setSaved(false)
              }}
            >
              <option value="">First live market (no preference)</option>
              {markets.map((m) => (
                <option key={m.slug} value={m.slug}>
                  {m.name} · {m.region}
                </option>
              ))}
              {/* A preference for a market the catalogue no longer lists stays
                  visible rather than silently reading as "none". */}
              {choice && !markets.some((m) => m.slug === choice) ? (
                <option value={choice}>{choice} (not currently live)</option>
              ) : null}
            </select>
            <button type="button" className="btn-primary" disabled={saving || !dirty} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            {saved ? <span className="text-xs text-brand-deep">Saved.</span> : null}
          </div>
          {marketsError ? (
            <p className="mt-2 text-xs text-muted">The market list could not be loaded just now; the choice can still be saved by slug.</p>
          ) : null}
          {error ? <p className="mt-2 text-xs text-rose-600">{error}</p> : null}
        </section>

        <section className="panel mt-6 p-5">
          <h2 className="panel-title">Team</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            Everyone who shares this workspace: the same surveys, CRM records, comps and saved map views.
          </p>
          {members === null ? (
            <p className="mt-3 text-xs text-muted">Loading…</p>
          ) : (
            <ul className="mt-3 rounded-lg border border-line">
              {members.map((member) => (
                <li
                  key={member.id}
                  className="flex items-center gap-3 border-b border-line px-3 py-2 text-xs last:border-b-0"
                >
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand text-[10px] font-bold text-white">
                    {(member.name || member.email).slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body">{member.name || member.email}</span>
                    {member.name ? <span className="block truncate text-muted">{member.email}</span> : null}
                  </span>
                  {member.owner ? <span className="pill bg-brand-tint text-brand-deep">Owner</span> : null}
                  {member.id === account.id ? <span className="pill bg-sunken text-muted">You</span> : null}
                  <span className="hidden text-faint sm:block">
                    {member.lastLoginAt ? `Signed in ${new Date(member.lastLoginAt).toLocaleDateString()}` : 'Never signed in'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <InviteCollaborators />

        <p className="mt-6 text-xs text-muted">
          Two-factor sign-in, your phone number, password and billing are in the account menu at the top right.
        </p>
      </main>
    </div>
  )
}
