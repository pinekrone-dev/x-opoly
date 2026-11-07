/**
 * The landmarks that sell a site: colleges, hospitals, stadiums and arenas,
 * airports, malls, attractions, convention centres, military bases, and the
 * headquarters of major employers, each with the figure that says how big a
 * draw it is (students, seats, passengers, beds, employees).
 *
 * All from Wikidata's public query service, free and keyless. A landmark
 * there is notable by definition, which is the filter wanted: a campus, not
 * a tutoring centre. Three quick queries, none of them a full scan:
 *
 *   1. every item with coordinates near the point, with its types, through
 *      the service's geographic index;
 *   2. the types that count as each kind (every subtype of "hospital", of
 *      "higher education institution"...), worked out once per isolate, so
 *      matching the two is a set lookup here rather than a type walk there;
 *   3. the figures for the matches.
 *
 * Headquarters are a fourth: companies whose headquarters location (P159)
 * is a place near the point, with their employee count. Where Wikidata
 * gives the headquarters its own coordinates the distance is to them;
 * where it names only the city, the distance is to the city's centre and
 * the answer says so.
 */

import { commonsThumbs, safeLogo } from './logos.js'
import { haversineMiles } from './tour.js'

const SPARQL = 'https://query.wikidata.org/sparql'
const UA = 'LandQuotient/1.0 (https://landquotient.com; landmarks near a site)'
const ENTITY = 'http://www.wikidata.org/entity/'

/** Each kind, and the Wikidata classes whose every subtype counts as it. */
export const LANDMARK_KINDS = {
  // Many US colleges are typed only "public educational institution of the
  // United States", which takes in other schools too: those count as a
  // college only with a federal IPEDS id (P1771), which only colleges have.
  colleges: { label: 'Colleges & universities', classes: ['Q38723'], loose: ['Q23002039'], proof: 'P1771' },
  hospitals: { label: 'Hospitals', classes: ['Q16917'] },
  stadiums: { label: 'Stadiums & arenas', classes: ['Q483110', 'Q641226'] },
  airports: { label: 'Airports (commercial)', classes: ['Q1248784'] },
  malls: { label: 'Malls & shopping centres', classes: ['Q11315', 'Q31374404'] },
  attractions: { label: 'Theme parks, zoos & aquariums', classes: ['Q194195', 'Q43501', 'Q2281788'] },
  convention: { label: 'Convention centres', classes: ['Q1378975'] },
  military: { label: 'Military bases', classes: ['Q245016'] },
  headquarters: { label: 'Headquarters of major employers', classes: [] },
}

export class LandmarksUnavailable extends Error {
  constructor(message) {
    super(message)
    this.name = 'LandmarksUnavailable'
  }
}

async function sparql(fetchImpl, query, { timeout = 20000, accept = 'application/sparql-results+json' } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    // POST, so a long list of items is not a long URL.
    const response = await fetchImpl(SPARQL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept, 'user-agent': UA, 'api-user-agent': UA },
      body: `query=${encodeURIComponent(query)}`,
    })
    if (response.status === 429) throw new LandmarksUnavailable('Wikidata is rate limiting us. Wait a minute and try again.')
    if (!response.ok) throw new LandmarksUnavailable(`Wikidata's query service returned HTTP ${response.status}.`)
    return accept.includes('json') ? await response.json() : await response.text()
  } catch (error) {
    if (error instanceof LandmarksUnavailable) throw error
    if (error?.name === 'AbortError') throw new LandmarksUnavailable('Wikidata took too long to answer. Try a smaller radius.')
    throw new LandmarksUnavailable(`Wikidata could not be reached (${error.message}).`)
  } finally {
    clearTimeout(timer)
  }
}

const qid = (uri) => String(uri ?? '').replace(/^<|>$/g, '').replace(ENTITY, '')
const value = (binding, key) => binding?.[key]?.value
const number = (binding, key) => {
  const n = Number(value(binding, key))
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined
}

/** "Point(lng lat)" as {lat, lng}. */
export function pointOf(wkt) {
  const m = /Point\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/i.exec(String(wkt ?? ''))
  return m ? { lng: Number(m[1]), lat: Number(m[2]) } : null
}

// The subtypes of each kind's classes, which change on Wikidata's own clock.
let kindsOfType = null
let kindsAt = 0
const DAY = 24 * 60 * 60 * 1000

