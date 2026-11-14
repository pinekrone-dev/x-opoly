/**
 * Ask the zoning code: a city's own published zoning rules, indexed in
 * Cloudflare AI Search, read back as what a district allows and what the
 * most intensive use of a lot under it would be.
 *
 * The text comes from the pipeline. It reads the rules from the city's own
 * publication on a runner, a page at a time, bundles an article's pages in
 * `<market>/zoning-code-<folder>.md` in the catalogue bucket, and lists
 * every page in `<market>/zoning-code.json` with its title, page number and
 * address. `indexCode` loads each page into the market's AI Search instance
 * as `<folder>/<key>.md`; nothing is crawled from here. The list also says
 * which folder governs which districts (`routes`), so a district is asked
 * about in its own article and not across the whole code.
 *
 * Two things keep an answer honest. The model is given only passages the
 * search retrieved and asked to copy, beside every figure, the words that
 * state it; a figure whose words are not in the retrieved passages is
 * marked "check", and one whose number appears nowhere in them is dropped.
 * And nothing here is an appraisal: the lot arithmetic multiplies a quoted
 * standard by the county's lot size and says it is an estimate.
 *
 * Cost is capped twice. AI Search includes a thousand searches a month, so
 * a ledger refuses the search that would pass MONTHLY_CAP; and a district's
 * brief is stored once it has been read, so a hundred lots in one district
 * cost one search between them.
 */

/** The AI Search instance that holds one market's code. */
export const instanceId = (market) => `zoning-${market}`

/** Searches a month, all markets together, under the thousand included. */
export const MONTHLY_CAP = 800

/** Free-form questions one workspace may ask in a day. */
export const DAILY_QUESTIONS = 25

/** The standards a brief may report, and the unit each is read in. */
export const STANDARDS = {
  height_ft: { label: 'Maximum height', unit: 'ft' },
  stories: { label: 'Maximum stories', unit: 'stories' },
  far: { label: 'Maximum floor area ratio', unit: '% of lot area' },
  lot_coverage_pct: { label: 'Maximum lot coverage', unit: '%' },
  open_area_pct: { label: 'Minimum open area', unit: '%' },
  min_lot_area_sf: { label: 'Minimum lot area', unit: 'sq ft' },
  min_lot_width_ft: { label: 'Minimum lot width', unit: 'ft' },
  lot_area_per_unit_sf: { label: 'Lot area per dwelling unit', unit: 'sq ft' },
  units_per_acre: { label: 'Maximum density', unit: 'units per acre' },
  front_setback_ft: { label: 'Front yard', unit: 'ft' },
  side_setback_ft: { label: 'Side yard', unit: 'ft' },
  rear_setback_ft: { label: 'Rear yard', unit: 'ft' },
}

const monthOf = (now = Date.now()) => new Date(now).toISOString().slice(0, 7)

/** Whether this deployment has AI Search bound at all. */
export const codeSearchBound = (env) => Boolean(env?.AI_SEARCH && typeof env.AI_SEARCH.get === 'function')

export async function searchesThisMonth(db, now = Date.now()) {
  const row = await db.get('SELECT count FROM code_search_ledger WHERE month = ?', [monthOf(now)])
  return Number(row?.count ?? 0)
}

/** Counts one search and says whether it was inside the month's cap. */
export async function chargeSearch(db, env, now = Date.now()) {
  const cap = Number(env?.CODE_SEARCH_MONTHLY_CAP) > 0 ? Math.floor(Number(env.CODE_SEARCH_MONTHLY_CAP)) : MONTHLY_CAP
  const used = await searchesThisMonth(db, now)
  if (used >= cap) return { allowed: false, used, cap }
  await db.run(
    `INSERT INTO code_search_ledger (month, count, updated_at) VALUES (?, 1, ?)
     ON CONFLICT(month) DO UPDATE SET count = count + 1, updated_at = excluded.updated_at`,
    [monthOf(now), new Date(now).toISOString()],
  )
  return { allowed: true, used: used + 1, cap }
}

/** Lower case, one space between words, typographic marks flattened. */
export const squash = (text) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()

