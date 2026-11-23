/**
 * The connector in code mode: two tools, search and execute, over the same
 * operations; what a script can and cannot do; and the month's allowance.
 */
import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'
import { createHash, randomBytes } from 'node:crypto'
import zlib from 'node:zlib'

import { CODE_INSTRUCTIONS, CODE_TOOLS, MAX_CALLS, MAX_RESULT_CHARS, describeOperation, runScript, runsCap, searchOperations, typeOf } from '../app/lib/codemode.js'
import { TOOLS } from '../app/lib/mcp.js'
import { forgetTokens } from '../app/lib/oauth.js'
import { resetRateLimits } from '../app/lib/ratelimit.js'
import { createServer } from '../server/index.js'
import { useTempData } from './helpers.js'
import { vmExecutor } from './vm-executor.js'

describe('what the assistant is told', () => {
  test('two tools and a short note, a fraction of the list they replace', () => {
    assert.deepEqual(CODE_TOOLS.map((tool) => tool.name), ['search', 'execute'])
    const now = JSON.stringify(CODE_TOOLS).length + CODE_INSTRUCTIONS.length
    const before = JSON.stringify(TOOLS).length
    // About four characters a token: under a thousand tokens, whatever the list grows to.
    assert.ok(now < 4000, `code mode is ${now} characters`)
    assert.ok(before > now * 8, `the list was ${before} characters`)
    assert.deepEqual(CODE_TOOLS[1].inputSchema.required, ['code'])
  })

  test('a schema reads as the TypeScript a script is written against', () => {
    assert.equal(
      typeOf({
        type: 'object',
        required: ['market'],
        properties: {
          market: { type: 'string', description: 'Market slug\n  from list_markets.' },
          acresMin: { type: 'number' },
          kind: { type: 'string', enum: ['land', 'office'] },
          ids: { type: 'array', items: { type: 'string' } },
          center: { type: 'object', properties: { lat: { type: 'number' }, lng: { type: 'number' } }, required: ['lat', 'lng'] },
          'odd-name': { type: 'boolean' },
          either: { type: ['string', 'number'] },
        },
      }),
      '{\n  market: string // Market slug from list_markets.\n  acresMin?: number\n  kind?: "land" | "office"\n  ids?: string[]\n  center?: {\n    lat: number\n    lng: number\n  }\n  "odd-name"?: boolean\n  either?: string | number\n}',
    )
    assert.equal(typeOf({ type: 'object', properties: {} }), '{}')
    assert.equal(typeOf({ type: 'array', items: { enum: ['a', 'b'] } }), '("a" | "b")[]')
    assert.equal(typeOf(null), 'unknown')
  })

  test('every operation has a signature a script can call', () => {
    for (const tool of TOOLS) {
      const op = describeOperation(tool)
      assert.match(op.signature, new RegExp(`^lq\\.${tool.name}\\(input: [\\s\\S]+\\): Promise<object>$`), tool.name)
      assert.doesNotMatch(op.signature, /unknown/, `${tool.name} has an argument with no type`)
    }
    // The sandbox renames a method that is a JavaScript reserved word (lq.double
    // would not be found), so no operation may be named one.
    const reserved = new Set('abstract arguments await boolean break byte case catch char class const continue debugger default delete do double else enum eval export extends false final finally float for function goto if implements import in instanceof int interface let long native new null package private protected public return short static super switch synchronized this throw throws transient true try typeof var void volatile while with yield'.split(' '))
    for (const tool of TOOLS) {
      assert.match(tool.name, /^[a-z][a-z0-9_]*$/, tool.name)
      assert.equal(reserved.has(tool.name), false, `${tool.name} is a reserved word`)
    }
    assert.equal(describeOperation(TOOLS.find((t) => t.name === 'add_to_list')).writes, true)
    assert.equal(describeOperation(TOOLS.find((t) => t.name === 'search_parcels')).writes, false)
  })
})

