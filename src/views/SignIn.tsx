import { useEffect, useState } from 'react'
import { api } from '../api'
import { BrandPin } from '../components/BrandMark'
import type { Account } from '../types'

/**
 * Signing in, claiming a fresh deployment, joining by invite, and — when the
 * instance sells subscriptions — creating an account from the street.
 *
 * States rather than screens: they share a frame so the flow never feels like
 * being bounced between pages. A self-serve signup detours through email
 * verification (`checkEmail`), and the emailed link lands back here with
 * `?verify=` in the query, which signs the browser in. A forgotten password
 * takes the same shape: `forgot` asks for the address, and the emailed link
 * lands on `?reset=`, which is the `reset` state.
 */

type Mode = 'signIn' | 'setup' | 'invited' | 'signUp' | 'code' | 'checkEmail' | 'forgot' | 'reset'

export default function SignIn({
  setupRequired,
  smsConfigured,
  selfServe = false,
  startMode,
  onSignedIn,
  onVerified,
  onBack,
}: {
  setupRequired: boolean
  smsConfigured: boolean
  selfServe?: boolean
  startMode?: 'signIn' | 'signUp'
  onSignedIn: (account: Account) => void
  /** A redeemed email link: signed in, and owed a welcome rather than a form. */
  onVerified?: (account: Account) => void
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
  const [resetToken, setResetToken] = useState<string | null>(null)
  /** The address a reset link was just asked for, which turns the panel into its receipt. */
  const [resetSentTo, setResetSentTo] = useState<string | null>(null)

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
        .then(({ user }) => (onVerified ?? onSignedIn)(user))
        .catch((cause) => {
          // A dead link must not strand them on a bare form: offer the resend
          // that fixes it, addressed to whoever they are.
          setMode('checkEmail')
          setUnverifiedEmail(null)
          setError(cause instanceof Error ? cause.message : 'This verification link is not valid.')
        })
        .finally(() => setBusy(false))
      return
    }

    /*
     * The emailed reset link. Unlike the verification link this cannot be
     * redeemed on arrival — there is a new password to choose first — so the
     * token is held and the form is shown. It leaves the address bar either
     * way, so a reload or a shared screen does not carry it.
     */
    const reset = params.get('reset')
    if (reset) {
      window.history.replaceState(null, '', window.location.pathname)
      setResetToken(reset)
      setPassword('')
      setMode('reset')
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

  const requestReset = () =>
    run(async () => {
      await api.forgotPassword(email)
      /*
       * Confirm the send, without confirming the account.
       *
       * The server answers the same whether or not that address has one, so
       * this screen cannot say "sent" outright. It can say what it did — the
       * request went, here is the address it went for, here is how long the
       * link lasts — which is the reassurance someone is actually looking
       * for, and it leaves the hedge where it belongs, in one quiet line.
       */
      // A second press from the receipt looks identical otherwise, so it
      // says so; the first press has the panel itself as its answer.
      setNotice(resetSentTo ? 'Another link is on its way.' : null)
      setResetSentTo(email)
    })

  const submitReset = () =>
    run(async () => {
      const result = await api.resetPassword({ token: resetToken ?? '', password })
      if (result.secondFactor || !result.user) {
        // The link proved the inbox, not the second factor. New password
        // set; they sign in with it and get challenged as usual.
        setMode('signIn')
        setResetToken(null)
        setPassword('')
        setNotice('Password changed. Sign in with it and we will ask for your code.')
        return
      }
      onSignedIn(result.user)
    })

  /*
   * What the panel calls itself. A lookup rather than a ternary chain: there
   * are eight states now, and the chain had grown deep enough that adding
   * one meant re-reading all of it.
   */
  const subtitle =
    mode === 'setup'
      ? 'Claim this workspace'
      : mode === 'invited'
        ? 'Join this workspace'
        : mode === 'signUp'
          ? 'Create your workspace'
          : mode === 'forgot'
            ? resetSentTo
              ? 'Check your email'
              : 'Reset your password'
            : mode === 'reset'
              ? 'Choose a new password'
              : mode === 'code'
                ? 'Confirm it is you'
                : mode === 'checkEmail'
                  ? unverifiedEmail || email
                    ? 'Check your email'
                    : 'Get a new link'
                  : 'Sign in to your surveys'

  return (
    <div className="grid min-h-full place-items-center bg-paper p-6">
      <div className="panel w-full max-w-sm p-7">
        <div className="mb-6 flex items-center gap-2.5">
          <BrandPin size={36} />
          <div>
            <p className="text-sm font-semibold text-ink">Land Quotient</p>
            <p className="text-xs text-muted">{subtitle}</p>
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

        {mode === 'forgot' ? (
          resetSentTo ? (
            /*
             * The receipt. It replaces the form rather than sitting above it,
             * because a confirmation next to the button that produced it
             * reads as "press me again" — the thing it is meant to stop.
             */
            <div className="space-y-3">
              <div className="rounded-lg border border-brand/30 bg-brand-tint p-3">
                <p className="text-sm font-semibold text-ink">Password reset on its way</p>
                <p className="mt-1 text-xs leading-relaxed text-body">
                  Check the inbox for <strong className="text-ink">{resetSentTo}</strong> and open the
                  link to choose a new password.
                </p>
              </div>
              <p className="text-xs leading-relaxed text-muted">
                The link lasts an hour and works once. Nothing there in a minute or two? Look in spam,
                then send another. If that address has no account, no email is sent.
              </p>
              {error ? (
                <p className="rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-xs text-rose-700">{error}</p>
              ) : null}
              {notice ? <p className="text-xs text-brand-deep">{notice}</p> : null}
              <button
                type="button"
                className="btn-ghost w-full text-xs"
                disabled={busy}
                onClick={() => void requestReset()}
              >
                {busy ? 'Working…' : 'Send another link'}
              </button>
              <button
                type="button"
                className="btn-primary w-full"
                onClick={() => {
                  setMode('signIn')
                  setResetSentTo(null)
                  setError(null)
                  setNotice(null)
                }}
              >
                Back to sign in
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm leading-relaxed text-body">
                Type the address you sign in with and we will email a link to choose a new password.
              </p>
              <p className="text-xs leading-relaxed text-muted">
                The link lasts an hour and works once. Your current password keeps working until you
                use it.
              </p>
              <input
                autoFocus
                className="field"
                type="email"
                autoComplete="email"
                placeholder="you@company.com"
                aria-label="Email address"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !busy && email) void requestReset()
                }}
              />
              {error ? (
                <p className="rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-xs text-rose-700">{error}</p>
              ) : null}
              <button
                type="button"
                className="btn-primary w-full"
                disabled={busy || !email}
                onClick={() => void requestReset()}
              >
                {busy ? 'Working…' : 'Email me a link'}
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
          )
        ) : mode === 'reset' ? (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              if (!busy) void submitReset()
            }}
          >
            <p className="text-sm leading-relaxed text-body">
              Choose a new password. Everywhere you are currently signed in will be signed out.
            </p>
            <label className="block">
              <span className="label">New password</span>
              <input
                autoFocus
                className="field"
                type="password"
                autoComplete="new-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <span className="mt-1 block text-[11px] text-muted">At least 10 characters.</span>
            </label>
            {error ? (
              <p className="rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-xs text-rose-700">{error}</p>
            ) : null}
            <button type="submit" className="btn-primary w-full" disabled={busy || password.length < 10}>
              {busy ? 'Working…' : 'Set the password'}
            </button>
            <button
              type="button"
              className="btn-ghost w-full text-xs"
              onClick={() => {
                setMode('signIn')
                setResetToken(null)
                setPassword('')
                setError(null)
              }}
            >
              Back to sign in
            </button>
          </form>
        ) : mode === 'checkEmail' ? (
          <div className="space-y-3">
            {/*
              Two different situations share this screen, and they are told
              apart by whether the address is *known* — from a signup or a
              sign-in that hit an unverified account — not by whether the
              field has anything in it. It used to be the latter, so on a
              dead link the input vanished after the first keystroke behind
              "We sent a confirmation link to k", which read as the page
              sending an email per letter. Typing is never a send; only the
              button is.
            */}
            {unverifiedEmail ? (
              <>
                <p className="text-sm leading-relaxed text-body">
                  We sent a confirmation link to <strong className="text-ink">{unverifiedEmail}</strong>. Open
                  it on this device and you will be signed straight in.
                </p>
                <p className="text-xs leading-relaxed text-muted">
                  The link lasts 24 hours. Nothing in your spam folder either? Send a fresh one:
                </p>
              </>
            ) : (
              <>
                <p className="text-sm leading-relaxed text-body">
                  That link cannot be used again — links work once and last 24 hours. If you already
                  confirmed on another device, just sign in.
                </p>
                <p className="text-xs leading-relaxed text-muted">
                  Otherwise type the address you signed up with and press the button for a fresh link.
                </p>
                <input
                  className="field"
                  type="email"
                  autoComplete="email"
                  placeholder="you@company.com"
                  aria-label="Email address"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !busy && email) void resend()
                  }}
                />
              </>
            )}
            {error ? (
              <p className="rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-xs text-rose-700">{error}</p>
            ) : null}
            {notice ? <p className="rounded-lg border border-brand/30 bg-brand-tint p-2.5 text-xs text-body">{notice}</p> : null}
            <button
              type="button"
              className="btn-primary w-full"
              disabled={busy || !(unverifiedEmail ?? email)}
              onClick={() => void resend()}
            >
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

            {mode === 'signIn' ? (
              <button
                type="button"
                className="btn-ghost w-full text-xs"
                onClick={() => {
                  setMode('forgot')
                  setResetSentTo(null)
                  setError(null)
                  setNotice(null)
                }}
              >
                Forgot your password?
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
