/*
 * The zoomed-out summary grid: the market summed into kilometre cells
 * (GET /api/gis/grid), drawn where lots are too small to tell apart.
 *
 * Each cell is shaded in one of five bands of the metric picked, cut at the
 * market's own quintiles so every county uses its whole ramp, and the bands
 * are the legend. A cell with nothing to say for the metric (no acreage, no
 * tagged parcels) is left out rather than drawn as zero.
 */

export interface ParcelGrid {
  market: string
  /** Cell size in degrees; cells are indexed from -180 / -90. */
  cell: number
  version: string
  tagged: boolean
  btagged: boolean
  /** gx, gy, parcels, value, acres, in flood, flood read, vacant, buildings read */
  cells: [number, number, number, number, number, number, number, number, number][]
}

export type GridMetric = 'value' | 'flood' | 'vacant' | 'count'

export const GRID_METRICS: { id: GridMetric; label: string; needs?: 'tagged' | 'btagged' }[] = [
  { id: 'value', label: 'Value per acre' },
  { id: 'count', label: 'Parcels' },
  { id: 'flood', label: 'Share in flood zone', needs: 'tagged' },
  { id: 'vacant', label: 'Share with no building', needs: 'btagged' },
]

/** Light to dark, readable over streets and imagery alike. */
export const GRID_RAMP = ['#fef3c7', '#fcd34d', '#f59e0b', '#d97706', '#7c2d12']

const one = (n: number) => n.toFixed(1).replace(/\.0$/, '')
const compact = (n: number) =>
  n >= 1e9 ? `${one(n / 1e9)}B` : n >= 1e6 ? `${one(n / 1e6)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n))

function metricOf(metric: GridMetric, c: ParcelGrid['cells'][number]): number | null {
  const [, , count, value, acres, flood, floodRead, vacant, built] = c
  if (metric === 'count') return count
  if (metric === 'value') return acres > 0 && value > 0 ? value / acres : null
  if (metric === 'flood') return floodRead > 0 ? flood / floodRead : null
  return built > 0 ? vacant / built : null
}

function word(metric: GridMetric, v: number): string {
  if (metric === 'value') return `$${compact(v)}`
  if (metric === 'count') return compact(v)
  return `${Math.round(v * 100)}%`
}

export interface GridDrawing {
  geo: GeoJSON.FeatureCollection
  /** Band label → colour, in order from lowest to highest. */
  colors: Record<string, string>
  counts: Record<string, number>
}

export function gridFeatures(grid: ParcelGrid | null, metric: GridMetric): GridDrawing | null {
  if (!grid?.cells?.length) return null
  const valued = grid.cells.map((c) => ({ c, v: metricOf(metric, c) })).filter((x): x is { c: typeof x.c; v: number } => x.v != null && Number.isFinite(x.v))
  if (!valued.length) return null
  const sorted = valued.map((x) => x.v).sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  // Upper edges of the bands, repeated edges merged: a market where most
  // cells are 0% vacant has fewer bands, not five that say the same thing.
  const edges = [...new Set([0.2, 0.4, 0.6, 0.8].map(at).concat(sorted[sorted.length - 1]))]
  const lows = [sorted[0], ...edges.slice(0, -1)]
  const labels = edges.map((hi, i) => {
    const lo = lows[i]
    const suffix = metric === 'value' ? ' / acre' : metric === 'count' ? ' parcels' : ''
    if (i === 0) return `up to ${word(metric, hi)}${suffix}`
    return word(metric, lo) === word(metric, hi) ? `${word(metric, hi)}${suffix}` : `${word(metric, lo)}–${word(metric, hi)}${suffix}`
  })
  // Spread whatever bands there are across the whole ramp.
  const colors: Record<string, string> = {}
  labels.forEach((label, i) => {
    colors[label] = GRID_RAMP[labels.length === 1 ? GRID_RAMP.length - 1 : Math.round((i * (GRID_RAMP.length - 1)) / (labels.length - 1))]
  })
  const counts: Record<string, number> = {}
  const size = grid.cell
  const features: GeoJSON.Feature[] = valued.map(({ c, v }) => {
    const band = edges.findIndex((hi) => v <= hi)
    const label = labels[band < 0 ? labels.length - 1 : band]
    counts[label] = (counts[label] ?? 0) + 1
    const [gx, gy, count, value, acres, flood, floodRead, vacant, built] = c
    const w = gx * size - 180
    const s = gy * size - 90
    const properties: Record<string, string | number> = {
      Band: label,
      Parcels: count.toLocaleString(),
      'Assessed value': value > 0 ? `$${compact(value)}` : '',
      Acres: Math.round(acres).toLocaleString(),
      'Value per acre': acres > 0 && value > 0 ? `$${compact(value / acres)}` : '',
    }
    if (floodRead > 0) properties['In flood zone'] = `${Math.round((flood / floodRead) * 100)}%`
    if (built > 0) properties['No building'] = `${Math.round((vacant / built) * 100)}%`
    return {
      type: 'Feature',
      properties,
      geometry: {
        type: 'Polygon',
        coordinates: [[[w, s], [w + size, s], [w + size, s + size], [w, s + size], [w, s]]],
      },
    }
  })
  return { geo: { type: 'FeatureCollection', features }, colors, counts }
}
