/**
 * The brain panel: a question, and optionally a spreadsheet, answered as a
 * set of parcels to show on the map or a file to download.
 *
 * The work is split so that the expensive part happens once. A model reads
 * the question, the upload's column names and three sample rows, and writes
 * a plan: which filters, which zoning, in or out of the flood zone, which
 * column holds the address, show or export. That is one small call, a
 * fraction of a cent. Everything after it is ordinary code: every row of the
 * upload is parsed and matched to a parcel without a model, every parcel is
 * checked against the county's zoning and FEMA's flood tiles by geometry,
 * and the result is the same every time the same plan runs.
 *
 * Without an AI key the rules in scout.js and below read the question
 * instead, and say so.
 */

import { heuristicScout, normalizeScout } from './scout.js'
import { askJson } from './ai.js'
import { guessColumns } from './addresses.js'

/** The most upload rows one ask reads. A spreadsheet past this is split. */
export const UPLOAD_ROWS = 2000

/** The most parcels one ask checks against zoning and flood. */
export const CHECK_LIMIT = 3000

/**
 * How many records an answer the AI planned hands back at once.
 *
 * The model reads the question once whatever the size of the answer, so
 * this is not about the model's cost per record: it keeps an AI-planned
 * answer to a list a person can read, and the next hundred are asked for
 * with the same plan, so they cost no second model call. An answer the free
 * rules planned comes back whole.
 */
export const AI_PAGE = 100

const ACTIONS = new Set(['show', 'export', 'count'])

const lower = (value) => String(value ?? '').trim().toLowerCase()

/**
 * A plan, whatever wrote it, reduced to what this market can actually do.
 *
 * Asset types, zoning categories and zoning codes are clamped to the ones
 * the county publishes, in the county's own spelling, because a filter on a
 * name the county never uses silently matches nothing. The flood filter is
 * dropped for a market with no flood layer, and upload columns are dropped
 * when the file has no such header.
 */
export function normalizePlan(raw, vocab = {}, headers = []) {
  const { filters } = normalizeScout(raw ?? {}, vocab)
  const clamp = (wanted, published) => {
    const byLower = new Map((published ?? []).map((entry) => [lower(entry), entry]))
    return [...new Set((Array.isArray(wanted) ? wanted : []).map((w) => byLower.get(lower(w))).filter(Boolean))]
  }
  const flood = raw?.flood === 'in' || raw?.flood === 'out' ? raw.flood : null
  const header = new Map(headers.map((h) => [lower(h), h]))
  const column = (name) => (name ? header.get(lower(name)) ?? null : null)
  const guessed = guessColumns(headers)
  const columns = headers.length
    ? {
        address: column(raw?.columns?.address) ?? guessed.address,
        city: column(raw?.columns?.city) ?? guessed.city,
        zip: column(raw?.columns?.zip) ?? guessed.zip,
        parcel: column(raw?.columns?.parcel) ?? guessed.parcel,
      }
    : null
  return {
    action: ACTIONS.has(raw?.action) ? raw.action : 'show',
    ...filters,
    zoningCategories: clamp(raw?.zoningCategories, vocab.zoningCategories),
    // "Anything but residential": categories to leave out.
    zoningNot: clamp(raw?.zoningNot, vocab.zoningCategories),
    zoningCodes: clamp(raw?.zoningCodes, vocab.zoningCodes),
    flood: vocab.hasFlood ? flood : null,
    columns,
    explanation: typeof raw?.explanation === 'string' ? raw.explanation.slice(0, 300) : null,
  }
}

/** Whether the plan needs the overlay check, which the parcel store cannot answer. */
export function needsOverlay(plan) {
  return Boolean(plan.flood || plan.zoningCategories.length || plan.zoningCodes.length || plan.zoningNot?.length)
}

/*
 * Words that turn a zoning category round: "anything but residential",
 * "not industrial", "except commercial", "other than", "excluding",
 * "non-residential". Read from the few words just before the category.
 */
const NEGATION = /(?:\bbut|\bother than|\bnot|\bexcept(?:ing)?|\bexclud(?:e|ing)|\bwithout|\bnon-?|\bno)\s*(?:\w+\s+){0,2}$/i

/**
 * The free reading of a question: the scout's rules for the parcel filters,
 * plus the three things the brain adds, what to do with the answer, the
 * flood zone, and zoning named by category or code.
 */