/** Map(type QID → kind), every subtype of every kind's classes. */
export async function typeKinds({ fetchImpl = fetch, now = Date.now() } = {}) {
  if (kindsOfType && now - kindsAt < DAY) return kindsOfType
  const pairs = Object.entries(LANDMARK_KINDS).flatMap(([kind, k]) => [
    ...k.classes.map((c) => `(wd:${c} "${kind}")`),
    ...(k.loose ?? []).map((c) => `(wd:${c} "${kind}?")`),
  ])
  const body = await sparql(fetchImpl, `SELECT ?sub ?kind WHERE { VALUES (?class ?kind) { ${pairs.join(' ')} } ?sub wdt:P279* ?class . }`)
  const map = new Map()
  for (const b of body?.results?.bindings ?? []) {
    const type = qid(value(b, 'sub'))
    // A type under two kinds (an arena that is also a convention centre)
    // keeps the first, the order of LANDMARK_KINDS; a strict match beats a
    // loose one ("colleges?", which needs proof).
    const kind = value(b, 'kind')
    if (!map.has(type) || (map.get(type).endsWith('?') && !kind.endsWith('?'))) map.set(type, kind)
  }
  if (!map.size) throw new LandmarksUnavailable('Wikidata returned no landmark types.')
  kindsOfType = map
  kindsAt = now
  return map
}

/** For tests. */
export function clearTypeKinds() {
  kindsOfType = null
  kindsAt = 0
}

const around = (lat, lng, km) =>
  `SERVICE wikibase:around { ?place wdt:P625 ?loc . bd:serviceParam wikibase:center "Point(${lng} ${lat})"^^geo:wktLiteral . bd:serviceParam wikibase:radius "${km}" . }`

/** Every item with coordinates within km, with its types: Map(item → [types]). Tab-separated, it is a third the size. */
async function nearbyItems(fetchImpl, lat, lng, km) {
  const text = await sparql(fetchImpl, `SELECT ?place ?t WHERE { ${around(lat, lng, km)} ?place wdt:P31 ?t . }`, {
    accept: 'text/tab-separated-values',
    timeout: 25000,
  })
  const items = new Map()
  for (const line of String(text).split('\n').slice(1)) {
    const [item, type] = line.split('\t')
    if (!item || !type) continue
    const id = qid(item.trim())
    const list = items.get(id) ?? []
    list.push(qid(type.trim()))
    items.set(id, list)
  }
  return items
}

/** The figures for these landmarks. */
async function details(fetchImpl, ids) {
  if (!ids.length) return []
  const query = `SELECT ?item ?itemLabel (SAMPLE(?loc) AS ?where) (MAX(?students) AS ?st) (MAX(?cap) AS ?capacity)
    (MAX(?pax) AS ?passengers) (MAX(?beds) AS ?bedcount) (SAMPLE(?iata) AS ?code) (SAMPLE(?logo) AS ?logoFile)
    (SAMPLE(?img) AS ?imageFile) (SAMPLE(?site) AS ?website) (SAMPLE(?ipeds) AS ?ipedsId)
    (GROUP_CONCAT(DISTINCT ?teamLabel; separator="|") AS ?teams)
    (GROUP_CONCAT(DISTINCT STR(?parent); separator=" ") AS ?parents) WHERE {
    VALUES ?item { ${ids.map((id) => `wd:${id}`).join(' ')} }
    ?item wdt:P625 ?loc .
    ?item rdfs:label ?itemLabel . FILTER(LANG(?itemLabel) = "en")
    FILTER NOT EXISTS { ?item wdt:P576 [] }
    FILTER NOT EXISTS { ?item wdt:P3999 [] }
    # Closed places: an end date, or decommissioned (Robert Mueller airport, 1999).
    FILTER NOT EXISTS { ?item wdt:P582 [] }
    FILTER NOT EXISTS { ?item wdt:P5817 wd:Q11639308 }
    OPTIONAL { ?item wdt:P2196 ?students }
    OPTIONAL { ?item wdt:P1083 ?cap }
    OPTIONAL { ?item wdt:P3872 ?pax }
    OPTIONAL { ?item wdt:P6801 ?beds }
    OPTIONAL { ?item wdt:P238 ?iata }
    OPTIONAL { ?item wdt:P154 ?logo }
    OPTIONAL { ?item wdt:P18 ?img }
    OPTIONAL { ?item wdt:P856 ?site }
    OPTIONAL { ?item wdt:P1771 ?ipeds }
    OPTIONAL { ?item wdt:P361|wdt:P749 ?parent . }
    OPTIONAL { ?item p:P466 ?occ . ?occ ps:P466 ?team . FILTER NOT EXISTS { ?occ pq:P582 [] }
               ?team rdfs:label ?teamLabel . FILTER(LANG(?teamLabel) = "en") }
  } GROUP BY ?item ?itemLabel`
  const body = await sparql(fetchImpl, query, { timeout: 25000 })
  return body?.results?.bindings ?? []
}

