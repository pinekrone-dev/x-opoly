/**
 * Sign in with Land Quotient: the OAuth 2.1 server behind the Claude
 * connector.
 *
 * Claude registers itself (dynamic client registration, RFC 7591), sends the
 * person here to sign in and approve, and gets back a short-lived access
 * token it presents on every call to /mcp. The token stands for that person
 * and nothing more: the same workspace, the same daily allowances, read-only
 * unless they ticked the CRM box when they approved.
 *
 * Kept in the main database beside the sessions, because it is the same kind
 * of record and the volume is tiny: a row when a client registers, one when
 * someone approves, one per token refresh. Every secret is stored as its
 * digest only, like the session tokens; the raw value exists once, in the
 * response that hands it over.
 *
 * Public clients only (no client secret, PKCE with S256 required), which is
 * what OAuth 2.1 asks of an app that cannot keep a secret and what Claude
 * sends.
 */
import { hashToken, randomToken } from './crypto.js'
import { getUser } from './auth.js'

export const ACCESS_TTL_S = 60 * 60
const REFRESH_TTL_S = 30 * 24 * 60 * 60
const CODE_TTL_S = 10 * 60

/** What a token may do. `read` and `maps` are always granted; `crm` is asked for. */
export const SCOPES = ['read', 'maps', 'crm']
export const DEFAULT_SCOPE = 'read maps'

const iso = (secondsFromNow) => new Date(Date.now() + secondsFromNow * 1000).toISOString()
const past = (when) => !when || Date.parse(when) <= Date.now()

/** A scope string reduced to the scopes this server knows, in order. */
export function readScope(value, { withCrm = false } = {}) {
  const asked = new Set(String(value || '').split(/\s+/).filter(Boolean))
  const out = ['read', 'maps']
  if (withCrm || asked.has('crm')) out.push('crm')
  return out.join(' ')
}

/*
 * Where an approval may be sent: Claude's own callback, on the hosts Claude
 * runs on, or the person's own machine (a desktop or command-line client
 * listening on the loopback address). Registration is open, as connectors
 * require, so this list is what stops a stranger registering "Claude" with
 * a callback of their own and phishing an approval out of someone: the code
 * can only ever travel to Claude or to the computer the person is sitting
 * at. CONNECTOR_REDIRECT_HOSTS adds hosts for another trusted client.
 */
const CALLBACK_HOSTS = ['claude.ai', 'claude.com']

