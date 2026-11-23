// Writes public/geo/counties/<state FIPS>.json: each state's counties as
// GeoJSON, one file a state, so the map fetches only the states it is showing
// (src/components/MapCanvas.tsx shades the counties that have data between
// the country view and the zoom where parcels draw).
//
//   npm install --no-save us-atlas@3 topojson-client@3
//   node scripts/us-counties.mjs
//
// The outlines are the Census Bureau's cartographic boundaries as packaged by
// us-atlas (counties-10m), kept to three decimals, about a hundred yards.
// us-atlas carries Connecticut's eight old counties, not the planning regions
// the Census Bureau has used since 2022, so a Connecticut market's own codes
// are not in here; the map falls back to the county its centre stands in.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { feature } = require('topojson-client')
const atlas = require('us-atlas/counties-10m.json')

const round = (n) => Math.round(n * 1000) / 1000
const thin = (ring) => {
  const out = []
  for (const [x, y] of ring) {
    const p = [round(x), round(y)]
    const last = out[out.length - 1]
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p)
  }
  return out.length >= 4 ? out : null
}

const byState = new Map()
for (const f of feature(atlas, atlas.objects.counties).features) {
  const fips = String(f.id).padStart(5, '0')
  const state = fips.slice(0, 2)
  if (Number(state) > 56) continue // the territories: no market is there
  const polygons = (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates)
    .map((polygon) => polygon.map(thin).filter(Boolean))
    .filter((polygon) => polygon.length)
  if (!polygons.length) continue
  if (!byState.has(state)) byState.set(state, [])
  byState.get(state).push({
    type: 'Feature',
    properties: { fips, name: f.properties.name },
    geometry: polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0] } : { type: 'MultiPolygon', coordinates: polygons },
  })
}
const dir = process.env.OUT_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'geo', 'counties')
fs.mkdirSync(dir, { recursive: true })
let total = 0
let largest = [0, '']
for (const [state, features] of byState) {
  features.sort((a, b) => a.properties.fips.localeCompare(b.properties.fips))
  const file = path.join(dir, `${state}.json`)
  fs.writeFileSync(file, JSON.stringify({ type: 'FeatureCollection', features }))
  const size = fs.statSync(file).size
  total += size
  if (size > largest[0]) largest = [size, state]
}
console.log(`${byState.size} states, ${(total / 1024).toFixed(0)} KB in all, largest ${largest[1]} at ${(largest[0] / 1024).toFixed(0)} KB`)
