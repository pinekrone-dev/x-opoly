/**
 * Sign in with Land Quotient and the Claude connector: the OAuth dance as
 * Claude performs it, then the tools, then what a token may not do.
 */
import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'
import { createHash, randomBytes } from 'node:crypto'

import { resetRateLimits } from '../app/lib/ratelimit.js'
import { forgetTokens } from '../app/lib/oauth.js'
import { createServer } from '../server/index.js'
import { useTempData } from './helpers.js'

const temp = useTempData()
let app

function client() {
  let cookie = null
  return async (path, init = {}) => {
    const response = await app.fetch(
      new Request(`http://localhost${path}`, {
        redirect: 'manual',
        ...init,
        headers: { ...(cookie ? { cookie } : {}), ...(init.headers || {}) },
      }),
    )
    const set = response.headers.get('set-cookie')
    if (set) cookie = set.split(';')[0]
    const text = await response.text()
    let body = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }
    return { status: response.status, body, headers: response.headers }
  }
}

const json = (payload, headers = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(payload),
})
const form = (payload, headers = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams(payload).toString(),
})
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback'
let owner
let claude
let clientId
let verifier
let tokens

before(async () => {
  resetRateLimits()
  forgetTokens()
  app = await createServer({ DATA_DIR: temp.directory, DB_FILE: `${temp.directory}/test.db` })
  owner = client()
  claude = client()
  await owner('/api/auth/register', json({ name: 'Kevin', email: 'kevin@example.com', password: 'a long enough password' }))
})

after(() => temp.cleanup())

describe('discovery', () => {
  test('the connector says where to sign in', async () => {
    const refused = await claude('/mcp', json({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))
    assert.equal(refused.status, 401)
    assert.match(refused.headers.get('www-authenticate'), /resource_metadata="http:\/\/localhost\/\.well-known\/oauth-protected-resource"/)
    const resource = await claude('/.well-known/oauth-protected-resource')
    assert.equal(resource.body.resource, 'http://localhost/mcp')
    assert.deepEqual(resource.body.authorization_servers, ['http://localhost'])
    const server = await claude('/.well-known/oauth-authorization-server')
    assert.equal(server.body.token_endpoint, 'http://localhost/oauth/token')
    assert.deepEqual(server.body.code_challenge_methods_supported, ['S256'])
  })

  test('a client registers itself, with https return addresses only', async () => {
    const bad = await claude('/oauth/register', json({ client_name: 'X', redirect_uris: ['http://evil.example/cb'] }))
    assert.equal(bad.status, 400)
    const made = await claude('/oauth/register', json({ client_name: 'Claude', redirect_uris: [REDIRECT] }))
    assert.equal(made.status, 201)
    assert.equal(made.body.token_endpoint_auth_method, 'none')
    clientId = made.body.client_id
  })
})

describe('approving', () => {
  const authorize = () => {
    verifier = b64url(randomBytes(32))
    const challenge = b64url(createHash('sha256').update(verifier).digest())
    return new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
      scope: 'read maps',
    })
  }

  test('signed out, the person is sent to sign in and back', async () => {
    const q = authorize()
    const res = await claude(`/oauth/authorize?${q}`)
    assert.equal(res.status, 302)
    const next = new URL(res.headers.get('location'), 'http://localhost').searchParams.get('next')
    assert.equal(next, `/oauth/authorize?${q}`)
  })

  test('a return address the client did not register is refused outright', async () => {
    const q = authorize()
    q.set('redirect_uri', 'https://evil.example/cb')
    const res = await owner(`/oauth/authorize?${q}`)
    assert.equal(res.status, 400)
  })

  test('signed in, the person sees what they are allowing, approves, and Claude gets tokens', async () => {
    const q = authorize()
    const page = await owner(`/oauth/authorize?${q}`)
    assert.equal(page.status, 200)
    assert.match(page.body, /Connect Claude to Land Quotient\?/)
    assert.match(page.body, /kevin@example\.com/)

    const decided = await owner('/oauth/authorize', form({ ...Object.fromEntries(q), decision: 'allow' }, { origin: 'http://localhost' }))
    assert.equal(decided.status, 302)
    const back = new URL(decided.headers.get('location'))
    assert.equal(back.origin + back.pathname, REDIRECT)
    assert.equal(back.searchParams.get('state'), 'xyz')
    const code = back.searchParams.get('code')
    assert.ok(code)

    const wrong = await claude('/oauth/token', form({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: 'not-it' }))
    assert.equal(wrong.body.error, 'invalid_grant', 'a wrong verifier is refused')
    const again = await claude('/oauth/token', form({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier }))
    assert.equal(again.body.error, 'invalid_grant', 'and the code is spent by the attempt')

    // A fresh approval, exchanged properly.
    const q2 = authorize()
    const ok = await owner('/oauth/authorize', form({ ...Object.fromEntries(q2), decision: 'allow' }, { origin: 'http://localhost' }))
    const code2 = new URL(ok.headers.get('location')).searchParams.get('code')
    const issued = await claude('/oauth/token', form({ grant_type: 'authorization_code', code: code2, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier }))
    assert.equal(issued.status, 200)
    assert.match(issued.body.access_token, /^lqt_/)
    assert.equal(issued.body.scope, 'read maps', 'no CRM unless the box was ticked')
    tokens = issued.body
  })

  test('cancelling sends Claude back with access_denied', async () => {
    const q = authorize()
    const res = await owner('/oauth/authorize', form({ ...Object.fromEntries(q), decision: 'deny' }, { origin: 'http://localhost' }))
    assert.equal(new URL(res.headers.get('location')).searchParams.get('error'), 'access_denied')
  })

  test('a decision posted from another site is refused', async () => {
    const q = authorize()
    const res = await owner('/oauth/authorize', form({ ...Object.fromEntries(q), decision: 'allow' }, { origin: 'https://evil.example' }))
    assert.equal(res.status, 403)
  })
})

