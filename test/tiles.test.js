import assert from 'node:assert/strict'
import test, { describe } from 'node:test'

import { TILE_PRESETS, placeholderTile, resolveTiles } from '../server/lib/tiles.js'

describe('basemap selection', () => {
  test('defaults to a provider that needs no key or billing account', () => {
    const tiles = resolveTiles({})
    assert.equal(tiles.provider, 'osm')
    assert.ok(tiles.url.includes('{z}/{x}/{y}'))
    assert.equal(tiles.placeholder, false)
  })

  test('substitutes the key and style into a keyed provider', () => {
    const mapbox = resolveTiles({ TILE_PROVIDER: 'mapbox', TILE_KEY: 'pk.test' })
    assert.equal(mapbox.provider, 'mapbox')
    assert.ok(mapbox.url.includes('pk.test'))
    assert.ok(!mapbox.url.includes('{key}'))
    assert.ok(!mapbox.url.includes('{style}'))

    const here = resolveTiles({ TILE_PROVIDER: 'here', TILE_KEY: 'HK1' })
    assert.ok(here.url.includes('apiKey=HK1'))
  })

  test('falls back rather than serving a broken keyed provider', () => {
    const tiles = resolveTiles({ TILE_PROVIDER: 'mapbox' })
    assert.equal(tiles.provider, 'osm', 'no key means no Mapbox')
    assert.match(tiles.notice, /needs an API key/)
    assert.ok(!tiles.url.includes('{key}'), 'never leaves an unfilled key placeholder in the URL')
  })

  test('an explicit TILE_URL wins, for a self-hosted tile server', () => {
    const tiles = resolveTiles({ TILE_URL: 'http://tiles.internal/{z}/{x}/{y}.png', TILE_ATTRIBUTION: 'Internal' })
    assert.equal(tiles.provider, 'custom')
    assert.equal(tiles.attribution, 'Internal')
  })

  test('an unknown provider name falls back instead of failing', () => {
    assert.equal(resolveTiles({ TILE_PROVIDER: 'not-a-provider' }).provider, 'osm')
  })

  test('natively dark basemaps are flagged so the UI does not invert them twice', () => {
    assert.equal(resolveTiles({}).darkNative, false, 'standard OSM is light and gets inverted')
    assert.equal(resolveTiles({ TILE_PROVIDER: 'carto-dark' }).darkNative, true)
    assert.equal(resolveTiles({ TILE_PROVIDER: 'here', TILE_KEY: 'k' }).darkNative, true)
  })

  test('every preset is a usable template', () => {
    for (const [name, preset] of Object.entries(TILE_PRESETS)) {
      assert.ok(preset.url.includes('{z}'), `${name} has no zoom placeholder`)
      assert.ok(preset.url.includes('{x}') && preset.url.includes('{y}'), `${name} has no tile placeholders`)
      assert.ok(preset.attribution.length > 0, `${name} has no attribution`)
      assert.ok(preset.maxZoom >= 18, `${name} has an unusable max zoom`)
    }
  })
})

describe('placeholder tiles', () => {
  test('renders a labelled grid, not invented geography', () => {
    const svg = placeholderTile(11, 472, 838)
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
    assert.match(svg, /width="256" height="256"/)
    assert.ok(svg.includes('11/472/838'), 'the tile states its own coordinates')
    assert.ok(svg.includes('<line'), 'it is a grid')
  })

  test('says plainly that no basemap is configured', () => {
    assert.match(TILE_PRESETS.offline.attribution, /no basemap/i)
    assert.equal(TILE_PRESETS.offline.placeholder, true)
  })
})
