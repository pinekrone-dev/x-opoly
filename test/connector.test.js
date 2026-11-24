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
let latest

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
    // Open registration, but the code can only travel to Claude or to the
    // person's own machine: a stranger's https callback calling itself
    // "Claude" is refused.
    const phish = await claude('/oauth/register', json({ client_name: 'Claude', redirect_uris: ['https://evil.example/cb'] }))
    assert.equal(phish.status, 400)
    const desktop = await claude('/oauth/register', json({ client_name: 'Claude Code', redirect_uris: ['http://localhost:33418/callback'] }))
    assert.equal(desktop.status, 201)
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
    assert.match(page.body, /sends you back to <strong>claude\.ai<\/strong>/)
    assert.doesNotMatch(page.body, /name="crm" value="1" checked/, 'the CRM is never pre-ticked')
    assert.equal(page.headers.get('x-frame-options'), 'DENY')

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

  test('the reads that travel as a POST are let through, since they change nothing', async () => {
    const auth = { authorization: `Bearer ${tokens.access_token}` }
    // Each is answered by its own route (whatever it says about this
    // market), not turned away at the door as a change.
    for (const path of ['/api/gis/zoning-report', '/api/gis/parcels/shapes', '/api/gis/map-image']) {
      const res = await claude(path, json({ market: 'austin-tx' }, auth))
      assert.notEqual(res.body?.code, 'connector_scope', path)
      assert.notEqual(res.status, 403, path)
    }
  })

  test('a refresh token is swapped for a new pair, once', async () => {
    const fresh = await claude('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId }))
    assert.equal(fresh.status, 200)
    assert.notEqual(fresh.body.access_token, tokens.access_token)
    const reused = await claude('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId }))
    assert.equal(reused.body.error, 'invalid_grant')
    const works = await claude('/mcp', json({ jsonrpc: '2.0', id: 9, method: 'ping' }, { authorization: `Bearer ${fresh.body.access_token}` }))
    assert.deepEqual(works.body.result, {})
    latest = fresh.body
  })

  test('a county the store does not hold says so, rather than failing blind', async () => {
    const res = await rpc('tools/call', { name: 'search_parcels', arguments: { market: 'charlotte-nc', assetTypes: ['Industrial'] } })
    assert.equal(res.body.result.isError, true)
    assert.match(res.body.result.content[0].text, /served from county files/)
  })

  test('a batch of more than twenty messages is refused whole', async () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' }))
    const res = await claude('/mcp', json(many, { authorization: `Bearer ${tokens.access_token}` }))
    assert.equal(res.status, 400)
  })

  test('a market that is not a slug is refused before it nears a path', async () => {
    const res = await rpc('tools/call', { name: 'market_layers', arguments: { market: '../secrets' } })
    assert.equal(res.body.result.isError, true)
  })

  test('the person sees the connection in Settings and can cut it off', async () => {
    const listed = await owner('/api/account/connections')
    assert.ok(listed.body.connections.some((c) => c.name === 'Claude'))
    const live = await claude('/mcp', json({ jsonrpc: '2.0', id: 1, method: 'ping' }, { authorization: `Bearer ${latest.access_token}` }))
    assert.equal(live.status, 200)
    const cut = await owner(`/api/account/connections/${encodeURIComponent(clientId)}`, { method: 'DELETE', headers: { 'sec-fetch-site': 'same-origin' } })
    assert.equal(cut.status, 204)
    forgetTokens()
    const dead = await claude('/mcp', json({ jsonrpc: '2.0', id: 2, method: 'ping' }, { authorization: `Bearer ${latest.access_token}` }))
    assert.equal(dead.status, 401)
  })

  test('a made-up token is not a session', async () => {
    const res = await claude('/api/crm/places', { headers: { authorization: 'Bearer lqt_nonsense' } })
    assert.equal(res.status, 401)
  })
})

