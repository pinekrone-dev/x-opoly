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

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

const INSTRUCTIONS = `Land Quotient is a parcel map of US counties: every lot with its county record (owner, mailing address, values, land use, acreage, sale) plus layers such as zoning, permits, flood, power lines and fuel tanks.

Start with list_markets to find the county slug (for example austin-tx). search_parcels answers "which parcels" questions with counts, totals and the top matches by value; get_parcel reads one lot in full, with its permits, code cases and recorded mortgages where the city publishes them. market_layers says what a county publishes. make_map saves a map (layers, criteria, a circle) and returns a link that opens it in Land Quotient: offer it whenever a result is easier to see than to read.

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
    name: 'make_map',
    title: 'Make a map',
    description: 'Save a map in Land Quotient (layers switched on, the search criteria, an optional circle, where it opens) and return a link that opens it. Saved under the name given; the same name replaces the earlier map.',
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
export function readable(row = {}) {
  const out = {}
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
 * Runs one tool.
 *
 * `call(path, init)` answers with the app's own JSON, as the signed-in
 * person; `origin` makes links; `scope` is what the token was granted.
 */
export async function runTool(name, input = {}, { call, origin, scope = [] }) {
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
        matches: (b.rows || []).slice(0, limit).map(readable),
      })
    }

    case 'get_parcel': {
      if (!input.market || !input.id) return failure('market and id are required.')
      const q = `market=${encodeURIComponent(input.market)}&id=${encodeURIComponent(input.id)}`
      const answer = await ask(`/api/gis/parcel?${q}`)
      if (answer.status !== 200) return failure(refusal(answer))
      const parcel = answer.body.parcel || {}
      const out = { parcel: { ...readable(parcel), details: parcel.rest ?? undefined } }
      if (input.records !== false) {
        const records = await ask(`/api/gis/records?${q}`)
        if (records.status === 200 && records.body?.supported) {
          out.cityRecords = { sources: records.body.sources, mortgages: records.body.loans }
        }
      }
      out.link = `${origin}/gis/${encodeURIComponent(input.market)}`
      return result(out)
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

    case 'make_map': {
      if (!scope.includes('maps')) return failure('This connection was not given permission to save maps.')
      if (!input.market || !input.name) return failure('market and name are required.')
      const answer = await ask('/api/gis/views', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ market: input.market, name: String(input.name).slice(0, 80), state: viewState(input) }),
      })
      if (answer.status !== 201) return failure(refusal(answer))
      const id = answer.body?.view?.id
      return result({ saved: answer.body?.view?.name, link: `${origin}/gis/${encodeURIComponent(input.market)}?view=${encodeURIComponent(id)}` })
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
          address: p.ad ?? null,
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
