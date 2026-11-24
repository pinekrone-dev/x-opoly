/**
 * The connector in code mode: two tools where there were twenty.
 *
 * A connector that lists every operation as its own tool spends the
 * assistant's attention on the list: each name, description and argument is
 * read on every turn whether it is used or not, and a question that needs
 * six steps is six round trips with every intermediate answer read in full.
 * Code mode (Cloudflare, "Code Mode: give agents an entire API in 1,000
 * tokens") turns that round: the assistant is told about two tools,
 *
 *   search   finds operations and hands back each one's call signature
 *   execute  runs a short script the assistant writes, in which
 *            `lq.<operation>(input)` calls an operation
 *
 * and the script chains calls, loops, filters and returns only what the
 * question needs. The operations are the same ones the classic connector
 * lists (mcp.js TOOLS), run by the same code as the same signed-in person,
 * so every allowance, scope and refusal holds exactly as before.
 *
 * Where the script runs. Never in this process: it runs in a Dynamic Worker,
 * an isolate started for the one script, with no network (fetch and connect
 * throw), no bindings, no file system and no environment. Its only way out
 * is `lq`, which calls back here. The executor is handed in (worker/index.js
 * builds Cloudflare's own from the LOADER binding); a deployment without one
 * serves the classic tools instead, and nothing here ever evaluates a script
 * itself.
 *
 * What it costs. Cloudflare counts each script run as a Dynamic Worker: a
 * thousand a month come with the plan and each one past that is billed. So
 * runs are counted in a ledger by calendar month (UTC) and refused past
 * CODE_RUNS_PER_MONTH, nine hundred unless set, with the classic connector
 * named as the way to carry on. `search` runs no script and costs nothing.
 */

export const DEFAULT_RUNS = 900
export const MAX_CALLS = 40
export const MAX_RESULT_CHARS = 100_000
export const MAX_CODE_CHARS = 20_000
export const RUN_TIMEOUT_MS = 45_000

export const CODE_TOOLS = [
  {
    name: 'search',
    title: 'Find operations',
    description:
      'Finds Land Quotient operations and returns each one\'s call signature for use in execute. Give words for what you want ("crime near a site", "screen parcels for slope and flood"), or the names of operations to read in full. With neither, lists every operation in a line each.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words describing what you want to do.' },
        operations: { type: 'array', items: { type: 'string' }, description: 'Operation names to read in full, e.g. ["find_sites", "site_pieces"].' },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'execute',
    title: 'Run a script',
    description:
      'Runs JavaScript against Land Quotient. Write one async arrow function. Inside it, `await lq.<operation>(input)` calls an operation from search and resolves to its result object; it throws with the reason when the operation refuses. Chain calls, loop, filter, and return only what you need: whatever the function returns is the answer. console.log lines come back too. No network or files; at most 40 calls and 45 seconds a run. Example: async () => { const m = await lq.list_markets({}); return m.markets.filter((x) => x.searchable).map((x) => x.slug) }',
    inputSchema: {
      type: 'object',
      properties: { code: { type: 'string', description: 'An async arrow function, as JavaScript source.' } },
      required: ['code'],
    },
    // A script may save a map or file a parcel on a list, so it is not
    // read-only; it deletes nothing, and reaches nothing outside Land Quotient.
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
]

export const CODE_INSTRUCTIONS = `Land Quotient is a parcel map of US counties: every lot with its county record (owner, mailing address, values, land use, acreage, sale) plus layers such as zoning, permits, flood, power lines and fuel tanks, and site work on top: buildability screens, reported crime, retail and landmarks nearby, maps and map images, client lists.

It has two tools. Call search first to find the operations for the task and read their signatures. Then call execute with a short script: \`await lq.<operation>(input)\` calls one, and a script can chain several, loop over parcels and return just the answer. Start a task with lq.list_markets to get the county slug (for example austin-tx). When unsure of a result's shape, return Object.keys(result) once and then write the real script.

Figures are the county's own. An assessed value is a tax figure, not an appraisal. California counties publish no owner names. A screen from public maps is not a survey. Offer a map link (lq.make_map) when a result is easier to see than to read, and keep each figure's source with it.`

