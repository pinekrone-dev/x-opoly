/**
 * What a parcel's record says about its owner's position: how long they have
 * held it, whether a loan from the purchase is likely paid off, and whether
 * they live in another state.
 *
 * None of the three is published as such. They are read off two things most
 * counties do publish — the last sale date and the owner's mailing address —
 * and the rules for reading them live here, once, for both paths: the server
 * applies them in SQL to the record it holds, and the pipeline applies the
 * same rules (prospector's pipeline/owner_traits.py) to the markets served from files.
 *
 *   Sale year. `sd` is not the same field everywhere (Austin's is a
 *   subdivision code, DC's a neighbourhood), so a value counts only when it
 *   is shaped like a date: YYYY-MM-DD, YYYY-MM, or MM-DD-YYYY as Travis
 *   writes its deed dates. `sd` first, then `dd`.
 *
 *   Mailing state. Read from the ZIP code, not the state letters. Counties
 *   write the state as "AZ", "Az", "N J", or not at all (Orange County ends
 *   "Irvine 92602-2304"), but every one of them ends the address on a ZIP,
 *   and the first three digits of a ZIP name its state.
 *
 *   Likely free and clear. No county here publishes mortgages; the recorder
 *   holds them and none of these rolls carry them. So this is an inference
 *   and is labelled as one: the last sale was thirty or more years ago, so a
 *   thirty-year loan taken out to buy it would have run its course. A
 *   refinance since would not show. The card says so.
 */

export const HELD_YEARS = 10
export const FREE_CLEAR_YEARS = 30

/*
 * ZIP prefixes by state, as USPS assigns them. [first, last, state].
 * Military (AA, AE, AP) and the territories are listed so an owner mailing
 * from an APO reads as out of state rather than unknown.
 */
export const ZIP3: [number, number, string][] = [
  [5, 5, 'NY'], [6, 7, 'PR'], [8, 8, 'VI'], [9, 9, 'PR'],
  [10, 27, 'MA'], [28, 29, 'RI'], [30, 38, 'NH'], [39, 49, 'ME'],
  [50, 54, 'VT'], [55, 55, 'MA'], [56, 59, 'VT'], [60, 69, 'CT'],
  [70, 89, 'NJ'], [90, 99, 'AE'], [100, 149, 'NY'], [150, 196, 'PA'],
  [197, 199, 'DE'], [200, 200, 'DC'], [201, 201, 'VA'], [202, 205, 'DC'],
  [206, 219, 'MD'], [220, 246, 'VA'], [247, 268, 'WV'], [270, 289, 'NC'],
  [290, 299, 'SC'], [300, 319, 'GA'], [320, 339, 'FL'], [340, 340, 'AA'],
  [341, 349, 'FL'], [350, 369, 'AL'], [370, 385, 'TN'], [386, 397, 'MS'],
  [398, 399, 'GA'], [400, 427, 'KY'], [430, 459, 'OH'], [460, 479, 'IN'],
  [480, 499, 'MI'], [500, 528, 'IA'], [530, 549, 'WI'], [550, 567, 'MN'],
  [569, 569, 'DC'], [570, 577, 'SD'], [580, 588, 'ND'], [590, 599, 'MT'],
  [600, 629, 'IL'], [630, 658, 'MO'], [660, 679, 'KS'], [680, 693, 'NE'],
  [700, 714, 'LA'], [716, 729, 'AR'], [730, 732, 'OK'], [733, 733, 'TX'],
  [734, 749, 'OK'], [750, 799, 'TX'], [800, 816, 'CO'], [820, 831, 'WY'],
  [832, 838, 'ID'], [840, 847, 'UT'], [850, 865, 'AZ'], [870, 884, 'NM'],
  [885, 885, 'TX'], [889, 898, 'NV'], [900, 961, 'CA'], [962, 966, 'AP'],
  [967, 968, 'HI'], [969, 969, 'GU'], [970, 979, 'OR'], [980, 994, 'WA'],
  [995, 999, 'AK'],
]

