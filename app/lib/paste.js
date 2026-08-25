/**
 * Turning pasted listing text into property fields.
 *
 * Brokers live in email: the details of a site arrive as a forwarded blurb
 * far more often than as a clean PDF. Pasting that blurb should fill the form
 * the way a flyer does.
 *
 * With an Anthropic key the same extractor that reads flyers reads the text.
 * Without one, a heuristic parser takes over — listing copy is formulaic
 * ($28.50/SF, 12,000 SF, "Built in 2007", an address line), and pulling the
 * obvious fields beats making the broker retype what they just pasted. Every
 * heuristic result is marked low-confidence, because a guessed rate presented
 * as a fact is how a wrong number ends up in front of a client.
 */

import { FlyerExtractionError, isConfigured } from './flyer.js'

const MAX_CHARS = 20000

/** ", Austin, TX 78727" — city, a two-letter state, an optional ZIP. */
const CITY_STATE_ZIP = /,\s*([A-Za-z .'-]+?)\s*,\s*([A-Z]{2})\s*,?\s*(\d{5})?(?:-\d{4})?\b/

const STREET_TYPES =
  'St|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Rd|Road|Ln|Lane|Pkwy|Parkway|Way|Ct|Court|Hwy|Highway|Cir|Circle|Trl|Trail|Pl|Place|Loop|Expy|Expressway'

const ADDRESS = new RegExp(
  `\\b(\\d{1,6}(?:[ ][NSEW]\\.?)?[ ][A-Za-z0-9 .'-]{2,40}?(?:${STREET_TYPES})\\b\\.?)(?=[ ,\\n]|$)`,
  'i',
)

function match(text, pattern, group = 1) {
  const found = text.match(pattern)
  return found?.[group]?.trim() || null
}

function numeric(value) {
  if (value == null) return null
  const parsed = Number(String(value).replace(/[,$]/g, ''))
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * The keyless parser. Exported on its own so tests can pin its behaviour
 * without an API key in sight.
 */
export function parseListingText(raw) {
  const text = String(raw ?? '').slice(0, MAX_CHARS)
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  const address = match(text, ADDRESS)
  const cityStateZip = text.match(CITY_STATE_ZIP)

  // "$28.50/SF", "$28.50 per SF", "$28.50 PSF"
  const rentRate = numeric(
    match(text, /\$\s?([\d,]+(?:\.\d+)?)\s*(?:\/|per\s+)?(?:SF|PSF|sq\.?\s?ft)/i),
  )

  // "NNN: $8.25", "$8.25 NNN", "triple nets ... $12"
  const nnn = numeric(
    match(text, /NNN[:\s]*\$?\s?([\d,]+(?:\.\d+)?)/i) ??
      match(text, /\$\s?([\d,]+(?:\.\d+)?)\s*(?:\/|per\s+)?(?:SF|PSF)?\s*NNN/i) ??
      match(text, /triple\s*nets?[^$\d]{0,20}\$?\s?([\d,]+(?:\.\d+)?)/i),
  )

  // The biggest square footage mentioned is almost always the building.
  let sizeSqft = null
  for (const found of text.matchAll(/([\d,]{3,})\s*(?:SF|sq\.?\s?ft|square\s*feet)/gi)) {
    const value = numeric(found[1])
    if (value != null && (sizeSqft == null || value > sizeSqft)) sizeSqft = value
  }

  const yearBuilt = numeric(
    match(text, /(?:year\s*built|built(?:\s*in)?)[:\s]*(\d{4})/i),
  )
  const zoning = match(text, /zon(?:ing|ed)[:\s]*([A-Z]{1,4}[0-9-]{0,6})\b/i)
  const acreage = numeric(match(text, /([\d.]+)\s*acres?\b/i))
  const parkingSpaces = numeric(
    match(text, /(\d{1,5})\s*(?:parking\s*)?(?:spaces|stalls)\b/i),
  )
  const brokerEmail = match(text, /\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/)
  const brokerPhone = match(text, /(\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4})/)

  // The first line that is not the address itself usually names the property.
  const name =
    lines.find(
      (line) =>
        line.length >= 4 &&
        line.length <= 90 &&
        !(address && line.includes(address)) &&
        !/@|\$|^\d/.test(line),
    ) ?? null

  const fields = {
    name,
    address,
    city: cityStateZip?.[1]?.trim() ?? null,
    state: cityStateZip?.[2] ?? null,
    zip: cityStateZip?.[3] ?? null,
    rentRate,
    rentUnit: rentRate != null ? 'psf/yr' : null,
    nnn,
    sizeSqft,
    acreage,
    parkingSpaces,
    zoning,
    yearBuilt,
    availability: match(text, /availab(?:le|ility)[:\s]*([^\n.]{2,60})/i),
    listingBroker: null,
    brokerEmail,
    brokerPhone,
    notes: text.length <= 2000 ? text : `${text.slice(0, 2000)}…`,
    // A regex cannot vouch for itself: everything it pulled needs a glance.
    confidence: 'low',
    uncertainFields: ['rentRate', 'nnn', 'sizeSqft'].filter(
      (key) => ({ rentRate, nnn, sizeSqft })[key] != null,
    ),
  }

  // A name alone is any first line of any email; only a fact about the
  // property itself makes the text a listing.
  const found = Object.entries(fields).filter(
    ([key, value]) =>
      value != null && !['name', 'notes', 'confidence', 'uncertainFields', 'rentUnit'].includes(key),
  )
  if (found.length === 0) {
    throw new FlyerExtractionError(
      'Nothing recognisable in that text — no address, rate, or size. Paste the listing details, or enter them by hand.',
    )
  }
  return fields
}

/**
 * Pasted text, extracted — by the model when a key is configured, by the
 * heuristics when not. Never refuses for want of a key: unlike a flyer image,
 * text is parseable either way, just less confidently.
 */
export async function extractFromText(raw, { env = {}, client } = {}) {
  const text = String(raw ?? '').trim()
  if (text.length < 20) {
    throw new FlyerExtractionError('Paste the listing details — a line or two is not enough to read.')
  }

  if (client || isConfigured(env)) {
    try {
      const { extractTextWithModel } = await import('./flyer.js')
      const result = await extractTextWithModel(text, { env, client })
      return { fields: result.fields, source: 'ai', model: result.model }
    } catch (error) {
      // The model failing must not cost the paste: fall back to heuristics,
      // which is where a keyless deployment starts anyway.
      if (!(error instanceof FlyerExtractionError) || error.configured === false) {
        return { fields: parseListingText(text), source: 'heuristic', model: null }
      }
      throw error
    }
  }

  return { fields: parseListingText(text), source: 'heuristic', model: null }
}
