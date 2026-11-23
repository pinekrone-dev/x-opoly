/**
 * The state outlines the map shades when it shows the whole country
 * (scripts/us-states.mjs writes them; MapCanvas draws them).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'

test('fifty states and the District, each with its postal code and a box to frame it by', () => {
  const file = fs.readFileSync('public/geo/us-states.json', 'utf8')
  assert.ok(file.length < 300_000, 'light enough to fetch for a zoomed-out map')
  const { features } = JSON.parse(file)
  assert.equal(features.length, 51)
  const codes = features.map((f) => f.properties.abbr)
  assert.equal(new Set(codes).size, 51)
  for (const code of ['TX', 'CA', 'NY', 'DC', 'AK', 'HI']) assert.ok(codes.includes(code), code)
  for (const f of features) {
    assert.match(f.properties.abbr, /^[A-Z]{2}$/)
    assert.ok(f.properties.name)
    const [w, s, e, n] = f.properties.box
    assert.ok(w < e && s < n && w >= -180 && e <= -66 && s >= 18 && n <= 72, `${f.properties.abbr} box ${f.properties.box}`)
    assert.ok(['Polygon', 'MultiPolygon'].includes(f.geometry.type))
  }
  const texas = features.find((f) => f.properties.abbr === 'TX').properties.box
  assert.deepEqual(texas.map(Math.round), [-107, 26, -94, 37])
})