/** The state a ZIP prefix belongs to, or null. */
export function stateOfZip3(prefix: string | number): string | null {
  const n = Number(prefix)
  if (!Number.isInteger(n)) return null
  for (const [lo, hi, state] of ZIP3) if (n >= lo && n <= hi) return state
  return null
}

/** The ZIP an address ends on (ZIP+4 allowed), or null. */
export function mailingZip(text: unknown): string | null {
  const match = /(?:^|\D)(\d{5})(?:-\d{4})?\s*$/.exec(String(text ?? ''))
  return match ? match[1] : null
}

/** The state an owner's mail goes to, from the ZIP it ends on. */
export function mailingState(text: unknown): string | null {
  const zip = mailingZip(text)
  return zip ? stateOfZip3(zip.slice(0, 3)) : null
}

/** A market's own state, from the end of its slug: phoenix-az → AZ. */
export function marketState(market: unknown): string | null {
  const match = /-([a-z]{2})$/.exec(String(market ?? ''))
  return match ? match[1].toUpperCase() : null
}

/** The year of a date-shaped value, or null for anything that is not a date. */
export function yearOf(value: unknown): number | null {
  const text = String(value ?? '').trim()
  let match = /^([12]\d{3})-[01]\d(?:-[0-3]\d)?/.exec(text)
  if (!match) match = /^[01]\d[-/][0-3]\d[-/]([12]\d{3})/.exec(text)
  if (!match) return null
  const year = Number(match[1])
  return year >= 1800 && year <= new Date().getUTCFullYear() ? year : null
}

/** The last sale year a record carries, by the rule above. */
export function saleYear(record: Record<string, unknown> | null | undefined): number | null {
  if (!record) return null
  if (record.sy != null && Number.isFinite(Number(record.sy)) && Number(record.sy) > 0) return Number(record.sy)
  return yearOf(record.sd) ?? yearOf(record.dd)
}

/**
 * The three readings for one parcel, for the card. Each is null when the
 * record cannot say, which is different from false: a parcel with no sale
 * date on file is not "held under ten years".
 */
export interface OwnerTraits {
  saleYear: number | null
  heldYears: number | null
  held10: boolean | null
  freeClear: boolean | null
  mailState: string | null
  outOfState: boolean | null
}

export function ownerTraits(
  record: Record<string, unknown> | null | undefined,
  market: string | null | undefined,
  now = new Date(),
): OwnerTraits {
  const year = saleYear(record)
  const thisYear = now.getUTCFullYear()
  const mail = (typeof record?.ms === 'string' && record.ms) || mailingState(record?.ma)
  const home = marketState(market)
  return {
    saleYear: year,
    heldYears: year == null ? null : thisYear - year,
    held10: year == null ? null : year <= thisYear - HELD_YEARS,
    freeClear: year == null ? null : year <= thisYear - FREE_CLEAR_YEARS,
    mailState: mail ?? null,
    outOfState: mail && home ? mail !== home : null,
  }
}

/* ---------------------------------------------------------------- SQL --- */

// GLOB patterns are kept short and checked piece by piece: D1 refuses any
// LIKE or GLOB pattern over about fifty characters ("pattern too complex"),
// which a whole ZIP+4 written as one pattern exceeds.
const D4 = "'[0-9][0-9][0-9][0-9]'"
const D5 = "'[0-9][0-9][0-9][0-9][0-9]'"

// One date-shaped JSON field's year, as an SQL expression. json_extract
// reads the parsed document, which SQLite keeps for the row, so the
// repeated reads cost one parse.
const yearSql = (key: string) => {
  const v = `CAST(json_extract(rest, '$.${key}') AS TEXT)`
  return `(CASE
    WHEN substr(${v}, 1, 4) GLOB '[12][0-9][0-9][0-9]' AND substr(${v}, 5, 1) = '-'
      AND substr(${v}, 6, 2) GLOB '[01][0-9]'
      THEN CAST(substr(${v}, 1, 4) AS INTEGER)
    WHEN substr(${v}, 1, 2) GLOB '[01][0-9]' AND substr(${v}, 3, 1) IN ('-', '/')
      AND substr(${v}, 4, 2) GLOB '[0-3][0-9]' AND substr(${v}, 6, 1) IN ('-', '/')
      AND substr(${v}, 7, 4) GLOB '[12][0-9][0-9][0-9]'
      THEN CAST(substr(${v}, 7, 4) AS INTEGER)
  END)`
}