const oneLine = (text, max = 220) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** A JSON Schema as the TypeScript a script writer reads: names, types, what is optional, and what each is for. */
export function typeOf(schema, indent = '') {
  if (!schema || typeof schema !== 'object') return 'unknown'
  if (Array.isArray(schema.enum)) return schema.enum.map((v) => JSON.stringify(v)).join(' | ')
  for (const key of ['oneOf', 'anyOf']) {
    if (Array.isArray(schema[key])) return schema[key].map((s) => typeOf(s, indent)).join(' | ')
  }
  if (Array.isArray(schema.type)) return schema.type.map((type) => typeOf({ ...schema, type }, indent)).join(' | ')
  switch (schema.type) {
    case 'string':
      return 'string'
    case 'number':
    case 'integer':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'null':
      return 'null'
    case 'array': {
      const item = typeOf(schema.items, indent)
      return /[|\s]/.test(item) && !item.startsWith('{') ? `(${item})[]` : `${item}[]`
    }
    case 'object':
    default: {
      const properties = schema.properties && typeof schema.properties === 'object' ? Object.entries(schema.properties) : []
      if (!properties.length) return schema.type === 'object' ? '{}' : 'unknown'
      const required = new Set(Array.isArray(schema.required) ? schema.required : [])
      const inner = `${indent}  `
      const lines = properties.map(([name, property]) => {
        const key = /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name)
        const note = property?.description ? ` // ${oneLine(property.description)}` : ''
        return `${inner}${key}${required.has(name) ? '' : '?'}: ${typeOf(property, inner)}${note}`
      })
      return `{\n${lines.join('\n')}\n${indent}}`
    }
  }
}

/** One operation as search hands it back. */
export function describeOperation(tool) {
  return {
    name: tool.name,
    does: tool.description,
    writes: !tool.annotations?.readOnlyHint,
    signature: `lq.${tool.name}(input: ${typeOf(tool.inputSchema)}): Promise<object>`,
  }
}

const wordsOf = (text) =>
  String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2)
    .map((word) => (word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word))

/**
 * What search answers: the named operations in full, else the best matches
 * for the words in full, else every operation in a line.
 */
