import type { Property, Stage } from '../types'

export const STAGE_META: Record<Stage, { label: string; color: string; ring: string }> = {
  prospect: { label: 'Prospect', color: '#94a3b8', ring: 'bg-slate-500/15 text-slate-300 ring-slate-400/30' },
  touring: { label: 'Touring', color: '#38bdf8', ring: 'bg-sky-500/15 text-sky-300 ring-sky-400/30' },
  loi: { label: 'LOI out', color: '#fbbf24', ring: 'bg-amber-500/15 text-amber-300 ring-amber-400/30' },
  under_contract: { label: 'Under contract', color: '#34d399', ring: 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/30' },
  passed: { label: 'Passed', color: '#64748b', ring: 'bg-slate-600/20 text-slate-400 ring-slate-500/30' },
}

export const STAGE_ORDER: Stage[] = ['prospect', 'touring', 'loi', 'under_contract', 'passed']

export function money(value: number | null | undefined, fractionDigits = 2): string {
  if (value == null) return '—'
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits })}`
}

export function sqft(value: number | null | undefined): string {
  return value == null ? '—' : `${value.toLocaleString('en-US')} SF`
}

export function count(value: number | null | undefined): string {
  return value == null ? '—' : value.toLocaleString('en-US')
}

/** "$28.50 psf/yr" — the rate as a broker would say it. */
export function rate(property: Pick<Property, 'rentRate' | 'rentUnit'>): string {
  if (property.rentRate == null) return 'Rate on request'
  return `${money(property.rentRate)}${property.rentUnit ? ` ${property.rentUnit}` : ''}`
}

export function fullAddress(property: Partial<Property>): string {
  const line = [property.address, property.city, property.state].filter(Boolean).join(', ')
  return [line, property.zip].filter(Boolean).join(' ') || 'No address yet'
}

export function displayName(property: Partial<Property>): string {
  return property.name || property.address || 'Untitled site'
}

export function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`
}

export function shortDate(value: string | null | undefined): string {
  if (!value) return '—'
  return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** Center and zoom that fit every pin, for a fresh map load. */
export function boundsFor(properties: Property[]): { center: [number, number]; zoom: number } | null {
  const located = properties.filter((property) => property.lat != null && property.lng != null)
  if (located.length === 0) return null

  const lats = located.map((property) => property.lat as number)
  const lngs = located.map((property) => property.lng as number)
  const center: [number, number] = [(Math.min(...lats) + Math.max(...lats)) / 2, (Math.min(...lngs) + Math.max(...lngs)) / 2]
  const spread = Math.max(Math.max(...lats) - Math.min(...lats), Math.max(...lngs) - Math.min(...lngs))

  let zoom = 13
  if (spread > 1.5) zoom = 8
  else if (spread > 0.7) zoom = 9
  else if (spread > 0.35) zoom = 10
  else if (spread > 0.15) zoom = 11
  else if (spread > 0.06) zoom = 12

  return { center, zoom }
}
