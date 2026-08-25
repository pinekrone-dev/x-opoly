/**
 * Flyer ingestion.
 *
 * Listing flyers arrive as PDFs and screenshots with the useful facts scattered
 * across a designed page. This hands the file to Claude and gets structured
 * fields back, so adding a site is a drag-and-drop instead of ten minutes of
 * retyping.
 *
 * Every field is nullable on purpose: a flyer that does not state the year
 * built should produce `null`, never a guess. The prompt says so, and anything
 * the model is unsure of is surfaced for the broker to confirm rather than
 * silently written into the record.
 */

import { toBase64 } from './storage.js'

const DEFAULT_MODEL = 'claude-opus-5'
const MAX_BYTES = 10 * 1024 * 1024

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export class FlyerExtractionError extends Error {
  constructor(message, { configured = true } = {}) {
    super(message)
    this.name = 'FlyerExtractionError'
    this.configured = configured
  }
}

/**
 * The Anthropic SDK is loaded on demand.
 *
 * It used to be a top-level import, which meant every request — including
 * serving the home page — evaluated the whole SDK. On Workers that also made
 * the entire app depend on the SDK's Node compatibility shims loading
 * correctly at startup, so one bad import took down routes that have nothing
 * to do with reading flyers.
 */
let sdk = null

async function loadSdk() {
  if (sdk) return sdk

  const [anthropic, zod, helpers] = await Promise.all([
    import('@anthropic-ai/sdk'),
    import('zod'),
    import('@anthropic-ai/sdk/helpers/zod'),
  ])

  const z = zod.z
  sdk = {
    Anthropic: anthropic.default,
    zodOutputFormat: helpers.zodOutputFormat,
    schema: z.object({
  name: z.string().nullable().describe('Building or property name, e.g. "Parmer Business Park"'),
  address: z.string().nullable().describe('Street address only, without city or state'),
  city: z.string().nullable(),
  state: z.string().nullable().describe('Two-letter state code'),
  zip: z.string().nullable(),
  sizeSqft: z.number().nullable().describe('Available square footage. If a range, use the smallest.'),
  acreage: z.number().nullable(),
  rentRate: z.number().nullable().describe('Asking rate as a number only, e.g. 28.5'),
  rentUnit: z.string().nullable().describe('Unit for the rate, e.g. "psf/yr", "psf/mo", "monthly"'),
  nnn: z.number().nullable().describe('Triple-net or operating expense figure, number only'),
  parkingSpaces: z.number().nullable(),
  zoning: z.string().nullable(),
  yearBuilt: z.number().nullable(),
  availability: z.string().nullable().describe('When the space is available, as written'),
  listingBroker: z.string().nullable().describe('Listing broker or brokerage named on the flyer'),
  notes: z.string().nullable().describe('Other selling points worth keeping, one short paragraph'),
  confidence: z.enum(['high', 'medium', 'low']).describe('How legible and complete the flyer was'),
  uncertainFields: z.array(z.string()).describe('Names of fields that were guessed or ambiguous, for the broker to confirm'),}),
  }
  return sdk
}

const SYSTEM_PROMPT = `You read commercial real estate listing flyers and pull out the facts a tenant rep broker records for a site survey.

Rules:
- Only report what the document actually states. If a field is not present, return null for it. Never infer, estimate, or fill a field from general knowledge.
- Rates: return the number alone in rentRate and the unit separately in rentUnit. "$28.50/SF/YR" becomes rentRate 28.5 and rentUnit "psf/yr".
- If a rate or size is given as a range, use the lower bound and mention the full range in notes.
- "Negotiable", "Call for pricing" and similar are not numbers — leave rentRate null and note it.
- Put the street address in address, and keep city, state and zip in their own fields.
- List any field you were unsure about in uncertainFields so the broker can check it.`

/**
 * True when this deployment can call any extraction provider.
 *
 * Anthropic, Google Gemini and xAI Grok are all supported; whichever key is
 * present decides (AI_PROVIDER forces the choice when several are set).
 */
export function isConfigured(env = {}) {
  return Boolean(
    env.ANTHROPIC_API_KEY ||
      env.ANTHROPIC_AUTH_TOKEN ||
      env.GEMINI_API_KEY ||
      env.GOOGLE_API_KEY ||
      env.XAI_API_KEY ||
      env.GROK_API_KEY,
  )
}

