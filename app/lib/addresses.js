/**
 * Street addresses from an upload, matched to parcels without a model.
 *
 * A broker's spreadsheet writes "3401 Bayshore Boulevard, Unit 401, Tampa FL
 * 33629"; the county roll writes "3401 Bayshore Blvd 401". Both are reduced
 * to the same parts here, a house number, a street, a unit, a zip, and
 * compared part by part, so the match is the same every time and costs one
 * indexed text lookup per row rather than a model call per row.
 *
 * The lookup asks the text index for the house number and the first word of
 * the street, which is selective enough to return a handful of rows even in
 * a county of two million, and the comparison below decides among them.
 * Nothing is guessed: a row whose number and street do not both agree with a
 * parcel is reported unmatched, with the reason, rather than pinned to the
 * nearest thing.
 */

const SUFFIX = {
  STREET: 'ST', STR: 'ST', ST: 'ST',
  AVENUE: 'AVE', AV: 'AVE', AVE: 'AVE',
  BOULEVARD: 'BLVD', BLV: 'BLVD', BLVD: 'BLVD',
  DRIVE: 'DR', DRV: 'DR', DR: 'DR',
  ROAD: 'RD', RD: 'RD',
  LANE: 'LN', LN: 'LN',
  COURT: 'CT', CT: 'CT',
  PLACE: 'PL', PL: 'PL',
  PARKWAY: 'PKWY', PKY: 'PKWY', PKWY: 'PKWY',
  HIGHWAY: 'HWY', HWY: 'HWY',
  TERRACE: 'TER', TERR: 'TER', TER: 'TER',
  CIRCLE: 'CIR', CIR: 'CIR',
  TRAIL: 'TRL', TRL: 'TRL',
  WAY: 'WAY',
  SQUARE: 'SQ', SQ: 'SQ',
  EXPRESSWAY: 'EXPY', EXPY: 'EXPY',
  FREEWAY: 'FWY', FWY: 'FWY',
  PIKE: 'PIKE',
  LOOP: 'LOOP',
  ALLEY: 'ALY', ALY: 'ALY',
  CROSSING: 'XING', XING: 'XING',
  POINT: 'PT', PT: 'PT',
}

const DIRECTION = {
  NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W',
  NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW',
  N: 'N', S: 'S', E: 'E', W: 'W', NE: 'NE', NW: 'NW', SE: 'SE', SW: 'SW',
}

const ORDINAL = {
  FIRST: '1ST', SECOND: '2ND', THIRD: '3RD', FOURTH: '4TH', FIFTH: '5TH',
  SIXTH: '6TH', SEVENTH: '7TH', EIGHTH: '8TH', NINTH: '9TH', TENTH: '10TH',
}

