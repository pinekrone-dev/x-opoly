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
 * A redirect URI Claude may be sent back to: https anywhere, or http on the
 * loopback address for a desktop client. Nothing else, so a registration
 * cannot point the approval at a page that would leak the code.
 */
function goodRedirect(uri) {
  try {
    const url = new URL(uri)
    if (url.hash) return false
    if (url.protocol === 'https:') return true
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}

export async function registerClient(db, body = {}) {
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : []
  if (!uris.length || uris.length > 10 || !uris.every(goodRedirect)) {
    return { error: 'invalid_redirect_uri', description: 'redirect_uris must be https URLs (or http on localhost).' }
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
  const row = await db.get('SELECT * FROM oauth_codes WHERE code_hash = ?', [hash])
  // Spent the moment it is presented, right or wrong: a code is never tried twice.
  if (row) await db.run('DELETE FROM oauth_codes WHERE code_hash = ?', [hash])
  if (!row || past(row.expires_at)) return { error: 'invalid_grant' }
  if (row.client_id !== clientId || row.redirect_uri !== redirectUri) return { error: 'invalid_grant' }
  if ((await s256(String(verifier))) !== row.challenge) return { error: 'invalid_grant' }
  return { tokens: await issueTokens(db, { clientId, userId: row.user_id, scope: row.scope }) }
}

/** A refresh token for a new pair; the old refresh token is spent. */
export async function refreshTokens(db, { refreshToken, clientId }) {
  if (!refreshToken || !clientId) return { error: 'invalid_request' }
  const hash = await hashToken(String(refreshToken))
  const row = await db.get("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'", [hash])
  if (!row || past(row.expires_at) || row.client_id !== clientId) return { error: 'invalid_grant' }
  await db.run('DELETE FROM oauth_tokens WHERE token_hash = ?', [hash])
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

/** Expired codes and tokens, swept with the daily usage sweep. */
export async function sweepOauth(db) {
  const now = new Date().toISOString()
  await db.run('DELETE FROM oauth_codes WHERE expires_at < ?', [now])
  await db.run('DELETE FROM oauth_tokens WHERE expires_at < ?', [now])
}