function contentBlockFor(bytes, mimeType) {
  // Base64 without Buffer, so this runs unchanged on Workers.
  const data = toBase64(bytes)

  if (mimeType === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
  }
  if (IMAGE_TYPES.has(mimeType)) {
    return { type: 'image', source: { type: 'base64', media_type: mimeType, data } }
  }
  throw new FlyerExtractionError(`${mimeType || 'That file type'} cannot be read. Upload a PDF, PNG or JPEG flyer.`)
}

/**
 * Reads a flyer and returns the property fields it describes.
 *
 * @param {Buffer} buffer     the uploaded file
 * @param {string} mimeType   its content type
 * @param {object} [deps]     `client` is injectable for tests
 * @returns {Promise<{ fields: object, model: string }>}
 */
export async function extractFromFlyer(bytes, mimeType, { env = {}, client } = {}) {
  if (!bytes?.length) throw new FlyerExtractionError('The uploaded file was empty.')
  if (bytes.length > MAX_BYTES) {
    throw new FlyerExtractionError(`That file is ${(bytes.length / 1e6).toFixed(1)} MB. Flyers must be under 10 MB.`)
  }

  if (!client && !isConfigured(env)) {
    throw new FlyerExtractionError(
      'Reading flyers automatically needs an AI key. Set ANTHROPIC_API_KEY, GEMINI_API_KEY, or XAI_API_KEY on the server, or enter the details by hand.',
      { configured: false },
    )
  }

  // Gemini and Grok run over plain fetch in ai.js; Anthropic keeps its SDK
  // path below. An injected test client always means the Anthropic shape.
  if (!client) {
    const { resolveProvider, extractWithProvider } = await import('./ai.js')
    const provider = resolveProvider(env)
    if (provider !== 'anthropic') {
      return extractWithProvider(provider, { bytes, mimeType }, env)
    }
  }

  // Only reached when a flyer is actually being read.
  const { Anthropic, zodOutputFormat, schema } = await loadSdk()
  const anthropic =
    client || new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, authToken: env.ANTHROPIC_AUTH_TOKEN })
  const block = contentBlockFor(bytes, mimeType)

  try {
    const response = await anthropic.messages.parse({
      model: env.ANTHROPIC_MODEL || DEFAULT_MODEL,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      output_config: {
        effort: 'medium',
        format: zodOutputFormat(schema),
      },
      messages: [
        {
          role: 'user',
          // The document goes first; the instruction reads better after it.
          content: [block, { type: 'text', text: 'Extract the site survey fields from this listing flyer.' }],
        },
      ],
    })

    if (!response.parsed_output) {
      throw new FlyerExtractionError('The flyer could not be read into structured fields. Try a clearer copy, or enter the details by hand.')
    }

    return { fields: response.parsed_output, model: response.model }
  } catch (error) {
    if (error instanceof FlyerExtractionError) throw error

    // Classified by status so this path never needs the SDK itself.
    if (error?.status === 401 || error?.status === 403) {
      throw new FlyerExtractionError('The Anthropic API key was rejected. Check ANTHROPIC_API_KEY on the server.', { configured: false })
    }
    if (error?.status === 429) {
      throw new FlyerExtractionError('The API is rate limiting us right now. Try that flyer again in a moment.')
    }
    if (error?.status) {
      throw new FlyerExtractionError(`The extraction service returned an error (${error.status}). ${error.message}`)
    }
    throw new FlyerExtractionError(`The flyer could not be processed: ${error.message}`)
  }
}

/**
 * The flyer extractor pointed at plain text instead of a document.
 *
 * Same model, same schema, same field semantics — a pasted email blurb and a
 * flyer PDF describe the same thing, so they must fill the form identically.
 */
