/**
 * The parcel scout: a hunt written in plain English, answered as map filters.
 *
 * "Vacant land over five acres under $2M" is how a broker actually thinks,
 * and every word of it maps onto a filter the GIS view already has — asset
 * type, value range, lot size, a keyword over address and owner. So the
 * scout never invents a second query engine: it translates the sentence into
 * those same filters and hands them back, which means the person can see
 * exactly what was understood, correct it in the panel, and the count, the
 * report and the CSV all agree by construction.
 *
 * With an AI key the deployment's provider — Anthropic, Gemini or Grok,
 * resolved the same way the flyer reader resolves it — does the reading.
 * Without one, a heuristic parser covers the formulaic phrasings, marked as
 * such so nobody mistakes pattern-matching for comprehension.
 *
 * The vocabulary travels with the request. Asset types are whatever this
 * county publishes ("VACANT LAND" in one, "Vacant" in the next), so the
 * client sends the list it actually loaded and the answer is clamped to it —
 * a filter naming a type the county never publishes would silently match
 * nothing.
 */

import { parseModelJson, readJson } from './ai.js'

/** The filters the GIS view has, and therefore the only things a hunt can mean. */
const EMPTY = {
  assetTypes: [],
  valueMin: null,
  valueMax: null,
  acresMin: null,
  acresMax: null,
  keyword: null,
}

