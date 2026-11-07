/**
 * The chains on an amenity map, numbered the way a reader looks for them.
 *
 * One pin per store fails in exactly the places that matter: a shopping
 * centre holds a dozen tenants within a block, and a dozen pins there pile
 * up behind each other. So stores that share a spot are one marker ("12–15"),
 * placed approximately, and the numbers run outward from the site, marker by
 * marker, so neighbours read consecutively on the map and in the list.
 */
import type { NearbyBusiness } from '../types'

export interface NumberedAmenity extends NearbyBusiness {
  /** The number on the map and in the legend. */
  n: number
  /** Which marker it shares with its neighbours. */
  group: number
}

export interface AmenityGroup {
  group: number
  first: number
  last: number
  lat: number
  lng: number
  members: NumberedAmenity[]
}

function meters(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const k = Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180))
  const dx = (a.lng - b.lng) * 111320 * k
  const dy = (a.lat - b.lat) * 110540
  return Math.hypot(dx, dy)
}

/**
 * One store per brand (the nearest) within `withinMiles`, the nearest
 * `limit`, grouped where they stand within `joinMeters` of each other, and
 * numbered group by group from the site outward.
 */
export function numberAmenities(
  results: NearbyBusiness[],
  { limit = 48, withinMiles = 1.05, joinMeters = 120 } = {},
): NumberedAmenity[] {
  const nearest = new Map<string, NearbyBusiness>()
  for (const r of results) {
    if (!(r.miles <= withinMiles)) continue
    // An amenity map shows storefronts: offices, and the chargers and
    // kiosks a brand tags, are not what a tenant or a shopper looks for.
    if (r.sector === 'Offices' || /charg|atm|locker|kiosk/i.test(String(r.category ?? ''))) continue
    const key = (r.brand || r.name).toLowerCase()
    const held = nearest.get(key)
    if (!held || r.miles < held.miles) nearest.set(key, r)
  }
  const kept = [...nearest.values()].sort((a, b) => a.miles - b.miles).slice(0, limit)

  // Each group is anchored on its nearest store; a store joins the first
  // group whose anchor is within reach. Groups come out ordered by their
  // anchor's distance, since stores are taken nearest first.
  const groups: { anchor: NearbyBusiness; members: NearbyBusiness[] }[] = []
  for (const r of kept) {
    const home = groups.find((g) => meters(g.anchor, r) <= joinMeters)
    if (home) home.members.push(r)
    else groups.push({ anchor: r, members: [r] })
  }
  let n = 0
  return groups.flatMap((g, group) => g.members.map((r) => ({ ...r, n: ++n, group })))
}

/** The markers to draw: one per group, at its stores' middle. */
export function amenityGroups(list: NumberedAmenity[]): AmenityGroup[] {
  const byGroup = new Map<number, NumberedAmenity[]>()
  for (const a of list) byGroup.set(a.group, [...(byGroup.get(a.group) ?? []), a])
  return [...byGroup.entries()].map(([group, members]) => ({
    group,
    first: Math.min(...members.map((m) => m.n)),
    last: Math.max(...members.map((m) => m.n)),
    lat: members.reduce((t, m) => t + m.lat, 0) / members.length,
    lng: members.reduce((t, m) => t + m.lng, 0) / members.length,
    members,
  }))
}

/** "Quick service 9 · Restaurants 4 · Banks 2": the tenant mix, largest first. */
export function tenantMix(list: NearbyBusiness[]): string {
  const counts = new Map<string, number>()
  for (const a of list) counts.set(a.sector ?? 'Other', (counts.get(a.sector ?? 'Other') ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([s, c]) => `${s} ${c}`).join(' · ')
}

/**
 * Where each marker goes: its own spot when that is free, otherwise the
 * nearest free spot around it, on rings of growing radius. Boxes are
 * width × height around a centre; nothing placed overlaps anything placed
 * before it, nor the `keepClear` boxes (the site pin). Coordinates in the
 * caller's units, clamped inside `bounds`.
 */
export function placeMarkers(
  wants: { x: number; y: number; w: number; h: number }[],
  bounds: { width: number; height: number },
  keepClear: { x: number; y: number; w: number; h: number }[] = [],
  gap = 2,
): { x: number; y: number }[] {
  const taken = [...keepClear]
  const clash = (x: number, y: number, w: number, h: number) =>
    taken.some((t) => Math.abs(t.x - x) * 2 < t.w + w + gap * 2 && Math.abs(t.y - y) * 2 < t.h + h + gap * 2)
  const clamp = (v: number, half: number, size: number) => Math.min(size - half - 1, Math.max(half + 1, v))
  return wants.map((want) => {
    const fit = (x: number, y: number) => [clamp(x, want.w / 2, bounds.width), clamp(y, want.h / 2, bounds.height)] as const
    let [bx, by] = fit(want.x, want.y)
    if (clash(bx, by, want.w, want.h)) {
      search: for (let ring = 1; ring <= 12; ring += 1) {
        const r = ring * Math.max(want.h, 12) * 0.95
        const steps = 8 + ring * 4
        for (let i = 0; i < steps; i += 1) {
          const angle = (i / steps) * Math.PI * 2 - Math.PI / 2
          const [x, y] = fit(want.x + r * Math.cos(angle), want.y + r * Math.sin(angle))
          if (!clash(x, y, want.w, want.h)) {
            ;[bx, by] = [x, y]
            break search
          }
        }
      }
    }
    taken.push({ x: bx, y: by, w: want.w, h: want.h })
    return { x: bx, y: by }
  })
}