export async function extractTextWithModel(text, { env = {}, client } = {}) {
  if (!client) {
    const { resolveProvider, extractWithProvider } = await import('./ai.js')
    const provider = resolveProvider(env)
    if (provider !== 'anthropic') {
      return extractWithProvider(provider, { text }, env)
    }
  }

  const { Anthropic, zodOutputFormat, schema } = await loadSdk()
  const anthropic =
    client || new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, authToken: env.ANTHROPIC_AUTH_TOKEN })

  try {
    const response = await anthropic.messages.parse({
      model: env.ANTHROPIC_MODEL || DEFAULT_MODEL,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      output_config: {
        effort: 'medium',
        format: zodOutputFormat(schema),
      },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text },
            { type: 'text', text: 'Extract the site survey fields from this pasted listing text.' },
          ],
        },
      ],
    })

    if (!response.parsed_output) {
      throw new FlyerExtractionError('That text could not be read into structured fields.')
    }
    return { fields: response.parsed_output, model: response.model }
  } catch (error) {
    if (error instanceof FlyerExtractionError) throw error
    if (error?.status === 401 || error?.status === 403) {
      throw new FlyerExtractionError('The Anthropic API key was rejected. Check ANTHROPIC_API_KEY on the server.', { configured: false })
    }
    if (error?.status === 429) {
      throw new FlyerExtractionError('The API is rate limiting us right now. Try again in a moment.')
    }
    throw new FlyerExtractionError(`The text could not be processed: ${error.message}`)
  }
}

/** Maps extracted fields onto the columns a property record accepts. */
export function toPropertyInput(fields) {
  return {
    name: fields.name,
    address: fields.address,
    city: fields.city,
    state: fields.state,
    zip: fields.zip,
    sizeSqft: fields.sizeSqft,
    acreage: fields.acreage,
    rentRate: fields.rentRate,
    rentUnit: fields.rentUnit,
    nnn: fields.nnn,
    parkingSpaces: fields.parkingSpaces,
    zoning: fields.zoning,
    yearBuilt: fields.yearBuilt,
    availability: fields.availability,
    listingBroker: fields.listingBroker,
    notes: fields.notes,
  }
}

/**
 * Extraction turned into the labelled rows a site card shows.
 *
 * The flyer's numbers are what a broker reads off a card — "Available SF",
 * "Lease Rate", "NNN" — so they are written as custom fields rather than only
 * into typed columns. Anything the flyer did not state is left out entirely:
 * an empty row is noise, and a zero would be a claim the document never made.
 */
export function toCustomFields(fields) {
  const rows = []
  const add = (label, value) => {
    if (value == null || value === '') return
    rows.push({ label, value: String(value) })
  }

  if (Number.isFinite(fields.sizeSqft)) add('Available SF', `${fields.sizeSqft.toLocaleString()} SF`)
  if (Number.isFinite(fields.rentRate)) {
    add('Lease Rate', fields.rentUnit ? `${fields.rentRate}/${unitSuffix(fields.rentUnit)}` : String(fields.rentRate))
  }
  if (Number.isFinite(fields.nnn)) add('NNN', `${fields.nnn}/SF`)
  if (Number.isFinite(fields.yearBuilt)) add('Year Built', String(fields.yearBuilt))
  add('Zoning', fields.zoning)
  if (Number.isFinite(fields.acreage)) add('Acreage', `${fields.acreage} ac`)
  if (Number.isFinite(fields.parkingSpaces)) add('Parking', `${fields.parkingSpaces} spaces`)
  add('Available', fields.availability)

  return rows
}

/** "psf/yr" reads as "SF" on a card; anything else is kept as written. */
function unitSuffix(unit) {
  const normalised = String(unit).toLowerCase()
  if (normalised.startsWith('psf')) return 'SF'
  return unit
}

/**
 * Works out what a re-read should actually change on an existing site.
 *
 * Pure, so the rule that matters — a value the broker already has is not
 * overwritten unless they ask — is testable without calling the model.
 *
 * @param {object} property  the site as it stands
 * @param {object} fields    what the flyer said
 * @param {{overwrite?: boolean}} options
 */
export function mergeExtraction(property, fields, { overwrite = false } = {}) {
  const extracted = toPropertyInput(fields)
  const patch = {}
  const filled = []
  const skipped = []

  for (const [key, value] of Object.entries(extracted)) {
    if (value == null || value === '') continue
    const current = property?.[key]
    const isEmpty = current == null || current === ''
    if (overwrite || isEmpty) {
      patch[key] = value
      filled.push(key)
    } else {
      skipped.push(key)
    }
  }

  // Custom rows merge by label, so rows the broker added themselves survive a
  // re-read and a row they left blank still gets filled.
  const byLabel = new Map((property?.fields ?? []).map((field) => [field.label.toLowerCase(), field]))
  for (const row of toCustomFields(fields)) {
    const key = row.label.toLowerCase()
    const current = byLabel.get(key)
    if (!current || overwrite || !current.value) byLabel.set(key, row)
  }

  return { patch, filled, skipped, fields: [...byLabel.values()] }
}
