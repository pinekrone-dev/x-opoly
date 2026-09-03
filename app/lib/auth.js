/**
 * Accounts, sessions, and the SMS second factor.
 *
 * Until now anyone with the URL could edit every survey. This closes that.
 *
 * Two rules shape most of what follows. A wrong password and an unknown email
 * must be indistinguishable, in message and in timing, or the login form
 * becomes a way to enumerate customers. And a second factor is only a second
 * factor if the first one alone cannot produce a session — so the password
 * step issues a challenge, never a cookie, when 2FA is on.
 */

import { newId, nowIso } from './ids.js'
import {
  hashCode,
  hashPassword,
  hashToken,
  randomCode,
  randomToken,
  verifyCode,
  verifyPassword,
} from './crypto.js'
import { generateSecret, otpauthUri, verifyTotp } from './totp.js'

/** Sessions last a fortnight; a broker should not log in every morning. */
const SESSION_DAYS = 14

/** Long enough that guessing is hopeless, short enough to be typed from a text. */
const CODE_TTL_MINUTES = 10
const MAX_CODE_ATTEMPTS = 5

/** Slows credential stuffing without locking a person out for long. */
const MAX_FAILED_LOGINS = 8
const LOCKOUT_MINUTES = 15

/** Below this, a password is not worth hashing well. */
export const MIN_PASSWORD_LENGTH = 10

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

/**
 * A hash of the right shape and cost that no password matches.
 *
 * Verified against when the email is unknown, so a missing account costs the
 * same time as a wrong password. Without this, login latency answers "is this
 * person a customer?" for anyone who can time a request.
 */
const DUMMY_HASH =
  'pbkdf2$sha256$210000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

export function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase()
}

/** Digits only, kept in a form Twilio accepts. */
export function normalizePhone(value) {
  if (value == null) return null
  const digits = String(value).replace(/[^\d+]/g, '')
  if (!digits) return null
  if (digits.startsWith('+')) return digits.slice(0, 16)
  // Bare 10-digit numbers are assumed North American, which is where the
  // product is used; anything else has to be written in full E.164.
  if (digits.length === 10) return `+1${digits}`
  return `+${digits}`.slice(0, 16)
}

function mapUser(row) {
  if (!row) return null
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    // Never the whole number: enough to recognise, not enough to reuse.
    phoneHint: row.phone ? `••• ••• ${String(row.phone).slice(-4)}` : null,
    hasPhone: Boolean(row.phone),
    sms2fa: Boolean(row.sms_2fa),
    teamId: row.team_id ?? row.id,
    verified: Boolean(row.verified ?? 1),
    totp: Boolean(row.totp_enabled),
    // What the login form will ask for. TOTP wins when both are on: it needs
    // no carrier, costs nothing, and survives a SIM swap.
    secondFactor: row.totp_enabled ? 'totp' : row.sms_2fa && row.phone ? 'sms' : null,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  }
}

export async function countUsers(db) {
  const row = await db.get('SELECT COUNT(*) AS total FROM users')
  return Number(row?.total ?? 0)
}

export async function findByEmail(db, email) {
  return db.get('SELECT * FROM users WHERE email = ?', [normalizeEmail(email)])
}

export async function getUser(db, id) {
  return mapUser(await db.get('SELECT * FROM users WHERE id = ?', [id]))
}

