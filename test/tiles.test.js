import assert from 'node:assert/strict'
import test, { describe } from 'node:test'

import { DEFAULT_PROVIDER, TILE_PRESETS, availableBasemaps, placeholderTile, resolveTiles } from '../server/lib/tiles.js'

describe('basemap selection', () => {
  test('defaults to a keyless basemap with real streets', () => {
    const tiles = resolveTiles({})
    assert.equal(tiles.provider, DEFAULT_PROVIDER)
    assert.ok(tiles.url.includes('{z}'))
    assert.equal(tiles.placeholder, false, 'the default is a real basemap, not the placeholder grid')
    assert.equal(TILE_PRESETS[DEFAULT_PROVIDER].keyRequired, false, 'the default needs no API key')
  })

  test('the default is dark natively rather than a filtered light basemap', () => {
    // Inverting a light basemap to force it dark also inverts the street
    // labels, which is the one thing that has to stay readable.
    assert.equal(resolveTiles({}).darkNative, true)
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
    assert.equal(tiles.provider, DEFAULT_PROVIDER, 'no key means no Mapbox')
    assert.match(tiles.notice, /needs an API key/)
    assert.ok(!tiles.url.includes('{key}'), 'never leaves an unfilled key placeholder in the URL')
  })

  test('an explicit TILE_URL wins, for a self-hosted tile server', () => {
    const tiles = resolveTiles({ TILE_URL: 'http://tiles.internal/{z}/{x}/{y}.png', TILE_ATTRIBUTION: 'Internal' })
    assert.equal(tiles.provider, 'custom')
    assert.equal(tiles.attribution, 'Internal')
  })

  test('an unknown provider name falls back instead of failing', () => {
    assert.equal(resolveTiles({ TILE_PROVIDER: 'not-a-provider' }).provider, DEFAULT_PROVIDER)
  })

  test('reports which basemaps are dark, so the UI never has to guess', () => {
    assert.equal(resolveTiles({ TILE_PROVIDER: 'osm' }).darkNative, false)
    assert.equal(resolveTiles({ TILE_PROVIDER: 'carto-dark' }).darkNative, true)
    assert.equal(resolveTiles({ TILE_PROVIDER: 'here', TILE_KEY: 'k' }).darkNative, true)
  })

  test('every preset carries a human label for the switcher', () => {
    for (const [name, preset] of Object.entries(TILE_PRESETS)) {
      assert.ok(preset.label && preset.label.length > 0, `${name} has no label`)
    }
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

describe('the basemap switcher', () => {
  test('offers only basemaps this deployment can actually load', () => {
    const keyless = availableBasemaps({})
    assert.ok(keyless.length >= 3, 'several keyless street basemaps are offered')
    assert.ok(keyless.every((option) => !option.url.includes('{key}')), 'no option has an unfilled key')
    assert.ok(!keyless.some((option) => option.provider === 'mapbox'), 'a keyed provider is hidden without a key')
    assert.ok(!keyless.some((option) => option.placeholder), 'the placeholder grid is not offered as a real basemap')
  })

  test('adds the keyed providers once a key is configured', () => {
    const withKey = availableBasemaps({ TILE_KEY: 'pk.test' })
    const ids = withKey.map((option) => option.provider)
    for (const provider of ['mapbox', 'here', 'maptiler', 'stadia']) {
      assert.ok(ids.includes(provider), `${provider} should be selectable with a key`)
    }
    assert.ok(withKey.every((option) => !option.url.includes('{key}')))
  })

  test('a self-hosted basemap is offered first', () => {
    const options = availableBasemaps({ TILE_URL: 'http://tiles.internal/{z}/{x}/{y}.png' })
    assert.equal(options[0].provider, 'custom')
  })

  test('the placeholder grid is only offered when it was asked for', () => {
    const options = availableBasemaps({ TILE_PROVIDER: 'offline' })
    assert.ok(options.some((option) => option.provider === 'offline'))
  })
})
