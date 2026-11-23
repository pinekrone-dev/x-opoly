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
import { demographicsRows } from '../../src/lib/libraryPieces.ts'
import { safeLogo } from './logos.js'
import { squeeze } from './places.js'

import { toBase64 } from './storage.js'
import { CODE_INSTRUCTIONS, CODE_TOOLS, runScript, searchOperations } from './codemode.js'

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

const INSTRUCTIONS = `Land Quotient is a parcel map of US counties: every lot with its county record (owner, mailing address, values, land use, acreage, sale) plus layers such as zoning, permits, flood, power lines and fuel tanks.

Start with list_markets to find the county slug (for example austin-tx). search_parcels answers "which parcels" questions with counts, totals and the top matches by value; get_parcel reads one lot in full, with its permits, code cases and recorded mortgages where the city publishes them. market_layers says what a county publishes. nearby_retail lists the national and regional chains around a point (Target to Zaxby's) with their logos, the tenant mix by sector and the nearest store of each brand, or finds particular brands. find_sites searches and screens in one step, returning the matches ranked by the acres that pass (use it for "find me a site for..."). site_pieces returns ready-made, unbranded pieces about a parcel (property, feasibility, crime, demographics, retail, a map) for the user to paste into their own brief; it never writes the brief. site_feasibility screens a parcel for buildability in any market (slope, FEMA flood hazard, wetlands, protected land, and the acres that pass), one lot or up to five ranked: use it after search_parcels to narrow a list. nearby_crime counts the violent and property crime reported within a quarter, a half and a mile of a site over the last year, with where that stands among the market's parcels (market by market; it says when a market or a site is not covered), and where it is published market_layers lists a crime layer that make_map can switch on. nearby_landmarks lists what sells a site: colleges, hospitals, stadiums and arenas, airports, malls, attractions and the headquarters of major employers, with enrolment, seats, passengers and headcount. add_to_list files parcels on a client's list (my_lists finds them by client or tag). make_map saves a map (layers, criteria, a circle, pins with logos for chains or landmarks) and returns a link that opens it in Land Quotient: offer it whenever a result is easier to see than to read. export_map_image draws a map (a saved one by name, or one described the same way) as a PNG with a link to the file, for a proposal or a deck. export_parcels_geojson returns the matching parcels with their real outlines as GeoJSON. platform_stats gives the totals across every market (markets, parcels, acres, roll value) for headline figures.

Figures are the county's own. An assessed value is a tax figure, not an appraisal. California counties publish no owner names. Some markets are served from county files: there, search_parcels finds a parcel by address, owner or parcel number (text alone) and get_parcel reads any lot, but filters and totals are not available; the tool says so.`

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

/** The landmark kinds, as app/lib/landmarks.js names them. */
const LANDMARK_IDS = ['colleges', 'hospitals', 'stadiums', 'airports', 'malls', 'attractions', 'convention', 'military', 'headquarters']