export async function createUser(db, { email, password, name = null, phone = null, teamId = null, verified = true } = {}) {
  const address = normalizeEmail(email)
  if (!EMAIL.test(address)) return { error: 'That does not look like an email address.' }
  if (String(password ?? '').length < MIN_PASSWORD_LENGTH) {
    return { error: `Use at least ${MIN_PASSWORD_LENGTH} characters for the password.` }
  }
  if (await findByEmail(db, address)) {
    return { error: 'An account with that email already exists.' }
  }

  const id = newId()
  await db.run(
    `INSERT INTO users (id, email, password_hash, name, phone, sms_2fa, team_id, verified, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    [
      id,
      address,
      await hashPassword(password),
      name ? String(name).trim().slice(0, 120) : null,
      normalizePhone(phone),
      // A self-serve account is its own team; an invited one joins the
      // inviter's, so they see the same surveys.
      teamId ?? id,
      // An invite or a setup token proves the email; a self-serve signup
      // proves nothing yet, so it starts unverified.
      verified ? 1 : 0,
      nowIso(),
    ],
  )
  return { user: await getUser(db, id) }
}

/** How long a verification link stays good. Generous: signups check email later. */
const VERIFY_TTL_HOURS = 24

/**
 * Mints a fresh verification token for an unverified account.
 *
 * Stored as a digest, like sessions and invites: a leaked database must not
 * yield working verification links. Re-issuing replaces the old token, so a
 * resend invalidates every earlier email.
 */
export async function createEmailVerification(db, userId) {
  const token = randomToken(32)
  await db.run('UPDATE users SET verify_digest = ?, verify_expires = ? WHERE id = ?', [
    await hashToken(token),
    minutesFromNow(VERIFY_TTL_HOURS * 60),
    userId,
  ])
  return token
}

/**
 * Records how the send of a verification link went, so a signup stuck on
 * "check your email" can be told apart from one whose link the provider
 * refused. `error` is the provider's message, or null when it accepted.
 */
export async function recordVerificationSend(db, userId, error = null) {
  await db.run('UPDATE users SET verify_sent_at = ?, verify_error = ? WHERE id = ?', [
    new Date().toISOString(),
    error ? String(error).slice(0, 300) : null,
    userId,
  ])
}

/**
 * Redeems a verification link. One use: the digest is cleared on success, and
 * an expired or unknown token says so without revealing whose it was.
 */
export async function verifyEmailToken(db, token) {
  if (!token) return { error: 'This verification link is not valid.' }
  const row = await db.get('SELECT * FROM users WHERE verify_digest = ?', [await hashToken(String(token))])
  if (!row) return { error: 'This verification link is not valid. It may have been replaced by a newer email.' }
  if (isPast(row.verify_expires)) {
    return { error: 'This verification link has expired. Sign in to get a new one.' }
  }
  await db.run('UPDATE users SET verified = 1, verify_digest = NULL, verify_expires = NULL WHERE id = ?', [row.id])
  return { userId: row.id, user: await getUser(db, row.id) }
}

function minutesFromNow(minutes) {
  return new Date(Date.now() + minutes * 60_000).toISOString()
}

function isPast(timestamp) {
  return Boolean(timestamp) && new Date(timestamp).getTime() < Date.now()
}

/**
 * Checks an email and password.
 *
 * Returns `{ user }` on success, or `{ error }` — deliberately the same error
 * for a wrong password and an unknown address.
 */
export async function authenticate(db, email, password) {
  const row = await findByEmail(db, email)

  if (!row) {
    // Burn the same work as a real verification before answering.
    await verifyPassword(String(password ?? ''), DUMMY_HASH)
    return { error: 'That email and password do not match.' }
  }

  if (row.locked_until && !isPast(row.locked_until)) {
    return { error: 'Too many attempts. Try again in a few minutes.', locked: true }
  }

  if (!(await verifyPassword(String(password ?? ''), row.password_hash))) {
    const failures = Number(row.failed_logins ?? 0) + 1
    await db.run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', [
      failures,
      failures >= MAX_FAILED_LOGINS ? minutesFromNow(LOCKOUT_MINUTES) : null,
      row.id,
    ])
    return { error: 'That email and password do not match.' }
  }

  await db.run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', [row.id])
  return { user: mapUser(row), row }
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                    */
/* -------------------------------------------------------------------------- */

/** Returns the raw token; only its digest is stored. */
export async function createSession(db, userId) {
  const token = randomToken(32)
  await db.run(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    [await hashToken(token), userId, nowIso(), minutesFromNow(SESSION_DAYS * 24 * 60)],
  )
  return token
}

/**
 * The user behind a session token, in one query.
 *
 * This runs on every authenticated request, so the session row and the user
 * row are read together rather than as two round trips. The session's expiry
 * rides along under its own name so it cannot collide with a user column.
 */
/*
 * Who a token belongs to, remembered briefly per isolate.
 *
 * Every API request resolves its cookie to a user, and that was one row read
 * per request — the single largest line in the read bill once the searches
 * stopped scanning counties, because a map session makes hundreds of small
 * requests. A minute of memory removes almost all of it. A minute is short
 * enough that a sign-out or a password change lands before anyone notices,
 * and both clear this table directly for the token they know about.
 */
const SESSION_TTL = 60 * 1000
const SESSION_MEMORY = 500
const sessions = new Map()

function rememberSession(hash, user) {
  if (sessions.size >= SESSION_MEMORY) sessions.delete(sessions.keys().next().value)
  sessions.set(hash, { user, until: Date.now() + SESSION_TTL })
}

/** Only for tests, which sign in and out within one process. */
export function forgetSessions() {
  sessions.clear()
}

export async function sessionUser(db, token) {
  if (!token) return null
  const hash = await hashToken(token)
  const held = sessions.get(hash)
  if (held && held.until > Date.now()) return held.user
  const row = await db.get(
    `SELECT u.*, s.expires_at AS session_expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
    [hash],
  )
  if (!row) return null

  if (isPast(row.session_expires_at)) {
    await db.run('DELETE FROM sessions WHERE token_hash = ?', [hash])
    return null
  }
  const user = mapUser(row)
  rememberSession(hash, user)
  return user
}

export async function destroySession(db, token) {
  if (!token) return
  const hash = await hashToken(token)
  sessions.delete(hash)
  await db.run('DELETE FROM sessions WHERE token_hash = ?', [hash])
}

/** Used when a password changes: every other device should be signed out. */
export async function destroyAllSessions(db, userId) {
  for (const [hash, held] of sessions) if (held.user?.id === userId) sessions.delete(hash)
  await db.run('DELETE FROM sessions WHERE user_id = ?', [userId])
}

/* -------------------------------------------------------------------------- */
/* Second factor                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Opens a challenge for an authenticator app.
 *
 * No code is stored, because there is nothing to store: the phone and the
 * server both derive the code from the shared secret and the clock. The row
 * exists only to carry the fact that the password step happened, and to expire.
 */
