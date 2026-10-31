/**
 * The connector's saved-map state: what make_map writes for the app to open.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { TOOLS, viewState } from '../app/lib/mcp.js'

test('a basemap name becomes the app basemap id', () => {
  assert.equal(viewState({ market: 'austin-tx', basemap: 'satellite' }).basemap, 'satellite')
  assert.equal(viewState({ market: 'austin-tx', basemap: 'streets' }).basemap, 'osm')
  assert.equal(viewState({ market: 'austin-tx', basemap: 'dark' }).basemap, 'esri-dark')
})

test('no basemap, or an unknown one, leaves the viewer on their own', () => {
  assert.equal('basemap' in viewState({ market: 'austin-tx' }), false)
  assert.equal('basemap' in viewState({ market: 'austin-tx', basemap: 'mapbox-secret' }), false)
})

test('make_map offers the basemap names', () => {
  const tool = TOOLS.find((t) => t.name === 'make_map')
  assert.deepEqual(tool.inputSchema.properties.basemap.enum, ['streets', 'satellite', 'topographic', 'light', 'dark'])
})
