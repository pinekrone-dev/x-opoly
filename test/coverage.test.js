/**
 * The picture of the country on the home page: a market's dot has to land
 * inside the state it is in, and Alaska and Hawaii sit clear of the mainland.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { MAP_H, MAP_W, place, stateOf } from '../src/lib/coverage.ts'

const states = JSON.parse(readFileSync(new URL('../public/geo/us-states.json', import.meta.url), 'utf8')).features

/** The box a state's outline occupies on the picture. */
function boxOf(abbr) {
  const shape = states.find((s) => s.properties.abbr === abbr)
  const polygons = shape.geometry.type === 'Polygon' ? [shape.geometry.coordinates] : shape.geometry.coordinates
  const box = [Infinity, Infinity, -Infinity, -Infinity]
  for (const polygon of polygons) for (const ring of polygon) for (const [lon, lat] of ring) {
    const [x, y] = place(abbr, lon, lat)
    box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y)
  }
  return box
}

test('a market is placed in the state its slug names', () => {
  assert.equal(stateOf('austin-tx'), 'TX')
  assert.equal(stateOf('new-york-ny'), 'NY')
  assert.equal(stateOf('austin'), '')        // no state on the slug: no dot, rather than a guess
  for (const [slug, lon, lat] of [['austin-tx', -97.74, 30.27], ['seattle-wa', -122.33, 47.61], ['miami-fl', -80.19, 25.76], ['anchorage-ak', -149.9, 61.22]]) {
    const abbr = stateOf(slug)
    const [x, y] = place(abbr, lon, lat)
    const [x0, y0, x1, y1] = boxOf(abbr)
    assert.ok(x >= x0 && x <= x1 && y >= y0 && y <= y1, `${slug} falls outside ${abbr}`)
  }
})

test('every state fits on the picture, and Alaska and Hawaii clear the mainland', () => {
  for (const shape of states) {
    const [x0, y0, x1, y1] = boxOf(shape.properties.abbr)
    assert.ok(x0 >= 0 && y0 >= 0 && x1 <= MAP_W && y1 <= MAP_H, `${shape.properties.abbr} runs off the picture`)
  }
  const [, akTop] = boxOf('AK')
  const california = boxOf('CA'), arizona = boxOf('AZ')
  assert.ok(akTop > california[3] && akTop > arizona[3], 'Alaska overlaps the southwest')
  // West is left and north is up.
  assert.ok(place('CA', -122, 37)[0] < place('NY', -74, 41)[0])
  assert.ok(place('WA', -122, 47)[1] < place('TX', -97, 30)[1])
})
