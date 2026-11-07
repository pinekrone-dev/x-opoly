/**
 * The Land Quotient connector for Claude: a Model Context Protocol server
 * over streamable HTTP, stateless, answering JSON-RPC at /mcp.
 *
 * Every tool is answered by the app's own routes, called as the signed-in
 * person with their access token. Nothing here reads the database directly,
 * so a tool can do exactly what that person could do in the app and no
 * more, and every daily allowance (rows shown, rows read, county files)
 * holds for Claude the way it holds for a browser.
 */

import { fullAddress } from '../../src/lib/address.ts'
import { safeLogo } from './logos.js'
import { squeeze } from './places.js'

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

const INSTRUCTIONS = `Land Quotient is a parcel map of US counties: every lot with its county record (owner, mailing address, values, land use, acreage, sale) plus layers such as zoning, permits, flood, power lines and fuel tanks.

Start with list_markets to find the county slug (for example austin-tx). search_parcels answers "which parcels" questions with counts, totals and the top matches by value; get_parcel reads one lot in full, with its permits, code cases and recorded mortgages where the city publishes them. market_layers says what a county publishes. nearby_retail lists the national and regional chains around a point (Target to Zaxby's) with their logos, the tenant mix by sector and the nearest store of each brand, or finds particular brands. make_map saves a map (layers, criteria, a circle, pins with brand logos) and returns a link that opens it in Land Quotient: offer it whenever a result is easier to see than to read.

Figures are the county's own. An assessed value is a tax figure, not an appraisal. California counties publish no owner names. Some markets are served from county files and cannot be searched here yet; the tool says so.`

const MARKET = { type: 'string', description: 'Market slug from list_markets, e.g. austin-tx.' }
const CRITERIA = {
  text: { type: 'string', description: 'Words to match in the address, owner or parcel id.' },
  assetTypes: { type: 'array', items: { type: 'string' }, description: 'Asset types as the county names them (see search_parcels byAsset), e.g. ["Industrial"].' },
  valueMin: { type: 'number' },
  valueMax: { type: 'number' },
  acresMin: { type: 'number' },
  acresMax: { type: 'number' },
  zoning: { type: 'array', items: { type: 'string' }, description: 'Zoning categories to keep: Residential, Commercial, Industrial, Mixed use, Agricultural, Other.' },
  notZoning: { type: 'array', items: { type: 'string' }, description: 'Zoning categories to leave out.' },
  flood: { type: 'string', enum: ['in', 'out'], description: 'In or out of a FEMA flood zone.' },
  buildings: { type: 'string', enum: ['vacant', 'built'] },
  owners: {
    type: 'array',
    items: { type: 'string', enum: ['held10', 'freeClear', 'outOfState'] },
    description: 'Held 10+ years, likely free and clear (last sale 30+ years ago), mailing out of state.',
  },
  near: {
    type: 'array',
    maxItems: 4,
    items: {
      type: 'object',
      properties: {
        layer: { type: 'string', description: 'A layer id from market_layers, e.g. transmission, substations, lust, opportunity-zones.' },
        miles: { type: 'number', enum: [0, 0.25, 0.5, 1, 2, 5, 10], description: '0 means inside an area layer.' },
      },
      required: ['layer', 'miles'],
    },
  },
  circle: {
    type: 'object',
    properties: { lat: { type: 'number' }, lng: { type: 'number' }, miles: { type: 'number', maximum: 20 } },
    required: ['lat', 'lng', 'miles'],
    description: 'Only parcels whose centre is inside this circle.',
  },
  match: { type: 'string', enum: ['all', 'any'], description: 'Whether a parcel must meet every criterion (default) or any one.' },
}

/** The business kinds nearby_retail and make_map's nearby know, as app/lib/places.js names them. */
const PLACE_KINDS = ['chains', 'retail', 'restaurant', 'cafe', 'grocery', 'pharmacy', 'bank', 'fitness', 'salon', 'medical', 'dentist', 'veterinary', 'childcare']

