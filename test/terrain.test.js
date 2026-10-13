/**
 * When the ground is drawn in relief.
 *
 * Terrain is the heaviest thing the map can be asked to draw, so the rule for
 * when it is on is pinned: only tilted, only if the viewer has not switched it
 * off, never on a map already stepped down for want of GPU memory. And the
 * source itself is checked against MapLibre's own style validator, because a
 * bad source does not throw on the map; the ground just stays flat.
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec'

import {
  TERRAIN_ATTRIBUTION,
  TERRAIN_EXAGGERATION,
  TERRAIN_MAX_ZOOM,
  TERRAIN_SOURCE,
  TERRAIN_TILES,
  readTerrainChoice,
  terrainWanted,
} from '../src/lib/terrain.ts'

describe('terrain', () => {
  test('relief only while tilted, switched on, and at full quality', () => {
    assert.equal(terrainWanted({ tilted: true, enabled: true, gpuLevel: 0 }), true)
    assert.equal(terrainWanted({ tilted: false, enabled: true, gpuLevel: 0 }), false)
    assert.equal(terrainWanted({ tilted: true, enabled: false, gpuLevel: 0 }), false)
    assert.equal(terrainWanted({ tilted: true, enabled: true, gpuLevel: 1 }), false)
  })

  test('on unless the viewer turned it off', () => {
    assert.equal(readTerrainChoice(null), true)
    assert.equal(readTerrainChoice('on'), true)
    assert.equal(readTerrainChoice('garbage'), true)
    assert.equal(readTerrainChoice('off'), false)
  })

  test('the source and terrain are a valid style', () => {
    const style = {
      version: 8,
      sources: {
        [TERRAIN_SOURCE]: {
          type: 'raster-dem',
          tiles: [TERRAIN_TILES],
          encoding: 'terrarium',
          tileSize: 256,
          maxzoom: TERRAIN_MAX_ZOOM,
          attribution: TERRAIN_ATTRIBUTION,
        },
      },
      terrain: { source: TERRAIN_SOURCE, exaggeration: TERRAIN_EXAGGERATION },
      layers: [],
    }
    assert.deepEqual(validateStyleMin(style), [])
    assert.match(TERRAIN_TILES, /^https:\/\/.+\{z\}\/\{x\}\/\{y\}\.png$/)
  })
})
