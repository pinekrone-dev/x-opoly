/**
 * TypeSafe's Jev: a calibrated yes-or-no judge.
 *
 * Jev takes some context (the "state") and named yes/no questions and answers
 * each with a probability. It writes no text and keeps nothing between calls,
 * so everything it knows arrives in the request, and a question costs a few
 * hundred input tokens, fractions of a thousandth of a dollar.
 *
 * It is used for the two things rules cannot do well: rating a parcel against
 * the part of a question no column answers ("would this suit a car wash?"),
 * and settling an uploaded address that nearly matches a parcel. Three rules,
 * the same as the pipeline's client (prospector/pipeline/jev.py):
 *
 * - Optional. With no TYPESAFE_API_KEY every answer is null, which callers
 *   treat as "not judged", never as a no.
 * - Bounded. A judge is made per request with a ceiling on calls.
 * - Never breaks an answer. A refused, slow or malformed reply is null.
 */

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone'

/** Most questions one request may ask, whatever it is handed. */
export const JEV_MAX_CALLS = 250

/** How many questions are in flight at once. */
const PARALLEL = 8

export function jevEnabled(env = {}) {
  return Boolean(env.TYPESAFE_API_KEY)
}

/**
 * A judge for one request. `ask(state, question)` resolves to a probability
 * between 0 and 1, or null; `many(items)` asks a list of them eight at a time
 * and resolves to their answers in order.
 */
export function createJev(env = {}, { fetchImpl = fetch, maxCalls = JEV_MAX_CALLS, timeoutMs = 20000 } = {}) {
  const key = env.TYPESAFE_API_KEY || ''
  const model = env.TYPESAFE_MODEL || 'jev-latest'
  let calls = 0
  let inputTokens = 0
  let failures = 0

  async function ask(state, question) {
    if (!key || calls >= maxCalls) return null
    calls += 1
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
    try {
      const response = await fetchImpl(JEV_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          state: String(state).slice(0, 4000),
          questions: { q: { type: 'noul', instructions: String(question).slice(0, 600) } },
        }),
        signal: controller?.signal,
      })
      if (!response.ok) {
        failures += 1
        return null
      }
      const doc = await response.json()
      inputTokens += Number(doc?.usage?.input_tokens) || 0
      const value = Number(doc?.answers?.q?.noul)
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        failures += 1
        return null
      }
      return value
    } catch {
      failures += 1
      return null
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async function many(items) {
    const out = new Array(items.length).fill(null)
    let next = 0
    const worker = async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await ask(items[i].state, items[i].question)
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker))
    return out
  }

  return {
    enabled: Boolean(key),
    ask,
    many,
    spent: () => ({ calls, inputTokens, failures }),
  }
}

const money = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? `$${Math.round(Number(v)).toLocaleString()}` : null)

/**
 * A parcel as the context Jev reads: only the county's own public record and
 * what the map's layers say about it. Nothing a customer uploaded.
 */
export function parcelState(parcel, extra = {}) {
  const facts = [
    parcel.ad ? `Address: ${parcel.ad}` : null,
    parcel.at ? `Land use on the assessment roll: ${parcel.at}` : null,
    money(parcel.mv) ? `Assessed value: ${money(parcel.mv)}` : null,
    Number(parcel.ac) > 0 ? `Lot size: ${Math.round(Number(parcel.ac) * 100) / 100} acres` : null,
    extra.zoning ? `Zoning: ${extra.zoning}` : null,
    extra.flood ? `FEMA flood hazard area: ${extra.flood}` : null,
    parcel.yb ? `Year built: ${parcel.yb}` : null,
    parcel.sf ? `Building area: ${parcel.sf} sq ft` : null,
  ].filter(Boolean)
  return `A land parcel from a US county assessment roll. ${facts.join('. ')}.`
}