/** The first JSON object in a model's reply, or null. */
export function readJson(text) {
  const body = String(text ?? '')
  const start = body.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let quoted = false
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i]
    if (quoted) {
      if (ch === '\\') i += 1
      else if (ch === '"') quoted = false
    } else if (ch === '"') quoted = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        try { return JSON.parse(body.slice(start, i + 1)) } catch { return null }
      }
    }
  }
  return null
}

/** Whether a number is written somewhere in the passages. */
function numberIn(value, haystack) {
  const n = Number(value)
  if (!Number.isFinite(n)) return false
  const plain = String(n)
  const grouped = n.toLocaleString('en-US')
  return [plain, grouped].some((form) => new RegExp(`(^|[^0-9.])${form.replace(/[.,]/g, '\\$&')}([^0-9]|$)`).test(haystack))
}

/**
 * The document a passage came from, as the index lists it: its title, page
 * and address, so a line can say where to read it.
 */
export function sourceOf(chunk, index) {
  const key = String(chunk?.item?.key ?? '')
  const doc = (index?.docs ?? []).find((d) => d.item === key || key.endsWith(`/${d.key}.md`) || key === `${d.key}.md`)
  return {
    key,
    title: doc?.title ?? key,
    page: doc?.page ?? null,
    url: doc?.url ?? index?.source ?? null,
  }
}

/**
 * Checks a model's brief against the passages it was given.
 *
 * A standard keeps its line only when its number is written in the
 * passages; it is "cited" when the words the model quoted are there too,
 * and "check" when only the number is. A use is kept on the same test of
 * its quote, or of its own name.
 */
export function groundBrief(raw, chunks, index) {
  const texts = (chunks ?? []).map((c) => squash(c.text))
  const all = texts.join('\n')
  const where = (quote) => {
    const q = squash(quote)
    if (q.length < 6) return -1
    return texts.findIndex((t) => t.includes(q))
  }
  const standards = []
  for (const line of Array.isArray(raw?.standards) ? raw.standards : []) {
    const spec = STANDARDS[line?.key]
    const value = Number(line?.value)
    if (!spec || !Number.isFinite(value) || value < 0) continue
    if (standards.some((s) => s.key === line.key)) continue
    const at = where(line.quote)
    if (at < 0 && !numberIn(value, all)) continue
    standards.push({
      key: line.key, label: spec.label, value, unit: spec.unit,
      status: at >= 0 ? 'cited' : 'check',
      quote: at >= 0 ? String(line.quote).trim().slice(0, 300) : null,
      source: at >= 0 ? sourceOf(chunks[at], index) : null,
    })
  }
  const uses = []
  for (const line of Array.isArray(raw?.uses) ? raw.uses : []) {
    const use = String(line?.use ?? '').trim().slice(0, 120)
    if (!use) continue
    let at = where(line.quote)
    if (at < 0) at = texts.findIndex((t) => t.includes(squash(use)))
    if (at < 0) continue
    const how = ['by right', 'special exception', 'not allowed'].includes(line.how) ? line.how : 'by right'
    if (uses.some((u) => u.use.toLowerCase() === use.toLowerCase())) continue
    uses.push({ use, how, source: sourceOf(chunks[at], index) })
    if (uses.length >= 24) break
  }
  const clean = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
  return {
    summary: clean(raw?.summary, 400) || null,
    highestUse: clean(raw?.highest_use, 200) || null,
    standards,
    uses,
    notes: (Array.isArray(raw?.notes) ? raw.notes : []).map((n) => clean(n, 240)).filter(Boolean).slice(0, 5),
  }
}

/**
 * What a lot of this size could carry under the district's standards.
 *
 * Arithmetic only, on standards that survived grounding, and each line says
 * which standard it multiplied. Lot size is the county's figure in acres.
 */