const LANDMARKS = {
  kinds: {
    type: 'array',
    items: { type: 'string', enum: LANDMARK_IDS },
    description: 'Which kinds (default all): colleges, hospitals, stadiums (and arenas), airports (commercial), malls, attractions (theme parks, zoos, aquariums), convention (centres), military (bases), headquarters (of major employers).',
  },
  radiusMiles: { type: 'number', minimum: 0.5, maximum: 15, description: 'How far from the point (default 5 miles).' },
  minEmployees: { type: 'integer', minimum: 100, description: 'Smallest headquarters to count, by employees (default 1,000).' },
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
    name: 'nearby_landmarks',
    title: 'Nearby landmarks and demand drivers',
    description: 'The landmarks that sell a site, around a point: colleges and universities (with enrolment), hospitals (beds), stadiums and arenas (seats and home teams), commercial airports (passengers), malls, theme parks, zoos and aquariums, convention centres, military bases, and the headquarters of major employers (employees, industry). Each with its distance and a logo or photo, the largest first. From Wikidata, so notable places only. Give lat and lng, or an address. Use make_map landmarks to pin them.',
    inputSchema: {
      type: 'object',
      properties: {
        lat: { type: 'number' },
        lng: { type: 'number' },
        address: { type: 'string', description: 'Used when lat and lng are not given.' },
        ...LANDMARKS,
        perKind: { type: 'integer', minimum: 1, maximum: 40, description: 'How many of each kind to list, largest first (default 10).' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'site_feasibility',
    title: 'Site feasibility screen',
    description: "A first screen of whether a parcel can be built on, in any market: how steep it is (mean and steepest slope, and the share over a limit, 15% unless said, from USGS 3DEP elevation), how much lies in FEMA's special flood hazard area and which flood zones it touches, how much is mapped wetland (National Wetlands Inventory), how much is protected or publicly held land (PAD-US), and the acres left after all of those are taken out. Give one parcel id, or up to five to compare, ranked by the acres that pass. Use it to narrow search_parcels results to the lots worth a closer look. For one parcel it also returns a map of the lot with each cell coloured by the result. A screen from public maps, not a survey; zoning, access and utilities are not part of it.",
    inputSchema: {
      type: 'object',
      properties: {
        market: MARKET,
        id: { type: 'string', description: 'The parcel id from search_parcels.' },
        ids: { type: 'array', items: { type: 'string' }, maxItems: 5, description: 'Up to five parcel ids to screen and rank, in place of id.' },
        maxSlopePercent: { type: 'number', minimum: 1, maximum: 100, description: 'The steepest ground counted as buildable, in percent (default 15).' },
        image: { type: 'boolean', description: 'Also draw the lot as a map, each cell coloured by what it came to: passes, steep, flood hazard, wetland, protected land (default true for one parcel; the image link opens without signing in).' },
      },
      required: ['market'],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'find_sites',
    title: 'Find and screen sites',
    description: "Search a market for parcels that meet criteria and screen the matches for buildability in one step: the search of search_parcels (asset type, acres, value, zoning, vacant, a circle, owner signals...), then site_feasibility on each match (slope, FEMA flood hazard, wetlands, protected land), returning the lots ranked by the acres that pass, with what stands in the way of each. Give minBuildableAcres or minBuildablePercent to keep only the finalists. Eight matches are screened a call, the most valuable first; `offset` screens the next eight, and the answer says how many matches remain. This is the way to go from \"find me a site for X\" to a short list.",
    inputSchema: {
      type: 'object',
      properties: {
        market: MARKET,
        ...CRITERIA,
        maxSlopePercent: { type: 'number', minimum: 1, maximum: 100, description: 'The steepest ground counted as buildable, in percent (default 15).' },
        minBuildableAcres: { type: 'number', minimum: 0, description: 'Keep only lots with at least this many acres passing the screen.' },
        minBuildablePercent: { type: 'number', minimum: 0, maximum: 100, description: 'Keep only lots with at least this share passing the screen.' },
        offset: { type: 'integer', minimum: 0, description: 'How many matches to skip: 8 for the second eight, 16 for the third.' },
      },
      required: ['market'],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'site_pieces',
    title: 'Pieces for a site',
    description: "Ready-made pieces about one parcel, for pasting into the user's own brief, offering memorandum or email: each stands alone, carries no branding, and comes as a short paragraph, a table (also as Markdown) and, where it has one, an image link, with its public source named. Pieces: property (the county record), feasibility (slope, flood hazard, wetlands, protected land and the acres that pass, with a map of the lot), crime (reported violent and property crime within a quarter, a half and a mile, where the police publish it), demographics (population, households, income at 1, 3 and 5 miles), retail (the chains within a mile) and parcel-map (the lot outlined on the street map). Ask for the ones wanted; without `pieces` it returns property, feasibility, crime, demographics and retail. It does not write the brief: the user's document and branding are theirs.",
    inputSchema: {
      type: 'object',
      properties: {
        market: MARKET,
        id: { type: 'string', description: 'The parcel id from search_parcels or find_sites.' },
        pieces: { type: 'array', items: { type: 'string', enum: ['property', 'feasibility', 'crime', 'demographics', 'retail', 'parcel-map'] }, description: 'Which pieces to make (default: property, feasibility, crime, demographics, retail).' },
        images: { type: 'boolean', description: 'Draw the images that go with the pieces (the feasibility map; default true). Image links open without signing in and are kept 30 days.' },
      },
      required: ['market', 'id'],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'nearby_crime',
    title: 'Crime near a site',
    description: "Reported violent and property crime within a quarter mile, a half mile and a mile of a site over the last twelve months the police agency has published: the counts, how each stands among the market's own parcels (\"more violent crime nearby than 80% of parcels\"), and the agency's categories behind them (assault, larceny, vehicle theft, burglary...). Counted from each offense the agency publishes, with its own definition of violent and property crime. A site another agency polices is named as not covered, never given a zero. Available market by market, where the police agency publishes each offense with a place (market_layers lists a crime layer there); a market with nothing published says so.",
    inputSchema: {
      type: 'object',
      properties: {
        market: MARKET,
        lat: { type: 'number' },
        lng: { type: 'number' },
        address: { type: 'string', description: 'Used when lat and lng are not given.' },
      },
      required: ['market'],
    },
    annotations: { readOnlyHint: true },
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
        layers: { type: 'array', items: { type: 'string' }, description: 'Layer ids from market_layers to switch on (crime, zoning, permits, transmission...).' },
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
        landmarks: {
          type: 'object',
          properties: LANDMARKS,
          description: 'Pin the landmarks around the centre or circle (colleges, hospitals, stadiums, airports, malls, attractions, headquarters...) with their logos, found as nearby_landmarks finds them.',
        },
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
    name: 'export_map_image',
    title: 'Export a map as an image',
    description: 'Draw a Land Quotient map as a PNG and return it with a link to the file, for a proposal or a deck: the street basemap, the county\'s parcel lines, the parcels the criteria match picked out in red, the layers switched on, a circle and pins, with a legend, scale bar and attribution. Give `map` (the name of a map saved with make_map) to draw that map, or describe the map here exactly as for make_map. The link works without signing in and is kept for 30 days. Parcel lines appear from zoom 11; pins are drawn as labelled dots (no logos).',
    inputSchema: {
      type: 'object',
      properties: {
        market: MARKET,
        map: { type: 'string', maxLength: 80, description: 'The name (or id) of a saved map to draw. When given, the map\'s own layers, criteria, circle, pins and position are used.' },
        title: { type: 'string', maxLength: 90, description: 'A title set in the top left corner. Defaults to the saved map\'s name.' },
        width: { type: 'integer', minimum: 320, maximum: 1600, description: 'Pixels wide (default 1000).' },
        height: { type: 'integer', minimum: 240, maximum: 1200, description: 'Pixels high (default 700).' },
        layers: { type: 'array', items: { type: 'string' }, description: 'Layer ids from market_layers to draw (up to six).' },
        landUseColours: { type: 'boolean', description: 'Colour the parcels by land use.' },
        ...CRITERIA,
        center: { type: 'object', properties: { lat: { type: 'number' }, lng: { type: 'number' } }, required: ['lat', 'lng'] },
        zoom: { type: 'number', minimum: 3, maximum: 19, description: 'Whole zoom levels; 15 shows a few blocks, 12 a city.' },
        pins: { type: 'array', maxItems: MAX_PINS, items: PIN, description: 'Points to pin, each with a label.' },
        landmarks: { type: 'object', properties: LANDMARKS, description: 'Pin the landmarks around the centre or circle, as make_map does.' },
        nearby: { type: 'object', properties: NEARBY, description: 'Pin the chains (or other businesses) around the centre or circle, as make_map does.' },
        inline: { type: 'boolean', description: 'Also return the PNG itself in the reply (default true). Set false to get only the link.' },
      },
      required: ['market'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'export_parcels_geojson',
    title: 'Export parcels as GeoJSON',
    description: 'The parcels that meet the criteria as a GeoJSON FeatureCollection: each parcel\'s real outline (from the county\'s parcel geometry) with its record as properties, the most valuable first. Up to 200 a call; use offset for the next page. An outline is exact to about a foot. A parcel that crosses a map tile line at every zoom comes as a MultiPolygon of its pieces and says so in `pieces`.',
    inputSchema: {
      type: 'object',
      properties: {
        market: MARKET,
        ...CRITERIA,
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'How many parcels (default 50).' },
        offset: { type: 'integer', minimum: 0, description: 'Skip this many matches, for the next page.' },
      },
      required: ['market'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'platform_stats',
    title: 'Platform totals',
    description: 'Headline totals across every live market, from the platform\'s own published figures: how many markets, parcels, acres and the total roll value, with each market\'s own line. Use these for KPIs rather than figures from the website.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'my_lists',
    title: 'My lists',
    description: "The team's lists of places (prospect lists, client shortlists), each with its client, tags and size; filter by client or tag. Give a list's id to read the places on it.",
    inputSchema: {
      type: 'object',
      properties: {
        client: { type: 'string', description: 'Only lists for this client (any part of the name).' },
        tag: { type: 'string', description: 'Only lists with this tag.' },
        id: { type: 'string', description: 'A list id: returns its places.' },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'add_to_list',
    title: 'Add parcels to a list',
    description: 'Files parcels on a named list for a client, making the list (with its client and tags) if it does not exist, and saving each parcel as a CRM place if it is not one yet. Needs the CRM permission granted when the connector was approved.',
    inputSchema: {
      type: 'object',
      properties: {
        list: { type: 'string', maxLength: 120, description: 'The list name, e.g. "Acme industrial targets". An existing list of that name is used.' },
        client: { type: 'string', maxLength: 120, description: 'Whose list it is (used when the list is made).' },
        tags: { type: 'array', items: { type: 'string' }, maxItems: 12, description: 'Tags for a new list, e.g. ["Industrial", "Q3"].' },
        market: MARKET,
        ids: { type: 'array', items: { type: 'string' }, maxItems: 50, description: 'Parcel ids from search_parcels in that market.' },
      },
      required: ['list', 'market', 'ids'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
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

/**
 * The search a saved map's state describes, as the same query the parcel
 * search reads: the other direction from viewState below.
 */
export function stateParams(state = {}, market = '') {
  const p = new URLSearchParams({ market: String(market || '') })
  const list = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : [])
  const bound = (range, lo, hi) => {
    if (range?.min !== '' && range?.min != null && Number.isFinite(Number(range.min))) p.set(lo, String(Number(range.min)))
    if (range?.max !== '' && range?.max != null && Number.isFinite(Number(range.max))) p.set(hi, String(Number(range.max)))
  }
  if (state.query) p.set('q', String(state.query).slice(0, 120))
  if (list(state.assets).length) p.set('at', list(state.assets).join(','))
  bound(state.value, 'vmin', 'vmax')
  bound(state.acres, 'amin', 'amax')
  if (list(state.zoningKeep).length) p.set('zc', list(state.zoningKeep).join(','))
  if (list(state.zoningDrop).length) p.set('znot', list(state.zoningDrop).join(','))
  if (list(state.zoningCodes).length) p.set('zn', list(state.zoningCodes).join(','))
  if (state.flood === 'in' || state.flood === 'out') p.set('flood', state.flood)
  if (state.buildings === 'vacant' || state.buildings === 'built') p.set('bld', state.buildings)
  if (list(state.ownerFilters).length) p.set('own', list(state.ownerFilters).join(','))
  if (Array.isArray(state.near) && state.near.length) {
    p.set('near', state.near.slice(0, 4).map((n) => `${n.layer}:${Number(n.miles)}`).join(','))
  }
  const c = state.circle
  if (c && [c.lat, c.lng, c.miles].every((v) => Number.isFinite(Number(v)))) p.set('circle', `${c.lat},${c.lng},${c.miles}`)
  if (state.match === 'any') p.set('match', 'any')
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

const KIND_LABELS = {
  colleges: 'College', hospitals: 'Hospital', stadiums: 'Stadium', airports: 'Airport', malls: 'Mall',
  attractions: 'Attraction', convention: 'Convention centre', military: 'Military base', headquarters: 'HQ',
}
const fmt = (n) => Number(n).toLocaleString('en-US')

/** One line on how big a landmark is. */
export function landmarkFigure(l) {
  if (l.students) return `${fmt(l.students)} students`
  if (l.capacity) return `${fmt(l.capacity)} seats${l.teams?.length ? ` · ${l.teams.slice(0, 2).join(', ')}` : ''}`
  if (l.passengers) return `${fmt(l.passengers)} passengers a year`
  if (l.beds) return `${fmt(l.beds)} beds`
  if (l.employees) return `${fmt(l.employees)} employees${l.located && l.located !== 'exact' ? ' (HQ city)' : ''}`
  return l.teams?.length ? l.teams.slice(0, 2).join(', ') : ''
}

/** A landmark as a pin. */
export function landmarkPin(l) {
  return {
    lat: l.lat,
    lng: l.lng,
    label: l.name,
    detail: [KIND_LABELS[l.kind], landmarkFigure(l), l.miles != null ? `${l.miles} mi` : null].filter(Boolean).join(' · '),
    logo: l.logo ?? undefined,
  }
}

/** Query string for /api/places/landmarks. */
function landmarksQuery(lat, lng, options = {}) {
  const p = new URLSearchParams({ lat: String(lat), lng: String(lng) })
  const miles = Number(options.radiusMiles)
  p.set('radius', String(Number.isFinite(miles) ? Math.min(15, Math.max(0.5, miles)) : 5))
  const kinds = (Array.isArray(options.kinds) ? options.kinds : []).filter((k) => LANDMARK_IDS.includes(k))
  if (kinds.length) p.set('kinds', kinds.join(','))
  if (Number.isFinite(Number(options.minEmployees))) p.set('minEmployees', String(Math.round(Number(options.minEmployees))))
  return p
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

/** A table as Markdown, for a client that pastes text. */
export function markdownTable(columns, rows) {
  const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
  return [`| ${columns.map(cell).join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${columns.map((_, i) => cell(row[i])).join(' | ')} |`)].join('\n')
}

/**
 * One piece for someone's own brief: a title, a paragraph, a table, an
 * image, the source. Nothing in it names this product: it goes into a
 * document under somebody else's letterhead, and what it must carry is where
 * the figures came from.
 */
export function pieceOf({ id, title, text: words, columns = null, rows = null, image = null, source = null, note = null }) {
  const table = columns && rows && rows.length ? { columns, rows } : undefined
  const markdown = [
    `**${title}**`,
    words || null,
    table ? markdownTable(columns, rows) : null,
    image ? `![${title}](${image})` : null,
    note ? `_${note}_` : null,
    source ? `_Source: ${source}_` : null,
  ].filter(Boolean).join('\n\n')
  return { id, title, text: words || undefined, table, image: image || undefined, note: note || undefined, source: source || undefined, markdown }
}

const money = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? `$${Math.round(Number(value)).toLocaleString('en-US')}` : null)

/** The feasibility route's answer, with the findings said plainly and the limits of the screen beside them. */
export function feasibilityReport(b) {
  const pct = (share) => `${Math.round((Number(share) || 0) * 1000) / 10}%`
  const flags = []
  const slope = b.slope || {}
  const flood = b.flood || {}
  const wetlands = b.wetlands || {}
  const land = b.protectedLand || {}
  const build = b.buildable || {}
  if (slope.available && slope.shareOverLimit > 0) flags.push(`${pct(slope.shareOverLimit)} of the lot is steeper than ${slope.limitPercent}% (steepest about ${slope.maxPercent}%).`)
  if (flood.available && flood.shareInHazardArea > 0) {
    const zones = (flood.zones || []).filter((z) => z.hazardArea).map((z) => (z.subtype ? `${z.zone} (${String(z.subtype).toLowerCase()})` : z.zone))
    flags.push(`${pct(flood.shareInHazardArea)} is in FEMA's special flood hazard area${zones.length ? `, zone ${[...new Set(zones)].join(', ')}` : ''}.`)
  }
  if (flood.available && !flood.mapped) flags.push('FEMA has not mapped flood hazard on this ground, which is not the same as no hazard.')
  if (wetlands.available && wetlands.share > 0) flags.push(`${pct(wetlands.share)} is mapped wetland (${[...new Set((wetlands.types || []).map((t) => t.type))].join(', ')}).`)
  if (land.available) {
    for (const unit of (land.units || []).filter((u) => u.counted).slice(0, 3)) {
      flags.push(`${pct(unit.share)} is within ${unit.name}${unit.manager ? `, held by ${unit.manager}` : ''}${unit.designation ? ` (${unit.designation})` : ''}.`)
    }
    const around = (land.units || []).filter((u) => !u.counted).map((u) => u.name)
    if (around.length) flags.push(`Inside the drawn boundary of ${[...new Set(around)].slice(0, 3).join(', ')}, which does not by itself restrict private land.`)
  }
  for (const section of [slope, flood, wetlands, land]) if (section.available === false && section.reason) flags.push(`Not screened: ${section.reason}`)
  const passed = (build.screened || []).length
  const said = passed
    ? `About ${build.acres} of ${b.acres} acres (${pct(build.share)}) pass the screen: ${[
        (build.screened || []).includes('slope') ? `slope of ${build.limitPercent}% or less` : null,
        (build.screened || []).includes('flood') ? "outside FEMA's flood hazard area" : null,
        (build.screened || []).includes('wetlands') ? 'outside mapped wetlands' : null,
        (build.screened || []).includes('protected land') ? 'outside protected or publicly held land' : null,
      ].filter(Boolean).join(', ')}.`
    : 'None of the four services answered, so nothing could be screened.'
  const strip = ({ available, ...rest }) => (available ? rest : { notScreened: rest.reason })
  return {
    market: b.market,
    id: b.id,
    address: b.address ?? undefined,
    acres: b.acres,
    countyAcres: b.countyAcres ?? undefined,
    buildable: { acres: build.acres, percent: Math.round((Number(build.share) || 0) * 1000) / 10, maxSlopePercent: build.limitPercent, notScreened: (build.notScreened || []).length ? build.notScreened : undefined },
    slope: strip(slope),
    flood: strip(flood),
    wetlands: strip(wetlands),
    protectedLand: strip(land),
    flags,
    summary: `${said}${flags.length ? ` ${flags.filter((f) => !f.startsWith('Not screened')).slice(0, 3).join(' ')}` : ' Nothing on these four maps stands in the way.'}`,
    method: `The lot${b.outline === 'box' ? "'s bounding box (its outline was not available)" : ''} was laid over with ${b.cells?.count} cells about ${b.cells?.spacingFeet} ft apart; each was given its elevation and tested against the flood, wetland and protected-area outlines.`,
    caveats: [
      'A screen from public maps, not a survey, an elevation certificate or a wetland delineation.',
      'Zoning, access, utilities, soils, easements and title are not part of it.',
    ],
    sources: b.sources,
  }
}

/** The crime route's answer, said the way a person asking about a site would want it. */
export function crimeReport(b, { market, place = null } = {}) {
  const at = { market, place: place ?? undefined, lat: b.lat, lng: b.lng }
  if (!b.covered) {
    return {
      ...at,
      covered: false,
      summary: b.elsewhere
        ? `This site is in ${b.elsewhere}, which has its own police; their reported crime is not published here, so there are no figures for it. This is not a count of zero.`
        : 'This site is outside the area of any police agency whose reported crime is published here, so there are no figures for it. This is not a count of zero.',
    }
  }
  const day = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' })
  const miles = (m) => (m === 0.25 ? 'a quarter mile' : m === 0.5 ? 'a half mile' : m === 1 ? 'one mile' : `${m} miles`)
  const rings = Array.isArray(b.rings) ? b.rings : []
  const within = rings.map((r) => ({
    miles: r.miles,
    violent: r.violent,
    property: r.property,
    otherOffenses: r.other,
    violentHigherThanPercentOfParcels: r.violentAbove ?? undefined,
    propertyHigherThanPercentOfParcels: r.propertyAbove ?? undefined,
    // Said only when it matters: a circle that runs into another agency's area undercounts.
    shareOfCircleCovered: r.covered < 0.98 ? r.covered : undefined,
  }))
  const stand = (share) => (share == null ? '' : ` (more than ${share}% of parcels)`)
  const lines = rings.map((r) => `Within ${miles(r.miles)}: ${r.violent.toLocaleString('en-US')} violent${stand(r.violentAbove)}, ${r.property.toLocaleString('en-US')} property${stand(r.propertyAbove)}.`)
  const partial = rings.filter((r) => r.covered < 0.98)
  return {
    ...at,
    covered: true,
    policedBy: b.agency,
    period: { from: b.from, to: b.to },
    within,
    categories: (b.categories || []).slice(0, 12).map((c) => ({ category: c.category, kind: c.kind, counts: Object.fromEntries(rings.map((r, i) => [`within${r.miles}mi`, c.counts[i]])) })),
    comparedWith: b.compared ? `${b.compared.parcels.toLocaleString('en-US')} parcels in the area ${b.agency} polices, each counted the same way` : undefined,
    definitions: b.definitions,
    notes: [
      ...(b.notes || []),
      ...(partial.length ? [`Part of the ${partial.map((r) => miles(r.miles)).join(', ')} ${partial.length > 1 ? 'circles lie' : 'circle lies'} outside the area these figures cover (another police agency's, or water); nothing is counted there, so those figures may run low.`] : []),
    ],
    source: b.source,
    summary: `Offenses reported to ${b.agency}, ${day(b.from)} to ${day(b.to)}. ${lines.join(' ')}`,
  }
}

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

  // A point from lat and lng, or from an address.
  const locate = async (args) => {
    const lat = Number(args.lat)
    const lng = Number(args.lng)
    if (args.lat != null && args.lng != null && Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng, place: null }
    if (!args.address) return { error: 'Give lat and lng, or an address.' }
    const found = await ask(`/api/geocode?q=${encodeURIComponent(String(args.address).slice(0, 200))}`)
    const top = found.body?.results?.[0]
    if (found.status !== 200 || !top) return { error: found.status === 200 ? `No location found for "${args.address}".` : refusal(found) }
    const at = { lat: Number(top.lat), lng: Number(top.lng ?? top.lon), place: top.label ?? top.name ?? top.address ?? String(args.address) }
    return Number.isFinite(at.lat) && Number.isFinite(at.lng) ? at : { error: `No location found for "${args.address}".` }
  }

  // The pins a map asks to have found for it (chains, landmarks), added to
  // the state the way make_map has always added them.
  const findPins = async (state) => {
    let pinned = 0
    let foundCount
    let foundSource
    if (input.nearby && typeof input.nearby === 'object') {
      const at = state.circle ?? (state.center ? { lat: state.center[1], lng: state.center[0] } : null)
      if (!at) return { error: 'nearby needs a center or a circle to search around.' }
      const options = { ...input.nearby, radiusMiles: input.nearby.radiusMiles ?? state.circle?.miles ?? 1 }
      const found = await ask(`/api/places/nearby?${nearbyQuery(at.lat, at.lng, options)}`)
      if (found.status !== 200) return { error: refusal(found) }
      const businesses = Array.isArray(found.body?.results) ? found.body.results : []
      foundCount = businesses.length
      foundSource = found.body?.source
      const pins = pinList([...(state.pins ?? []), ...businesses.map(businessPin)])
      pinned = pins.length - (state.pins?.length ?? 0)
      if (pins.length) state.pins = pins
      if (!input.center && !state.circle) state.zoom = zoomFor(Number(options.radiusMiles) || 1)
    }
    let landmarksPinned
    if (input.landmarks && typeof input.landmarks === 'object') {
      const at = state.circle ?? (state.center ? { lat: state.center[1], lng: state.center[0] } : null)
      if (!at) return { error: 'landmarks needs a center or a circle to search around.' }
      const options = { ...input.landmarks, radiusMiles: input.landmarks.radiusMiles ?? state.circle?.miles ?? 5 }
      const found = await ask(`/api/places/landmarks?${landmarksQuery(at.lat, at.lng, options)}`)
      if (found.status !== 200) return { error: refusal(found) }
      const before = state.pins?.length ?? 0
      const pins = pinList([...(state.pins ?? []), ...(found.body?.landmarks ?? []).map(landmarkPin)])
      landmarksPinned = pins.length - before
      if (pins.length) state.pins = pins
      if (!input.center && !state.circle) state.zoom = zoomFor(Number(options.radiusMiles) || 5)
    }
    return { pinned, foundCount, foundSource, landmarksPinned }
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
        /*
         * A market served from county files has no totals to give and no
         * filters to run, but a parcel can still be found in it by what
         * someone would type: the lookup reads its search index.
         */
        const textOnly = input.text && [...params.keys()].every((key) => ['market', 'q', 'limit'].includes(key))
        if (textOnly) {
          const found = await ask(`/api/gis/lookup?market=${encodeURIComponent(input.market)}&q=${encodeURIComponent(String(input.text).slice(0, 120))}&limit=${Math.min(20, limit)}`)
          if (found.status === 200) {
            const rows = found.body?.rows || []
            return result({
              market: input.market,
              note: 'This market is served from county files: these are the parcels whose address, owner or parcel number starts with the text. Totals and filters (value, acreage, asset type, zoning) are not available here; make_map can open the market with those criteria.',
              shown: rows.length,
              matches: rows.map((row) => readable(row, input.market)),
            })
          }
        }
        return failure(`${input.market} is served from county files: it can be searched by address, owner name or parcel number (text alone), and get_parcel reads any lot in it, but value, acreage, asset type and zoning filters need the search store. make_map can still open it on the map with these criteria.`)
      }
      if (answer.status !== 200) return failure(refusal(answer))
      const b = answer.body
      return result({
        market: input.market,
        // A market answered from county files says so, and what that leaves out.
        ...(b.source === 'files'
          ? { note: b.brief
              ? 'Served from county files: these are the parcels whose address, owner or parcel number starts with the text, not a count of every match.'
              : 'Served from county files: asset type, value, acres, the owner filters and a radius are answered; zoning, flood and building filters are not available in this market.' }
          : {}),
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
      // Reported crime is a layer the app draws from its own packed file,
      // not one in the market's catalogue: listed first where it is published.
      const crime = await ask(`/api/gis/crime?market=${input.market}`)
      if (crime.status === 200 && crime.body?.ready) {
        const c = crime.body
        layers.unshift({
          id: 'crime',
          label: 'Crime',
          kind: 'point',
          count: c.violent + c.property,
          note: `${c.violent.toLocaleString('en-US')} violent and ${c.property.toLocaleString('en-US')} property offenses reported to ${c.agencies.join(', ')}, ${c.from} to ${c.to}. Switch it on in make_map with layers: ["crime"]; nearby_crime counts them round a site.`,
        })
      }
      return result({ market: input.market, layers })
    }

    case 'geocode': {
      if (!input.address) return failure('address is required.')
      const answer = await ask(`/api/geocode?q=${encodeURIComponent(String(input.address).slice(0, 200))}`)
      if (answer.status !== 200) return failure(refusal(answer))
      return result({ results: (answer.body?.results ?? []).slice(0, 5) })
    }

    case 'nearby_landmarks': {
      const point = await locate(input)
      if (point.error) return failure(point.error)
      const { lat, lng, place } = point
      const answer = await ask(`/api/places/landmarks?${landmarksQuery(lat, lng, input)}`)
      if (answer.status !== 200) return failure(refusal(answer))
      const b = answer.body || {}
      const perKind = Math.min(40, Math.max(1, Number(input.perKind) || 10))
      const groups = {}
      for (const l of b.landmarks || []) {
        const list = (groups[l.kind] ??= [])
        if (list.length >= perKind) continue
        list.push({
          name: l.name,
          miles: l.miles,
          figure: landmarkFigure(l) || undefined,
          students: l.students, seats: l.capacity, teams: l.teams, passengers: l.passengers, beds: l.beds, iata: l.iata,
          employees: l.employees, industries: l.industries,
          located: l.kind === 'headquarters' ? (l.located === 'exact' ? 'headquarters address' : `${l.located.replace(/^city: /, '')} (city only; distance is to the city centre)`) : undefined,
          lat: l.lat, lng: l.lng, logo: l.logo, website: l.website, wikidata: l.wikidata,
        })
      }
      return result({
        center: { lat, lng, ...(place ? { place } : {}) },
        radiusMiles: b.radiusMiles,
        found: b.byKind,
        landmarks: groups,
        source: 'Wikidata (community-edited; notable places only, figures as Wikidata records them, some years old)',
      })
    }

    case 'find_sites': {
      if (!input.market) return failure('market is required.')
      const params = searchParams(input)
      const offset = Math.max(0, Math.floor(Number(input.offset) || 0))
      const batch = 8
      params.set('limit', String(batch))
      if (offset) params.set('offset', String(offset))
      const found = await ask(`/api/gis/parcels?${params.toString()}`)
      if (found.status !== 200) return failure(refusal(found))
      const rows = (found.body.rows || []).slice(0, batch)
      const total = Number(found.body.count) || rows.length
      if (!rows.length) return result({ market: input.market, matches: total, screened: 0, sites: [], summary: offset ? 'No more matches to screen.' : 'No parcel in this market meets those criteria.' })
      const slope = Number(input.maxSlopePercent)
      const limit = Number.isFinite(slope) && slope >= 1 && slope <= 100 ? `&maxSlope=${Math.round(slope)}` : ''
      // All at once: each is four requests to federal services, and a lot screened before is answered from the edge.
      const screened = await Promise.all(rows.map(async (row) => {
        const answer = await ask(`/api/gis/feasibility?market=${input.market}&id=${encodeURIComponent(String(row.id))}${limit}`)
        const record = readable(row, input.market)
        if (answer.status !== 200) return { id: String(row.id), address: record.fullAddress ?? record.address, notScreened: refusal(answer) }
        const report = feasibilityReport(answer.body || {})
        return {
          id: String(row.id), address: record.fullAddress ?? record.address, owner: record.owner, assetType: record.assetType, zoning: record.zoning, value: record.value,
          acres: report.acres, buildableAcres: report.buildable.acres, buildablePercent: report.buildable.percent,
          flags: report.flags, notScreened: report.buildable.notScreened,
        }
      }))
      const minAcres = Number(input.minBuildableAcres)
      const minPercent = Number(input.minBuildablePercent)
      const asked = (Number.isFinite(minAcres) && minAcres > 0) || (Number.isFinite(minPercent) && minPercent > 0)
      const passes = (site) => site.buildableAcres != null && !(Number.isFinite(minAcres) && site.buildableAcres < minAcres) && !(Number.isFinite(minPercent) && site.buildablePercent < minPercent)
      const ranked = screened.filter((site) => site.buildableAcres != null).sort((a, b) => b.buildableAcres - a.buildableAcres)
      const sites = asked ? ranked.filter(passes) : ranked
      const out = asked ? ranked.filter((site) => !passes(site)).map((site) => ({ id: site.id, address: site.address, buildableAcres: site.buildableAcres, buildablePercent: site.buildablePercent, why: site.flags.slice(0, 2).join(' ') || 'Below the threshold asked for.' })) : undefined
      const failed = screened.filter((site) => site.buildableAcres == null).map((site) => ({ id: site.id, address: site.address, why: site.notScreened }))
      const left = Math.max(0, total - offset - rows.length)
      return result({
        market: input.market,
        matches: total,
        screened: rows.length,
        screenedFrom: offset + 1,
        maxSlopePercent: Number.isFinite(slope) && slope >= 1 && slope <= 100 ? Math.round(slope) : 15,
        sites,
        screenedOut: out && out.length ? out : undefined,
        couldNotScreen: failed.length ? failed : undefined,
        remaining: left,
        next: left ? { offset: offset + rows.length } : undefined,
        summary: `${total.toLocaleString('en-US')} parcel${total === 1 ? '' : 's'} match; ${rows.length} screened (the most valuable${offset ? `, from number ${offset + 1}` : ''})${asked ? `, ${sites.length} of them pass what was asked` : ''}.${left ? ` ${left.toLocaleString('en-US')} more can be screened with offset ${offset + rows.length}.` : ''}`,
        then: 'site_feasibility draws any one of these; site_pieces returns pieces about it for a brief.',
        caveats: ['A screen from public maps, not a survey. Zoning, access, utilities and title are not part of it.'],
      })
    }

    case 'site_pieces': {
      if (!input.market || !input.id) return failure('market and id are required.')
      const KNOWN = ['property', 'feasibility', 'crime', 'demographics', 'retail', 'parcel-map']
      const wanted = Array.isArray(input.pieces) && input.pieces.length ? KNOWN.filter((k) => input.pieces.map(String).includes(k)) : ['property', 'feasibility', 'crime', 'demographics', 'retail']
      if (!wanted.length) return failure(`pieces is any of ${KNOWN.join(', ')}.`)
      const record = await ask(`/api/gis/parcel?market=${input.market}&id=${encodeURIComponent(String(input.id))}`)
      if (record.status !== 200) return failure(refusal(record))
      const parcel = record.body.parcel || {}
      const facts = readable(parcel, input.market)
      const where = facts.fullAddress || facts.address || `Parcel ${facts.parcelId || input.id}`
      const box = Array.isArray(parcel.bb) && parcel.bb.length === 4 ? parcel.bb.map(Number) : null
      const at = box && box.every(Number.isFinite) ? { lat: (box[1] + box[3]) / 2, lng: (box[0] + box[2]) / 2 } : null
      const pieces = []
      const missing = []
      const inline = []
      const draw = async (body) => {
        const made = await ask('/api/gis/map-image', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ market: input.market, state: {}, width: 1200, height: 800, ...body }) })
        if (made.status !== 200) return { error: refusal(made) }
        if (Number(made.body.bytes) <= 1_500_000) {
          const file = await call(made.body.path)
          if (file.status === 200) inline.push({ type: 'image', data: toBase64(new Uint8Array(await file.arrayBuffer())), mimeType: 'image/png' })
        }
        return { image: `${origin}${made.body.path}` }
      }
      const jobs = {
        property: async () => {
          const rows = [
            ['Address', facts.fullAddress || facts.address],
            ['Parcel number', facts.parcelId],
            ['Lot size', facts.acres != null ? `${Number(facts.acres).toLocaleString('en-US')} acres` : null],
            ['Use', facts.assetType],
            ['Zoning', [facts.zoning, facts.zoningCategory].filter(Boolean).join(', ') || null],
            ['Assessed value', money(facts.value)],
            ['Owner of record', facts.owner],
            ['Owner mailing address', facts.mailing],
            ['Last sale', facts.lastSaleYear],
          ].filter(([, value]) => value != null && value !== '')
          const words = `${where}${facts.acres != null ? ` is a ${Number(facts.acres).toLocaleString('en-US')}-acre` : ' is a'}${facts.assetType ? ` ${String(facts.assetType).toLowerCase()}` : ''} parcel${facts.parcelId ? ` (parcel ${facts.parcelId})` : ''}${money(facts.value) ? `, assessed at ${money(facts.value)}` : ''}.`
          pieces.push(pieceOf({ id: 'property', title: 'Property', text: words, columns: ['Item', 'Detail'], rows, source: "The county assessor's roll", note: 'An assessed value is a tax figure, not an appraisal.' }))
        },
        feasibility: async () => {
          const answer = await ask(`/api/gis/feasibility?market=${input.market}&id=${encodeURIComponent(String(input.id))}`)
          if (answer.status !== 200) return missing.push({ piece: 'feasibility', why: refusal(answer) })
          const b = answer.body
          const report = feasibilityReport(b)
          const pct = (share) => `${Math.round((Number(share) || 0) * 1000) / 10}%`
          const rows = [['Lot area', `${b.acres} acres`], ['Passing the screen', `${b.buildable.acres} acres (${pct(b.buildable.share)})`]]
          if (b.slope.available) rows.push(['Slope', `mean ${b.slope.meanPercent}%, steepest ${b.slope.maxPercent}%; ${pct(b.slope.shareOverLimit)} over ${b.slope.limitPercent}%`], ['Ground elevation', `${b.slope.elevationMinFeet.toLocaleString('en-US')} to ${b.slope.elevationMaxFeet.toLocaleString('en-US')} ft`])
          else rows.push(['Slope', `Not screened: ${b.slope.reason}`])
          if (b.flood.available) rows.push(['FEMA flood hazard area', b.flood.mapped ? `${pct(b.flood.shareInHazardArea)} of the lot; zone ${b.flood.zones.map((z) => `${z.zone} ${pct(z.share)}`).join(', ')}` : 'Not mapped by FEMA here'])
          else rows.push(['FEMA flood hazard area', `Not screened: ${b.flood.reason}`])
          if (b.wetlands.available) rows.push(['Mapped wetland', b.wetlands.share > 0 ? `${pct(b.wetlands.share)} (${[...new Set(b.wetlands.types.map((t) => t.type))].join(', ')})` : 'None'])
          else rows.push(['Mapped wetland', `Not screened: ${b.wetlands.reason}`])
          if (b.protectedLand.available) rows.push(['Protected or public land', b.protectedLand.share > 0 ? `${pct(b.protectedLand.share)} (${b.protectedLand.units.filter((u) => u.counted).slice(0, 3).map((u) => u.name).join('; ')})` : 'None'])
          else rows.push(['Protected or public land', `Not screened: ${b.protectedLand.reason}`])
          const drawn = input.images !== false && b.map ? await draw({ cells: b.map, title: `Site feasibility: ${where}` }) : {}
          pieces.push(pieceOf({
            id: 'feasibility', title: 'Site feasibility', text: report.summary, columns: ['Screen', 'Finding'], rows, image: drawn.image,
            source: (b.sources || []).map((src) => src.name).join('; '),
            note: 'A screen from public maps, not a survey, an elevation certificate or a wetland delineation.',
          }))
        },
        crime: async () => {
          if (!at) return missing.push({ piece: 'crime', why: 'The parcel has no place on the map.' })
          const answer = await ask(`/api/gis/crime?market=${input.market}&lat=${at.lat}&lng=${at.lng}`)
          if (answer.status !== 200) return missing.push({ piece: 'crime', why: refusal(answer) })
          const report = crimeReport(answer.body, { market: input.market })
          if (!report.covered) return missing.push({ piece: 'crime', why: report.summary })
          const label = (m) => (m === 0.25 ? '1/4 mile' : m === 0.5 ? '1/2 mile' : `${m} mile`)
          pieces.push(pieceOf({
            id: 'crime', title: 'Reported crime nearby', text: report.summary,
            columns: ['Reported offenses', ...report.within.map((w) => label(w.miles))],
            rows: [['Violent crime', ...report.within.map((w) => w.violent)], ['Property crime', ...report.within.map((w) => w.property)]],
            source: `${report.policedBy}, offenses reported ${report.period.from} to ${report.period.to}`,
            note: [answer.body.definitions?.violent, answer.body.definitions?.property].filter(Boolean).join(' '),
          }))
        },
        demographics: async () => {
          if (!at) return missing.push({ piece: 'demographics', why: 'The parcel has no place on the map.' })
          const answer = await ask(`/api/demographics?lat=${at.lat}&lng=${at.lng}`)
          if (answer.status !== 200 || !Array.isArray(answer.body?.radii)) return missing.push({ piece: 'demographics', why: refusal(answer) })
          const table = demographicsRows(answer.body).filter((row) => row.length > 1 && row[0] !== 'Source')
          const first = answer.body.radii[0]
          const people = first?.metrics?.population
          pieces.push(pieceOf({
            id: 'demographics', title: 'Demographics',
            text: people != null ? `About ${Math.round(people).toLocaleString('en-US')} people live within ${first.miles} mile${first.miles === 1 ? '' : 's'} of the site.` : null,
            columns: table[0], rows: table.slice(1), source: answer.body.source,
          }))
        },
        retail: async () => {
          if (!at) return missing.push({ piece: 'retail', why: 'The parcel has no place on the map.' })
          const answer = await ask(`/api/places/nearby?${nearbyQuery(at.lat, at.lng, { radiusMiles: 1, category: 'chains' })}`)
          if (answer.status !== 200) return missing.push({ piece: 'retail', why: refusal(answer) })
          const nearest = new Map()
          for (const store of answer.body.results || []) {
            const key = store.brand || store.name
            if (key && !nearest.has(key)) nearest.set(key, store)
          }
          const rows = [...nearest.values()].slice(0, 25).map((store) => [store.brand || store.name, store.sector ?? '', Math.round(Number(store.miles) * 100) / 100])
          if (!rows.length) return missing.push({ piece: 'retail', why: 'No national or regional chain is listed within one mile.' })
          pieces.push(pieceOf({
            id: 'retail', title: 'Retail within one mile',
            text: `${nearest.size} national and regional chain${nearest.size === 1 ? '' : 's'} within one mile, the nearest being ${rows.slice(0, 4).map((row) => row[0]).join(', ')}.`,
            columns: ['Chain', 'Sector', 'Miles'], rows, source: answer.body.source || 'OpenStreetMap contributors',
            note: 'A store the directory has not tagged with its brand can be missing, so the count is a floor.',
          }))
        },
        'parcel-map': async () => {
          if (!at) return missing.push({ piece: 'parcel-map', why: 'The parcel has no place on the map.' })
          const drawn = await draw({ state: { center: [at.lng, at.lat], zoom: 17 }, highlight: [String(parcel.id ?? input.id)], title: where })
          if (drawn.error) return missing.push({ piece: 'parcel-map', why: drawn.error })
          pieces.push(pieceOf({ id: 'parcel-map', title: 'Parcel map', image: drawn.image, source: 'County parcel lines; street map by OpenStreetMap contributors' }))
        },
      }
      // One after another: a piece that fails is named and the rest still come.
      for (const name of wanted) {
        try {
          await jobs[name]()
        } catch (cause) {
          missing.push({ piece: name, why: String(cause?.message || 'could not be made just now').slice(0, 160) })
        }
      }
      const out = {
        market: input.market,
        id: String(parcel.id ?? input.id),
        site: where,
        pieces,
        notAvailable: missing.length ? missing : undefined,
        use: 'Each piece stands alone and carries no branding (a map keeps only the small credit line for its sources): paste its text, table (or markdown) and image into the user\'s own document, under their name. Keep the source line with it. Do not present these as a finished brief.',
      }
      return { content: [text(out), ...inline.slice(0, 2)], structuredContent: out }
    }

    case 'site_feasibility': {
      const wanted = [...new Set([input.id, ...(Array.isArray(input.ids) ? input.ids : [])].map((v) => String(v ?? '').trim()).filter(Boolean))].slice(0, 5)
      if (!wanted.length) return failure('Give a parcel id from search_parcels (id), or up to five (ids).')
      const slope = Number(input.maxSlopePercent)
      const limit = Number.isFinite(slope) && slope >= 1 && slope <= 100 ? `&maxSlope=${Math.round(slope)}` : ''
      const screens = []
      let cells = null
      for (const id of wanted) {
        const answer = await ask(`/api/gis/feasibility?market=${input.market}&id=${encodeURIComponent(id)}${limit}`)
        screens.push(answer.status === 200 ? feasibilityReport(answer.body || {}) : { id, error: refusal(answer) })
        if (answer.status === 200) cells = answer.body?.map ?? null
      }
      if (screens.length === 1) {
        if (screens[0].error) return failure(screens[0].error)
        const report = screens[0]
        const content = [text(report)]
        // The lot drawn, each cell coloured by what it came to.
        if (input.image !== false && cells) {
          const drawn = await ask('/api/gis/map-image', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ market: input.market, state: {}, cells, title: `Site feasibility: ${report.address || `parcel ${report.id}`}`, width: 900, height: 640 }),
          })
          if (drawn.status === 200) {
            report.image = `${origin}${drawn.body.path}`
            report.imageNote = 'A PNG of the lot, each cell coloured by the result; the link opens without signing in and is kept 30 days.'
            content[0] = text(report)
            if (Number(drawn.body.bytes) <= 1_500_000) {
              const file = await call(drawn.body.path)
              if (file.status === 200) content.push({ type: 'image', data: toBase64(new Uint8Array(await file.arrayBuffer())), mimeType: 'image/png' })
            }
          } else {
            report.imageNote = `The map of the lot could not be drawn: ${refusal(drawn)}`
            content[0] = text(report)
          }
        }
        return { content, structuredContent: report }
      }
      // Most acres passing first; a lot that could not be screened last.
      const ranked = [...screens].sort((a, b) => (b.buildable?.acres ?? -1) - (a.buildable?.acres ?? -1))
      return result({
        market: input.market,
        ranked: ranked.map((r) => (r.error ? { id: r.id, error: r.error } : { id: r.id, address: r.address, acres: r.acres, buildableAcres: r.buildable.acres, buildablePercent: r.buildable.percent, flags: r.flags })),
        screens: ranked,
      })
    }
    case 'nearby_crime': {
      const point = await locate(input)
      if (point.error) return failure(point.error)
      const { lat, lng, place } = point
      const answer = await ask(`/api/gis/crime?market=${input.market}&lat=${lat}&lng=${lng}`)
      if (answer.status !== 200) return failure(refusal(answer))
      return result(crimeReport(answer.body || {}, { market: input.market, place }))
    }
    case 'nearby_retail': {
      const point = await locate(input)
      if (point.error) return failure(point.error)
      const { lat, lng, place } = point
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
      const pinsFound = await findPins(state)
      if (pinsFound.error) return failure(pinsFound.error)
      const { pinned, foundCount, foundSource, landmarksPinned } = pinsFound
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
        landmarksPinned,
        link: `${origin}/gis/${encodeURIComponent(input.market)}?view=${encodeURIComponent(id)}`,
      })
    }

    case 'export_map_image': {
      if (!input.market) return failure('market is required.')
      let state
      let title = input.title ? String(input.title) : null
      let criteria
      if (input.map) {
        const views = await ask(`/api/gis/views?market=${encodeURIComponent(input.market)}`)
        if (views.status !== 200) return failure(refusal(views))
        const want = String(input.map).trim().toLowerCase()
        const saved = (views.body?.views ?? []).find((v) => String(v.id) === String(input.map) || String(v.name).trim().toLowerCase() === want)
        if (!saved) {
          const names = (views.body?.views ?? []).map((v) => v.name).slice(0, 20)
          return failure(`No saved map called "${input.map}" in ${input.market}.${names.length ? ` Saved maps there: ${names.join('; ')}.` : ' Save one with make_map first, or describe the map here.'}`)
        }
        state = saved.state || {}
        title = title ?? saved.name
        criteria = stateParams(state, input.market)
      } else {
        state = viewState(input)
        const pinsFound = await findPins(state)
        if (pinsFound.error) return failure(pinsFound.error)
        criteria = searchParams(input)
      }
      const answer = await ask('/api/gis/map-image', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ market: input.market, state, criteria: criteria.toString(), title, width: input.width, height: input.height }),
      })
      if (answer.status !== 200) return failure(refusal(answer))
      const b = answer.body
      const summary = {
        image: `${origin}${b.path}`,
        width: b.width, height: b.height, bytes: b.bytes,
        center: b.center, zoom: b.zoom,
        shown: b.shown,
        notes: b.notes?.length ? b.notes : undefined,
        keptDays: b.keptDays,
        use: 'The image link is a plain PNG that opens without signing in; embed or download it. It is kept for 30 days.',
      }
      const content = [text(summary)]
      // The picture itself, for a client that can take one, unless it is
      // too large to carry in a reply or was not asked for.
      if (input.inline !== false && Number(b.bytes) <= 1_500_000) {
        const file = await call(b.path)
        if (file.status === 200) content.push({ type: 'image', data: toBase64(new Uint8Array(await file.arrayBuffer())), mimeType: 'image/png' })
      }
      return { content, structuredContent: summary }
    }

    case 'export_parcels_geojson': {
      if (!input.market) return failure('market is required.')
      const params = searchParams(input)
      const limit = Math.min(200, Math.max(1, Number(input.limit) || 50))
      params.set('limit', String(limit))
      if (Number(input.offset) > 0) params.set('offset', String(Math.floor(Number(input.offset))))
      const found = await ask(`/api/gis/parcels?${params.toString()}`)
      if (found.status === 404 && found.body?.ready === false) {
        return failure(`${input.market} is served from county files and cannot be searched through the connector yet, so its parcels cannot be exported here.`)
      }
      if (found.status !== 200) return failure(refusal(found))
      const rows = (found.body.rows || []).slice(0, limit)
      const shapes = await ask('/api/gis/parcels/shapes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ market: input.market, parcels: rows.map((row) => ({ id: row.id, bb: row.bb })) }),
      })
      if (shapes.status !== 200) return failure(refusal(shapes))
      const features = []
      let withoutShape = 0
      for (const row of rows) {
        const shape = shapes.body.shapes?.[String(row.id)]
        if (!shape) withoutShape += 1
        features.push({
          type: 'Feature',
          id: row.id,
          geometry: shape?.geometry ?? null,
          properties: { ...readable(row, input.market), ...(shape && shape.pieces > 1 ? { pieces: shape.pieces } : {}) },
        })
      }
      return result({
        type: 'FeatureCollection',
        market: input.market,
        matched: found.body.count,
        returned: features.length,
        offset: Number(input.offset) > 0 ? Math.floor(Number(input.offset)) : 0,
        withoutShape: withoutShape || undefined,
        crs: 'WGS 84 longitude, latitude (EPSG:4326)',
        source: 'Outlines from the county\'s published parcel geometry, as drawn on the Land Quotient map; records from the county roll.',
        features,
      })
    }

    case 'platform_stats': {
      const answer = await ask('/catalog/markets.json')
      if (answer.status !== 200) return failure(refusal(answer))
      const live = (answer.body?.markets ?? []).filter((m) => m.status === 'live')
      const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
      const markets = live
        .map((m) => ({ slug: m.slug, name: m.name, region: m.region, parcels: num(m.stats?.parcels), value: num(m.stats?.value), acres: num(m.stats?.acres), roll: m.roll ?? undefined }))
        .sort((a, b) => b.parcels - a.parcels)
      const states = new Set(live.map((m) => String(m.region || '').split(',').pop().trim()).filter(Boolean))
      return result({
        asOf: answer.body?.updated ?? undefined,
        markets: markets.length,
        states: states.size,
        parcels: markets.reduce((n, m) => n + m.parcels, 0),
        totalValue: markets.reduce((n, m) => n + m.value, 0),
        acres: Math.round(markets.reduce((n, m) => n + m.acres, 0)),
        note: 'Summed from each live market\'s published totals. Value is each county\'s own roll value (assessed or market, as the county states it), so the total is a sum of unlike figures and best quoted as "roll value".',
        byMarket: markets,
      })
    }

    case 'my_lists': {
      if (input.id) {
        const answer = await ask(`/api/lists/${encodeURIComponent(String(input.id))}`)
        if (answer.status !== 200) return failure(refusal(answer))
        const l = answer.body.list
        return result({
          id: l.id, name: l.name, client: l.client, tags: l.tags, count: l.count,
          places: (l.places || []).map((p) => ({ name: p.name, address: p.address, acres: p.acreage, market: p.market, parcelId: p.parcelId, lat: p.lat, lng: p.lng })),
          link: `${origin}/lists/${encodeURIComponent(l.id)}`,
        })
      }
      const answer = await ask('/api/lists')
      if (answer.status !== 200) return failure(refusal(answer))
      const client = String(input.client || '').toLowerCase()
      const tag = String(input.tag || '').toLowerCase()
      const lists = (answer.body?.lists || []).filter(
        (l) => (!client || String(l.client || '').toLowerCase().includes(client)) && (!tag || l.tags.some((t) => t.toLowerCase() === tag)),
      )
      return result({ lists: lists.map((l) => ({ id: l.id, name: l.name, client: l.client, tags: l.tags, places: l.count, link: `${origin}/lists/${l.id}` })) })
    }

    case 'add_to_list': {
      if (!scope.includes('crm')) {
        return failure('This connection can read but not change the CRM. Reconnect the Land Quotient connector and tick "Add to my CRM" to allow it.')
      }
      const name = String(input.list || '').trim()
      const ids = (Array.isArray(input.ids) ? input.ids : []).map(String).slice(0, 50)
      if (!name || !input.market || !ids.length) return failure('list, market and ids are required.')
      // The list: one of that name, or a new one with its client and tags.
      const all = await ask('/api/lists')
      if (all.status !== 200) return failure(refusal(all))
      let list = (all.body?.lists || []).find((l) => l.name.toLowerCase() === name.toLowerCase())
      let made = false
      if (!list) {
        const created = await ask('/api/lists', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, client: input.client ?? null, tags: Array.isArray(input.tags) ? input.tags : [] }),
        })
        if (created.status !== 201) return failure(refusal(created))
        list = created.body.list
        made = true
      }
      // Each parcel as a CRM place: the one already kept, or a new one.
      const placeIds = []
      const skipped = []
      for (const id of ids) {
        const q = `market=${encodeURIComponent(input.market)}&parcel=${encodeURIComponent(id)}`
        const known = await ask(`/api/crm/parcel?${q}`)
        if (known.status === 200 && known.body?.place?.id) {
          placeIds.push(known.body.place.id)
          continue
        }
        const found = await ask(`/api/gis/parcel?market=${encodeURIComponent(input.market)}&id=${encodeURIComponent(id)}`)
        if (found.status !== 200) {
          skipped.push(id)
          continue
        }
        const p = found.body.parcel || {}
        const bb = Array.isArray(p.bb) && p.bb.length === 4 ? p.bb.map(Number) : null
        const saved = await ask('/api/crm/places', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: String(p.ad || `Parcel ${p.gid ?? id}`),
            address: fullAddress(p, input.market).full || p.ad || null,
            acreage: p.ac ?? null,
            market: input.market,
            parcelId: String(id),
            lat: bb ? (bb[1] + bb[3]) / 2 : null,
            lng: bb ? (bb[0] + bb[2]) / 2 : null,
            notes: p.ow ? `Owner of record: ${p.ow}` : null,
          }),
        })
        if (saved.status !== 201 && saved.status !== 200) {
          skipped.push(id)
          continue
        }
        placeIds.push(saved.body?.record?.id)
      }
      let added = 0
      if (placeIds.length) {
        const answer = await ask(`/api/lists/${encodeURIComponent(list.id)}/places`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ placeIds: placeIds.filter(Boolean) }),
        })
        if (answer.status !== 200) return failure(refusal(answer))
        added = answer.body?.added ?? 0
      }
      return result({
        list: list.name,
        made: made || undefined,
        client: list.client ?? undefined,
        added,
        alreadyOn: placeIds.length - added || undefined,
        skipped: skipped.length ? skipped : undefined,
        link: `${origin}/lists/${encodeURIComponent(list.id)}`,
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
 *
 * `context.code` ({ executor, admit }) turns the connector to code mode: two
 * tools, search and execute, in place of the list. `context.classic` keeps
 * the list whatever the deployment can do.
 */
export async function handleRpc(message, context) {
  const reply = (resultValue) => ({ jsonrpc: '2.0', id: message.id, result: resultValue })
  const error = (code, text) => ({ jsonrpc: '2.0', id: message.id ?? null, error: { code, message: text } })
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return error(-32600, 'Invalid request')
  const isNotification = message.id === undefined || message.id === null
  // Code mode where the deployment has a sandbox to run scripts in and the
  // caller did not ask for the classic list; see codemode.js.
  const code = context?.code?.executor && !context.classic ? context.code : null

  switch (message.method) {
    case 'initialize': {
      const asked = message.params?.protocolVersion
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'land-quotient', title: 'Land Quotient', version: code ? '2.0.0' : '1.0.0' },
        instructions: code ? CODE_INSTRUCTIONS : INSTRUCTIONS,
      })
    }
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: code ? CODE_TOOLS : TOOLS })
    case 'tools/call': {
      const name = message.params?.name
      if (code && name === 'search') {
        const found = searchOperations(TOOLS, message.params?.arguments ?? {})
        return reply({ content: [{ type: 'text', text: JSON.stringify(found) }], structuredContent: found })
      }
      if (code && name === 'execute') {
        try {
          // The month's allowance of runs is checked, and charged, before the sandbox starts.
          const admitted = await code.admit()
          if (!admitted.ok) return reply(failure(admitted.why))
          return reply(await runScript(message.params?.arguments?.code, {
            tools: TOOLS,
            run: (operation, input) => runTool(operation, input, context),
            executor: code.executor,
          }))
        } catch (cause) {
          return reply(failure(`The script could not be run: ${cause?.message || cause}`))
        }
      }
      // An operation called by its own name: the classic connector, and an
      // assistant still holding the list it read before code mode.
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
