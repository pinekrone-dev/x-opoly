// Writes public/geo/us-states.json: the fifty states and the District of
// Columbia as GeoJSON, light enough to draw when the map is zoomed out to the
// whole country (src/components/MapCanvas.tsx shades the states with data).
//
//   npm install --no-save us-atlas@3 topojson-client@3
//   node scripts/us-states.mjs
//
// The outlines are the Census Bureau's cartographic boundaries as packaged by
// us-atlas (states-10m). Coordinates are kept to two decimals, about half a
// mile, which is finer than a state reads at that zoom.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { feature } = require('topojson-client')
const atlas = require('us-atlas/states-10m.json')

const USPS = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL',
  '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME',
  '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH',
  '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI',
  '45': 'SC', '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV', '55': 'WI',
  '56': 'WY',
}

const round = (n) => Math.round(n * 100) / 100
const thin = (ring) => {
  const out = []
  for (const [x, y] of ring) {
    const p = [round(x), round(y)]
    const last = out[out.length - 1]
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p)
  }
  return out.length >= 4 ? out : null
}

const features = []
for (const f of feature(atlas, atlas.objects.states).features) {
  const abbr = USPS[String(f.id).padStart(2, '0')]
  if (!abbr) continue // the territories: no market is there
  const polygons = (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates)
    .map((polygon) => polygon.map(thin).filter(Boolean))
    .filter((polygon) => polygon.length)
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity]
  for (const polygon of polygons) for (const [x, y] of polygon[0]) {
    // Alaska's far islands cross the date line; they are left out of the frame.
    if (x > 0) continue
    w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y)
  }
  features.push({
    type: 'Feature',
    properties: { abbr, name: f.properties.name, box: [w, s, e, n] },
    geometry: polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0] } : { type: 'MultiPolygon', coordinates: polygons },
  })
}
features.sort((a, b) => a.properties.abbr.localeCompare(b.properties.abbr))
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'geo', 'us-states.json')
fs.writeFileSync(out, JSON.stringify({ type: 'FeatureCollection', features }))
console.log(`${features.length} states, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`)
