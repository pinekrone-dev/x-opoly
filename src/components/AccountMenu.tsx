import { useState } from 'react'
import { api } from '../api'
import InviteCollaborators from './InviteCollaborators'
import type { Account, BillingStatus } from '../types'

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
  billing,
  onChange,
  onSignedOut,
}: {
  account: Account
  smsConfigured: boolean
  billing?: BillingStatus | null
  onChange: (account: Account) => void
  onSignedOut: () => void
}) {
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [enrolment, setEnrolment] = useState<{ secret: string; uri: string; qr: string } | null>(null)
  const [totpCode, setTotpCode] = useState('')
  const [emailCheck, setEmailCheck] = useState<string | null>(null)

  /**
   * The operator's proof that verification emails can leave: one test
   * message to their own inbox, with the provider's answer shown here.
   */
  const runEmailCheck = async () => {
    setBusy(true)
    setError(null)
    setEmailCheck(null)
    try {
      const result = await api.emailCheck()
      setEmailCheck(`${result.provider} accepted it (${result.id ?? 'no id'}). Check ${result.to} for it now.`)
    } catch (cause) {
      setEmailCheck(null)
      setError(cause instanceof Error ? cause.message : 'The test email could not be sent.')
    } finally {
      setBusy(false)
    }
  }

  /** Mints a secret and renders it as a QR for the authenticator to scan. */
  const startTotp = async () => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const { secret, uri } = await api.startTotp(password)
      const QRCode = (await import('qrcode')).default
      setEnrolment({
        secret,
        uri,
        qr: await QRCode.toDataURL(uri, { width: 200, margin: 1 }),
      })
      setPassword('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Setup could not be started.')
    } finally {
      setBusy(false)
    }
  }

  const confirmTotp = async () => {
    setBusy(true)
    setError(null)
    try {
      const { user } = await api.confirmTotp(totpCode)
      onChange(user)
      setEnrolment(null)
      setTotpCode('')
      setNotice('Your authenticator is set up.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That code was not accepted.')
    } finally {
      setBusy(false)
    }
  }

  const turnOffTotp = async () => {
    setBusy(true)
    setError(null)
    try {
      const { user } = await api.disableTotp(password)
      onChange(user)
      setPassword('')
      setNotice('Authenticator codes are off.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That could not be changed.')
    } finally {
      setBusy(false)
    }
  }

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
    // Its own stacking context, above the map. The menu drops down over
    // whatever page it is on, and on the GIS and survey pages that is the map
    // with its rail at z-500 and its record panel at z-600: without a level of
    // its own the menu opened underneath them and looked like it never opened.
    <div className="relative z-[700]">
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
        <div className="panel scrollbar-thin absolute right-0 z-20 mt-2 max-h-[min(80vh,42rem)] w-80 overflow-y-auto p-4 text-left">
          <p className="truncate text-sm font-semibold text-ink">{account.name || 'Signed in'}</p>
          <p className="truncate text-xs text-muted">{account.email}</p>

          <div className="mt-4 border-t border-line pt-3">
            <p className="label mb-2">Collaborators</p>
            <InviteCollaborators compact />
          </div>

          <div className="mt-4 border-t border-line pt-3">
            <p className="label mb-2">Authenticator app</p>

            {account.totp ? (
              <>
                <p className="text-xs text-body">On. Codes come from your authenticator app.</p>
                <input
                  className="field mt-2"
                  type="password"
                  placeholder="Current password"
                  aria-label="Current password to turn off the authenticator"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <button
                  type="button"
                  className="btn-secondary mt-2 w-full text-xs"
                  disabled={busy || !password}
                  onClick={() => void turnOffTotp()}
                >
                  Turn off
                </button>
              </>
            ) : enrolment ? (
              <>
                <p className="text-xs text-body">
                  Scan this with your authenticator, then type the code it shows.
                </p>
                <img
                  src={enrolment.qr}
                  alt="Scan to add this account to your authenticator"
                  className="mx-auto mt-2 rounded-lg border border-line"
                  width={160}
                  height={160}
                />
                <p className="mt-1 break-all text-center font-mono text-[10px] text-muted">
                  {enrolment.secret}
                </p>
                <input
                  className="field mt-2 text-center tracking-[0.3em]"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="000000"
                  aria-label="Code from your authenticator"
                  value={totpCode}
                  onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, ''))}
                />
                <button
                  type="button"
                  className="btn-primary mt-2 w-full text-xs"
                  disabled={busy || totpCode.length !== 6}
                  onClick={() => void confirmTotp()}
                >
                  {busy ? 'Checking…' : 'Confirm'}
                </button>
              </>
            ) : (
              <>
                <p className="text-xs text-body">
                  Codes from an app on your phone. Nothing is sent, so it works without signal and
                  costs nothing.
                </p>
                <input
                  className="field mt-2"
                  type="password"
                  placeholder="Current password"
                  aria-label="Current password to set up an authenticator"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <button
                  type="button"
                  className="btn-primary mt-2 w-full text-xs"
                  disabled={busy || !password}
                  onClick={() => void startTotp()}
                >
                  {busy ? 'Working…' : 'Set up'}
                </button>
              </>
            )}
          </div>

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

          {billing?.configured ? (
            <div className="mt-4 border-t border-line pt-3">
              <p className="label mb-2">Subscription</p>
              <p className="text-xs text-body">
                {billing.status === 'exempt'
                  ? 'This workspace is on the house.'
                  : billing.active
                    ? `Active — ${billing.priceLabel}${
                        billing.periodEnd ? `, renews ${new Date(billing.periodEnd).toLocaleDateString()}` : ''
                      }.`
                    : 'Not active.'}
              </p>
              {/* Instance owner only: no minting here — free codes are made
                  in Stripe, off the site — but the email path can be proven
                  from this menu. */}
              {billing.canMintCodes ? (
                <div className="mt-2">
                  <button
                    type="button"
                    className="btn-secondary w-full text-xs"
                    disabled={busy}
                    onClick={() => void runEmailCheck()}
                  >
                    {busy ? 'Working…' : 'Send me a test email'}
                  </button>
                  {emailCheck ? <p className="mt-2 text-xs text-brand-deep">{emailCheck}</p> : null}
                </div>
              ) : null}
              {billing.portalAvailable ? (
                <button
                  type="button"
                  className="btn-secondary mt-2 w-full text-xs"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true)
                    setError(null)
                    try {
                      // Cards, invoices and cancellation live on Stripe's
                      // portal; the return link brings them straight back.
                      const { url } = await api.billingPortal()
                      window.location.assign(url)
                    } catch (cause) {
                      setError(cause instanceof Error ? cause.message : 'The billing page could not be opened.')
                      setBusy(false)
                    }
                  }}
                >
                  Manage billing
                </button>
              ) : null}
            </div>
          ) : null}

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
