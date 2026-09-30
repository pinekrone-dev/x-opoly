/*
 * Ships on the map: what both halves agree on.
 *
 * Positions come from AIS, the radio beacon every commercial ship over 300
 * tons and every passenger ship must carry, relayed by aisstream.io's free
 * stream. The server holds the stream (see app/lib/vessels.js); this file is
 * the vocabulary the server and the map share, so a ship the server calls a
 * tanker is painted as one.
 */

/**
 * Markets with water that ships report from, checked against NOAA's 2025
 * transit counts rather than guessed from a map: every market here showed
 * traffic within a county's reach of its centre, and none of the others did.
 * Offering the layer inland would only ever draw an empty map.
 */
export const COASTAL_MARKETS = new Set([
  'boston-ma',
  'chicago-il',
  'detroit-mi',
  'fort-lauderdale-fl',
  'houston-tx',
  'jersey-city-nj',
  'los-angeles-ca',
  'miami-fl',
  'new-york-ny',
  'orange-county-ca',
  'philadelphia-pa',
  'san-diego-ca',
  'tampa-fl',
  'washington-dc',
])

/**
 * How far from a market's centre ships are asked for, in degrees.
 *
 * About 65 km north and south and 70 km east and west at these latitudes:
 * enough to take in Houston's ship channel down to Galveston and the mouth of
 * Tampa Bay, and small enough that the stream is not carrying the Gulf.
 */
export const REACH = { lat: 0.6, lng: 0.75 }

/** A market's box as [west, south, east, north]. */
export function marketBox(center: [number, number]): [number, number, number, number] {
  const [lng, lat] = center
  return [lng - REACH.lng, lat - REACH.lat, lng + REACH.lng, lat + REACH.lat]
}

/**
 * The widest view, in degrees either way, that ships are drawn for.
 *
 * About a city's worth at street-to-district zoom. A whole county of ships is
 * a smear of dots that says nothing, and it is also the biggest answer the
 * server would ever send, every twenty seconds; zoomed out, the layer says
 * how many ships are about and asks to be zoomed in instead.
 */
export const VIEW_MAX_SPAN = 0.9

/** The most ships one answer carries, however busy the harbour. */
export const VIEW_SHIP_CAP = 1500

/**
 * A view snapped outward to a 0.02 degree grid, about two kilometres.
 *
 * Two people looking at nearly the same stretch of water ask the same
 * question, so the answer can be shared at the edge; a pan of a few hundred
 * metres does not make a new one.
 */
export function snapView(bounds: [number, number, number, number]): [number, number, number, number] {
  const step = 0.02
  const down = (v: number) => Math.round(Math.floor(v / step) * step * 100) / 100
  const up = (v: number) => Math.round(Math.ceil(v / step) * step * 100) / 100
  return [down(bounds[0]), down(bounds[1]), up(bounds[2]), up(bounds[3])]
}

/** Whether a view is too wide to draw ships for. */
export function viewTooWide(bounds: [number, number, number, number]): boolean {
  return bounds[2] - bounds[0] > VIEW_MAX_SPAN || bounds[3] - bounds[1] > VIEW_MAX_SPAN
}

/** The groups a ship is coloured by, in legend order. */
export const VESSEL_COLORS: Record<string, string> = {
  Cargo: '#2a78d6',
  Tanker: '#d94c4c',
  Passenger: '#8b5cf6',
  'Tug and towing': '#eb8a34',
  Fishing: '#1baf7a',
  'Pleasure and sailing': '#e0b100',
  'High-speed craft': '#0ea5b7',
  Service: '#64748b',
  Other: '#9AA1B4',
  'Not yet reported': '#cbd5e1',
}

/**
 * The AIS ship type code, grouped.
 *
 * The code is two digits, and the first says most of it: 6x passenger, 7x
 * cargo, 8x tanker. The 3x and 5x ranges are one code per trade. A ship's
 * type arrives in its static report, every six minutes, not with its
 * position, so a ship seen for the first time is "not yet reported" rather
 * than guessed at.
 */
export function shipGroup(code: number | null | undefined): string {
  if (code == null || !Number.isFinite(code) || code <= 0) return 'Not yet reported'
  if (code === 30) return 'Fishing'
  if (code === 31 || code === 32 || code === 52) return 'Tug and towing'
  if (code === 36 || code === 37) return 'Pleasure and sailing'
  if (code >= 40 && code <= 49) return 'High-speed craft'
  if (code >= 60 && code <= 69) return 'Passenger'
  if (code >= 70 && code <= 79) return 'Cargo'
  if (code >= 80 && code <= 89) return 'Tanker'
  if ([33, 34, 35, 50, 51, 53, 54, 55, 58, 59].includes(code)) return 'Service'
  return 'Other'
}

const NAV_STATUS: Record<number, string> = {
  0: 'Under way',
  1: 'At anchor',
  2: 'Not under command',
  3: 'Restricted manoeuvrability',
  4: 'Constrained by draught',
  5: 'Moored',
  6: 'Aground',
  7: 'Fishing',
  8: 'Under way, sailing',
  14: 'Emergency beacon',
}

/** What the ship says it is doing, when it says. */
export function navStatus(code: number | null | undefined): string | null {
  return code == null ? null : NAV_STATUS[code] ?? null
}

/** One ship as the server hands it over: short keys, since a busy port is a thousand of them every few seconds. */
export interface Ship {
  /** MMSI, the radio's own number. */
  m: number
  la: number
  lo: number
  /** Name, as the ship broadcasts it. */
  n?: string | null
  /** Speed over ground, knots. */
  sog?: number | null
  /** Course over ground, degrees. */
  cog?: number | null
  /** Heading, degrees. */
  hdg?: number | null
  /** Navigational status code. */
  st?: number | null
  /** AIS ship type code. */
  ty?: number | null
  /** Destination, as typed by the crew. */
  de?: string | null
  /** Length, metres. */
  len?: number | null
  cs?: string | null
  imo?: number | null
  /** When the position was reported, epoch milliseconds. */
  t: number
}

export interface VesselAnswer {
  /** live: streaming; connecting: asked, not yet answered; off: no key here; error: the stream refused. */
  status: 'live' | 'connecting' | 'off' | 'error'
  note?: string | null
  /** Ships heard anywhere in the market, whether or not they are in view. */
  total?: number
  /** The view was wider than ships are drawn for; `ships` is empty and `total` says what is out there. */
  tooWide?: boolean
  /** When the stream started for this market, epoch milliseconds. */
  since?: number | null
  ships: Ship[]
}

function ago(ms: number): string {
  const minutes = Math.round(ms / 60000)
  if (minutes < 1) return 'just now'
  return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`
}

/** The ships as a point layer, with the fields the record card reads out. */
export function vesselFeatures(ships: Ship[], now = Date.now()): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: ships.map((ship) => ({
      type: 'Feature' as const,
      id: ship.m,
      geometry: { type: 'Point' as const, coordinates: [ship.lo, ship.la] },
      properties: {
        Name: ship.n || '',
        Type: shipGroup(ship.ty),
        Status: navStatus(ship.st) ?? '',
        Speed: ship.sog != null ? `${ship.sog} kn` : '',
        Course: ship.cog != null ? `${Math.round(ship.cog)}°` : '',
        Heading: ship.hdg != null ? `${ship.hdg}°` : '',
        Destination: ship.de || '',
        Length: ship.len ? `${ship.len} m` : '',
        'Call sign': ship.cs || '',
        IMO: ship.imo ? String(ship.imo) : '',
        MMSI: String(ship.m),
        'Last report': ago(now - ship.t),
      },
    })),
  }
}
