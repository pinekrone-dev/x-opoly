import { useState } from 'react'
import { api } from '../api'
import type { Account } from '../types'

/**
 * The signed-in account: signing out, and the second factor.
 *
 * Turning 2FA on asks for the password again. A live session is not proof that
 * the person at the keyboard is the account holder — an unattended browser is
 * exactly the case a second factor exists to survive — so the server demands it
 * and this asks for it rather than letting the request fail.
 */
export default function AccountMenu({
  account,
  smsConfigured,
  onChange,
  onSignedOut,
}: {
  account: Account
  smsConfigured: boolean
  onChange: (account: Account) => void
  onSignedOut: () => void
}) {
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const toggleTwoFactor = async (enabled: boolean) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const { user } = await api.setTwoFactor({
        enabled,
        password,
        phone: phone || undefined,
      })
      onChange(user)
      setPassword('')
      setPhone('')
      setNotice(enabled ? 'Codes will be texted at sign-in.' : 'Texted codes are off.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That could not be changed.')
    } finally {
      setBusy(false)
    }
  }

  const initials = (account.name || account.email)
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('')

  return (
    <div className="relative">
      <button
        type="button"
        className="flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm hover:bg-sunken"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-label="Account"
      >
        <span className="grid h-6 w-6 place-items-center rounded-full bg-brand text-[11px] font-bold text-white">
          {initials || '?'}
        </span>
        <span className="hidden max-w-[10rem] truncate text-body sm:block">
          {account.name || account.email}
        </span>
      </button>

      {open ? (
        <div className="panel absolute right-0 z-20 mt-2 w-72 p-4 text-left">
          <p className="truncate text-sm font-semibold text-ink">{account.name || 'Signed in'}</p>
          <p className="truncate text-xs text-muted">{account.email}</p>

          <div className="mt-4 border-t border-line pt-3">
            <p className="label mb-2">Two-factor by text</p>

            {account.sms2fa ? (
              <>
                <p className="text-xs text-body">
                  On, texting {account.phoneHint ?? 'your mobile'} at sign-in.
                </p>
                <input
                  className="field mt-2"
                  type="password"
                  placeholder="Current password"
                  aria-label="Current password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <button
                  type="button"
                  className="btn-secondary mt-2 w-full text-xs"
                  disabled={busy || !password}
                  onClick={() => void toggleTwoFactor(false)}
                >
                  Turn off
                </button>
              </>
            ) : !smsConfigured ? (
              <p className="text-xs text-muted">
                Texting is not configured on this server, so a code could never arrive. Set the
                Twilio credentials first.
              </p>
            ) : (
              <>
                <p className="text-xs text-body">
                  Ask for a texted code as well as the password when signing in.
                </p>
                {!account.hasPhone ? (
                  <input
                    className="field mt-2"
                    type="tel"
                    placeholder="Mobile number"
                    aria-label="Mobile number"
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                  />
                ) : null}
                <input
                  className="field mt-2"
                  type="password"
                  placeholder="Current password"
                  aria-label="Current password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <button
                  type="button"
                  className="btn-primary mt-2 w-full text-xs"
                  disabled={busy || !password || (!account.hasPhone && !phone)}
                  onClick={() => void toggleTwoFactor(true)}
                >
                  {busy ? 'Saving…' : 'Turn on'}
                </button>
              </>
            )}

            {error ? <p className="mt-2 text-xs text-rose-600">{error}</p> : null}
            {notice ? <p className="mt-2 text-xs text-brand-deep">{notice}</p> : null}
          </div>

          <button
            type="button"
            className="btn-secondary mt-4 w-full text-xs"
            onClick={async () => {
              await api.signOut().catch(() => undefined)
              onSignedOut()
            }}
          >
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  )
}
