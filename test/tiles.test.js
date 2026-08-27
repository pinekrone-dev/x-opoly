import assert from 'node:assert/strict'
import test, { describe } from 'node:test'

import { DEFAULT_PROVIDER, TILE_PRESETS, availableBasemaps, placeholderTile, resolveTiles } from '../app/lib/tiles.js'

describe('basemap selection', () => {
  test('defaults to a keyless basemap with real streets', () => {
    const tiles = resolveTiles({})
    assert.equal(tiles.provider, DEFAULT_PROVIDER)
    assert.ok(tiles.url.includes('{z}'))
    assert.equal(tiles.placeholder, false, 'the default is a real basemap, not the placeholder grid')
    assert.equal(TILE_PRESETS[DEFAULT_PROVIDER].keyRequired, false, 'the default needs no API key')
  })

  test('the default is an ordinary street map, not a dark one', () => {
    const tiles = resolveTiles({})
    assert.equal(tiles.darkNative, false, 'the default basemap is a standard light street map')
    assert.match(tiles.label, /street/i)
  })

  test('the keyed providers default to their standard street style', () => {
    // A night style is a preference, not a default — these must look like an
    // ordinary road map out of the box.
    for (const provider of ['mapbox', 'here', 'maptiler', 'stadia']) {
      assert.notEqual(resolveTiles({ TILE_PROVIDER: provider, TILE_KEY: 'k' }).darkNative, true, `${provider} defaults dark`)
    }
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
    assert.equal(resolveTiles({ TILE_PROVIDER: 'carto-voyager' }).darkNative, false)
    assert.equal(resolveTiles({ TILE_PROVIDER: 'here', TILE_KEY: 'k' }).darkNative, false)
    // Only the explicitly dark basemap reports itself as dark.
    assert.equal(resolveTiles({ TILE_PROVIDER: 'carto-dark' }).darkNative, true)
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
    assert.ok(keyless.length >= 4, 'several keyless basemaps are offered')
    assert.match(keyless[0].label, /street/i, 'a plain street map is offered first')
    assert.ok(keyless.every((option) => !option.url.includes('{key}')), 'no option has an unfilled key')
    assert.ok(!keyless.some((option) => option.provider === 'mapbox'), 'a keyed provider is hidden without a key')
    assert.ok(!keyless.some((option) => option.placeholder), 'the placeholder grid is not offered as a real basemap')
  })

  test('a keyed provider is offered only when it is the configured one', () => {
    // A TILE_KEY belongs to one service. A stray key must not populate the
    // picker with every keyed provider — the other three would render 401s
    // or "API key required" watermark tiles.
    const strayKey = availableBasemaps({ TILE_KEY: 'pk.test' })
    for (const provider of ['mapbox', 'here', 'maptiler', 'stadia']) {
      assert.ok(!strayKey.some((option) => option.provider === provider), `${provider} hidden without TILE_PROVIDER`)
    }

    const chosen = availableBasemaps({ TILE_PROVIDER: 'maptiler', TILE_KEY: 'k' })
    const ids = chosen.map((option) => option.provider)
    assert.ok(ids.includes('maptiler'), 'the configured keyed provider is offered')
    assert.ok(!ids.includes('mapbox') && !ids.includes('stadia'), 'the other keyed providers stay hidden')
    assert.ok(chosen.every((option) => !option.url.includes('{key}')))
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