/** Companies headquartered near the point, with at least this many employees. */
async function headquarters(fetchImpl, lat, lng, km, minEmployees) {
  const query = `SELECT ?co ?coLabel (MAX(?e) AS ?employees) (SAMPLE(?hq) AS ?hqLoc) (SAMPLE(?loc) AS ?placeLoc)
    (SAMPLE(?placeLabel) AS ?inPlace) (SAMPLE(?logo) AS ?logoFile) (SAMPLE(?site) AS ?website)
    (GROUP_CONCAT(DISTINCT ?industryLabel; separator="|") AS ?industries)
    (GROUP_CONCAT(DISTINCT STR(?type); separator=" ") AS ?types) WHERE {
    ${around(lat, lng, km)}
    ?st ps:P159 ?place . ?co p:P159 ?st .
    FILTER NOT EXISTS { ?st pq:P582 [] }
    OPTIONAL { ?st pq:P625 ?hq }
    ?co wdt:P1128 ?e .
    FILTER NOT EXISTS { ?co wdt:P576 [] }
    OPTIONAL { ?co wdt:P31 ?type }
    ?place rdfs:label ?placeLabel . FILTER(LANG(?placeLabel) = "en")
    ?co rdfs:label ?coLabel . FILTER(LANG(?coLabel) = "en")
    OPTIONAL { ?co wdt:P154 ?logo }
    OPTIONAL { ?co wdt:P856 ?site }
    OPTIONAL { ?co wdt:P452 ?industry . ?industry rdfs:label ?industryLabel . FILTER(LANG(?industryLabel) = "en") }
  } GROUP BY ?co ?coLabel HAVING (MAX(?e) >= ${Math.max(1, Math.round(minEmployees))}) ORDER BY DESC(?employees) LIMIT 60`
  const body = await sparql(fetchImpl, query, { timeout: 25000 })
  return body?.results?.bindings ?? []
}

/** The figure that says how big a draw each kind is, for ranking. */
function size(l) {
  return l.students ?? l.capacity ?? l.passengers ?? l.beds ?? l.employees ?? 0
}

/**
 * Landmarks near a point.
 * @returns {Promise<{ landmarks: Array, byKind: Object, radiusMiles: number, source: string }>}
 * @throws {LandmarksUnavailable}
 */
