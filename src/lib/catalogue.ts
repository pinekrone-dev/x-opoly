/**
 * The published market catalogue, for the pages that quote it.
 *
 * The map view has its own copy of this fetch with the reasoning behind the
 * fallback; the public pages need only the numbers, so this is the small
 * version. Same origin first, the data domain if this bundle is served
 * somewhere without the catalogue route.
 */

export interface MarketStats {
  parcels: number
  value: number
  acres?: number
  groups?: Record<string, number>
  names?: number
  portfolios?: number
  offices?: number
  inPortfolio?: number
  fields?: { k: string; l: string; pct: number }[]
  center?: [number, number]
}

export interface Market {
  slug: string
  name: string
  region: string
  status: string
  blurb: string
  roll?: string
  sources?: string[]
  stats: MarketStats
}

const CATALOG = import.meta.env.VITE_PARCEL_CATALOG || '/catalog'
const CATALOG_DEFAULT = 'https://data.realestateaistudio.com'

async function asJson(r: Response) {
  if (!r.ok) throw new Error(`${r.status}`)
  return r.json()
}

export async function fetchMarkets(): Promise<Market[]> {
  let doc: { markets?: Market[] } | Market[]
  try {
    doc = await asJson(await fetch(`${CATALOG}/markets.json`, { cache: 'no-cache' }))
  } catch (first) {
    if (CATALOG === CATALOG_DEFAULT) throw first
    doc = await asJson(await fetch(`${CATALOG_DEFAULT}/markets.json`, { cache: 'no-cache' }))
  }
  const list = Array.isArray(doc) ? doc : (doc.markets ?? [])
  return list.filter((m) => m.status === 'live')
}

/** The headline totals a page quotes, summed from whatever is published. */
export function totals(markets: Market[]) {
  return markets.reduce(
    (sum, m) => ({
      markets: sum.markets + 1,
      parcels: sum.parcels + (m.stats?.parcels ?? 0),
      value: sum.value + (m.stats?.value ?? 0),
      portfolios: sum.portfolios + (m.stats?.portfolios ?? 0),
    }),
    { markets: 0, parcels: 0, value: 0, portfolios: 0 },
  )
}

/** 6.2M, 1.7M, 41,802 — the count as a person would say it. */
export function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e5) return `${Math.round(n / 1e3)}K`
  return n.toLocaleString()
}

/** $4.6T, $389B, $69B. */
export function money(n: number): string {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(1)}T`
  if (n >= 1e9) return `$${Math.round(n / 1e9)}B`
  if (n >= 1e6) return `$${Math.round(n / 1e6)}M`
  return `$${n.toLocaleString()}`
}