export function redirectHosts(env = {}) {
  const extra = String(env.CONNECTOR_REDIRECT_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
  return [...CALLBACK_HOSTS, ...extra]
}

export function goodRedirect(uri, env = {}) {
  try {
    const url = new URL(uri)
    if (url.hash || url.username || url.password) return false
    if (url.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (url.protocol !== 'https:') return false
    const host = url.hostname.toLowerCase()
    return redirectHosts(env).some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
  } catch {
    return false
  }
}

export async function registerClient(db, body = {}, env = {}) {
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : []
  if (!uris.length || uris.length > 10 || !uris.every((uri) => goodRedirect(uri, env))) {
    return { error: 'invalid_redirect_uri', description: "redirect_uris must be Claude's callback, or http on localhost." }
  }
  const name = String(body.client_name || 'An application').slice(0, 100)
  const id = `lqc_${randomToken(16)}`
  await db.run('INSERT INTO oauth_clients (client_id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)', [
    id,
    name,
    JSON.stringify(uris),
    new Date().toISOString(),
  ])
  return {
    client: {
      client_id: id,
      client_name: name,
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      client_id_issued_at: Math.floor(Date.now() / 1000),
    },
  }
}

export async function getClient(db, clientId) {
  if (!clientId) return null
  const row = await db.get('SELECT client_id, name, redirect_uris FROM oauth_clients WHERE client_id = ?', [String(clientId)])
  if (!row) return null
  let uris = []
  try {
    uris = JSON.parse(row.redirect_uris)
  } catch {
    uris = []
  }
  return { id: row.client_id, name: row.name, redirectUris: uris }
}

/** The approval, as a one-time code bound to the client, the URI and the PKCE challenge. */
export async function createCode(db, { clientId, userId, redirectUri, challenge, scope }) {
  const code = `lqa_${randomToken(24)}`
  await db.run(
    `INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, challenge, scope, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [await hashToken(code), clientId, userId, redirectUri, challenge, scope, iso(CODE_TTL_S)],
  )
  return code
}

async function s256(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  let text = ''
  for (const byte of new Uint8Array(digest)) text += String.fromCharCode(byte)
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function issueTokens(db, { clientId, userId, scope }) {
  const access = `lqt_${randomToken(32)}`
  const refresh = `lqr_${randomToken(32)}`
  const now = new Date().toISOString()
  await db.batch([
    [
      'INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, scope, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [await hashToken(access), 'access', clientId, userId, scope, iso(ACCESS_TTL_S), now],
    ],
    [
      'INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, scope, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [await hashToken(refresh), 'refresh', clientId, userId, scope, iso(REFRESH_TTL_S), now],
    ],
  ])
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope }
}

/** A code for tokens: single use, same client, same redirect, PKCE verified. */
export async function exchangeCode(db, { code, clientId, redirectUri, verifier }) {
  if (!code || !clientId || !verifier) return { error: 'invalid_request' }
  const hash = await hashToken(String(code))
  // Spent the moment it is presented, right or wrong, in one statement: two
  // presentations at once cannot both find it.
  const row = await db.get('DELETE FROM oauth_codes WHERE code_hash = ? RETURNING *', [hash])
  if (!row || past(row.expires_at)) return { error: 'invalid_grant' }
  if (row.client_id !== clientId || row.redirect_uri !== redirectUri) return { error: 'invalid_grant' }
  if ((await s256(String(verifier))) !== row.challenge) return { error: 'invalid_grant' }
  return { tokens: await issueTokens(db, { clientId, userId: row.user_id, scope: row.scope }) }
}

/** A refresh token for a new pair; the old refresh token is spent. */
export async function refreshTokens(db, { refreshToken, clientId }) {
  if (!refreshToken || !clientId) return { error: 'invalid_request' }
  const hash = await hashToken(String(refreshToken))
  const row = await db.get("DELETE FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh' RETURNING *", [hash])
  if (!row || past(row.expires_at) || row.client_id !== clientId) return { error: 'invalid_grant' }
  return { tokens: await issueTokens(db, { clientId, userId: row.user_id, scope: row.scope }) }
}

/*
 * Who an access token belongs to, remembered for a minute per isolate the
 * way sessions are: Claude makes several calls a question, and each would
 * otherwise read the token and the user.
 */
const held = new Map()
export function forgetTokens() {
  held.clear()
}

export async function tokenUser(db, token) {
  if (!token || !String(token).startsWith('lqt_')) return null
  const hash = await hashToken(String(token))
  const cached = held.get(hash)
  if (cached && cached.until > Date.now()) return cached.value
  const row = await db.get("SELECT user_id, scope, expires_at FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'", [hash])
  if (!row || past(row.expires_at)) return null
  const user = await getUser(db, row.user_id)
  if (!user) return null
  const value = { user, scope: String(row.scope || DEFAULT_SCOPE).split(' ') }
  if (held.size > 500) held.delete(held.keys().next().value)
  held.set(hash, { value, until: Math.min(Date.now() + 60 * 1000, Date.parse(row.expires_at)) })
  return value
}

/** RFC 7009: a client gives up a token it holds. Unknown tokens are not an error. */
export async function revokeToken(db, token) {
  if (!token) return
  const hash = await hashToken(String(token))
  held.delete(hash)
  await db.run('DELETE FROM oauth_tokens WHERE token_hash = ?', [hash])
}

/** The applications a person has connected, one row per application. */
export async function listConnections(db, userId) {
  const rows = await db.all(
    `SELECT t.client_id, c.name, MAX(t.scope) AS scope, MIN(t.created_at) AS since, MAX(t.created_at) AS last
       FROM oauth_tokens t LEFT JOIN oauth_clients c ON c.client_id = t.client_id
      WHERE t.user_id = ? AND t.expires_at > ?
      GROUP BY t.client_id, c.name ORDER BY last DESC`,
    [userId, new Date().toISOString()],
  )
  return rows.map((r) => ({ clientId: r.client_id, name: r.name || 'An application', scope: String(r.scope || '').split(' '), since: r.since, lastUsed: r.last }))
}

/** Disconnects one application (or every one), effective at once. */
export async function disconnect(db, userId, clientId = null) {
  held.clear()
  if (clientId) await db.run('DELETE FROM oauth_tokens WHERE user_id = ? AND client_id = ?', [userId, clientId])
  else await db.run('DELETE FROM oauth_tokens WHERE user_id = ?', [userId])
}

/** Expired codes and tokens, swept with the daily usage sweep. */
export async function sweepOauth(db) {
  const now = new Date().toISOString()
  await db.run('DELETE FROM oauth_codes WHERE expires_at < ?', [now])
  await db.run('DELETE FROM oauth_tokens WHERE expires_at < ?', [now])
}