export async function nearbyLandmarks({
  lat,
  lng,
  radiusMiles = 5,
  kinds = null,
  minEmployees = 1000,
  fetchImpl = fetch,
  logos = true,
} = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new LandmarksUnavailable('A point is needed: lat and lng.')
  const radius = Math.min(Math.max(Number(radiusMiles) || 5, 0.5), 15)
  const km = Math.round(radius * 1.609344 * 100) / 100
  const wanted = new Set((kinds?.length ? kinds : Object.keys(LANDMARK_KINDS)).filter((k) => LANDMARK_KINDS[k]))
  const places = [...wanted].some((k) => k !== 'headquarters')

  const [types, items, hqRows] = await Promise.all([
    places ? typeKinds({ fetchImpl }) : null,
    places ? nearbyItems(fetchImpl, lat, lng, km) : null,
    wanted.has('headquarters') ? headquarters(fetchImpl, lat, lng, km, minEmployees) : [],
  ])

  const kindOf = new Map()
  const needsProof = new Set()
  if (places) {
    for (const [id, list] of items) {
      const found = list.map((t) => types.get(t)).filter((k) => k && wanted.has(k.replace(/\?$/, '')))
      const kind = found.find((k) => !k.endsWith('?')) ?? found[0]
      if (!kind) continue
      kindOf.set(id, kind.replace(/\?$/, ''))
      if (kind.endsWith('?')) needsProof.add(id)
    }
  }
  const rows = places ? await details(fetchImpl, [...kindOf.keys()].slice(0, 400)) : []

  const origin = { lat, lng }
  const landmarks = []
  for (const b of rows) {
    const id = qid(value(b, 'item'))
    const kind = kindOf.get(id)
    const at = pointOf(value(b, 'where'))
    if (!kind || !at) continue
    if (needsProof.has(id) && !value(b, 'ipedsId')) continue
    // A school within a nearby university (its law school, a college of
    // engineering) is part of that campus, not a campus of its own. One
    // with its own enrolment stays: a university in a state system is
    // "part of" the system and is very much its own campus.
    if (kind === 'colleges' && !number(b, 'st') && String(value(b, 'parents') ?? '').split(' ').some((p) => kindOf.get(qid(p)) === 'colleges')) continue
    const code = value(b, 'code')
    // An airfield with no IATA code has no airline service.
    if (kind === 'airports' && !code) continue
    landmarks.push({
      kind,
      name: value(b, 'itemLabel'),
      miles: Math.round(haversineMiles(origin, at) * 100) / 100,
      lat: at.lat,
      lng: at.lng,
      students: number(b, 'st'),
      capacity: number(b, 'capacity'),
      passengers: number(b, 'passengers'),
      beds: number(b, 'bedcount'),
      iata: code || undefined,
      teams: value(b, 'teams') ? value(b, 'teams').split('|').filter(Boolean).slice(0, 6) : undefined,
      website: value(b, 'website') || undefined,
      logoFile: value(b, 'logoFile'),
      imageFile: value(b, 'imageFile'),
      wikidata: id,
    })
  }

  // Colleges and hospitals are employers too, but they have kinds of their own.
  const hqTypes = types ?? (hqRows.length ? await typeKinds({ fetchImpl }) : new Map())
  for (const b of hqRows) {
    const own = String(value(b, 'types') ?? '').split(' ').map((t) => hqTypes.get(qid(t)))
    if (own.includes('colleges') || own.includes('hospitals')) continue
    const exact = pointOf(value(b, 'hqLoc'))
    const city = pointOf(value(b, 'placeLoc'))
    const at = exact ?? city
    if (!at) continue
    const miles = Math.round(haversineMiles(origin, at) * 100) / 100
    // Exact coordinates outside the radius: the city is near, the office is not.
    if (exact && miles > radius) continue
    landmarks.push({
      kind: 'headquarters',
      name: value(b, 'coLabel'),
      miles,
      lat: at.lat,
      lng: at.lng,
      employees: number(b, 'employees'),
      located: exact ? 'exact' : `city: ${value(b, 'inPlace')}`,
      industries: value(b, 'industries') ? value(b, 'industries').split('|').filter(Boolean).slice(0, 3) : undefined,
      website: value(b, 'website') || undefined,
      logoFile: value(b, 'logoFile'),
      wikidata: qid(value(b, 'co')),
    })
  }

  // Logos (a college's seal, a team's stadium photo where there is no logo).
  if (logos) {
    // Wikidata gives a file as a Special:FilePath link; Commons wants its name.
    const fileName = (link) => {
      const tail = String(link ?? '').split('/').pop()
      try {
        return tail ? decodeURIComponent(tail) : ''
      } catch {
        return tail
      }
    }
    const files = landmarks.map((l) => fileName(l.logoFile || l.imageFile)).filter(Boolean)
    const thumbs = files.length ? await commonsThumbs(files, { fetchImpl, width: 128 }).catch(() => new Map()) : new Map()
    for (const l of landmarks) {
      const file = fileName(l.logoFile || l.imageFile)
      const thumb = file ? thumbs.get(file) : null
      if (thumb && safeLogo(thumb)) {
        l.logo = thumb
        l.logoSource = l.logoFile ? 'logo' : 'photo'
      }
    }
  }
  for (const l of landmarks) {
    delete l.logoFile
    delete l.imageFile
  }

  landmarks.sort((a, b) => size(b) - size(a) || a.miles - b.miles)
  const byKind = {}
  for (const l of landmarks) byKind[l.kind] = (byKind[l.kind] ?? 0) + 1
  return { landmarks, byKind, radiusMiles: radius, source: 'Wikidata' }
}