export function heuristicPlan(prompt, vocab = {}, headers = []) {
  const text = String(prompt ?? '')
  const base = heuristicScout(text, vocab)
  const raw = { ...base.filters }

  if (/\b(export|download|csv|spreadsheet|excel|file|send me|list them)\b/i.test(text)) raw.action = 'export'
  else if (/\bhow many\b|\bcount\b/i.test(text)) raw.action = 'count'
  else raw.action = 'show'

  if (/flood/i.test(text)) {
    raw.flood = /\b(not|outside|out of|no|avoid|avoiding|exclude|excluding|without|free of|clear of|dry)\b[^.]{0,30}flood|flood[^.]{0,12}\b(free|clear)\b/i.test(text)
      ? 'out'
      : 'in'
  }

  if (/zon(ed|ing|e)\b/i.test(text) || /\bnon-?\w/i.test(text)) {
    const words = lower(text)
    raw.zoningCategories = []
    raw.zoningNot = []
    for (const category of vocab.zoningCategories ?? []) {
      const head = lower(category).split(/[\s/]+/)[0]
      if (head.length <= 3) continue
      const at = words.indexOf(head)
      if (at < 0) continue
      const before = words.slice(Math.max(0, at - 40), at)
      if (NEGATION.test(before)) raw.zoningNot.push(category)
      else raw.zoningCategories.push(category)
    }
    // A code is matched as written, whole: "C-2" or "PD", never inside a word.
    const tokens = new Set(text.split(/[^A-Za-z0-9.-]+/).filter(Boolean).map((t) => t.toUpperCase()))
    raw.zoningCodes = (vocab.zoningCodes ?? []).filter((code) => tokens.has(String(code).toUpperCase()))
    // The category words were about zoning, not the assessor's land use:
    // "industrial zoning" is not a request for parcels the county taxes as
    // industrial.
    if (raw.zoningCategories.length || raw.zoningNot.length || raw.zoningCodes.length) raw.assetTypes = []
  }

  const plan = normalizePlan(raw, vocab, headers)
  const empty =
    base.empty && !plan.flood && !plan.zoningCategories.length && !plan.zoningNot.length && !plan.zoningCodes.length && !headers.length
  return { plan, empty }
}

/**
 * What the model is told. The vocabulary is the county's own, so the model
 * picks from it rather than inventing names, and the sample rows let it name
 * the address column in a file whose headers say "Site" or "Location".
 */
export function planPrompt(prompt, vocab = {}, upload = null) {
  const list = (items, cap) => (items ?? []).slice(0, cap).map((item) => JSON.stringify(item)).join(', ') || 'none'
  const system = [
    'You turn a commercial real estate request into a JSON plan for a parcel map. Reply with JSON only.',
    'Keys: action ("show" to put parcels on the map, "export" for a downloadable file, "count" for a number),',
    'assetTypes (array, from the list given), valueMin, valueMax (dollars), acresMin, acresMax,',
    'keyword (an owner or street name to search, or null), flood ("in" for parcels in a FEMA special flood',
    'hazard area, "out" for parcels outside one, or null), zoningCategories and zoningCodes (arrays, from the',
    'lists given, to include), zoningNot (array of zoning categories to leave out: "anything but residential"',
    'is zoningNot ["Residential"], not zoningCategories), columns ({address, city, zip, parcel}: the upload header names holding each, or null),',
    'and explanation (one sentence saying what will be done). Use only names from the lists given.',
    'Leave anything the request does not ask for as null or an empty array.',
  ].join(' ')
  const lines = [
    `Request: ${String(prompt).slice(0, 600)}`,
    `Asset types in this county: ${list(vocab.assetTypes, 60)}`,
    `Zoning categories: ${list(vocab.zoningCategories, 40)}`,
    `Zoning codes: ${list(vocab.zoningCodes, 150)}`,
    `Flood data available: ${vocab.hasFlood ? 'yes' : 'no'}`,
  ]
  if (upload) {
    lines.push(`Upload columns: ${list(upload.headers, 60)}`)
    for (const row of upload.sample.slice(0, 3)) {
      const cells = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, String(v).slice(0, 60)]))
      lines.push(`Sample row: ${JSON.stringify(cells)}`)
    }
  }
  return { system, user: lines.join('\n') }
}