const NEARBY = {
  category: {
    type: 'string',
    enum: PLACE_KINDS,
    description: 'What to find. chains (default): the national and regional brands, Target to Zaxby\'s, across shops, restaurants, banks and fuel, leaving out independents. retail: every shop, independents included. The rest: every business of that kind.',
  },
  brands: {
    type: 'array',
    maxItems: 25,
    items: { type: 'string', maxLength: 60 },
    description: 'Particular chains to look for, e.g. ["Target", "Chick-fil-A", "Zaxbys"]: each comes back with its nearest store, or as not found within the radius. Spelling is forgiving.',
  },
  keyword: { type: 'string', maxLength: 60, description: 'A name to look for among every business of the category, e.g. "Dollar".' },
  radiusMiles: { type: 'number', minimum: 0.25, maximum: 10, description: 'How far from the point (default 1 mile).' },
}

/** As many pins as one map carries: a saved map holds settings, not data. */
export const MAX_PINS = 120

const PIN = {
  type: 'object',
  properties: {
    lat: { type: 'number' },
    lng: { type: 'number' },
    label: { type: 'string', maxLength: 60, description: 'The name shown beside the pin.' },
    detail: { type: 'string', maxLength: 80, description: 'A second line, e.g. the category or address.' },
    logo: { type: 'string', description: 'A logo URL from nearby_retail. Other hosts are dropped.' },
  },
  required: ['lat', 'lng', 'label'],
}

/** The connector's basemap names, as the app's basemap ids (app/lib/tiles.js). */
const BASEMAPS = { streets: 'osm', satellite: 'satellite', topographic: 'esri-topo', light: 'esri-gray', dark: 'esri-dark' }

