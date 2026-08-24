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

export async function createUser(db, { email, password, name = null, phone = null } = {}) {
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
    `INSERT INTO users (id, email, password_hash, name, phone, sms_2fa, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`,
    [
      id,
      address,
      await hashPassword(password),
      name ? String(name).trim().slice(0, 120) : null,
      normalizePhone(phone),
      nowIso(),
    ],
  )
  return { user: await getUser(db, id) }
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

export async function sessionUser(db, token) {
  if (!token) return null
  const row = await db.get('SELECT * FROM sessions WHERE token_hash = ?', [await hashToken(token)])
  if (!row) return null

  if (isPast(row.expires_at)) {
    await db.run('DELETE FROM sessions WHERE token_hash = ?', [row.token_hash])
    return null
  }
  return getUser(db, row.user_id)
}

export async function destroySession(db, token) {
  if (!token) return
  await db.run('DELETE FROM sessions WHERE token_hash = ?', [await hashToken(token)])
}

/** Used when a password changes: every other device should be signed out. */
export async function destroyAllSessions(db, userId) {
  await db.run('DELETE FROM sessions WHERE user_id = ?', [userId])
}

/* -------------------------------------------------------------------------- */
/* Second factor                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Issues a one-time code and returns it alongside the challenge id.
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

  if (!(await verifyCode(String(code ?? '').trim(), row.code_salt, row.code_hash))) {
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