export function lotYield(standards, acres) {
  const lotSf = Number(acres) > 0 ? Number(acres) * 43560 : null
  if (!lotSf) return []
  const get = (key) => standards.find((s) => s.key === key) ?? null
  const out = []
  const push = (label, value, unit, from) =>
    out.push({ label, value: Math.floor(value), unit, basis: from.map((s) => s.label).join(' × ') + ' × lot size', check: from.some((s) => s.status !== 'cited') })
  const far = get('far')
  // A ratio written as 5 (500%) or as 500; anything up to 30 is a ratio.
  if (far && far.value > 0) push('Buildable floor area', lotSf * (far.value <= 30 ? far.value : far.value / 100), 'sq ft', [far])
  const coverage = get('lot_coverage_pct') ?? (get('open_area_pct') ? { ...get('open_area_pct'), value: 100 - get('open_area_pct').value, label: 'Minimum open area' } : null)
  if (coverage && coverage.value > 0 && coverage.value <= 100) {
    push('Largest building footprint', lotSf * coverage.value / 100, 'sq ft', [coverage])
    const stories = get('stories')
    if (!far && stories && stories.value >= 1 && stories.value <= 120) {
      push('Floor area at full height', lotSf * coverage.value / 100 * stories.value, 'sq ft', [coverage, stories])
    }
  }
  const perUnit = get('lot_area_per_unit_sf')
  const perAcre = get('units_per_acre')
  if (perUnit && perUnit.value >= 100) push('Dwelling units', lotSf / perUnit.value, 'units', [perUnit])
  else if (perAcre && perAcre.value > 0) push('Dwelling units', Number(acres) * perAcre.value, 'units', [perAcre])
  const minLot = get('min_lot_area_sf')
  if (minLot && minLot.value >= 100 && lotSf / minLot.value >= 2) push('Lots it could divide into', lotSf / minLot.value, 'lots', [minLot])
  return out.filter((line) => line.value > 0)
}

const BRIEF_SYSTEM = [
  'You read a city\'s published zoning rules for a commercial real estate product.',
  'Use ONLY the context passages. Never estimate, never use outside knowledge, and leave out anything the passages do not state for the district asked about.',
  'Reply with one JSON object and nothing else, in this shape:',
  '{"summary": "one or two plain sentences on what the district is for",',
  ' "highest_use": "the most intensive use the district allows by right, in a short phrase",',
  ' "uses": [{"use": "name of a use", "how": "by right" | "special exception" | "not allowed", "quote": "words copied exactly from the context"}],',
  ' "standards": [{"key": "<one of the keys below>", "value": <number>, "quote": "words copied exactly from the context that state this figure for this district"}],',
  ' "notes": ["a condition or exception worth knowing, in the context\'s own terms"]}',
  `Standard keys: ${Object.entries(STANDARDS).map(([k, s]) => `${k} (${s.label}, in ${s.unit})`).join('; ')}.`,
  'For far give the ratio as a percentage of lot area (a ratio of 5 is 500). Give each key at most once. List at most twelve uses, the most intensive first.',
].join('\n')

const ASK_SYSTEM = [
  'You answer questions about a city\'s published zoning rules for a commercial real estate product.',
  'Use ONLY the context passages. If they do not answer the question, say that the indexed rules do not say, in one sentence.',
  'Answer in at most six short sentences of plain prose. Give figures exactly as the passages state them. Do not give legal advice or an opinion of value.',
].join('\n')

/**
 * Where a district's rules are, by the list's own routes: the first whose
 * pattern matches the district code. `{ folder, label }` to search one
 * article, `{ skip }` when the district has no general rules to read, or
 * null to search the whole code.
 */
export function routeFor(zone, index) {
  for (const route of Array.isArray(index?.routes) ? index.routes : []) {
    let hit = false
    try { hit = new RegExp(route.match).test(String(zone)) } catch { hit = false }
    if (hit) return route
  }
  return null
}

async function complete(env, market, messages, folder) {
  const instance = env.AI_SEARCH.get(instanceId(market))
  const reply = await instance.chatCompletions({
    messages,
    ...(env.CODE_SEARCH_MODEL ? { model: env.CODE_SEARCH_MODEL } : {}),
    ai_search_options: {
      retrieval: {
        max_num_results: 14, keyword_match_mode: 'or', context_expansion: 1, match_threshold: 0.2,
        ...(folder ? { filters: { folder: `${folder}/` } } : {}),
      },
    },
  })
  return {
    text: reply?.choices?.[0]?.message?.content ?? '',
    chunks: Array.isArray(reply?.chunks) ? reply.chunks : [],
    model: reply?.model ?? null,
  }
}

/**
 * Reads one district's brief from the code. One search; the caller stores
 * the result so the district is not read twice.
 */