function toNumber(value) {
  if (value == null || value === '') return null
  const parsed = Number(String(value).replace(/[,$\s]/g, ''))
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

/**
 * Whatever a model (or the heuristic) answered, as filters the view can use.
 *
 * Asset types are matched case-insensitively against the county's published
 * list and returned in the county's own spelling; anything else is dropped
 * rather than passed through to match nothing. Swapped bounds are put back
 * in order rather than rejected — "between 2M and 500k" is a typo, not a
 * request for the empty set.
 */
export function normalizeScout(raw, vocab = {}) {
  const published = Array.isArray(vocab.assetTypes) ? vocab.assetTypes : []
  const byLower = new Map(published.map((label) => [String(label).trim().toLowerCase(), label]))
  const filters = { ...EMPTY }

  const wanted = Array.isArray(raw?.assetTypes) ? raw.assetTypes : []
  filters.assetTypes = [
    ...new Set(
      wanted
        .map((entry) => byLower.get(String(entry).trim().toLowerCase()))
        .filter((label) => label != null),
    ),
  ]

  filters.valueMin = toNumber(raw?.valueMin)
  filters.valueMax = toNumber(raw?.valueMax)
  if (filters.valueMin != null && filters.valueMax != null && filters.valueMin > filters.valueMax) {
    ;[filters.valueMin, filters.valueMax] = [filters.valueMax, filters.valueMin]
  }
  filters.acresMin = toNumber(raw?.acresMin)
  filters.acresMax = toNumber(raw?.acresMax)
  if (filters.acresMin != null && filters.acresMax != null && filters.acresMin > filters.acresMax) {
    ;[filters.acresMin, filters.acresMax] = [filters.acresMax, filters.acresMin]
  }

  const keyword = typeof raw?.keyword === 'string' ? raw.keyword.trim() : ''
  filters.keyword = keyword ? keyword.slice(0, 80) : null

  const empty =
    filters.assetTypes.length === 0 &&
    filters.valueMin == null &&
    filters.valueMax == null &&
    filters.acresMin == null &&
    filters.acresMax == null &&
    filters.keyword == null
  return { filters, empty }
}

// --- The heuristic ---------------------------------------------------------

/** "$2M", "500k", "1.2 million", "750,000" — as a number of dollars. */
export function parseMoney(text) {
  const found = String(text ?? '').match(/\$?\s*([\d][\d,]*(?:\.\d+)?)\s*(k|m|b|thousand|million|billion)?/i)
  if (!found) return null
  const base = Number(found[1].replace(/,/g, ''))
  if (!Number.isFinite(base)) return null
  const unit = (found[2] ?? '').toLowerCase()
  const scale = unit.startsWith('k') || unit === 'thousand' ? 1e3
    : unit.startsWith('m') ? 1e6
      : unit.startsWith('b') ? 1e9
        : 1
  return base * scale
}

/**
 * The words people use for asset classes, keyed to a fragment of the label a
 * county is likely to publish. Matching is by substring in both directions,
 * so "apartments" finds "MULTIFAMILY" and "multi-family residential" alike.
 */
const ASSET_HINTS = [
  [/vacant|raw land|\bland\b|undeveloped|\blots?\b/i, ['vacant', 'land']],
  [/apartment|multi[- ]?family|multifamily|duplex|triplex/i, ['multi', 'apartment']],
  [/commercial|retail|office|shopping|store(front)?s?\b/i, ['commercial', 'retail', 'office']],
  [/industrial|warehouse|flex|manufactur/i, ['industrial', 'warehouse']],
  [/single[- ]family|\bhouses?\b|\bhomes?\b|residential/i, ['single', 'residential']],
  [/\bcondo(minium)?s?\b/i, ['condo']],
  [/\bfarm|agricultur|ranch/i, ['farm', 'agri', 'ranch']],
]

const MIN_WORDS = '(?:over|above|more than|at least|bigger than|larger than|greater than|minimum(?: of)?|starting at|starting from|from)'
const MAX_WORDS = '(?:under|below|less than|at most|smaller than|no more than|maximum(?: of)?|up to)'
const MONEY = String.raw`\$?\s*[\d][\d,]*(?:\.\d+)?\s*(?:k|m|b|thousand|million|billion)?`
const ACRES = String.raw`[\d][\d,]*(?:\.\d+)?`

/**
 * The formulaic phrasings, read without a model.
 *
 * Every capture is marked apart — acreage is only read next to the word
 * "acre", money only with a dollar sign or a value word nearby — because the
 * cost of crossing them ("5 acres under $2M" becoming acresMax 2e6) is a
 * confidently wrong map.
 */
export function heuristicScout(prompt, vocab = {}) {
  const text = String(prompt ?? '')
  const raw = { ...EMPTY, assetTypes: [] }

  // Lot size, always anchored to "acre".
  const acreMin =
    text.match(new RegExp(`${MIN_WORDS}\\s+(${ACRES})\\s*acres?\\b`, 'i')) ||
    text.match(new RegExp(`(${ACRES})\\s*\\+\\s*acres?\\b`, 'i')) ||
    text.match(new RegExp(`(${ACRES})\\s*acres?\\s+(?:or more|and up|or larger|or bigger|minimum)`, 'i'))
  if (acreMin) raw.acresMin = Number(acreMin[1].replace(/,/g, ''))
  const acreMax =
    text.match(new RegExp(`${MAX_WORDS}\\s+(${ACRES})\\s*acres?\\b`, 'i')) ||
    text.match(new RegExp(`(${ACRES})\\s*acres?\\s+or (?:less|smaller|fewer)`, 'i'))
  if (acreMax) raw.acresMax = Number(acreMax[1].replace(/,/g, ''))
  const acreBetween = text.match(new RegExp(`between\\s+(${ACRES})\\s+and\\s+(${ACRES})\\s*acres?\\b`, 'i'))
  if (acreBetween) {
    raw.acresMin = Number(acreBetween[1].replace(/,/g, ''))
    raw.acresMax = Number(acreBetween[2].replace(/,/g, ''))
  }

  // Money, never allowed to read an acreage figure: a bare number only
  // counts when it carries a dollar sign or scale word, and any candidate
  // that the acre patterns already consumed is skipped by the \s*acres? veto.
  const moneyish = (fragment) => /\$|k\b|m\b|b\b|thousand|million|billion/i.test(fragment)
  const valueMin = text.match(new RegExp(`(?:worth|valued?(?: at)?|priced?)?\\s*${MIN_WORDS}\\s+(${MONEY})(?!\\s*acres?)`, 'i'))
  if (valueMin && moneyish(valueMin[1])) raw.valueMin = parseMoney(valueMin[1])
  const valueMax = text.match(new RegExp(`(?:worth|valued?(?: at)?|priced?)?\\s*${MAX_WORDS}\\s+(${MONEY})(?!\\s*acres?)`, 'i'))
  if (valueMax && moneyish(valueMax[1])) raw.valueMax = parseMoney(valueMax[1])
  const valueBetween = text.match(new RegExp(`between\\s+(${MONEY})\\s+and\\s+(${MONEY})(?!\\s*acres?)`, 'i'))
  if (valueBetween && moneyish(valueBetween[1]) && moneyish(valueBetween[2])) {
    raw.valueMin = parseMoney(valueBetween[1])
    raw.valueMax = parseMoney(valueBetween[2])
  }

  // Asset classes, resolved against what this county actually publishes.
  const published = Array.isArray(vocab.assetTypes) ? vocab.assetTypes : []
  for (const [pattern, fragments] of ASSET_HINTS) {
    if (!pattern.test(text)) continue
    for (const label of published) {
      const lower = String(label).toLowerCase()
      if (fragments.some((fragment) => lower.includes(fragment))) raw.assetTypes.push(label)
    }
  }

  // A named owner, or anything the person put in quotes, becomes the keyword
  // the search box already runs over address and owner of record.
  const owned = text.match(/owned by\s+(?:the\s+)?([a-z0-9 .&'-]{2,60}?)(?=$|[,.]| with\b| that\b| over\b| under\b| and\b)/i)
  const quoted = text.match(/"([^"]{2,60})"|'([^']{2,60})'/)
  if (owned) raw.keyword = owned[1].trim()
  else if (quoted) raw.keyword = (quoted[1] ?? quoted[2]).trim()
  else {
    const onStreet = text.match(/\b(?:on|along|near)\s+([A-Z][a-z0-9 .'-]{2,40}?(?:St|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Rd|Road|Ln|Lane|Pkwy|Parkway|Hwy|Highway)\b\.?)/)
    if (onStreet) raw.keyword = onStreet[1].trim()
  }

  return normalizeScout(raw, vocab)
}

// --- The providers ---------------------------------------------------------

function scoutInstructions(vocab) {
  const types = (vocab.assetTypes ?? []).map((label) => JSON.stringify(label)).join(', ')
  const valueLabel = vocab.valueLabel || 'Value'
  return `You translate a commercial real estate hunt, written in plain English, into the filters of a county parcel map.

The only filters that exist:
- assetTypes: zero or more entries chosen EXACTLY from this county's published list: [${types || 'none published'}]. Pick every entry that matches the intent; an empty array means all types.
- valueMin / valueMax: dollar bounds on "${valueLabel}" as plain numbers ($2M is 2000000). null when unbounded.
- acresMin / acresMax: bounds on lot size in acres. "5+ acres" means acresMin 5.
- keyword: one short word or phrase matched against the situs address and the owner of record — use it for "owned by X", a street name, or a neighborhood. null otherwise.

Rules: set only what the request implies and leave the rest null; never guess a bound the person did not state. Respond with a single JSON object shaped exactly {"assetTypes": [], "valueMin": null, "valueMax": null, "acresMin": null, "acresMax": null, "keyword": null, "explanation": "one short sentence restating the hunt as you read it"}.`
}

async function anthropicScout(prompt, vocab, env, fetchImpl) {
  const key = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }
  if (env.ANTHROPIC_API_KEY) headers['x-api-key'] = env.ANTHROPIC_API_KEY
  else headers.authorization = `Bearer ${key}`
  const model = env.ANTHROPIC_MODEL || 'claude-opus-5'
  const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      max_tokens: 400,
      system: scoutInstructions(vocab),
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  const body = await readJson(response, 'Anthropic')
  const answer = (body?.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
  return { raw: parseModelJson(answer, 'Anthropic'), model: body?.model ?? model }
}

async function geminiScout(prompt, vocab, env, fetchImpl) {
  const model = env.GEMINI_MODEL || 'gemini-flash-latest'
  const response = await fetchImpl(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': env.GEMINI_API_KEY || env.GOOGLE_API_KEY,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: scoutInstructions(vocab) }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 },
      }),
    },
  )
  const body = await readJson(response, 'Gemini')
  const answer = body?.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('')
  return { raw: parseModelJson(answer, 'Gemini'), model }
}

async function grokScout(prompt, vocab, env, fetchImpl) {
  const model = env.GROK_MODEL || 'grok-4'
  const response = await fetchImpl('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.XAI_API_KEY || env.GROK_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: scoutInstructions(vocab) },
        { role: 'user', content: prompt },
      ],
    }),
  })
  const body = await readJson(response, 'Grok')
  return { raw: parseModelJson(body?.choices?.[0]?.message?.content, 'Grok'), model: body?.model ?? model }
}

/**
 * One hunt, answered.
 *
 * The provider is whichever the deployment resolved for AI generally — the
 * scout does not get its own key. No provider at all is not an error: the
 * heuristic answers, and says so, because a map that only filters when a key
 * is set would be a worse map.
 */
export async function runScout(prompt, vocab, provider, env = {}, { fetchImpl = fetch } = {}) {
  if (!provider) {
    const { filters, empty } = heuristicScout(prompt, vocab)
    return { filters, empty, explanation: null, source: 'heuristic', provider: null, model: null }
  }
  const call = provider === 'anthropic' ? anthropicScout : provider === 'gemini' ? geminiScout : grokScout
  const { raw, model } = await call(prompt, vocab, env, fetchImpl)
  const { filters, empty } = normalizeScout(raw, vocab)
  const explanation = typeof raw?.explanation === 'string' ? raw.explanation.trim().slice(0, 300) || null : null
  return { filters, empty, explanation, source: 'ai', provider, model }
}
