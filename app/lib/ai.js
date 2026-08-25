/**
 * The AI extraction providers this deployment can use.
 *
 * Anthropic, Google Gemini, and xAI Grok all read the same listing content
 * into the same fields; which one runs is decided by whichever key the
 * deployment has, or by AI_PROVIDER when more than one is set. Gemini and
 * Grok are called over plain fetch — no SDKs — so they run unchanged on
 * Cloudflare Workers; the Anthropic path keeps its SDK in flyer.js.
 *
 * Capability differences are stated, not papered over: Grok reads text and
 * images but not PDF documents, so a PDF flyer on a Grok-only deployment gets
 * a clear error naming the fix rather than a garbled answer.
 */

import { FlyerExtractionError } from './flyer.js'

export const PROVIDERS = ['anthropic', 'gemini', 'grok']

/**
 * Which provider this deployment should use.
 *
 * AI_PROVIDER wins when set (and is validated, so a typo fails loudly);
 * otherwise the first configured key in PROVIDERS order decides.
 */
export function resolveProvider(env = {}) {
  const forced = String(env.AI_PROVIDER ?? '').trim().toLowerCase()
  if (forced) {
    if (!PROVIDERS.includes(forced)) {
      throw new FlyerExtractionError(
        `AI_PROVIDER is set to "${forced}" — it must be one of ${PROVIDERS.join(', ')}.`,
      )
    }
    return forced
  }
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return 'anthropic'
  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) return 'gemini'
  if (env.XAI_API_KEY || env.GROK_API_KEY) return 'grok'
  return null
}

/** The extraction fields, as plain JSON schema for the non-Anthropic APIs. */
const FIELD_TYPES = {
  name: 'string',
  address: 'string',
  city: 'string',
  state: 'string',
  zip: 'string',
  sizeSqft: 'number',
  acreage: 'number',
  rentRate: 'number',
  rentUnit: 'string',
  nnn: 'number',
  parkingSpaces: 'number',
  zoning: 'string',
  yearBuilt: 'number',
  availability: 'string',
  listingBroker: 'string',
  notes: 'string',
}

export const EXTRACTION_PROMPT = `You read commercial real estate listing material and pull out the facts a tenant rep broker records for a site survey.

Rules:
- Only report what the material actually states. If a field is not present, return null for it. Never infer, estimate, or fill a field from general knowledge.
- Rates: return the number alone in rentRate and the unit separately in rentUnit. "$28.50/SF/YR" becomes rentRate 28.5 and rentUnit "psf/yr".
- If a rate or size is given as a range, use the lower bound and mention the full range in notes.
- "Negotiable", "Call for pricing" and similar are not numbers — leave rentRate null and note it.
- Put the street address in address, and keep city, state and zip in their own fields.
- List any field you were unsure about in uncertainFields so the broker can check it.

Respond with a single JSON object holding exactly these keys (null when unknown): ${Object.keys(FIELD_TYPES).join(', ')}, confidence ("high", "medium" or "low"), and uncertainFields (an array of field names).`

/**
 * Whatever a model answered, as the fields the rest of the app expects.
 *
 * Models drift — a number as a string, an omitted key, an invented one — and
 * every drift here would otherwise surface as a broken form field. Coercion
 * happens once, at the boundary.
 */
export function normalizeFields(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new FlyerExtractionError('The model did not return readable fields. Try again, or enter the details by hand.')
  }
  const fields = {}
  for (const [key, kind] of Object.entries(FIELD_TYPES)) {
    const value = raw[key]
    if (value == null || value === '') {
      fields[key] = null
    } else if (kind === 'number') {
      const parsed = Number(String(value).replace(/[,$]/g, ''))
      fields[key] = Number.isFinite(parsed) ? parsed : null
    } else {
      fields[key] = String(value)
    }
  }
  fields.confidence = ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'medium'
  fields.uncertainFields = Array.isArray(raw.uncertainFields)
    ? raw.uncertainFields.filter((entry) => typeof entry === 'string').slice(0, 20)
    : []
  return fields
}