/** One model call, normalized. Throws on a provider failure so the caller can fall back to the rules. */
export async function aiPlan(prompt, vocab, upload, provider, env, options = {}) {
  const raw = await askJson(provider, planPrompt(prompt, vocab, upload), env, options)
  return normalizePlan(raw, vocab, upload?.headers ?? [])
}

// --- running a plan ----------------------------------------------------------

/** Whether one parcel's own fields pass the plan's attribute filters. */
export function passesAttributes(parcel, plan) {
  if (plan.assetTypes.length && !plan.assetTypes.includes(parcel.at)) return 'Asset type is not one asked for'
  const value = Number(parcel.mv)
  if (plan.valueMin != null && !(value >= plan.valueMin)) return 'Value below the floor asked for'
  if (plan.valueMax != null && !(value <= plan.valueMax)) return 'Value above the ceiling asked for'
  const acres = Number(parcel.ac)
  if (plan.acresMin != null && !(acres >= plan.acresMin)) return 'Lot smaller than asked for'
  if (plan.acresMax != null && !(acres <= plan.acresMax)) return 'Lot larger than asked for'
  if (plan.keyword) {
    const hay = `${parcel.ad ?? ''} ${parcel.ow ?? ''} ${parcel.gid ?? ''}`.toLowerCase()
    if (!hay.includes(plan.keyword.toLowerCase())) return `Does not mention "${plan.keyword}"`
  }
  return null
}

/** Whether the overlay answers pass. Null reasons pass; a string says why not. */
export function passesOverlay(check, plan) {
  if (plan.flood) {
    if (!check.flood) return 'Flood zone could not be read'
    const wet = check.flood.status !== 'out'
    if (plan.flood === 'in' && !wet) return 'Not in a flood hazard area'
    if (plan.flood === 'out' && wet) return `In flood zone ${check.flood.zones.join(', ') || check.flood.zone || ''}`.trim()
  }
  if (plan.zoningNot?.length) {
    if (!check.zoning) return 'Zoning could not be read'
    if (!check.zoning.code && !check.zoning.category) return 'No zoning district mapped here'
    if (plan.zoningNot.includes(check.zoning.category)) {
      return `Zoned ${[check.zoning.code, check.zoning.category ? `(${check.zoning.category})` : null].filter(Boolean).join(' ')}`
    }
  }
  if (plan.zoningCategories.length || plan.zoningCodes.length) {
    if (!check.zoning) return 'Zoning could not be read'
    const byCategory = plan.zoningCategories.includes(check.zoning.category)
    const byCode = plan.zoningCodes.map(lower).includes(lower(check.zoning.code))
    if (!byCategory && !byCode) return check.zoning.code ? `Zoned ${check.zoning.code}` : 'No zoning district mapped here'
  }
  return null
}

/** A sentence describing the plan, for when no model wrote one. */
export function describePlan(plan, { upload = false } = {}) {
  const parts = []
  if (plan.assetTypes.length) parts.push(plan.assetTypes.join(' or '))
  if (plan.acresMin != null) parts.push(`${plan.acresMin}+ acres`)
  if (plan.acresMax != null) parts.push(`up to ${plan.acresMax} acres`)
  if (plan.valueMin != null) parts.push(`worth $${Number(plan.valueMin).toLocaleString()}+`)
  if (plan.valueMax != null) parts.push(`worth up to $${Number(plan.valueMax).toLocaleString()}`)
  if (plan.zoningCategories.length || plan.zoningCodes.length) {
    parts.push(`zoned ${[...plan.zoningCategories, ...plan.zoningCodes].join(' or ')}`)
  }
  if (plan.zoningNot?.length) parts.push(`zoned anything but ${plan.zoningNot.join(' or ')}`)
  if (plan.flood === 'in') parts.push('in a FEMA flood hazard area')
  if (plan.flood === 'out') parts.push('outside FEMA flood hazard areas')
  if (plan.keyword) parts.push(`mentioning "${plan.keyword}"`)
  const what = upload ? 'Matching your list to parcels' : 'Finding parcels'
  const verb = plan.action === 'export' ? ', as a file' : plan.action === 'count' ? ', counted' : ', on the map'
  return `${what}${parts.length ? `: ${parts.join(', ')}` : ''}${verb}.`
}
