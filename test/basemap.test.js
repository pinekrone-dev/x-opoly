/**
 * The blank-map bug, pinned.
 *
 * A stored basemap choice used to outlive every server-side change, so a
 * deployment that switched away from a failing tile host still served the
 * broken one to every browser that had been there before — a blank map with
 * no remote way to fix it. And nothing watched whether tiles arrived, so the
 * failure had no signal at all.
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { pickBasemap, readStoredBasemap, writeStoredBasemap } from '../src/lib/basemap.ts'

const tile = (provider, label = provider) => ({
  provider,
  label,
  url: `https://tiles.example/${provider}/{z}/{x}/{y}.png`,
  attribution: '',
  maxZoom: 19,
  darkNative: false,
  placeholder: false,
})

const OSM = tile('osm', 'Street map')
const CARTO = tile('carto-light', 'Muted')
const SAT = tile('satellite', 'Satellite')
const ALL = [OSM, CARTO, SAT]

describe('a stored basemap choice', () => {
  test('is kept while the deployment default it was chosen over still stands', () => {
    const raw = writeStoredBasemap('satellite', 'carto-light')
    assert.equal(readStoredBasemap(raw, 'carto-light'), 'satellite')
  })

  test('is dropped once the deployment changes its default', () => {
    // The exact bug: chosen when osm was the default, still applied after the
    // server moved to carto-light, which is why switching the server fixed
    // nothing for anyone who had loaded the map before.
    const raw = writeStoredBasemap('osm', 'osm')
    assert.equal(readStoredBasemap(raw, 'carto-light'), null)
  })

  test('in the old bare-string format is not trusted', () => {
    // Written before the default was recorded beside it, so it cannot be told
    // apart from a stale choice.
    assert.equal(readStoredBasemap('osm', 'carto-light'), null)
  })

  test('survives nothing at all, or nonsense', () => {
    assert.equal(readStoredBasemap(null, 'osm'), null)
    assert.equal(readStoredBasemap('', 'osm'), null)
    assert.equal(readStoredBasemap('{not json', 'osm'), null)
    assert.equal(readStoredBasemap('{"base":"osm"}', 'osm'), null, 'no id')
    assert.equal(readStoredBasemap('{"id":"","base":"osm"}', 'osm'), null, 'empty id')
  })
})

describe('picking which basemap to draw', () => {
  test('honours the viewer’s choice', () => {
    assert.equal(pickBasemap({ activeId: 'satellite', options: ALL, fallback: CARTO }).provider, 'satellite')
  })

  test('falls back to the deployment default when the choice is unknown', () => {
    assert.equal(pickBasemap({ activeId: 'nope', options: ALL, fallback: CARTO }).provider, 'carto-light')
  })

  test('skips a basemap whose tiles have failed, preferring the default', () => {
    const picked = pickBasemap({ activeId: 'osm', options: ALL, fallback: CARTO, broken: ['osm'] })
    assert.equal(picked.provider, 'carto-light', 'one dead tile host must not empty the map')
  })

  test('keeps looking when the default is broken too', () => {
    const picked = pickBasemap({ activeId: 'osm', options: ALL, fallback: CARTO, broken: ['osm', 'carto-light'] })
    assert.equal(picked.provider, 'satellite')
  })

  test('returns the choice unchanged when everything is broken', () => {
    // A blank map correctly labelled beats a crash; the failure is reported
    // to the viewer separately.
    const picked = pickBasemap({
      activeId: 'osm',
      options: ALL,
      fallback: CARTO,
      broken: ['osm', 'carto-light', 'satellite'],
    })
    assert.equal(picked.provider, 'osm')
  })

  test('a single basemap is not a switcher, so the default is used', () => {
    assert.equal(pickBasemap({ activeId: 'osm', options: [OSM], fallback: CARTO }).provider, 'carto-light')
    assert.equal(pickBasemap({ activeId: 'osm', options: null, fallback: CARTO }).provider, 'carto-light')
  })
})