export async function createTotpChallenge(db, userId) {
  const id = newId()
  await db.batch([
    ['DELETE FROM login_challenges WHERE user_id = ?', [userId]],
    [
      `INSERT INTO login_challenges (id, user_id, code_salt, code_hash, attempts, expires_at, created_at, method)
       VALUES (?, ?, '', '', 0, ?, ?, 'totp')`,
      [id, userId, minutesFromNow(CODE_TTL_MINUTES), nowIso()],
    ],
  ])
  return { challengeId: id }
}

/**
 * Starts enrolling an authenticator.
 *
 * The secret is stored but not switched on until a code proves the phone
 * actually holds it. Enabling first would let someone lock themselves out with
 * a mistyped setup.
 */
export async function beginTotpEnrollment(db, user) {
  const secret = generateSecret()
  await db.run('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?', [secret, user.id])
  return { secret, uri: otpauthUri(secret, { account: user.email }) }
}

export async function confirmTotpEnrollment(db, userId, code) {
  const row = await db.get('SELECT * FROM users WHERE id = ?', [userId])
  if (!row?.totp_secret) return { error: 'Start the setup again — there is no pending secret.' }

  if (!(await verifyTotp(row.totp_secret, code))) {
    return { error: 'That code is not right. Check the clock on your phone and try the next one.' }
  }

  await db.run('UPDATE users SET totp_enabled = 1 WHERE id = ?', [userId])
  return { ok: true }
}

export async function disableTotp(db, userId) {
  await db.run('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?', [userId])
}

/**
 * Issues a one-time code by text and returns it alongside the challenge id.
 *
 * The caller sends the code; it is never stored in the clear and never
 * returned to the browser. Any older challenge for the user is deleted, so a
 * code from a previous attempt cannot be replayed.
 */
export async function createChallenge(db, userId) {
  const code = randomCode(6)
  const { salt, hash } = await hashCode(code)
  const id = newId()

  await db.batch([
    ['DELETE FROM login_challenges WHERE user_id = ?', [userId]],
    [
      `INSERT INTO login_challenges (id, user_id, code_salt, code_hash, attempts, expires_at, created_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
      [id, userId, salt, hash, minutesFromNow(CODE_TTL_MINUTES), nowIso()],
    ],
  ])

  return { challengeId: id, code }
}

/**
 * Checks a code against a challenge.
 *
 * Consumed on success and on running out of attempts, so a code is good once
 * and a challenge cannot be ground down indefinitely.
 */
export async function verifyChallenge(db, challengeId, code) {
  const row = await db.get('SELECT * FROM login_challenges WHERE id = ?', [challengeId])
  if (!row) return { error: 'That code has expired. Sign in again to get a new one.' }

  if (isPast(row.expires_at)) {
    await db.run('DELETE FROM login_challenges WHERE id = ?', [challengeId])
    return { error: 'That code has expired. Sign in again to get a new one.' }
  }

  if (Number(row.attempts ?? 0) >= MAX_CODE_ATTEMPTS) {
    await db.run('DELETE FROM login_challenges WHERE id = ?', [challengeId])
    return { error: 'Too many wrong codes. Sign in again to get a new one.' }
  }

  // A texted code is checked against what was stored; an authenticator code is
  // checked against the shared secret and the clock.
  const correct =
    row.method === 'totp'
      ? await verifyTotpFor(db, row.user_id, code)
      : await verifyCode(String(code ?? '').trim(), row.code_salt, row.code_hash)

  if (!correct) {
    const attempts = Number(row.attempts ?? 0) + 1
    if (attempts >= MAX_CODE_ATTEMPTS) {
      await db.run('DELETE FROM login_challenges WHERE id = ?', [challengeId])
      return { error: 'Too many wrong codes. Sign in again to get a new one.' }
    }
    await db.run('UPDATE login_challenges SET attempts = ? WHERE id = ?', [attempts, challengeId])
    return { error: 'That code is not right.', remaining: MAX_CODE_ATTEMPTS - attempts }
  }

  await db.batch([
    ['DELETE FROM login_challenges WHERE id = ?', [challengeId]],
    ['UPDATE users SET last_login_at = ? WHERE id = ?', [nowIso(), row.user_id]],
  ])
  return { userId: row.user_id }
}

/* -------------------------------------------------------------------------- */

/**
 * Hands surveys created before accounts existed to the first account created.
 *
 * The alternative is that they become unreachable the moment auth is turned
 * on, which would silently destroy real work.
 */
async function verifyTotpFor(db, userId, code) {
  const row = await db.get('SELECT totp_secret FROM users WHERE id = ?', [userId])
  if (!row?.totp_secret) return false
  return verifyTotp(row.totp_secret, code)
}

export async function adoptOrphanSurveys(db, userId) {
  const { changes } = await db.run(
    'UPDATE surveys SET owner_id = ? WHERE owner_id IS NULL',
    [userId],
  )
  return changes
}

export async function markLogin(db, userId) {
  await db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [nowIso(), userId])
}