/** The sale year of a stored row, in SQL: a published `sy` first, then sd, then dd. */
export const SALE_YEAR_SQL = `COALESCE(CAST(json_extract(rest, '$.sy') AS INTEGER), ${yearSql('sd')}, ${yearSql('dd')})`

// The first three digits of the ZIP the mailing address ends on: five
// digits at the end, or five, a dash and four, with no digit before them.
const MA = `TRIM(CAST(json_extract(rest, '$.ma') AS TEXT))`
const ZIP3_SQL = `(CASE
    WHEN substr(${MA}, -4) GLOB ${D4} AND substr(${MA}, -5, 1) = '-'
      AND substr(${MA}, -10, 5) GLOB ${D5}
      AND (length(${MA}) = 10 OR substr(${MA}, -11, 1) NOT GLOB '[0-9]')
      THEN CAST(substr(${MA}, -10, 3) AS INTEGER)
    WHEN substr(${MA}, -5) GLOB ${D5}
      AND (length(${MA}) = 5 OR substr(${MA}, -6, 1) NOT GLOB '[0-9]')
      THEN CAST(substr(${MA}, -5, 3) AS INTEGER)
  END)`

/**
 * The WHERE clauses for the owner filters, with their parameters.
 *
 * With `columns`, read from the `sy` and `ms` columns a tagging pass wrote
 * (fast: plain columns). Without, parsed from the stored record in SQL,
 * which is correct but reads every row's JSON — a fallback for a market
 * not yet tagged, and the definition the tagging pass is checked against.
 *
 * `owners` is a list of 'held10', 'freeClear', 'outOfState'. Out of state
 * means the mail goes to a ZIP outside the market's state; an address with
 * no ZIP to read is left out, not counted as either.
 */
export function ownerClauses(
  owners: string[] = [],
  market: string,
  now = new Date(),
  { columns = false }: { columns?: boolean } = {},
) {
  const clauses: string[] = []
  const params: (string | number)[] = []
  const thisYear = now.getUTCFullYear()
  const picked = new Set(owners)
  if (picked.has('held10') || picked.has('freeClear')) {
    const years = picked.has('freeClear') ? FREE_CLEAR_YEARS : HELD_YEARS
    clauses.push(`${columns ? 'sy' : SALE_YEAR_SQL} <= ?`)
    params.push(thisYear - years)
  }
  if (picked.has('outOfState')) {
    const home = marketState(market)
    if (columns) {
      // NULL (no ZIP to read) drops out of <> by itself.
      clauses.push(home ? 'ms <> ?' : '0')
      if (home) params.push(home)
      return { clauses, params }
    }
    const ranges = ZIP3.filter(([, , state]) => state === home)
    if (!ranges.length) {
      // A market whose state this cannot place matches nothing rather than
      // everything: an "out of state" list that is really the whole county
      // would be the worse mistake.
      clauses.push('0')
    } else {
      // NOT IN against the state's own prefixes. An address with no ZIP
      // gives NULL, and NULL NOT IN (...) is NULL, so it drops out.
      const prefixes = ranges.flatMap(([lo, hi]) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i))
      clauses.push(`${ZIP3_SQL} NOT IN (SELECT value FROM json_each(?))`)
      params.push(JSON.stringify(prefixes))
    }
  }
  return { clauses, params }
}

export type OwnerFilter = 'held10' | 'freeClear' | 'outOfState'

export const OWNER_FILTERS: OwnerFilter[] = ['held10', 'freeClear', 'outOfState']