export function searchOperations(tools, { query = '', operations = [] } = {}) {
  const index = () => tools.map((tool) => ({ name: tool.name, does: oneLine(tool.description, 140) }))
  const named = (Array.isArray(operations) ? operations : [operations]).map((name) => String(name ?? '').replace(/^lq\./, '').trim()).filter(Boolean)
  if (named.length) {
    const found = named.map((name) => tools.find((tool) => tool.name === name)).filter(Boolean)
    const unknown = named.filter((name) => !tools.some((tool) => tool.name === name))
    return {
      operations: found.map(describeOperation),
      ...(unknown.length ? { unknown, every: index() } : {}),
      use: 'Call these inside execute as await lq.<name>(input).',
    }
  }
  const asked = [...new Set(wordsOf(query))]
  if (!asked.length) return { every: index(), use: 'Call search again with words or with operations: [names] to read the signatures, then execute.' }
  const scored = tools
    .map((tool) => {
      const name = wordsOf(tool.name)
      const title = wordsOf(tool.title)
      const text = wordsOf(tool.description)
      const fields = wordsOf(Object.keys(tool.inputSchema?.properties ?? {}).join(' '))
      const score = asked.reduce((sum, word) => sum + (name.includes(word) ? 4 : 0) + (title.includes(word) ? 2 : 0) + (text.includes(word) ? 1 : 0) + (fields.includes(word) ? 1 : 0), 0)
      return { tool, score }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
  if (!scored.length) return { operations: [], every: index(), use: 'Nothing matched those words. Pick from every, then search with operations: [names].' }
  const best = scored.slice(0, 5)
  return {
    operations: best.map((entry) => describeOperation(entry.tool)),
    others: scored.slice(5).map((entry) => entry.tool.name),
    use: 'Call these inside execute as await lq.<name>(input). list_markets gives the market slug most of them need.',
  }
}

/* -------------------------------------------------------------------------- */
/* The month's runs                                                            */
/* -------------------------------------------------------------------------- */

export const monthOf = (now = Date.now()) => new Date(now).toISOString().slice(0, 7)

export function runsCap(env = {}) {
  const n = Number(env.CODE_RUNS_PER_MONTH)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_RUNS
}

export async function runsSpent(db, month = monthOf()) {
  const row = await db.get('SELECT runs FROM code_run_ledger WHERE month = ?', [month])
  return Number(row?.runs ?? 0)
}

/** One more run this month. The ledger costs one written row a run. */
export async function chargeRun(db, month = monthOf()) {
  await db.run(
    `INSERT INTO code_run_ledger (month, runs, updated_at) VALUES (?, 1, ?)
     ON CONFLICT(month) DO UPDATE SET runs = runs + 1, updated_at = excluded.updated_at`,
    [month, new Date().toISOString()],
  )
}

/* -------------------------------------------------------------------------- */
/* Running a script                                                            */
/* -------------------------------------------------------------------------- */

const textOf = (out) => (out?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n')

/**
 * Runs one script.
 *
 * `tools` are the operations and `run(name, input)` runs one as the signed-in
 * person, answering in the classic connector's shape. `executor` is the
 * sandbox: execute(code, [{ name, fns }]) resolving to { result, error?, logs? }.
 * Answers in the connector's shape too: the returned value as JSON, the log
 * lines, and up to two images the operations drew along the way.
 */
export async function runScript(code, { tools, run, executor, maxCalls = MAX_CALLS }) {
  const failure = (message) => ({ content: [{ type: 'text', text: message }], isError: true })
  const source = String(code ?? '').trim()
  if (!source) return failure('code is required: an async arrow function, as JavaScript source.')
  if (source.length > MAX_CODE_CHARS) return failure(`The script is ${source.length.toLocaleString('en-US')} characters; the most a run takes is ${MAX_CODE_CHARS.toLocaleString('en-US')}.`)

  let calls = 0
  const images = []
  const fns = {}
  for (const tool of tools) {
    fns[tool.name] = async (input = {}) => {
      calls += 1
      if (calls > maxCalls) throw new Error(`A script may make ${maxCalls} calls; this one asked for more. Narrow the list first, or finish in a second run.`)
      if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error(`lq.${tool.name} takes one object: lq.${tool.name}({ ... }).`)
      const out = await run(tool.name, input)
      if (!out) throw new Error(`lq.${tool.name} is not an operation.`)
      if (out.isError) throw new Error(textOf(out) || `lq.${tool.name} failed.`)
      for (const part of out.content ?? []) {
        if (part.type === 'image' && images.length < 2) images.push(part)
      }
      if (out.structuredContent !== undefined) return out.structuredContent
      const said = textOf(out)
      try {
        return JSON.parse(said)
      } catch {
        return said
      }
    }
  }

  let outcome
  try {
    outcome = await executor.execute(source, [{ name: 'lq', fns }])
  } catch (cause) {
    return failure(`The script could not be run: ${oneLine(cause?.message || cause, 300)}`)
  }
  const logs = (Array.isArray(outcome?.logs) ? outcome.logs : []).slice(0, 100).map((line) => oneLine(line, 500))
  if (outcome?.error) {
    return failure([`The script failed: ${oneLine(outcome.error, 600)}`, ...(logs.length ? ['Log:', ...logs] : []), `Calls made: ${calls}.`].join('\n'))
  }

  let body
  try {
    body = JSON.stringify(outcome?.result === undefined ? null : outcome.result)
  } catch {
    return failure('The script returned something that is not JSON (a function, a cycle). Return plain objects, arrays, strings and numbers.')
  }
  if (body.length > MAX_RESULT_CHARS) {
    return failure(`The script returned ${body.length.toLocaleString('en-US')} characters, past the ${MAX_RESULT_CHARS.toLocaleString('en-US')} a run may hand back. Return fewer rows or fewer fields (map each row to the keys you need).`)
  }
  const answer = { result: outcome?.result === undefined ? null : outcome.result, calls, ...(logs.length ? { logs } : {}) }
  return { content: [{ type: 'text', text: JSON.stringify(answer) }, ...images], structuredContent: answer }
}
