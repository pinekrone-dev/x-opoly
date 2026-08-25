/**
 * Collaborator invitations.
 *
 * Registration on a claimed workspace is closed; an invite is the one door
 * back in. Each is a one-time link bound to an email address, because the
 * broker typed a colleague's address, not "whoever this gets forwarded to" —
 * redeeming with a different address fails.
 *
 * There is no outbound email here on purpose: the broker sends the link
 * themselves, through whatever channel they already talk to that person on.
 * That keeps the server free of SMTP credentials and the invite as easy to
 * hand over in a text message as in an email.
 */

import { hashToken, randomToken } from './crypto.js'
import { normalizeEmail } from './auth.js'
import { newId, nowIso } from './ids.js'

const INVITE_DAYS = 14

function mapInvite(row) {
  if (!row) return null
  return {
    id: row.id,
    email: row.email,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    used: Boolean(row.used_at),
  }
}

function isPast(iso) {
  return new Date(iso).getTime() < Date.now()
}

/**
 * Mints an invitation and returns the token exactly once.
 *
 * Re-inviting an address replaces the outstanding invite rather than
 * stacking a second working link for the same person.
 */
export async function createInvite(db, { email, createdBy }) {
  const normalized = normalizeEmail(email)
  if (!normalized || !normalized.includes('@')) {
    return { error: 'That does not look like an email address.' }
  }

  const existing = await db.get('SELECT id FROM users WHERE email = ?', [normalized])
  if (existing) return { error: 'That person already has an account here.' }

  await db.run('DELETE FROM invites WHERE email = ? AND used_at IS NULL', [normalized])

  const token = randomToken(24)
  const invite = {
    id: newId(),
    email: normalized,
    token_digest: await hashToken(token),
    created_by: createdBy ?? null,
    created_at: nowIso(),
    expires_at: new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000).toISOString(),
  }
  await db.run(
    `INSERT INTO invites (id, email, token_digest, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [invite.id, invite.email, invite.token_digest, invite.created_by, invite.created_at, invite.expires_at],
  )
  return { invite: mapInvite({ ...invite, used_at: null }), token }
}

/** Outstanding and recently-used invites, newest first, for the Share tab. */
export async function listInvites(db, teamId = null) {
  const rows = teamId
    ? await db.all(
        `SELECT * FROM invites WHERE created_by IN (SELECT id FROM users WHERE COALESCE(team_id, id) = ?)
         ORDER BY created_at DESC LIMIT 50`,
        [teamId],
      )
    : await db.all('SELECT * FROM invites ORDER BY created_at DESC LIMIT 50')
  return rows.map(mapInvite)
}

export async function revokeInvite(db, id) {
  const { changes } = await db.run('DELETE FROM invites WHERE id = ? AND used_at IS NULL', [id])
  return changes > 0
}

/**
 * Looks an invite up by its token, for the joining page.
 *
 * Answers with the email it is addressed to, so the form can show who this
 * invitation is for — and a reason when it can no longer be used, so the
 * person holding a dead link is told what happened rather than shown a form
 * that will fail after they fill it in.
 */
export async function checkInvite(db, token) {
  const row = await db.get('SELECT * FROM invites WHERE token_digest = ?', [
    await hashToken(String(token ?? '')),
  ])
  if (!row) return { ok: false, reason: 'not_found' }
  if (row.used_at) return { ok: false, reason: 'used' }
  if (isPast(row.expires_at)) return { ok: false, reason: 'expired' }
  return { ok: true, email: row.email }
}

/**
 * Burns an invite during registration.
 *
 * The email must match the invitation: the token opens the door only for the
 * person it was addressed to. Marked used rather than deleted, so the Share
 * tab can show that the colleague actually joined.
 */
export async function redeemInvite(db, token, email) {
  const row = await db.get('SELECT * FROM invites WHERE token_digest = ?', [
    await hashToken(String(token ?? '')),
  ])
  if (!row || row.used_at || isPast(row.expires_at)) {
    return { ok: false, error: 'That invitation is no longer valid. Ask for a new one.' }
  }
  if (normalizeEmail(email) !== row.email) {
    return { ok: false, error: `This invitation was sent to ${row.email}. Sign up with that address.` }
  }
  await db.run('UPDATE invites SET used_at = ? WHERE id = ?', [nowIso(), row.id])

  // The team the new account joins: the inviter's.
  const inviter = row.created_by
    ? await db.get('SELECT id, team_id FROM users WHERE id = ?', [row.created_by])
    : null
  return { ok: true, teamId: inviter ? inviter.team_id ?? inviter.id : null }
}