/** Base64 without Buffer, so this runs unchanged on Workers. */
function toBase64(bytes) {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

async function readJson(response, label) {
  const text = await response.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    // Fall through with the raw text in hand for the error below.
  }

  if (response.status === 401 || response.status === 403) {
    throw new FlyerExtractionError(`The ${label} API key was rejected. Check it on the server.`, { configured: false })
  }
  if (response.status === 429) {
    throw new FlyerExtractionError(`${label} is rate limiting us right now. Try again in a moment.`)
  }
  if (!response.ok) {
    const detail = body?.error?.message ?? text.slice(0, 200)
    throw new FlyerExtractionError(`${label} returned an error (${response.status}). ${detail}`)
  }
  if (!body) {
    throw new FlyerExtractionError(`${label} answered with something other than JSON.`)
  }
  return body
}

/** The model's JSON answer, tolerating a markdown code fence around it. */
function parseModelJson(text, label) {
  const cleaned = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  try {
    return JSON.parse(cleaned)
  } catch {
    throw new FlyerExtractionError(`${label} did not answer with the JSON fields. Try again, or enter the details by hand.`)
  }
}

// --- Google Gemini ---------------------------------------------------------

/**
 * Google's rolling alias for the newest flash model. Pinning a versioned
 * name broke live the day Google retired it ("gemini-2.5-flash is no longer
 * available to new users"); the alias survives retirements.
 */
const GEMINI_DEFAULT = 'gemini-flash-latest'

export async function geminiExtract({ text, bytes, mimeType }, env = {}, { fetchImpl = fetch } = {}) {
  const model = env.GEMINI_MODEL || GEMINI_DEFAULT
  const parts = []
  if (bytes) parts.push({ inline_data: { mime_type: mimeType, data: toBase64(bytes) } })
  if (text) parts.push({ text })
  parts.push({ text: 'Extract the site survey fields from this listing.' })

  const response = await fetchImpl(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': env.GEMINI_API_KEY || env.GOOGLE_API_KEY,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: EXTRACTION_PROMPT }] },
        contents: [{ role: 'user', parts }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 },
      }),
    },
  )

  // A retired or mistyped model answers 404. When the caller pinned one,
  // retry once on the rolling alias rather than failing the whole read.
  if (response.status === 404 && model !== GEMINI_DEFAULT) {
    return geminiExtract({ text, bytes, mimeType }, { ...env, GEMINI_MODEL: GEMINI_DEFAULT }, { fetchImpl })
  }

  const body = await readJson(response, 'Gemini')
  const answer = body?.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('')
  return { fields: normalizeFields(parseModelJson(answer, 'Gemini')), model }
}

// --- xAI Grok --------------------------------------------------------------

export async function grokExtract({ text, bytes, mimeType }, env = {}, { fetchImpl = fetch } = {}) {
  if (bytes && mimeType === 'application/pdf') {
    throw new FlyerExtractionError(
      'Grok cannot read PDF flyers. Upload the flyer as an image, paste its text, or set AI_PROVIDER to anthropic or gemini.',
    )
  }

  const model = env.GROK_MODEL || 'grok-4'
  const content = []
  if (bytes) {
    content.push({ type: 'image_url', image_url: { url: `data:${mimeType};base64,${toBase64(bytes)}` } })
  }
  content.push({ type: 'text', text: text || 'Extract the site survey fields from this listing.' })

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
        { role: 'system', content: EXTRACTION_PROMPT },
        { role: 'user', content },
      ],
    }),
  })

  const body = await readJson(response, 'Grok')
  const answer = body?.choices?.[0]?.message?.content
  return { fields: normalizeFields(parseModelJson(answer, 'Grok')), model: body?.model ?? model }
}

/** One entry point for the non-Anthropic providers. */
export async function extractWithProvider(provider, input, env = {}, deps = {}) {
  if (provider === 'gemini') return geminiExtract(input, env, deps)
  if (provider === 'grok') return grokExtract(input, env, deps)
  throw new FlyerExtractionError(`Unknown AI provider "${provider}".`)
}
