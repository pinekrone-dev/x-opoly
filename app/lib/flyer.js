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

import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
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

const FlyerFields = z.object({
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
  uncertainFields: z.array(z.string()).describe('Names of fields that were guessed or ambiguous, for the broker to confirm'),
})

const SYSTEM_PROMPT = `You read commercial real estate listing flyers and pull out the facts a tenant rep broker records for a site survey.

Rules:
- Only report what the document actually states. If a field is not present, return null for it. Never infer, estimate, or fill a field from general knowledge.
- Rates: return the number alone in rentRate and the unit separately in rentUnit. "$28.50/SF/YR" becomes rentRate 28.5 and rentUnit "psf/yr".
- If a rate or size is given as a range, use the lower bound and mention the full range in notes.
- "Negotiable", "Call for pricing" and similar are not numbers — leave rentRate null and note it.
- Put the street address in address, and keep city, state and zip in their own fields.
- List any field you were unsure about in uncertainFields so the broker can check it.`

/** True when this deployment has credentials to call the API. */
export function isConfigured(env = {}) {
  return Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN)
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

  const anthropic =
    client || (isConfigured(env) ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, authToken: env.ANTHROPIC_AUTH_TOKEN }) : null)
  if (!anthropic) {
    throw new FlyerExtractionError(
      'Reading flyers automatically needs an Anthropic API key. Set ANTHROPIC_API_KEY on the server, or enter the details by hand.',
      { configured: false },
    )
  }

  const block = contentBlockFor(bytes, mimeType)

  try {
    const response = await anthropic.messages.parse({
      model: env.ANTHROPIC_MODEL || DEFAULT_MODEL,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      output_config: {
        effort: 'medium',
        format: zodOutputFormat(FlyerFields),
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
    if (error instanceof Anthropic.AuthenticationError) {
      throw new FlyerExtractionError('The Anthropic API key was rejected. Check ANTHROPIC_API_KEY on the server.', { configured: false })
    }
    if (error instanceof Anthropic.RateLimitError) {
      throw new FlyerExtractionError('The API is rate limiting us right now. Try that flyer again in a moment.')
    }
    if (error instanceof Anthropic.APIError) {
      throw new FlyerExtractionError(`The extraction service returned an error (${error.status}). ${error.message}`)
    }
    throw new FlyerExtractionError(`The flyer could not be processed: ${error.message}`)
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