describe('search', () => {
  test('with nothing asked, every operation in a line', () => {
    const out = searchOperations(TOOLS, {})
    assert.equal(out.every.length, TOOLS.length)
    assert.ok(out.every.every((op) => op.does.length <= 140))
    assert.equal(out.operations, undefined)
  })

  test('words find the operations for a task, the best first, with their signatures', () => {
    const crime = searchOperations(TOOLS, { query: 'crime near a site' })
    assert.equal(crime.operations[0].name, 'nearby_crime')
    assert.match(crime.operations[0].signature, /lq\.nearby_crime\(input: \{\n {2}market: string/)
    assert.ok(crime.operations.length <= 5)
    assert.equal(searchOperations(TOOLS, { query: 'screen parcels for slope and flood' }).operations.some((op) => op.name === 'site_feasibility'), true)
    assert.equal(searchOperations(TOOLS, { query: 'retail chains nearby' }).operations[0].name, 'nearby_retail')
    const nothing = searchOperations(TOOLS, { query: 'xylophone' })
    assert.deepEqual(nothing.operations, [])
    assert.equal(nothing.every.length, TOOLS.length)
  })

  test('named operations are read in full, and a name that is not one is said', () => {
    const out = searchOperations(TOOLS, { operations: ['find_sites', 'lq.site_pieces', 'no_such'] })
    assert.deepEqual(out.operations.map((op) => op.name), ['find_sites', 'site_pieces'])
    assert.deepEqual(out.unknown, ['no_such'])
    assert.match(out.operations[0].does, /Search a market for parcels/)
  })
})

describe('a script', () => {
  const tools = [
    { name: 'double', description: 'Twice a number.', inputSchema: { type: 'object', properties: { n: { type: 'number' } } } },
    { name: 'draw', description: 'A picture.', inputSchema: { type: 'object', properties: {} } },
    { name: 'refuse', description: 'Always refuses.', inputSchema: { type: 'object', properties: {} } },
    { name: 'words', description: 'Plain words.', inputSchema: { type: 'object', properties: {} } },
  ]
  const asked = []
  const run = async (name, input) => {
    asked.push([name, input])
    if (name === 'double') return { content: [{ type: 'text', text: '{}' }], structuredContent: { value: input.n * 2 } }
    if (name === 'draw') return { content: [{ type: 'text', text: '{"ok":true}' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }], structuredContent: { ok: true } }
    if (name === 'refuse') return { content: [{ type: 'text', text: 'That market is not published.' }], isError: true }
    return { content: [{ type: 'text', text: 'just words' }] }
  }
  const go = (code, extra = {}) => runScript(code, { tools, run, executor: vmExecutor(), ...extra })

  test('chains calls and hands back only what it returns', async () => {
    const out = await go('async () => { const a = await lq.double({ n: 4 }); const b = await lq.double({ n: a.value }); console.log("halfway", a.value); return { total: b.value } }')
    assert.equal(out.isError, undefined)
    assert.deepEqual(out.structuredContent, { result: { total: 16 }, calls: 2, logs: ['halfway 8'] })
    assert.deepEqual(JSON.parse(out.content[0].text), out.structuredContent)
  })

  test('runs calls side by side, and a plain-words answer comes back as words', async () => {
    const out = await go('async () => { const all = await Promise.all([1, 2, 3].map((n) => lq.double({ n }))); return [all.map((x) => x.value), await lq.words({})] }')
    assert.deepEqual(out.structuredContent.result, [[2, 4, 6], 'just words'])
    assert.equal(out.structuredContent.calls, 4)
  })

  test('a refusal throws inside the script with its reason, and can be caught', async () => {
    const failed = await go('async () => { await lq.refuse({}); return 1 }')
    assert.equal(failed.isError, true)
    assert.match(failed.content[0].text, /The script failed: That market is not published\.\nCalls made: 1\./)
    const caught = await go('async () => { try { await lq.refuse({}) } catch (e) { return { why: e.message } } }')
    assert.deepEqual(caught.structuredContent.result, { why: 'That market is not published.' })
  })

  test('pictures the operations drew come back beside the answer, two at most', async () => {
    const out = await go('async () => { await lq.draw({}); await lq.draw({}); await lq.draw({}); return "drawn" }')
    assert.deepEqual(out.content.map((part) => part.type), ['text', 'image', 'image'])
  })

  test('a script is held to its limits', async () => {
    const many = await go(`async () => { for (let i = 0; i < ${MAX_CALLS + 1}; i += 1) await lq.double({ n: i }); return "done" }`)
    assert.equal(many.isError, true)
    assert.match(many.content[0].text, new RegExp(`A script may make ${MAX_CALLS} calls`))
    const big = await go(`async () => "x".repeat(${MAX_RESULT_CHARS + 10})`)
    assert.match(big.content[0].text, /Return fewer rows or fewer fields/)
    assert.match((await go('async () => lq.double(4)')).content[0].text, /takes one object/)
    assert.match((await go('async () => lq.nothing({})')).content[0].text, /not found/)
    assert.match((await go('   ')).content[0].text, /code is required/)
    assert.match((await go(`async () => ${'1+'.repeat(12000)}1`)).content[0].text, /the most a run takes is 20,000/)
    assert.match((await go('async () => { throw new Error("boom") }')).content[0].text, /The script failed: boom/)
    assert.equal((await go('async () => undefined')).structuredContent.result, null)
  })

  test('it has no way out but lq', async () => {
    for (const reach of ['fetch("https://example.com")', 'process.env', 'require("fs")', 'globalThis.Deno']) {
      const out = await go(`async () => { const got = ${reach}; return typeof got === "undefined" ? "nothing" : "something" }`)
      assert.ok(out.isError || out.structuredContent.result === 'nothing', reach)
    }
  })

  test('a sandbox that will not start is said, not thrown', async () => {
    const out = await go('async () => 1', { executor: { execute: async () => { throw new Error('loader unavailable') } } })
    assert.equal(out.isError, true)
    assert.match(out.content[0].text, /could not be run: loader unavailable/)
  })

  test('the allowance is nine hundred runs unless set', () => {
    assert.equal(runsCap({}), 900)
    assert.equal(runsCap({ CODE_RUNS_PER_MONTH: '50' }), 50)
    assert.equal(runsCap({ CODE_RUNS_PER_MONTH: '0' }), 0)
    assert.equal(runsCap({ CODE_RUNS_PER_MONTH: 'lots' }), 900)
  })
})

describe('the connector, in code mode', () => {
  const temp = useTempData()
  const plain = useTempData()
  const realFetch = globalThis.fetch
  const executor = vmExecutor()
  let app
  let bare
  let token
  let bareToken
  const record = { id: 7, ad: '7 Ridge Rd', ow: 'Vance Holdings', mv: 900000, ac: 9.9, at: 'Land', bb: [-121.5, 38.5, -121.49, 38.51] }
  const blob = zlib.gzipSync(Buffer.from(JSON.stringify({ 7: record })))
  const FILES = {
    'sacramento-ca/rows.json': Buffer.from(JSON.stringify({ v: 1, n: 1, per: 300, shards: 1, offsets: [0, blob.length], built: 1700000000 })),
    'sacramento-ca/rows.pack': blob,
  }
  const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const REDIRECT = 'https://claude.ai/api/mcp/auth_callback'

  // Sign up, register a client, approve it, and trade the code for a token: what Claude does.
  const connect = async (server, email) => {
    let cookie = null
    const call = async (path, init = {}) => {
      const response = await server.fetch(new Request(`http://localhost${path}`, { redirect: 'manual', ...init, headers: { ...(cookie ? { cookie } : {}), ...(init.headers || {}) } }))
      const set = response.headers.get('set-cookie')
      if (set) cookie = set.split(';')[0]
      const text = await response.text()
      let body = null
      try { body = text ? JSON.parse(text) : null } catch { body = text }
      return { status: response.status, body, headers: response.headers }
    }
    const json = (payload) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    const form = (payload, headers = {}) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(payload).toString() })
    await call('/api/auth/register', json({ name: 'C', email, password: 'a long enough password' }))
    const made = await call('/oauth/register', json({ client_name: 'Claude', redirect_uris: [REDIRECT] }))
    const verifier = b64url(randomBytes(32))
    const q = { response_type: 'code', client_id: made.body.client_id, redirect_uri: REDIRECT, code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', state: 's', scope: 'read maps' }
    const decided = await call('/oauth/authorize', form({ ...q, decision: 'allow' }, { origin: 'http://localhost' }))
    const code = new URL(decided.headers.get('location')).searchParams.get('code')
    const issued = await call('/oauth/token', form({ grant_type: 'authorization_code', code, client_id: made.body.client_id, redirect_uri: REDIRECT, code_verifier: verifier }))
    assert.match(issued.body.access_token, /^lqt_/)
    return issued.body.access_token
  }
  const rpc = async (server, bearer, method, params, path = '/mcp') => {
    const response = await server.fetch(new Request(`http://localhost${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }))
    return (await response.json()).result
  }
  const execute = (code) => rpc(app, token, 'tools/call', { name: 'execute', arguments: { code } })

  before(async () => {
    resetRateLimits()
    forgetTokens()
    globalThis.fetch = async (url, init) => {
      const file = FILES[String(url).replace('https://catalogue.test/', '')]
      if (!file) return new Response('not found', { status: 404 })
      const range = /^bytes=(\d+)-(\d+)$/.exec(init?.headers?.range ?? '')
      return range ? new Response(file.subarray(Number(range[1]), Number(range[2]) + 1), { status: 206 }) : new Response(file, { status: 200 })
    }
    app = await createServer({
      DATA_DIR: temp.directory, DB_FILE: `${temp.directory}/test.db`, PARCEL_CATALOG_ORIGIN: 'https://catalogue.test',
      CODE_EXECUTOR: executor, CODE_RUNS_PER_MONTH: '4',
    })
    bare = await createServer({ DATA_DIR: plain.directory, DB_FILE: `${plain.directory}/test.db` })
    token = await connect(app, 'code@example.com')
    bareToken = await connect(bare, 'bare@example.com')
  })
  after(async () => {
    globalThis.fetch = realFetch
    await temp.cleanup()
    await plain.cleanup()
  })

  test('it introduces itself with two tools', async () => {
    const hello = await rpc(app, token, 'initialize', { protocolVersion: '2025-06-18' })
    assert.equal(hello.serverInfo.version, '2.0.0')
    assert.match(hello.instructions, /Call search first/)
    const list = await rpc(app, token, 'tools/list', {})
    assert.deepEqual(list.tools.map((tool) => tool.name), ['search', 'execute'])
    const health = await (await app.fetch(new Request('http://localhost/api/health'))).json()
    assert.equal(health.features.codeMode, true)
  })

  test('search answers without a script being run', async () => {
    const found = await rpc(app, token, 'tools/call', { name: 'search', arguments: { query: 'read one parcel record' } })
    assert.ok(found.structuredContent.operations.some((op) => op.name === 'get_parcel'))
    assert.equal(executor.runs.length, 0)
  })

  test('a script reads a parcel as the signed-in person and returns what it picks out', async () => {
    const out = await execute('async () => { const got = await lq.get_parcel({ market: "sacramento-ca", id: "7" }); const p = got.parcel ?? got; return { keys: Object.keys(got), owner: JSON.stringify(got).includes("Vance Holdings") } }')
    assert.equal(out.isError, undefined, out.content[0].text)
    assert.equal(out.structuredContent.result.owner, true)
    assert.equal(out.structuredContent.calls, 1)
    assert.equal(executor.runs.length, 1)
  })

  test('an operation\'s refusal reaches the script in its own words', async () => {
    const out = await execute('async () => lq.get_parcel({ market: "Not A Slug", id: "7" })')
    assert.equal(out.isError, true)
    assert.match(out.content[0].text, /market must be a slug from list_markets/)
  })

  test('an operation called by its old name still answers, for an assistant holding the old list', async () => {
    const out = await rpc(app, token, 'tools/call', { name: 'get_parcel', arguments: { market: 'sacramento-ca', id: '7' } })
    assert.equal(out.isError, undefined, out.content[0].text)
    assert.match(JSON.stringify(out.structuredContent), /Vance Holdings/)
  })

  test('past the month\'s allowance a run is refused and the classic address is named; search still answers', async () => {
    assert.equal((await execute('async () => 3')).structuredContent.result, 3)
    assert.equal((await execute('async () => 4')).structuredContent.result, 4)
    const refused = await execute('async () => 5')
    assert.equal(refused.isError, true)
    assert.match(refused.content[0].text, /This month's 4 script runs are used\..*http:\/\/localhost\/mcp\/classic.*on the 1st/)
    assert.equal(executor.runs.length, 4, 'the refused run never reached the sandbox')
    const found = await rpc(app, token, 'tools/call', { name: 'search', arguments: {} })
    assert.equal(found.structuredContent.every.length, TOOLS.length)
  })

  test('the classic address lists every tool, and says so to an assistant finding its way in', async () => {
    const hello = await rpc(app, token, 'initialize', {}, '/mcp/classic')
    assert.equal(hello.serverInfo.version, '1.0.0')
    const list = await rpc(app, token, 'tools/list', {}, '/mcp/classic')
    assert.equal(list.tools.length, TOOLS.length)
    assert.ok(list.tools.some((tool) => tool.name === 'search_parcels'))
    const out = await rpc(app, token, 'tools/call', { name: 'get_parcel', arguments: { market: 'sacramento-ca', id: '7' } }, '/mcp/classic')
    assert.match(JSON.stringify(out.structuredContent), /Vance Holdings/)
    const doc = await (await app.fetch(new Request('http://localhost/.well-known/oauth-protected-resource/mcp/classic'))).json()
    assert.equal(doc.resource, 'http://localhost/mcp/classic')
    assert.equal((await (await app.fetch(new Request('http://localhost/.well-known/oauth-protected-resource/mcp'))).json()).resource, 'http://localhost/mcp')
    const turnedAway = await app.fetch(new Request('http://localhost/mcp/classic', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))
    assert.equal(turnedAway.status, 401)
    assert.match(turnedAway.headers.get('www-authenticate'), /oauth-protected-resource\/mcp\/classic"/)
  })

  test('a deployment with no sandbox lists its tools the old way, and runs no script', async () => {
    const list = await rpc(bare, bareToken, 'tools/list', {})
    assert.equal(list.tools.length, TOOLS.length)
    assert.equal((await rpc(bare, bareToken, 'initialize', {})).serverInfo.version, '1.0.0')
    const response = await bare.fetch(new Request('http://localhost/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bareToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'execute', arguments: { code: 'async () => 1' } } }),
    }))
    assert.match((await response.json()).error.message, /Unknown tool: execute/)
    const health = await (await bare.fetch(new Request('http://localhost/api/health'))).json()
    assert.equal(health.features.codeMode, false)
  })
})