export async function readBrief(env, market, zone, index) {
  const route = routeFor(zone, index)
  if (route?.skip) return { read: true, zone, skipped: String(route.skip), summary: null, highestUse: null, standards: [], uses: [], notes: [], sources: [], passages: 0 }
  const question =
    `Zoning district ${zone}${route?.label ? ` (${route.label})` : ''} in ${index?.jurisdiction ?? 'this city'}: ` +
    'what uses are permitted, and what are its dimensional standards (maximum height in feet and stories, ' +
    'floor area ratio, lot coverage or open area, minimum lot area and width, yards and setbacks, density)?'
  const { text, chunks, model } = await complete(env, market, [
    { role: 'system', content: BRIEF_SYSTEM },
    { role: 'user', content: question },
  ], route?.folder)
  const raw = readJson(text)
  if (!raw) return { read: false, passages: chunks.length, model }
  const brief = groundBrief(raw, chunks, index)
  const pages = []
  for (const chunk of chunks) {
    const source = sourceOf(chunk, index)
    if (!pages.some((p) => p.key === source.key)) pages.push(source)
  }
  return { read: true, zone, ...brief, sources: pages.slice(0, 8), passages: chunks.length, model }
}

/** Answers a free question about the code, with the pages it read. */
export async function askCode(env, market, question, zone, index) {
  const asked = `${zone ? `About zoning district ${zone}: ` : ''}${String(question).trim().slice(0, 500)}`
  const route = zone ? routeFor(zone, index) : null
  const { text, chunks, model } = await complete(env, market, [
    { role: 'system', content: ASK_SYSTEM },
    { role: 'user', content: asked },
  ], route?.folder)
  const sources = []
  for (const chunk of chunks) {
    const source = sourceOf(chunk, index)
    if (!sources.some((p) => p.key === source.key)) sources.push(source)
  }
  return { answer: String(text).trim().slice(0, 2400), sources: sources.slice(0, 6), passages: chunks.length, model }
}

/**
 * Loads a stretch of the market's published code documents into its AI
 * Search instance, creating the instance the first time. Called by the
 * pipeline through the ingest door, a page at a time.
 */
export async function indexCode(env, market, index, readBundle, { offset = 0, limit = 25 } = {}) {
  const id = instanceId(market)
  let created = false
  if (offset === 0) {
    const listed = await env.AI_SEARCH.list({ search: id, per_page: 100 }).catch(() => null)
    const there = (listed?.result ?? []).some((i) => i.id === id)
    if (!there) {
      await env.AI_SEARCH.create({ id })
      created = true
    }
  }
  const instance = env.AI_SEARCH.get(id)
  const docs = (index?.docs ?? []).slice(offset, offset + limit)
  const bundles = new Map()
  const failed = []
  let uploaded = 0
  for (const doc of docs) {
    if (!bundles.has(doc.bundle)) {
      const whole = await readBundle(doc.bundle).catch(() => null)
      bundles.set(doc.bundle, whole == null ? null : String(whole).split('\f'))
    }
    const text = bundles.get(doc.bundle)?.[doc.part]
    if (!text || !/^[a-z0-9]{1,20}\/[a-z0-9-]{1,60}\.md$/.test(String(doc.item))) {
      failed.push({ item: doc.item, why: text ? 'not a page name' : 'not in the catalogue' })
      continue
    }
    try {
      await instance.items.upload(doc.item, text)
      uploaded += 1
    } catch (cause) {
      failed.push({ item: doc.item, why: String(cause?.message ?? cause).slice(0, 160) })
    }
  }
  const total = (index?.docs ?? []).length
  const next = offset + docs.length
  return { instance: id, created, uploaded, failed, total, next: next < total ? next : null }
}

/** How the market's instance stands: its items by status. */
export async function codeStatus(env, market) {
  const instance = env.AI_SEARCH.get(instanceId(market))
  const counts = {}
  for (const status of ['completed', 'queued', 'running', 'error', 'skipped', 'outdated']) {
    const page = await instance.items.list({ status, per_page: 1 }).catch((cause) => ({ error: String(cause?.message ?? cause) }))
    if (page.error) return { instance: instanceId(market), error: page.error.slice(0, 200) }
    counts[status] = Number(page?.result_info?.total_count ?? 0)
  }
  return { instance: instanceId(market), items: counts }
}
