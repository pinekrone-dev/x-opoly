/*
 * The counties that have data, for the map between the country view and
 * the zoom where parcels draw.
 *
 * Three steps down from the whole country, each costing only what it
 * shows: the states with data (one small file), then the counties with
 * data in the states in view (one small file a state, fetched as the map
 * reaches them), then the parcels of the county the map is in. A market
 * says which counties it covers (the codes its census tracts sit in, from
 * the catalogue), and the shapes are the Census cartographic boundaries.
 *
 * A market whose codes are not in the shapes still gets a county: the one
 * its centre stands in. Connecticut is the case: its markets are filed
 * under the planning regions the Census Bureau uses now, and the shapes
 * carry the eight old counties.
 */
export interface CountyMarket {
  slug: string
  name: string
  /** Five-digit county codes, state then county. */
  counties: string[]
  /** Longitude, latitude. */
  center: [number, number]
}

type Shape = GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon, { fips: string; name: string }>
export type StateShapes = { features: Shape[] }

const USPS_FIPS: Record<string, string> = {
  AL: '01', AK: '02', AZ: '04', AR: '05', CA: '06', CO: '08', CT: '09', DE: '10', DC: '11', FL: '12', GA: '13', HI: '15',
  ID: '16', IL: '17', IN: '18', IA: '19', KS: '20', KY: '21', LA: '22', ME: '23', MD: '24', MA: '25', MI: '26', MN: '27',
  MS: '28', MO: '29', MT: '30', NE: '31', NV: '32', NH: '33', NJ: '34', NM: '35', NY: '36', NC: '37', ND: '38', OH: '39',
  OK: '40', OR: '41', PA: '42', RI: '44', SC: '45', SD: '46', TN: '47', TX: '48', UT: '49', VT: '50', VA: '51', WA: '53',
  WV: '54', WI: '55', WY: '56',
}

/** The states a market's counties are in: from its codes, else from the postal code its slug ends in. */
export function statesOf(market: CountyMarket): string[] {
  const fromCodes = [...new Set(market.counties.filter((code) => /^\d{5}$/.test(code)).map((code) => code.slice(0, 2)))]
  if (fromCodes.length) return fromCodes
  const postal = /-([a-z]{2})$/.exec(market.slug)?.[1].toUpperCase()
  const state = postal ? USPS_FIPS[postal] : undefined
  return state ? [state] : []
}

const inRing = (x: number, y: number, ring: number[][]) => {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

const contains = (shape: Shape, [x, y]: [number, number]) => {
  const polygons = shape.geometry.type === 'Polygon' ? [shape.geometry.coordinates] : shape.geometry.coordinates
  return polygons.some((polygon) => inRing(x, y, polygon[0]) && !polygon.slice(1).some((hole) => inRing(x, y, hole)))
}

/**
 * The counties to shade, each tagged with the market that covers it, from
 * whichever states' shapes have been fetched so far. A county two markets
 * name goes to the first; a market in a state not fetched yet is left for
 * when it is.
 */
export function countyFeatures(markets: CountyMarket[], shapes: Record<string, StateShapes>): GeoJSON.FeatureCollection {
  const taken = new Set<string>()
  const features: GeoJSON.Feature[] = []
  const add = (shape: Shape, market: CountyMarket) => {
    if (taken.has(shape.properties.fips)) return
    taken.add(shape.properties.fips)
    features.push({ type: 'Feature', geometry: shape.geometry, properties: { slug: market.slug, market: market.name, county: shape.properties.name, fips: shape.properties.fips } })
  }
  const unplaced: CountyMarket[] = []
  for (const market of markets) {
    const wanted = new Set(market.counties)
    let found = 0
    let fetched = false
    for (const state of statesOf(market)) {
      const have = shapes[state]
      if (!have) continue
      fetched = true
      for (const shape of have.features) {
        if (wanted.has(shape.properties.fips)) {
          add(shape, market)
          found += 1
        }
      }
    }
    if (fetched && !found) unplaced.push(market)
  }
  // After every named county is placed, so a centre never takes a county another market names.
  for (const market of unplaced) {
    for (const state of statesOf(market)) {
      const here = shapes[state]?.features.find((shape) => contains(shape, market.center))
      if (here) {
        add(here, market)
        break
      }
    }
  }
  return { type: 'FeatureCollection', features }
}