const UNIT_WORDS = /^(APT|APARTMENT|UNIT|STE|SUITE|BLDG|BUILDING|FL|FLOOR|RM|ROOM|SPC|SPACE|LOT|#)$/

/**
 * One address in parts. `street` is the name without its type or direction,
 * which is what two spellings of the same street have in common.
 */
export function parseAddress(text) {
  const raw = String(text ?? '').toUpperCase().replace(/\s+/g, ' ').trim()
  if (!raw) return null
  const zip = raw.match(/\b(\d{5})(?:-\d{4})?\s*$/)?.[1] ?? null
  // The street line is what comes before the first comma; city and state
  // follow it in every format a spreadsheet uses.
  const line = raw.split(',')[0].replace(/[.]/g, '').replace(/#\s*/g, '# ')
  const words = line.split(/[\s]+/).filter(Boolean)
  const number = words[0] && /^\d+[A-Z]?(-\d+[A-Z]?)?$/.test(words[0]) ? words.shift() : null
  if (!number) return { number: null, street: null, suffix: null, direction: null, unit: null, zip }

  let unit = null
  const kept = []
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    if (UNIT_WORDS.test(word)) {
      unit = words[i + 1] ?? unit
      break
    }
    if (word.startsWith('#')) {
      unit = word.slice(1) || words[i + 1] || unit
      break
    }
    kept.push(word)
  }
  // A trailing bare number after the street type is a unit ("... Blvd 401").
  let suffix = null
  let direction = null
  const street = []
  for (let i = 0; i < kept.length; i++) {
    const word = kept[i]
    const later = kept.slice(i + 1)
    if (i === 0 && DIRECTION[word] && kept.length > 1) {
      direction = DIRECTION[word]
      continue
    }
    if (SUFFIX[word] && street.length && !later.some((w) => SUFFIX[w])) {
      suffix = SUFFIX[word]
      // Whatever follows the type is a post-direction or a unit.
      for (const rest of later) {
        if (DIRECTION[rest] && !direction) direction = DIRECTION[rest]
        else if (!unit && /^\d+[A-Z]?$|^[A-Z]$/.test(rest)) unit = rest
      }
      break
    }
    street.push(ORDINAL[word] ?? word)
  }
  if (!suffix && street.length > 1 && /^\d+[A-Z]?$/.test(street[street.length - 1]) && !/^\d+(ST|ND|RD|TH)$/.test(street[street.length - 1])) {
    unit = unit ?? street.pop()
  }
  // "…Boulevard, Unit 401, Tampa": a unit written as its own comma segment.
  if (!unit) {
    for (const segment of raw.split(',').slice(1)) {
      const found = segment.trim().replace(/[.]/g, '').match(/^(?:APT|APARTMENT|UNIT|STE|SUITE|RM|ROOM|SPC|SPACE|#)\s*#?\s*([A-Z0-9-]+)$/)
      if (found) {
        unit = found[1]
        break
      }
    }
  }
  return {
    number,
    street: street.join(' ') || null,
    suffix,
    direction,
    unit: unit ? unit.replace(/^0+(?=\d)/, '') : null,
    zip,
  }
}

/** How well a parcel's address answers a row's: 'exact', 'street', or null for not this parcel. */
export function compareAddress(wanted, found) {
  if (!wanted?.number || !wanted.street || !found?.number || !found.street) return null
  if (wanted.number !== found.number) return null
  if (wanted.street !== found.street) return null
  if (wanted.suffix && found.suffix && wanted.suffix !== found.suffix) return null
  if (wanted.direction && found.direction && wanted.direction !== found.direction) return null
  if ((wanted.unit ?? null) !== (found.unit ?? null)) return wanted.unit && found.unit ? null : 'street'
  return 'exact'
}

/**
 * Matches rows to parcels. `lookup(words)` returns candidate parcels whose
 * text holds those words (the route answers it from the market's text
 * index); each row comes back with its parcel, or none and why.
 */
export async function matchAddresses(rows, lookup) {
  const out = []
  for (const row of rows) {
    const parts = parseAddress(row.address)
    if (!parts?.number || !parts.street) {
      out.push({ ...row, parcel: null, match: 'none', why: row.address ? 'No house number and street to match' : 'No address in this row' })
      continue
    }
    const firstWord = parts.street.split(' ')[0]
    const candidates = await lookup(`${parts.number} ${firstWord}`)
    let best = null
    let bestStrength = null
    let ties = 0
    for (const candidate of candidates) {
      const strength = compareAddress(parts, parseAddress(candidate.ad))
      if (!strength) continue
      const zipOk = !(parts.zip || row.zip) || !candidate.zp || String(candidate.zp).startsWith(parts.zip || row.zip)
      if (!zipOk) continue
      const rank = strength === 'exact' ? 2 : 1
      const bestRank = bestStrength === 'exact' ? 2 : bestStrength ? 1 : 0
      if (rank > bestRank) {
        best = candidate
        bestStrength = strength
        ties = 0
      } else if (rank === bestRank) {
        ties += 1
      }
    }
    if (!best) {
      out.push({ ...row, parcel: null, match: 'none', why: 'No parcel on the roll at that number and street' })
    } else {
      out.push({
        ...row,
        parcel: best,
        match: bestStrength,
        why:
          bestStrength === 'exact'
            ? ties
              ? `Matched; ${ties + 1} parcels share this address`
              : 'Matched'
            : `Matched the building; ${ties + 1} units on the roll at this address`,
      })
    }
  }
  return out
}

/*
 * Which column holds what, from the header alone.
 *
 * The model is told these guesses and may correct them, but an upload with
 * ordinary headers never needs it: "Address", "Street", "Property Address",
 * "City", "Zip" are read here for free.
 */
const COLUMN_HINTS = {
  address: [/^(property |site |street |situs |mailing )?address( line)?( 1)?$/i, /^street$/i, /^addr/i, /^location$/i, /address/i],
  city: [/^city$/i, /^(property |site )?city/i, /^town$/i],
  zip: [/^zip/i, /^postal/i, /zip ?code/i],
  parcel: [/^(apn|pin|folio|parcel( id| number| no\.?)?|parcel_?id|bbl|account)$/i, /parcel/i, /\bapn\b/i],
}

export function guessColumns(headers) {
  const pick = (hints) => {
    for (const hint of hints) {
      const found = headers.find((h) => hint.test(String(h).trim()))
      if (found) return found
    }
    return null
  }
  return {
    address: pick(COLUMN_HINTS.address),
    city: pick(COLUMN_HINTS.city),
    zip: pick(COLUMN_HINTS.zip),
    parcel: pick(COLUMN_HINTS.parcel),
  }
}