describe('the connector', () => {
  const rpc = (method, params, id = 1) =>
    claude('/mcp', json({ jsonrpc: '2.0', id, method, params }, { authorization: `Bearer ${tokens.access_token}` }))

  test('it introduces itself and lists its tools', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } })
    assert.equal(init.body.result.protocolVersion, '2025-06-18')
    assert.equal(init.body.result.serverInfo.name, 'land-quotient')
    const note = await claude('/mcp', json({ jsonrpc: '2.0', method: 'notifications/initialized' }, { authorization: `Bearer ${tokens.access_token}` }))
    assert.equal(note.status, 202)
    const list = await rpc('tools/list', {})
    const names = list.body.result.tools.map((t) => t.name)
    for (const name of ['list_markets', 'search_parcels', 'get_parcel', 'market_layers', 'geocode', 'make_map', 'add_to_crm']) {
      assert.ok(names.includes(name), name)
    }
  })

  test('make_map saves a map and links to it, criteria and circle included', async () => {
    const made = await rpc('tools/call', {
      name: 'make_map',
      arguments: {
        market: 'austin-tx',
        name: 'Industrial by the grid',
        layers: ['transmission'],
        assetTypes: ['Industrial'],
        acresMin: 5,
        near: [{ layer: 'substations', miles: 1 }],
        circle: { lat: 30.27, lng: -97.74, miles: 3 },
      },
    })
    assert.equal(made.body.result.isError, undefined, JSON.stringify(made.body))
    const link = new URL(made.body.result.structuredContent.link)
    assert.equal(link.pathname, '/gis/austin-tx')
    const id = link.searchParams.get('view')
    const views = await owner('/api/gis/views?market=austin-tx')
    const view = views.body.views.find((v) => String(v.id) === id)
    assert.ok(view, 'saved in the workspace')
    assert.equal(view.state.layerOn.transmission, true)
    assert.deepEqual(view.state.circle, { lat: 30.27, lng: -97.74, miles: 3 })
    assert.deepEqual(view.state.near, [{ layer: 'substations', miles: 1 }])
    assert.deepEqual(view.state.acres, { min: '5', max: '' })
  })

  test('without the CRM box ticked, it reads the CRM but cannot change it', async () => {
    const crm = await rpc('tools/call', { name: 'add_to_crm', arguments: { market: 'austin-tx', id: '1' } })
    assert.equal(crm.body.result.isError, true)
    const auth = { authorization: `Bearer ${tokens.access_token}` }
    assert.equal((await claude('/api/crm/places', { headers: auth })).status, 200, 'reading is allowed')
    const write = await claude('/api/crm/places', json({ name: 'X' }, auth))
    assert.equal(write.status, 403)
    assert.equal(write.body.code, 'connector_scope')
    const other = await claude('/api/account/settings', json({ defaultMarket: 'austin-tx' }, auth))
    assert.equal(other.status, 403, 'nor anything else')
  })

  test('a refresh token is swapped for a new pair, once', async () => {
    const fresh = await claude('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId }))
    assert.equal(fresh.status, 200)
    assert.notEqual(fresh.body.access_token, tokens.access_token)
    const reused = await claude('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId }))
    assert.equal(reused.body.error, 'invalid_grant')
    const works = await claude('/mcp', json({ jsonrpc: '2.0', id: 9, method: 'ping' }, { authorization: `Bearer ${fresh.body.access_token}` }))
    assert.deepEqual(works.body.result, {})
  })

  test('a county the store does not hold says so, rather than failing blind', async () => {
    const res = await rpc('tools/call', { name: 'search_parcels', arguments: { market: 'charlotte-nc', assetTypes: ['Industrial'] } })
    assert.equal(res.body.result.isError, true)
    assert.match(res.body.result.content[0].text, /served from county files/)
  })

  test('a made-up token is not a session', async () => {
    const res = await claude('/api/crm/places', { headers: { authorization: 'Bearer lqt_nonsense' } })
    assert.equal(res.status, 401)
  })
})

describe('changes from another site', () => {
  const view = { market: 'austin-tx', name: 'Guarded', state: { v: 1 } }
  test('a cookie-borne change marked cross-site by the browser is refused', async () => {
    const res = await owner('/api/gis/views', json(view, { 'sec-fetch-site': 'cross-site' }))
    assert.equal(res.status, 403)
    assert.equal(res.body.code, 'cross_site')
  })
  test('and one from another origin, from a browser that sends no Sec-Fetch-Site', async () => {
    const res = await owner('/api/gis/views', json(view, { origin: 'https://evil.example' }))
    assert.equal(res.status, 403)
  })
  test('the app itself is unaffected', async () => {
    assert.equal((await owner('/api/gis/views', json(view, { 'sec-fetch-site': 'same-origin' }))).status, 201)
    assert.equal((await owner('/api/gis/views', json(view, { origin: 'http://localhost' }))).status, 201)
  })
})