describe('changes from another site', () => {
  const view = { market: 'austin-tx', name: 'Guarded', state: { v: 1 } }
  test('so is one from a sibling subdomain, which the Lax cookie would ride along on', async () => {
    const res = await owner('/api/gis/views', json(view, { 'sec-fetch-site': 'same-site' }))
    assert.equal(res.status, 403)
  })
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

describe('another assistant, allowed by its callback host', () => {
  test('only the named host and what sits under it', async () => {
    const { goodRedirect } = await import('../app/lib/oauth.js')
    const env = { CONNECTOR_REDIRECT_HOSTS: 'agent.meta.ai' }
    const muse = 'https://agent.meta.ai/api/hatch/oauth/callback'
    assert.equal(goodRedirect(muse, env), true)
    assert.equal(goodRedirect(muse, {}), false, 'refused until the host is named')
    // The rest of the company's domain is not let in with it, and neither
    // is a look-alike or the same host over plain http.
    assert.equal(goodRedirect('https://www.meta.ai/callback', env), false)
    assert.equal(goodRedirect('https://agent.meta.ai.evil.example/cb', env), false)
    assert.equal(goodRedirect('https://notagent.meta.ai/cb', env), false)
    assert.equal(goodRedirect('http://agent.meta.ai/api/hatch/oauth/callback', env), false)
    assert.equal(goodRedirect('https://claude.ai/api/mcp/auth_callback', env), true)
  })
})

describe('Grok, allowed by its one return address', () => {
  const GROK = 'https://grok.com/connectors-oauth-exchange-code/'
  const env = { CONNECTOR_REDIRECT_HOSTS: `agent.meta.ai,${GROK}` }

  test('that address and nothing else on grok.com', async () => {
    const { goodRedirect } = await import('../app/lib/oauth.js')
    assert.equal(goodRedirect(GROK, env), true)
    assert.equal(goodRedirect(GROK, {}), false, 'refused until the address is named')
    // The slash is part of it, and so is the absence of a query.
    assert.equal(goodRedirect('https://grok.com/connectors-oauth-exchange-code', env), false)
    assert.equal(goodRedirect(`${GROK}?next=https://evil.example`, env), false)
    assert.equal(goodRedirect('https://grok.com/share/abc', env), false)
    assert.equal(goodRedirect('https://grok.com/', env), false)
    assert.equal(goodRedirect('https://sub.grok.com/connectors-oauth-exchange-code/', env), false)
    assert.equal(goodRedirect('https://grok.com.evil.example/connectors-oauth-exchange-code/', env), false)
    assert.equal(goodRedirect('http://grok.com/connectors-oauth-exchange-code/', env), false)
    // The host entries beside it still work as hosts.
    assert.equal(goodRedirect('https://agent.meta.ai/api/hatch/oauth/callback', env), true)
    assert.equal(goodRedirect('https://claude.ai/api/mcp/auth_callback', env), true)
  })

  test('a registration that also lists callbacks not allowed here keeps only the allowed ones', async () => {
    const { registerClient, getClient } = await import('../app/lib/oauth.js')
    const rows = new Map()
    const db = {
      run: async (_sql, [id, name, uris]) => rows.set(id, { client_id: id, name, redirect_uris: uris }),
      get: async (_sql, [id]) => rows.get(id),
    }
    const made = await registerClient(db, { client_name: 'Grok', redirect_uris: ['cursor://anysphere.cursor-mcp/oauth/callback', GROK, 'https://evil.example/cb'] }, env)
    assert.deepEqual(made.client.redirect_uris, [GROK])
    assert.deepEqual((await getClient(db, made.client.client_id)).redirectUris, [GROK])
    // Grok registers as "Cursor", with Cursor's list: kept under a name the person knows.
    const AGENTS = 'https://www.cursor.com/agents/mcp/oauth/callback'
    const all = { CONNECTOR_REDIRECT_HOSTS: `${GROK},${AGENTS}` }
    const asCursor = await registerClient(db, { client_name: 'Cursor', redirect_uris: [AGENTS, 'https://www.cursor.com/bot/mcp/oauth/callback', GROK, 'http://localhost:8787/callback'] }, all)
    assert.deepEqual(asCursor.client.redirect_uris, [AGENTS, GROK, 'http://localhost:8787/callback'])
    assert.equal(asCursor.client.client_name, 'Grok / Cursor')
    const { namedAddress } = await import('../app/lib/oauth.js')
    assert.equal(namedAddress(AGENTS, all), true)
    assert.equal(namedAddress(`${AGENTS}?x=1`, all), false)
    assert.equal(namedAddress('https://www.cursor.com/bot/mcp/oauth/callback', all), false)
    assert.equal(namedAddress('http://localhost:8787/callback', all), false, 'this machine is not a named address')
    assert.equal(namedAddress('https://claude.ai/api/mcp/auth_callback', all), false, 'nor is a host entry')
    const none = await registerClient(db, { client_name: 'Grok', redirect_uris: ['https://evil.example/cb', 'cursor://x/y'] }, env)
    assert.equal(none.error, 'invalid_redirect_uri')
    const many = await registerClient(db, { client_name: 'Grok', redirect_uris: Array(11).fill(GROK) }, env)
    assert.equal(many.error, 'invalid_redirect_uri')
  })
})

describe('an application that names itself by the address of its description, as Grok does', () => {
  const GROK = 'https://grok.com/connectors-oauth-exchange-code/'
  const ADDRESS = 'https://cursor.com/oauth/mcp-client.json'
  // What Cursor publishes there, which Grok connects under.
  const DOCUMENT = {
    client_id: ADDRESS,
    client_name: 'Cursor',
    redirect_uris: ['https://www.cursor.com/agents/mcp/oauth/callback', 'https://www.cursor.com/bot/mcp/oauth/callback', GROK, 'http://localhost:8787/callback', 'http://127.0.0.1:8787/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }
  const answer = (doc, status = 200) => async () => new Response(JSON.stringify(doc), { status, headers: { 'content-type': 'application/json' } })
  const store = () => {
    const rows = new Map()
    return {
      rows,
      run: async (_sql, [id, name, uris]) => rows.set(id, { client_id: id, name, redirect_uris: uris }),
      get: async (_sql, [id]) => rows.get(id),
    }
  }
  const env = { CONNECTOR_REDIRECT_HOSTS: `agent.meta.ai,${GROK}` }

  test('only a public https address with a path is taken for one', async () => {
    const { metadataAddress } = await import('../app/lib/oauth.js')
    assert.equal(metadataAddress(ADDRESS), ADDRESS)
    for (const not of ['lqc_abc', 'http://cursor.com/x.json', 'https://cursor.com/', 'https://cursor.com/a/../b.json', 'https://10.0.0.1/x.json', 'https://localhost/x.json', 'https://box.internal/x.json', 'https://cursor.com/x.json?a=1', 'https://cursor.com/x.json#f', 'https://u:p@cursor.com/x.json', 'https://cursor.com:8443/x.json']) {
      assert.equal(metadataAddress(not), null, not)
    }
  })

  test('the description is read, and only the return addresses allowed here are kept', async () => {
    const { metadataClient, getClient, assistantName } = await import('../app/lib/oauth.js')
    const db = store()
    const made = await metadataClient(db, ADDRESS, env, answer(DOCUMENT))
    assert.deepEqual(made.redirectUris, [GROK, 'http://localhost:8787/callback', 'http://127.0.0.1:8787/callback'])
    assert.equal(made.name, 'Grok / Cursor')
    assert.deepEqual((await getClient(db, ADDRESS)).redirectUris, made.redirectUris)
    // The approval page names the assistant by where the approval goes.
    assert.equal(assistantName(GROK, 'Cursor'), 'Grok')
    assert.equal(assistantName('http://127.0.0.1:8787/callback', 'Cursor'), 'Cursor')
    // Grok's other return address, on Cursor's service: that path and no other there.
    const both = { CONNECTOR_REDIRECT_HOSTS: `${env.CONNECTOR_REDIRECT_HOSTS},https://www.cursor.com/bot/mcp/oauth/callback` }
    const wider = await metadataClient(store(), ADDRESS, both, answer(DOCUMENT))
    assert.deepEqual(wider.redirectUris, ['https://www.cursor.com/bot/mcp/oauth/callback', GROK, 'http://localhost:8787/callback', 'http://127.0.0.1:8787/callback'])
    assert.equal(assistantName('https://www.cursor.com/bot/mcp/oauth/callback', wider.name), 'Grok / Cursor')
    // Without Grok's address allowed, the same description is Cursor on this machine only.
    const plain = await metadataClient(store(), ADDRESS, {}, answer(DOCUMENT))
    assert.deepEqual(plain.redirectUris, ['http://localhost:8787/callback', 'http://127.0.0.1:8787/callback'])
    assert.equal(plain.name, 'Cursor')
  })

  test('a description that is not the one asked for is no client', async () => {
    const { metadataClient } = await import('../app/lib/oauth.js')
    const refuse = async (doc, status) => assert.equal(await metadataClient(store(), ADDRESS, env, answer(doc, status)), null)
    await refuse({ ...DOCUMENT, client_id: 'https://cursor.com/other.json' }, 200)
    await refuse(DOCUMENT, 404)
    await refuse(DOCUMENT, 302)
    await refuse({ ...DOCUMENT, redirect_uris: ['https://evil.example/cb'] }, 200)
    await refuse({ ...DOCUMENT, token_endpoint_auth_method: 'client_secret_post' }, 200)
    await refuse({ ...DOCUMENT, client_name: 'x'.repeat(30000) }, 200)
    assert.equal(await metadataClient(store(), ADDRESS, env, async () => { throw new Error('unreachable') }), null)
    assert.equal(await metadataClient(store(), 'https://10.0.0.1/x.json', env, answer(DOCUMENT)), null)
  })

  test('through the door: discovery says so, the approval page appears, and the tokens are issued to that address', async () => {
    const server = await claude('/.well-known/oauth-authorization-server')
    assert.equal(server.body.client_id_metadata_document_supported, true)

    const real = globalThis.fetch
    let fetched = 0
    globalThis.fetch = async (input, init) => {
      if (String(input?.url || input) !== ADDRESS) return real(input, init)
      fetched += 1
      return new Response(JSON.stringify(DOCUMENT), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    try {
      const back = 'http://127.0.0.1:8787/callback'
      const proof = b64url(randomBytes(32))
      const q = new URLSearchParams({ response_type: 'code', client_id: ADDRESS, redirect_uri: back, code_challenge: b64url(createHash('sha256').update(proof).digest()), code_challenge_method: 'S256', state: 's1' })
      const page = await owner(`/oauth/authorize?${q}`)
      assert.equal(page.status, 200)
      assert.match(page.body, /Connect Cursor to Land Quotient\?/)
      const decided = await owner('/oauth/authorize', form({ ...Object.fromEntries(q), decision: 'allow' }, { origin: 'http://localhost' }))
      assert.equal(decided.status, 302)
      assert.equal(fetched, 1, 'the description is read once, then kept')
      const code = new URL(decided.headers.get('location')).searchParams.get('code')
      const issued = await claude('/oauth/token', form({ grant_type: 'authorization_code', code, client_id: ADDRESS, redirect_uri: back, code_verifier: proof }))
      assert.equal(issued.status, 200)
      assert.match(issued.body.access_token, /^lqt_/)
      const again = await claude('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: issued.body.refresh_token, client_id: ADDRESS }))
      assert.equal(again.status, 200)
      const used = await claude('/mcp', json({ jsonrpc: '2.0', id: 1, method: 'ping' }, { authorization: `Bearer ${again.body.access_token}` }))
      assert.equal(used.status, 200)

      // A return address the description does not list is refused, and the
      // page says what was asked so it can be passed on.
      q.set('redirect_uri', 'http://127.0.0.1:9999/other')
      const refused = await owner(`/oauth/authorize?${q}`)
      assert.equal(refused.status, 400)
      assert.match(refused.body, /Application: https:\/\/cursor\.com\/oauth\/mcp-client\.json/)
      assert.match(refused.body, /Return address: http:\/\/127\.0\.0\.1:9999\/other/)
    } finally {
      globalThis.fetch = real
    }
    const unknown = await owner('/oauth/authorize?client_id=lqc_nobody&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb&response_type=code')
    assert.equal(unknown.status, 400)
    assert.match(unknown.body, /is not registered here/)
    assert.match(unknown.body, /Application: lqc_nobody/)
  })
})


describe('ChatGPT, allowed by its fixed return address and its folder of numbered ones', () => {
  const FIXED = 'https://chatgpt.com/connector_platform_oauth_redirect'
  const env = { CONNECTOR_REDIRECT_HOSTS: `agent.meta.ai,${FIXED},https://chatgpt.com/connector/oauth/*` }

  test('those addresses and nothing else on chatgpt.com', async () => {
    const { goodRedirect, namedAddress } = await import('../app/lib/oauth.js')
    assert.equal(goodRedirect(FIXED, env), true)
    assert.equal(goodRedirect(FIXED, {}), false, 'refused until the address is named')
    // The numbered form: one id below the folder, and only an id.
    assert.equal(goodRedirect('https://chatgpt.com/connector/oauth/abc123_XYZ-9', env), true)
    assert.equal(namedAddress('https://chatgpt.com/connector/oauth/abc123_XYZ-9', env), true)
    assert.equal(goodRedirect('https://chatgpt.com/connector/oauth/', env), false, 'the folder itself is not an address')
    assert.equal(goodRedirect('https://chatgpt.com/connector/oauth/a/b', env), false)
    assert.equal(goodRedirect('https://chatgpt.com/connector/oauth/a?next=https://evil.example', env), false)
    assert.equal(goodRedirect('https://chatgpt.com/connector/oauth/..%2Fshare', env), false)
    // The rest of the site is where anyone can publish a page.
    assert.equal(goodRedirect('https://chatgpt.com/share/abc', env), false)
    assert.equal(goodRedirect('https://chatgpt.com/', env), false)
    assert.equal(goodRedirect('https://chatgpt.com/connector/other/abc', env), false)
    assert.equal(goodRedirect('https://chatgpt.com.evil.example/connector_platform_oauth_redirect', env), false)
    assert.equal(goodRedirect('http://chatgpt.com/connector_platform_oauth_redirect', env), false)
    // A folder entry never opens a whole site.
    assert.equal(goodRedirect('https://evil.example/anything', { CONNECTOR_REDIRECT_HOSTS: 'https://evil.example/*' }), false)
    // And the others beside it are untouched.
    assert.equal(goodRedirect('https://claude.ai/api/mcp/auth_callback', env), true)
    assert.equal(goodRedirect('https://agent.meta.ai/api/hatch/oauth/callback', env), true)
  })

  test('its published description is taken though it prefers a signed token request, since it also offers none', async () => {
    const { metadataClient } = await import('../app/lib/oauth.js')
    const ADDRESS = 'https://chatgpt.com/oauth/mcp-client.json'
    const rows = new Map()
    const db = {
      run: async (_sql, [id, name, uris]) => rows.set(id, { client_id: id, name, redirect_uris: uris }),
      get: async (_sql, [id]) => rows.get(id),
    }
    const doc = {
      client_id: ADDRESS,
      client_name: 'ChatGPT',
      redirect_uris: [FIXED, 'https://chatgpt.com/share/not-a-callback'],
      token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
      token_endpoint_auth_method: 'private_key_jwt',
    }
    const answer = (body) => async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    const kept = await metadataClient(db, ADDRESS, env, answer(doc))
    assert.deepEqual(kept, { id: ADDRESS, name: 'ChatGPT', redirectUris: [FIXED] })
    // One that can only sign its requests is not a client this server can serve.
    assert.equal(await metadataClient(db, ADDRESS, env, answer({ ...doc, token_endpoint_auth_methods_supported: ['private_key_jwt'] })), null)
    // The older single field still decides when the list is absent.
    assert.equal(await metadataClient(db, ADDRESS, env, answer({ ...doc, token_endpoint_auth_methods_supported: undefined })), null)
  })

  test('through the door: it registers, the person approves, and every answer names this server as its issuer', async () => {
    const server = await createServer({ DATA_DIR: temp.directory, DB_FILE: `${temp.directory}/chatgpt.db`, CONNECTOR_REDIRECT_HOSTS: env.CONNECTOR_REDIRECT_HOSTS })
    const visitor = () => {
      let cookie = null
      return async (path, init = {}) => {
        const response = await server.fetch(new Request(`http://localhost${path}`, { redirect: 'manual', ...init, headers: { ...(cookie ? { cookie } : {}), ...(init.headers || {}) } }))
        const set = response.headers.get('set-cookie')
        if (set) cookie = set.split(';')[0]
        const text = await response.text()
        let body = text
        try { body = text ? JSON.parse(text) : null } catch { /* a page */ }
        return { status: response.status, body, headers: response.headers }
      }
    }
    const person = visitor()
    const chatgpt = visitor()
    await person('/api/auth/register', json({ name: 'Kevin', email: 'kevin@example.com', password: 'a long enough password' }))

    // What ChatGPT checks before it will use its fixed address.
    const meta = await chatgpt('/.well-known/oauth-authorization-server')
    assert.equal(meta.body.authorization_response_iss_parameter_supported, true)
    assert.deepEqual(meta.body.code_challenge_methods_supported, ['S256'])
    const resource = await chatgpt('/.well-known/oauth-protected-resource/mcp')
    assert.deepEqual(resource.body.authorization_servers, [meta.body.issuer], 'the issuer is written the same in both places')

    const made = await chatgpt('/oauth/register', json({ client_name: 'ChatGPT', redirect_uris: [FIXED], token_endpoint_auth_method: 'none' }))
    assert.equal(made.status, 201)
    assert.deepEqual(made.body.redirect_uris, [FIXED])

    const proof = b64url(randomBytes(32))
    const q = new URLSearchParams({ response_type: 'code', client_id: made.body.client_id, redirect_uri: FIXED, code_challenge: b64url(createHash('sha256').update(proof).digest()), code_challenge_method: 'S256', state: 'st-1', resource: 'http://localhost/mcp' })
    const page = await person(`/oauth/authorize?${q}`)
    assert.equal(page.status, 200)
    assert.match(page.body, /Connect ChatGPT to Land Quotient\?/)

    // A refusal carries the issuer too.
    const refused = await person('/oauth/authorize', form({ ...Object.fromEntries(q), decision: 'deny' }, { origin: 'http://localhost' }))
    const no = new URL(refused.headers.get('location'))
    assert.equal(no.origin + no.pathname, FIXED)
    assert.equal(no.searchParams.get('error'), 'access_denied')
    assert.equal(no.searchParams.get('iss'), meta.body.issuer)

    const decided = await person('/oauth/authorize', form({ ...Object.fromEntries(q), decision: 'allow' }, { origin: 'http://localhost' }))
    assert.equal(decided.status, 302)
    const yes = new URL(decided.headers.get('location'))
    assert.equal(yes.origin + yes.pathname, FIXED)
    assert.equal(yes.searchParams.get('state'), 'st-1')
    assert.equal(yes.searchParams.get('iss'), meta.body.issuer, 'exactly the issuer published, not a near spelling of it')

    const issued = await chatgpt('/oauth/token', form({ grant_type: 'authorization_code', code: yes.searchParams.get('code'), client_id: made.body.client_id, redirect_uri: FIXED, code_verifier: proof, resource: 'http://localhost/mcp' }))
    assert.equal(issued.status, 200)
    assert.match(issued.body.access_token, /^lqt_/)

    // Unsigned, the connector says where to sign in; signed, it lists tools that each say they need it.
    const cold = await chatgpt('/mcp', json({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
    assert.equal(cold.status, 401)
    assert.match(cold.headers.get('www-authenticate'), /resource_metadata="http:\/\/localhost\/\.well-known\/oauth-protected-resource/)
    const listed = await chatgpt('/mcp', json({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { authorization: `Bearer ${issued.body.access_token}` }))
    assert.equal(listed.status, 200)
    const tools = listed.body.result.tools
    assert.ok(tools.length > 0)
    for (const tool of tools) {
      assert.deepEqual(tool.securitySchemes, [{ type: 'oauth2', scopes: ['read'] }], tool.name)
      assert.deepEqual(tool._meta.securitySchemes, tool.securitySchemes, tool.name)
      assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', `${tool.name} says whether it only reads`)
    }
  })
})
