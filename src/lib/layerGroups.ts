/**
 * Layer families, shared by the map panel and the offering memorandum.
 */

/*
 * Layer families: a market can publish one kind of data from several
 * sources that cannot share a layer (Phoenix's counted street segments and
 * Scottsdale's count stations are lines and points). The panel shows each
 * family as one card, switched on and off together.
 */
export const GROUP_LABELS: Record<string, string> = { traffic: 'Traffic' }

export function layerGroup(id: string): string {
  return id === 'traffic' || id.startsWith('traffic-') ? 'traffic' : id
}

/** "Traffic" for the main source, "Traffic (Scottsdale)" for a city's own. */
export function trafficLabel(layer: { id: string; label: string }): string {
  if (layer.id === 'traffic') return 'Traffic'
  const place = layer.label.replace(/traffic( counts?)?/i, '').trim()
  return place ? `Traffic (${place})` : 'Traffic'
}

/** Layers in panel order, with each family gathered where its first member stood. */
export function groupLayers<T extends { id: string }>(layers: T[]): { key: string; members: T[] }[] {
  const out: { key: string; members: T[] }[] = []
  const at = new Map<string, number>()
  for (const layer of layers) {
    const key = layerGroup(layer.id)
    const i = at.get(key)
    if (i === undefined) {
      at.set(key, out.length)
      out.push({ key, members: [layer] })
    } else out[i].members.push(layer)
  }
  return out
}

