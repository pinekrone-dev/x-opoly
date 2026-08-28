/**
 * The tour book's style: a handful of levers, not a theme engine.
 *
 * The designed book is the preset; these are the knobs a broker actually
 * turns on it — which cover, which accent, whether the schedule and QR ride
 * along, and a short word to the client on the cover. Everything else stays
 * the design's decision, because forty options is how a document stops
 * looking designed.
 *
 * The AI path maps a plain-English ask onto these same keys and nothing
 * else: a model can choose among the levers but cannot invent new ones.
 */

export const BOOK_DEFAULTS = {
  cover: 'navy',
  accent: '#01A3A8',
  showSchedule: true,
  showDetails: true,
  showQr: true,
  intro: null,
}

const HEX = /^#[0-9a-f]{6}$/i

/** Whatever arrived — a PATCH body, a model answer — as a valid style. */
export function normalizeBookStyle(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const style = { ...BOOK_DEFAULTS }
  if (input.cover === 'light' || input.cover === 'navy') style.cover = input.cover
  if (typeof input.accent === 'string' && HEX.test(input.accent.trim())) {
    style.accent = input.accent.trim().toLowerCase()
  }
  for (const key of ['showSchedule', 'showDetails', 'showQr']) {
    if (typeof input[key] === 'boolean') style[key] = input[key]
  }
  if (typeof input.intro === 'string') {
    const text = input.intro.trim().slice(0, 280)
    style.intro = text || null
  }
  return style
}

export const BOOK_STYLE_PROMPT = `You restyle a commercial real estate tour book. The book has exactly these style options and no others:
- cover: "navy" (dark cover) or "light" (white cover)
- accent: a hex colour like "#01a3a8", used for highlights
- showSchedule: boolean — whether the itinerary page with drive times is included
- showDetails: boolean — whether each stop page lists property details
- showQr: boolean — whether each stop carries a scan-for-directions code
- intro: a short note to the client printed on the cover (280 characters max), or null

You are given the current style and the broker's instruction. Apply only what the instruction asks; keep every other value as it is. If the instruction asks for something these options cannot express, ignore that part. If they ask for a colour by name, choose a tasteful hex for it.

Respond with a single JSON object holding exactly: cover, accent, showSchedule, showDetails, showQr, intro.`