export const TOOLS = [
  {
    name: 'list_markets',
    title: 'List markets',
    description: 'The counties Land Quotient covers, with their slugs and whether each can be searched here.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'search_parcels',
    title: 'Search parcels',
    description: 'Parcels in one market that meet the criteria: the count, total value and acreage, the mix by asset type, and the most valuable matches.',
    inputSchema: {
      type: 'object',
      properties: { market: MARKET, ...CRITERIA, limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many matches to list (default 20).' } },
      required: ['market'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_parcel',
    title: 'Get a parcel',
    description: "One parcel's full county record, and its permits, code cases and recorded mortgages where the city publishes them.",
    inputSchema: {
      type: 'object',
      properties: { market: MARKET, id: { type: 'string', description: 'The parcel id from search_parcels.' }, records: { type: 'boolean', description: 'Also read permits, cases and mortgages (default true).' } },
      required: ['market', 'id'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'zoning_report',
    title: 'Zoning report (City of Los Angeles)',
    description: 'What the zoning code allows on one City of Los Angeles lot: front, side and rear setbacks (prevailing front yards and corner, key, through and flag lots included), height, maximum floor area, lot coverage and density, each cited to its Los Angeles Municipal Code section, with the lot facts behind it. Lines marked review are ones the code text does not yet settle; Q, D and T conditions and overlays are flagged. The single-family zones (RA, RE, RS, R1 and its variations) are covered first.',
    inputSchema: {
      type: 'object',
      properties: {
        apn: { type: 'string', description: 'The ten-digit Los Angeles County assessor parcel number (the parcel id from search_parcels in los-angeles-ca).' },
      },
      required: ['apn'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'market_layers',
    title: 'Market layers',
    description: 'The layers a market publishes (zoning, permits, power lines, fuel tanks...), with ids for search_parcels near and make_map.',
    inputSchema: { type: 'object', properties: { market: MARKET }, required: ['market'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'geocode',
    title: 'Find an address',
    description: 'Coordinates for an address, for a circle or a map centre.',
    inputSchema: { type: 'object', properties: { address: { type: 'string' } }, required: ['address'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'nearby_retail',
    title: 'Nearby retail',
    description: 'The national and regional chains around a point (Target, Walmart, Chick-fil-A, Zaxby\'s, Starbucks, CVS, Chase...), each with its brand logo, sector, distance and address; the tenant mix by sector (quick service, grocery, department & big box, pharmacy, banks, convenience & fuel...); each brand present with its count and nearest store; and counts within 1, 3 and 5 miles. Ask for particular brands to get the nearest of each or "not within the radius". Other categories list every business of a kind, independents included. Give lat and lng, or an address. Use make_map nearby, or pass these as make_map pins, to see them on the map.',
    inputSchema: {
      type: 'object',
      properties: {
        lat: { type: 'number' },
        lng: { type: 'number' },
        address: { type: 'string', description: 'Used when lat and lng are not given.' },
        ...NEARBY,
        limit: { type: 'integer', minimum: 1, maximum: 150, description: 'How many stores to list, nearest first (default 40). The brand and sector summaries always cover every store found.' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'make_map',
    title: 'Make a map',
    description: 'Save a map in Land Quotient (layers switched on, the search criteria, an optional circle, pins with logos, where it opens) and return a link that opens it. Saved under the name given; the same name replaces the earlier map.',
    inputSchema: {
      type: 'object',
      properties: {
        market: MARKET,
        name: { type: 'string', maxLength: 80 },
        layers: { type: 'array', items: { type: 'string' }, description: 'Layer ids from market_layers to switch on.' },
        landUseColours: { type: 'boolean', description: 'Colour the parcels by land use.' },
        ...CRITERIA,
        center: { type: 'object', properties: { lat: { type: 'number' }, lng: { type: 'number' } }, required: ['lat', 'lng'] },
        zoom: { type: 'number', minimum: 3, maximum: 19 },
        basemap: {
          type: 'string',
          enum: Object.keys(BASEMAPS),
          description: 'The map underneath: streets (default), satellite, topographic, light or dark.',
        },
        pins: { type: 'array', maxItems: MAX_PINS, items: PIN, description: 'Points to pin on the map, each with a label and optionally a logo (from nearby_retail).' },
        nearby: {
          type: 'object',
          properties: NEARBY,
          description: 'Pin the chains (or other businesses) around the centre or circle with their logos, found as nearby_retail finds them.',
        },
      },
      required: ['market', 'name'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'add_to_crm',
    title: 'Add a parcel to the CRM',
    description: 'Save a parcel as a place in the workspace CRM. Needs the CRM permission granted when the connector was approved.',
    inputSchema: {
      type: 'object',
      properties: { market: MARKET, id: { type: 'string' }, notes: { type: 'string', maxLength: 2000 } },
      required: ['market', 'id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
]

/** Query parameters for /api/gis/parcels from the tool's criteria, as the app's api.ts writes them. */
export function searchParams(input = {}) {
  const p = new URLSearchParams({ market: String(input.market || '') })
  const list = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : [])
  const num = (key, name) => {
    const v = Number(input[key])
    if (input[key] != null && Number.isFinite(v)) p.set(name, String(v))
  }
  if (input.text) p.set('q', String(input.text).slice(0, 120))
  if (list(input.assetTypes).length) p.set('at', list(input.assetTypes).join(','))
  num('valueMin', 'vmin')
  num('valueMax', 'vmax')
  num('acresMin', 'amin')
  num('acresMax', 'amax')
  if (list(input.zoning).length) p.set('zc', list(input.zoning).join(','))
  if (list(input.notZoning).length) p.set('znot', list(input.notZoning).join(','))
  if (input.flood === 'in' || input.flood === 'out') p.set('flood', input.flood)
  if (input.buildings === 'vacant' || input.buildings === 'built') p.set('bld', input.buildings)
  if (list(input.owners).length) p.set('own', list(input.owners).join(','))
  if (Array.isArray(input.near) && input.near.length) {
    p.set('near', input.near.slice(0, 4).map((n) => `${n.layer}:${Number(n.miles)}`).join(','))
  }
  const c = input.circle
  if (c && [c.lat, c.lng, c.miles].every((v) => Number.isFinite(Number(v)))) p.set('circle', `${c.lat},${c.lng},${c.miles}`)
  if (input.match === 'any') p.set('match', 'any')
  return p
}

/** A saved view's state from the tool's input, in the shape the map's applyView reads. */
export function viewState(input = {}) {
  const list = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : [])
  const range = (lo, hi) => ({ min: lo != null ? String(lo) : '', max: hi != null ? String(hi) : '' })
  const state = {
    v: 1,
    layerOn: Object.fromEntries(list(input.layers).map((id) => [id, true])),
    showParcels: Boolean(input.landUseColours),
    query: input.text ? String(input.text) : '',
    assets: list(input.assetTypes),
    value: range(input.valueMin, input.valueMax),
    acres: range(input.acresMin, input.acresMax),
    ownerFilters: list(input.owners),
    zoningKeep: list(input.zoning),
    zoningDrop: list(input.notZoning),
    flood: input.flood === 'in' || input.flood === 'out' ? input.flood : null,
    buildings: input.buildings === 'vacant' || input.buildings === 'built' ? input.buildings : null,
    near: Array.isArray(input.near) ? input.near.slice(0, 4).map((n) => ({ layer: String(n.layer), miles: Number(n.miles) })) : [],
    match: input.match === 'any' ? 'any' : 'all',
  }
  if (BASEMAPS[input.basemap]) state.basemap = BASEMAPS[input.basemap]
  const pins = pinList(input.pins)
  if (pins.length) state.pins = pins
  const c = input.circle
  if (c && [c.lat, c.lng, c.miles].every((v) => Number.isFinite(Number(v)))) {
    state.circle = { lat: Number(c.lat), lng: Number(c.lng), miles: Math.min(20, Number(c.miles)) }
  }
  const centre = input.center ?? (state.circle ? { lat: state.circle.lat, lng: state.circle.lng } : null)
  if (centre && Number.isFinite(Number(centre.lat)) && Number.isFinite(Number(centre.lng))) {
    state.center = [Number(centre.lng), Number(centre.lat)]
    state.zoom = Number.isFinite(Number(input.zoom)) ? Number(input.zoom) : state.circle ? zoomFor(state.circle.miles) : 14
  }
  return state
}

/**
 * Pins as a saved map keeps them: on the globe, labelled, short, and with a
 * logo only from a host the map trusts (logos.js). Anything else is dropped
 * rather than stored, since a saved map opens in every teammate's browser.
 */
export function pinList(list) {
  if (!Array.isArray(list)) return []
  const out = []
  const clip = (v, n) => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim().slice(0, n))
  for (const pin of list) {
    if (out.length >= MAX_PINS) break
    const lat = Number(pin?.lat)
    const lng = Number(pin?.lng)
    const label = clip(pin?.label, 60)
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || !label) continue
    const entry = { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, label }
    const detail = clip(pin?.detail, 80)
    if (detail) entry.detail = detail
    const logo = pin?.logo ? safeLogo(pin.logo) : null
    if (logo) entry.logo = logo
    out.push(entry)
  }
  return out
}

/** A business from /api/places/nearby as a pin. */
export function businessPin(b) {
  const kind = b.brand && b.brand !== b.name ? `${b.brand} · ${b.category ?? ''}` : b.category ?? ''
  return {
    lat: b.lat,
    lng: b.lng,
    label: b.name,
    detail: [kind.replace(/ · $/, ''), b.miles != null ? `${b.miles} mi` : null].filter(Boolean).join(' · '),
    logo: b.logo ?? undefined,
  }
}

/** The brands asked for, cleaned. */
function brandList(value) {
  return (Array.isArray(value) ? value : []).map((b) => String(b).replace(/\|/g, ' ').trim().slice(0, 60)).filter((b) => squeeze(b)).slice(0, 25)
}

/** Query string for /api/places/nearby, with logos. Brands are always among the chains. */
function nearbyQuery(lat, lng, options = {}) {
  const p = new URLSearchParams({ lat: String(lat), lng: String(lng), logos: '1' })
  const brands = brandList(options.brands)
  p.set('category', brands.length ? 'chains' : PLACE_KINDS.includes(options.category) ? options.category : 'chains')
  if (brands.length) p.set('brands', brands.join('|'))
  else if (options.keyword) p.set('keyword', String(options.keyword).slice(0, 60))
  const miles = Number(options.radiusMiles)
  p.set('radius', String(Number.isFinite(miles) ? Math.min(10, Math.max(0.25, miles)) : 1))
  return p
}

// A zoom that fits a circle of this radius on a laptop screen.
function zoomFor(miles) {
  return Math.max(8, Math.min(16, Math.round(14.5 - Math.log2(Math.max(0.25, miles) * 2))))
}

const PARCEL_FIELDS = {
  id: 'id',
  gid: 'parcelId',
  ad: 'address',
  ow: 'owner',
  ma: 'mailing',
  at: 'assetType',
  sc: 'useCode',
  mv: 'value',
  ac: 'acres',
  zn: 'zoning',
  zc: 'zoningCategory',
  sy: 'lastSaleYear',
  ms: 'mailingState',
  bn: 'buildings',
}

/** A parcel row as Claude reads it: plain names, nothing blank. */
export function readable(row = {}, market = '') {
  const out = {}
  const place = fullAddress(row, market)
  if (place.full) out.fullAddress = place.full
  for (const [key, label] of Object.entries(PARCEL_FIELDS)) {
    const value = row[key]
    if (value !== null && value !== undefined && value !== '') out[label] = value
  }
  if (row.fz === 1 || row.fz === true) out.inFloodZone = true
  return out
}

const text = (value) => ({ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) })
const result = (value, extra = {}) => ({ content: [text(value)], structuredContent: typeof value === 'object' ? value : undefined, ...extra })
const failure = (message) => ({ content: [text(message)], isError: true })

/**
 * Arguments as the tool's schema declares them. Some clients send an object
 * or array argument as a JSON string (a client holding an older copy of the
 * tool list does, for an argument it has not heard of); those are read back
 * into what they say. Anything that will not parse is left as sent.
 */
export function parsedArguments(name, input) {
  if (!input || typeof input !== 'object') return input || {}
  const properties = TOOLS.find((t) => t.name === name)?.inputSchema?.properties ?? {}
  const out = { ...input }
  for (const [key, value] of Object.entries(out)) {
    const type = properties[key]?.type
    if (typeof value !== 'string' || (type !== 'object' && type !== 'array')) continue
    try {
      const parsed = JSON.parse(value)
      if (type === 'array' ? Array.isArray(parsed) : parsed && typeof parsed === 'object' && !Array.isArray(parsed)) out[key] = parsed
    } catch {
      // Not JSON: left as it came.
    }
  }
  return out
}

/**
 * Runs one tool.
 *
 * `call(path, init)` answers with the app's own JSON, as the signed-in
 * person; `origin` makes links; `scope` is what the token was granted.
 */
export async function runTool(name, rawInput = {}, { call, origin, scope = [] }) {
  const input = parsedArguments(name, rawInput)
  const ask = async (path, init) => {
    const response = await call(path, init)
    let body = null
    try {
      body = await response.json()
    } catch {
      body = null
    }
    return { status: response.status, body }
  }
  const refusal = (answer) => answer.body?.error || `Land Quotient answered ${answer.status}.`
  // A market is a slug and nothing else, before it goes near a path.
  if (input && 'market' in input && !/^[a-z0-9-]{2,40}$/.test(String(input.market || ''))) {
    return failure('market must be a slug from list_markets, like austin-tx.')
  }

  switch (name) {
    case 'list_markets': {
      const answer = await ask('/catalog/markets.json')
      if (answer.status !== 200) return failure(refusal(answer))
      const ready = await ask('/api/gis/markets')
      const searchable = new Set(Array.isArray(ready.body?.ready) ? ready.body.ready : [])
      const markets = (answer.body?.markets ?? [])
        .filter((m) => m.status === 'live')
        .map((m) => ({ slug: m.slug, name: m.name, region: m.region, searchable: searchable.size ? searchable.has(m.slug) : undefined }))
      return result({ markets })
    }

    case 'search_parcels': {
      if (!input.market) return failure('market is required.')
      const params = searchParams(input)
      const limit = Math.min(50, Math.max(1, Number(input.limit) || 20))
      params.set('limit', String(limit))
      const answer = await ask(`/api/gis/parcels?${params.toString()}`)
      if (answer.status === 404 && answer.body?.ready === false) {
        return failure(`${input.market} is served from county files and cannot be searched through the connector yet. make_map can still open it on the map with these criteria.`)
      }
      if (answer.status !== 200) return failure(refusal(answer))
      const b = answer.body
      return result({
        market: input.market,
        count: b.count,
        totalValue: b.total,
        acreage: Math.round(Number(b.acreage) || 0),
        byAsset: Object.fromEntries((b.byAsset || []).slice(0, 12)),
        shown: (b.rows || []).length,
        matches: (b.rows || []).slice(0, limit).map((row) => readable(row, input.market)),
      })
    }

    case 'get_parcel': {
      if (!input.market || !input.id) return failure('market and id are required.')
      const q = `market=${encodeURIComponent(input.market)}&id=${encodeURIComponent(input.id)}`
      const answer = await ask(`/api/gis/parcel?${q}`)
      if (answer.status !== 200) return failure(refusal(answer))
      const parcel = answer.body.parcel || {}
      const out = { parcel: { ...readable(parcel, input.market), details: parcel.rest ?? undefined } }
      if (input.records !== false) {
        const records = await ask(`/api/gis/records?${q}`)
        if (records.status === 200 && records.body?.supported) {
          out.cityRecords = { sources: records.body.sources, mortgages: records.body.loans }
        }
      }
      out.link = `${origin}/gis/${encodeURIComponent(input.market)}`
      return result(out)
    }

    case 'zoning_report': {
      const apn = String(input.apn || '').replace(/\D/g, '').padStart(10, '0')
      if (apn.length !== 10) return failure('apn must be the ten-digit assessor parcel number.')
      const answer = await ask('/api/gis/zoning-report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ market: 'los-angeles-ca', apn }),
      })
      if (answer.status !== 200) return failure(refusal(answer))
      const b = answer.body
      return result({
        apn, zone: b.zone, covered: b.covered, lot: b.lot,
        lines: (b.lines || []).map((l) => ({ item: l.label, value: l.value, unit: l.unit, status: l.status, code: l.cite?.section, basis: l.basis })),
        flags: b.flags, asOf: b.as_of, sources: b.sources, note: b.note,
        link: `${origin}/gis/los-angeles-ca`,
      })
    }

    case 'market_layers': {
      if (!input.market) return failure('market is required.')
      const answer = await ask(`/catalog/${encodeURIComponent(input.market)}/layers.json`)
      if (answer.status !== 200) return failure(refusal(answer))
      const layers = (answer.body?.layers ?? []).map((l) => ({ id: l.id, label: l.label, kind: l.kind, count: l.count, note: l.note || undefined }))
      return result({ market: input.market, layers })
    }

    case 'geocode': {
      if (!input.address) return failure('address is required.')
      const answer = await ask(`/api/geocode?q=${encodeURIComponent(String(input.address).slice(0, 200))}`)
      if (answer.status !== 200) return failure(refusal(answer))
      return result({ results: (answer.body?.results ?? []).slice(0, 5) })
    }

    case 'nearby_retail': {
      let lat = Number(input.lat)
      let lng = Number(input.lng)
      let place = null
      if (input.lat == null || input.lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
        if (!input.address) return failure('Give lat and lng, or an address.')
        const found = await ask(`/api/geocode?q=${encodeURIComponent(String(input.address).slice(0, 200))}`)
        const top = found.body?.results?.[0]
        if (found.status !== 200 || !top) return failure(found.status === 200 ? `No location found for "${input.address}".` : refusal(found))
        lat = Number(top.lat)
        lng = Number(top.lng ?? top.lon)
        place = top.label ?? top.name ?? top.address ?? String(input.address)
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return failure(`No location found for "${input.address}".`)
      }
      const answer = await ask(`/api/places/nearby?${nearbyQuery(lat, lng, input)}`)
      if (answer.status !== 200) return failure(refusal(answer))
      const b = answer.body || {}
      const all = Array.isArray(b.results) ? b.results : []
      const limit = Math.min(150, Math.max(1, Number(input.limit) || 40))
      const brandsSeen = new Map()
      const sectors = {}
      for (const r of all) {
        if (r.sector) sectors[r.sector] = (sectors[r.sector] ?? 0) + 1
        const key = r.brand || (r.brandWikidata ? r.name : null)
        if (!key) continue
        const seen = brandsSeen.get(key) ?? { brand: key, sector: r.sector ?? undefined, count: 0, nearestMiles: r.miles, logo: undefined }
        seen.count += 1
        seen.nearestMiles = Math.min(seen.nearestMiles, r.miles)
        if (!seen.logo && r.logoSource === 'brand') seen.logo = r.logo
        brandsSeen.set(key, seen)
      }
      const asked = brandList(input.brands)
      const lookingFor = asked.length
        ? asked.map((wanted) => {
            const w = squeeze(wanted)
            const hits = all.filter((r) => squeeze(r.brand).includes(w) || squeeze(r.name).includes(w))
            if (!hits.length) return { brand: wanted, found: 0, note: `None within ${b.radiusMiles} miles in the directory.` }
            const near = hits[0]
            return { brand: wanted, found: hits.length, nearestMiles: near.miles, nearest: { name: near.name, address: near.address ?? undefined, lat: near.lat, lng: near.lng }, logo: hits.find((h) => h.logoSource === 'brand')?.logo }
          })
        : undefined
      const category = asked.length ? 'chains' : PLACE_KINDS.includes(input.category) ? input.category : 'chains'
      return result({
        center: { lat, lng, ...(place ? { place } : {}) },
        radiusMiles: b.radiusMiles,
        category,
        source: b.source,
        found: all.length,
        withinMiles: Object.fromEntries((b.rings || []).map((ring) => [ring.miles, ring.count])),
        lookingFor,
        sectors: Object.fromEntries(Object.entries(sectors).sort((x, y) => y[1] - x[1])),
        brands: [...brandsSeen.values()].sort((x, y) => y.count - x.count || x.nearestMiles - y.nearestMiles).slice(0, 60),
        stores: all.slice(0, limit).map((r) => ({
          name: r.name,
          brand: r.brand ?? undefined,
          sector: r.sector ?? undefined,
          category: r.category ?? undefined,
          address: r.address ?? undefined,
          miles: r.miles,
          lat: r.lat,
          lng: r.lng,
          logo: r.logo ?? undefined,
          logoSource: r.logoSource ?? undefined,
        })),
        note: `From ${b.source || 'the business directory'}. ${category === 'chains' ? 'Chains are the stores the directory ties to a brand on Wikidata; a new or untagged store can be missing, so a count is a floor. ' : 'Small tenants can be missing, so a count is a floor. '}Logos marked brand are the chain's logo on Wikidata; favicon is the store website's own icon.${all.length >= 300 ? ' The directory stops at 300 stores: use a smaller radius for a full count.' : ''}`,
      })
    }

    case 'make_map': {
      if (!scope.includes('maps')) return failure('This connection was not given permission to save maps.')
      if (!input.market || !input.name) return failure('market and name are required.')
      const state = viewState(input)
      let pinned = 0
      let foundCount
      let foundSource
      if (input.nearby && typeof input.nearby === 'object') {
        const at = state.circle ?? (state.center ? { lat: state.center[1], lng: state.center[0] } : null)
        if (!at) return failure('nearby needs a center or a circle to search around.')
        const options = { ...input.nearby, radiusMiles: input.nearby.radiusMiles ?? state.circle?.miles ?? 1 }
        const found = await ask(`/api/places/nearby?${nearbyQuery(at.lat, at.lng, options)}`)
        if (found.status !== 200) return failure(refusal(found))
        const businesses = Array.isArray(found.body?.results) ? found.body.results : []
        foundCount = businesses.length
        foundSource = found.body?.source
        const pins = pinList([...(state.pins ?? []), ...businesses.map(businessPin)])
        pinned = pins.length - (state.pins?.length ?? 0)
        if (pins.length) state.pins = pins
        if (!input.center && !state.circle) state.zoom = zoomFor(Number(options.radiusMiles) || 1)
      }
      const answer = await ask('/api/gis/views', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ market: input.market, name: String(input.name).slice(0, 80), state }),
      })
      if (answer.status !== 201) return failure(refusal(answer))
      const id = answer.body?.view?.id
      return result({
        saved: answer.body?.view?.name,
        pins: state.pins?.length || undefined,
        nearbyPinned: input.nearby ? pinned : undefined,
        nearbyFound: input.nearby ? foundCount : undefined,
        nearbySource: input.nearby ? foundSource : undefined,
        link: `${origin}/gis/${encodeURIComponent(input.market)}?view=${encodeURIComponent(id)}`,
      })
    }

    case 'add_to_crm': {
      if (!scope.includes('crm')) {
        return failure('This connection can read but not change the CRM. Reconnect the Land Quotient connector and tick "Add to my CRM" to allow it.')
      }
      if (!input.market || !input.id) return failure('market and id are required.')
      const found = await ask(`/api/gis/parcel?market=${encodeURIComponent(input.market)}&id=${encodeURIComponent(input.id)}`)
      if (found.status !== 200) return failure(refusal(found))
      const p = found.body.parcel || {}
      const bb = Array.isArray(p.bb) && p.bb.length === 4 ? p.bb.map(Number) : null
      const answer = await ask('/api/crm/places', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: String(p.ad || `Parcel ${p.gid ?? input.id}`),
          address: fullAddress(p, input.market).full || p.ad || null,
          acreage: p.ac ?? null,
          market: input.market,
          parcelId: String(input.id),
          lat: bb ? (bb[1] + bb[3]) / 2 : null,
          lng: bb ? (bb[0] + bb[2]) / 2 : null,
          notes: [p.ow ? `Owner of record: ${p.ow}` : null, input.notes ? String(input.notes) : null].filter(Boolean).join('\n') || null,
        }),
      })
      if (answer.status !== 201 && answer.status !== 200) return failure(refusal(answer))
      return result({ added: answer.body?.record?.name ?? true, id: answer.body?.record?.id })
    }

    default:
      return null
  }
}

/**
 * One JSON-RPC message in, its answer out (null for a notification).
 */
export async function handleRpc(message, context) {
  const reply = (resultValue) => ({ jsonrpc: '2.0', id: message.id, result: resultValue })
  const error = (code, text) => ({ jsonrpc: '2.0', id: message.id ?? null, error: { code, message: text } })
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return error(-32600, 'Invalid request')
  const isNotification = message.id === undefined || message.id === null

  switch (message.method) {
    case 'initialize': {
      const asked = message.params?.protocolVersion
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'land-quotient', title: 'Land Quotient', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      })
    }
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: TOOLS })
    case 'tools/call': {
      const name = message.params?.name
      if (!TOOLS.some((t) => t.name === name)) return error(-32602, `Unknown tool: ${name}`)
      try {
        const out = await runTool(name, message.params?.arguments ?? {}, context)
        return reply(out ?? failure('Unknown tool.'))
      } catch (cause) {
        return reply(failure(`The tool failed: ${cause?.message || cause}`))
      }
    }
    default:
      if (isNotification) return null
      return error(-32601, `Method not found: ${message.method}`)
  }
}
