import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Account } from '../types'

/**
 * Signing in, claiming a fresh deployment, joining by invite, and — when the
 * instance sells subscriptions — creating an account from the street.
 *
 * States rather than screens: they share a frame so the flow never feels like
 * being bounced between pages. A self-serve signup detours through email
 * verification (`checkEmail`), and the emailed link lands back here with
 * `?verify=` in the query, which signs the browser in.
 */

type Mode = 'signIn' | 'setup' | 'invited' | 'signUp' | 'code' | 'checkEmail'

export default function SignIn({
  setupRequired,
  smsConfigured,
  selfServe = false,
  startMode,
  onSignedIn,
  onBack,
}: {
  setupRequired: boolean
  smsConfigured: boolean
  selfServe?: boolean
  startMode?: 'signIn' | 'signUp'
  onSignedIn: (account: Account) => void
  onBack?: () => void
}) {
  const [mode, setMode] = useState<Mode>(setupRequired ? 'setup' : startMode === 'signUp' && selfServe ? 'signUp' : 'signIn')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [challengeId, setChallengeId] = useState('')
  const [phoneHint, setPhoneHint] = useState<string | null>(null)
  const [method, setMethod] = useState<'sms' | 'totp'>('sms')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [inviteToken, setInviteToken] = useState<string | null>(null)
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null)

  /**
   * An invite link lands here signed out, with the token in the query string.
   * The server says who it is addressed to before any form is shown, so a
   * dead or forwarded link explains itself instead of failing at submit.
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)

    // The emailed verification link: redeeming it verifies the address and
    // signs this browser in, in one step.
    const verifyToken = params.get('verify')
    if (verifyToken) {
      window.history.replaceState(null, '', window.location.pathname)
      setBusy(true)
      api
        .verifyEmail(verifyToken)
        .then(({ user }) => onSignedIn(user))
        .catch((cause) => {
          setError(cause instanceof Error ? cause.message : 'This verification link is not valid.')
        })
        .finally(() => setBusy(false))
      return
    }

    const token = params.get('invite')
    if (!token) return
    api
      .checkInvite(token)
      .then(({ email: invitedEmail }) => {
        setInviteToken(token)
        setEmail(invitedEmail)
        setMode('invited')
      })
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : 'This invitation link is not valid.')
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const registering = mode === 'setup' || mode === 'invited' || mode === 'signUp'

  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  const submitSetup = () =>
    run(async () => {
      const result = await api.register({
        email,
        password,
        name: name || undefined,
        phone: phone || undefined,
        inviteToken: inviteToken || undefined,
      })
      // A burned token must not be re-checked on reload.
      if (inviteToken) window.history.replaceState(null, '', window.location.pathname)

      // A self-serve account exists but is not signed in until the emailed
      // link proves the address.
      if (result.requiresVerification) {
        setUnverifiedEmail(result.user.email)
        setNotice(null)
        setMode('checkEmail')
        if (result.emailFailed) {
          setError('The confirmation email could not be sent just now — use "Send it again" in a minute.')
        }
        return
      }

      const adopted = result.adoptedSurveys ?? 0
      if (adopted > 0) {
        setNotice(`${adopted} existing survey${adopted === 1 ? '' : 's'} moved to this account.`)
      }
      onSignedIn(result.user)
    })

  const submitSignIn = () =>
    run(async () => {
      try {
        const result = await api.signIn({ email, password })
        if (result.twoFactor && result.challengeId) {
          setChallengeId(result.challengeId)
          setPhoneHint(result.phoneHint ?? null)
          setMethod(result.method === 'totp' ? 'totp' : 'sms')
          setCode('')
          setMode('code')
          return
        }
        if (result.user) onSignedIn(result.user)
      } catch (cause) {
        const body = (cause as { body?: { code?: string; email?: string } })?.body
        if (body?.code === 'email_unverified') {
          setUnverifiedEmail(body.email ?? email)
          setMode('checkEmail')
          return
        }
        throw cause
      }
    })

  const submitCode = () =>
    run(async () => {
      const { user } = await api.verifyCode({ challengeId, code })
      onSignedIn(user)
    })

  const resend = () =>
    run(async () => {
      const { message } = await api.resendVerification(unverifiedEmail ?? email)
      setNotice(message)
    })

  return (
    <div className="grid min-h-full place-items-center bg-paper p-6">
      <div className="panel w-full max-w-sm p-7">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand text-white" aria-hidden>
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 20l-5.5 2.5V6L9 3.5m0 16.5l6-3m-6 3V3.5m6 13.5l5.5 2.5V3l-5.5 2.5m0 11.5V5.5m-6-2l6 2" />
            </svg>
          </span>
          <div>
            <p className="text-sm font-semibold text-ink">SiteSurvey CRE</p>
            <p className="text-xs text-muted">
              {mode === 'setup'
                ? 'Claim this workspace'
                : mode === 'invited'
                  ? 'Join this workspace'
                  : mode === 'signUp'
                    ? 'Create your workspace'
                    : mode === 'code'
                      ? 'Confirm it is you'
                      : mode === 'checkEmail'
                        ? 'Check your email'
                        : 'Sign in to your surveys'}
            </p>
          </div>
        </div>

        {mode === 'setup' ? (
          <p className="mb-4 rounded-lg border border-brand/30 bg-brand-tint p-3 text-xs leading-relaxed text-body">
            Nobody has claimed this workspace yet. The account you create here becomes its owner,
            and any surveys already in it move across.
          </p>
        ) : null}

        {mode === 'invited' ? (
          <p className="mb-4 rounded-lg border border-brand/30 bg-brand-tint p-3 text-xs leading-relaxed text-body">
            You were invited to collaborate as <strong className="text-ink">{email}</strong>. Create
            your account and you will see the team&rsquo;s surveys.
          </p>
        ) : null}

        {mode === 'signUp' ? (
          <p className="mb-4 rounded-lg border border-brand/30 bg-brand-tint p-3 text-xs leading-relaxed text-body">
            Your own workspace for <strong className="text-ink">$29/month</strong>. Confirm your email,
            add a card, and you are mapping sites in minutes.
          </p>
        ) : null}

        {mode === 'checkEmail' ? (
          <div className="space-y-3">
            <p className="text-sm leading-relaxed text-body">
              We sent a confirmation link to{' '}
              <strong className="text-ink">{unverifiedEmail ?? email}</strong>. Open it on this device
              and you will be signed straight in.
            </p>
            <p className="text-xs leading-relaxed text-muted">
              The link lasts 24 hours. Nothing in your spam folder either? Send a fresh one:
            </p>
            {error ? (
              <p className="rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-xs text-rose-700">{error}</p>
            ) : null}
            {notice ? <p className="rounded-lg border border-brand/30 bg-brand-tint p-2.5 text-xs text-body">{notice}</p> : null}
            <button type="button" className="btn-primary w-full" disabled={busy} onClick={() => void resend()}>
              {busy ? 'Working…' : 'Send it again'}
            </button>
            <button
              type="button"
              className="btn-ghost w-full text-xs"
              onClick={() => {
                setMode('signIn')
                setError(null)
                setNotice(null)
              }}
            >
              Back to sign in
            </button>
          </div>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              if (busy) return
              if (registering) void submitSetup()
              else if (mode === 'code') void submitCode()
              else void submitSignIn()
            }}
          >
            {mode === 'code' ? (
              <>
                <p className="text-sm text-body">
                  {method === 'totp'
                    ? 'Open your authenticator app and enter the six-digit code it is showing.'
                    : `We texted a six-digit code${phoneHint ? ` to ${phoneHint}` : ''}. It expires in ten minutes.`}
                </p>
                <label className="block">
                  <span className="label">Code</span>
                  <input
                    autoFocus
                    className="field text-center text-lg tracking-[0.4em]"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    aria-label="Six-digit code"
                    value={code}
                    onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                  />
                </label>
              </>
            ) : (
              <>
                {registering ? (
                  <label className="block">
                    <span className="label">Your name</span>
                    <input
                      className="field"
                      autoComplete="name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </label>
                ) : null}

                <label className="block">
                  <span className="label">Email</span>
                  <input
                    autoFocus={mode === 'signIn'}
                    className="field"
                    type="email"
                    autoComplete="username"
                    required
                    readOnly={mode === 'invited'}
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                  {mode === 'invited' ? (
                    <span className="mt-1 block text-[11px] text-muted">
                      The invitation is for this address, so it cannot be changed.
                    </span>
                  ) : null}
                </label>

                <label className="block">
                  <span className="label">Password</span>
                  <input
                    className="field"
                    type="password"
                    autoComplete={registering ? 'new-password' : 'current-password'}
                    required
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                  {registering ? (
                    <span className="mt-1 block text-[11px] text-muted">At least 10 characters.</span>
                  ) : null}
                </label>

                {registering && mode !== 'signUp' ? (
                  <label className="block">
                    <span className="label">Mobile number (optional)</span>
                    <input
                      className="field"
                      type="tel"
                      autoComplete="tel"
                      placeholder="(214) 555-0100"
                      value={phone}
                      onChange={(event) => setPhone(event.target.value)}
                    />
                    <span className="mt-1 block text-[11px] text-muted">
                      {smsConfigured
                        ? 'Needed if you want a texted code at sign-in. You can turn that on later.'
                        : 'Texted codes are not configured on this server yet, so this is just for your records.'}
                    </span>
                  </label>
                ) : null}
              </>
            )}

            {error ? (
              <p className="rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-xs text-rose-700">
                {error}
              </p>
            ) : null}

            <button type="submit" className="btn-primary w-full" disabled={busy}>
              {busy
                ? 'Working…'
                : mode === 'setup'
                  ? 'Create the account'
                  : mode === 'invited'
                    ? 'Join the workspace'
                    : mode === 'signUp'
                      ? 'Create my account'
                      : mode === 'code'
                        ? 'Confirm code'
                        : 'Sign in'}
            </button>

            {mode === 'code' ? (
              <button
                type="button"
                className="btn-ghost w-full text-xs"
                onClick={() => {
                  setMode('signIn')
                  setError(null)
                }}
              >
                Start over
              </button>
            ) : null}

            {selfServe && (mode === 'signIn' || mode === 'signUp') ? (
              <button
                type="button"
                className="btn-ghost w-full text-xs"
                onClick={() => {
                  setMode(mode === 'signIn' ? 'signUp' : 'signIn')
                  setError(null)
                }}
              >
                {mode === 'signIn' ? 'New here? Create a workspace' : 'Already have an account? Sign in'}
              </button>
            ) : null}

            {onBack && mode !== 'code' ? (
              <button type="button" className="btn-ghost w-full text-xs" onClick={onBack}>
                Back to the site
              </button>
            ) : null}
          </form>
        )}

        {mode !== 'checkEmail' && notice ? <p className="mt-3 text-xs text-brand-deep">{notice}</p> : null}
      </div>
    </div>
  )
}
