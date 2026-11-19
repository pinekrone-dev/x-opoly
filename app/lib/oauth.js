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
 * can only ever travel to an assistant named here or to the computer the
 * person is sitting at.
 *
 * CONNECTOR_REDIRECT_HOSTS adds another trusted client, one entry each,
 * comma-separated. A bare host ("agent.meta.ai") allows that host and what
 * sits under it. An entry that starts with https:// is one return address
 * and nothing else on its site: for an assistant whose callback lives on
 * the same host as everything else it serves (Grok, on grok.com).
 */
const CALLBACK_HOSTS = ['claude.ai', 'claude.com']

const extraEntries = (env = {}) =>
  String(env.CONNECTOR_REDIRECT_HOSTS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

export function redirectHosts(env = {}) {
  const extra = extraEntries(env)
    .filter((entry) => !entry.includes('://'))
    .map((host) => host.toLowerCase())
  return [...CALLBACK_HOSTS, ...extra]
}

/** The return addresses allowed whole: origin and path as written, no query. */
export function redirectAddresses(env = {}) {
  const out = []
  for (const entry of extraEntries(env)) {
    if (!entry.startsWith('https://')) continue
    try {
      const url = new URL(entry)
      if (!url.search && !url.hash && !url.username && !url.password) out.push(url.origin + url.pathname)
    } catch {
      // An entry that is not an address allows nothing.
    }
  }
  return out
}

export function goodRedirect(uri, env = {}) {
  try {
    const url = new URL(uri)
    if (url.hash || url.username || url.password) return false
    if (url.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (url.protocol !== 'https:') return false
    const host = url.hostname.toLowerCase()
    if (redirectHosts(env).some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) return true
    // A trailing slash is part of the address: Grok's has one.
    return !url.search && redirectAddresses(env).includes(url.origin + url.pathname)
  } catch {
    return false
  }
}

export async function registerClient(db, body = {}, env = {}) {
  const asked = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : []
  // Some assistants register with a list that also names other clients'
  // callbacks. The ones allowed here are kept and the rest are left out, so
  // an approval still has nowhere else to go; a list with none is refused.
  const uris = asked.length <= 10 ? asked.filter((uri) => goodRedirect(uri, env)) : []
  if (!uris.length) {
    return { error: 'invalid_redirect_uri', description: "redirect_uris must be the callback of an assistant this connector allows, or http on localhost." }
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

/*
 * An application that names itself by an address instead of registering: the
 * client_id is the https address of a short JSON description it publishes (a
 * client ID metadata document), and that description lists where approvals
 * may be sent. Grok connects this way, under the description Cursor
 * publishes for both. The description is read from that address, checked to
 * name itself, and kept beside the registered clients, so codes, tokens and
 * the Connected apps list treat it as any other.
 *
 * It widens nothing: registration was already open to anyone, and an
 * approval still only travels to an address goodRedirect allows.
 */
export function metadataAddress(clientId) {
  const text = String(clientId || '')
  if (text.length > 300 || !text.startsWith('https://')) return null
  try {
    const url = new URL(text)
    if (url.username || url.password || url.hash || url.search || url.port) return null
    // As written, with a path: no dot segments, and not a site's front page.
    if (url.href !== text || url.pathname === '/') return null
    const host = url.hostname.toLowerCase()
    // A public name only: nothing on this machine or a private network.
    if (!host.includes('.') || /^[\d.]+$/.test(host) || host.startsWith('[')) return null
    if (host === 'localhost' || /\.(local|internal|localhost|lan|home|corp)$/.test(host)) return null
    return text
  } catch {
    return null
  }
}

const METADATA_BYTES = 20000

/** The body of a response, up to a limit: more than that is not a client description. */
async function readCapped(res, limit) {
  if (Number(res.headers.get('content-length') || 0) > limit) return null
  if (!res.body || !res.body.getReader) {
    const text = await res.text()
    return text.length > limit ? null : text
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

// One description serves several assistants; the one an approval is going to
// is named by where it goes.
const NAMED_BY_HOST = { 'grok.com': 'Grok' }
const namedBy = (uri) => {
  try {
    return NAMED_BY_HOST[new URL(uri).hostname.toLowerCase()] || null
  } catch {
    return null
  }
}

/** What to call the application on the approval page. */
export function assistantName(redirectUri, clientName) {
  return namedBy(redirectUri) || clientName
}

/** Reads a client's published description and keeps it; null when there is none to trust. */
export async function metadataClient(db, clientId, env = {}, fetcher = fetch) {
  const address = metadataAddress(clientId)
  if (!address) return null
  let doc
  try {
    // Not followed anywhere else: the description is at its address or it is nowhere.
    const res = await fetcher(address, { headers: { accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(5000) })
    if (res.status !== 200) return null
    const text = await readCapped(res, METADATA_BYTES)
    if (!text) return null
    doc = JSON.parse(text)
  } catch {
    return null
  }
  if (!doc || typeof doc !== 'object' || doc.client_id !== address) return null
  // Public clients only, as with registration.
  if (doc.token_endpoint_auth_method && doc.token_endpoint_auth_method !== 'none') return null
  const asked = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.slice(0, 50).map(String) : []
  const uris = asked.filter((uri) => goodRedirect(uri, env))
  if (!uris.length) return null
  const own = String(doc.client_name || 'An application').slice(0, 100)
  const others = [...new Set(uris.map(namedBy).filter((name) => name && name !== own))]
  const name = [...others, own].join(' / ').slice(0, 100)
  const stored = JSON.stringify(uris)
  const known = await db.get('SELECT name, redirect_uris FROM oauth_clients WHERE client_id = ?', [address])
  if (!known || known.name !== name || known.redirect_uris !== stored) {
    await db.run(
      `INSERT INTO oauth_clients (client_id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(client_id) DO UPDATE SET name = excluded.name, redirect_uris = excluded.redirect_uris`,
      [address, name, stored, new Date().toISOString()],
    )
  }
  return { id: address, name, redirectUris: uris }
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
