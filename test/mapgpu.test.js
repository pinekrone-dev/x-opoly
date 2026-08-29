/**
 * What the map asks the GPU for, and what it settles for.
 *
 * A browser takes the graphics context away when it is short of GPU memory,
 * and it takes it from whichever tab is easiest to evict rather than from
 * whichever tab is greedy. The recovery that existed retried three times
 * asking for exactly as much memory each time — three ways of learning the
 * same thing — and then told the person to close other tabs, which is the one
 * repair we cannot make and they have no reason to want to make.
 *
 * The ladder replaces that. Its whole value is that every rung is strictly
 * cheaper than the one above, so recovery is a smaller map rather than the
 * same map again. A rung that quietly stopped going down would restore the
 * old behaviour while still looking like a fix, so it is asserted here.
 *
 * Read from the source because MapLibre cannot be constructed under
 * node:test, following the same approach as the map constants in geo.test.js.
 */
import assert from 'node:assert/strict'
import test, { before, describe } from 'node:test'
import { readFileSync } from 'node:fs'

let source
let steps

before(() => {
  source = readFileSync(new URL('../src/components/MapCanvas.tsx', import.meta.url), 'utf8')
  const literal = /const GPU_STEPS = (\[[\s\S]*?\n\])/.exec(source)
  assert.ok(literal, 'the ladder must be a plain literal this can read')
  // Plain data — no types, no calls — so evaluating it reads the real values
  // rather than a copy of them that can drift.
  steps = new Function(`return ${literal[1]}`)()
})

describe('the GPU memory ladder', () => {
  test('every rung asks for strictly less than the one above it', () => {
    assert.ok(steps.length >= 2, 'a ladder of one rung is not a ladder')
    for (let i = 1; i < steps.length; i += 1) {
      assert.ok(steps[i].cap < steps[i - 1].cap, `rung ${i} does not lower the pixel ratio`)
      assert.ok(steps[i].levels < steps[i - 1].levels, `rung ${i} does not shrink the tile cache`)
    }
  })

  test('the first rung is already below what the browser would ask for', () => {
    // MapLibre defaults to five zoom levels of tiles per source, and to this
    // screen's full device pixel ratio. Both are what gets the context taken
    // away on a busy machine, so the everyday setting is under both.
    assert.ok(steps[0].levels < 5, 'the default cache is five zoom levels; step zero must be less')
    assert.ok(steps[0].cap <= 2, 'a 3x screen must not be charged for pixels nobody can see')
  })

  test('the everyday rung says nothing, and the reduced ones say what happened', () => {
    assert.equal(steps[0].note, null, 'a map at full quality has no news')
    for (const step of steps.slice(1)) {
      assert.ok(step.note && step.note.length > 10, 'a reduced map explains itself')
    }
  })

  test('the ladder is actually wired into the map, not merely declared', () => {
    // The values are worthless if the constructor never reads them, and a
    // constant that nothing passes along is the easiest kind of dead code to
    // leave behind while believing the problem is solved.
    assert.match(source, /pixelRatio: budget\.pixelRatio/)
    assert.match(source, /maxTileCacheZoomLevels: budget\.levels/)
    assert.match(source, /maxTileCacheSize: budget\.tiles/)
  })

  test('losing the context steps down the ladder rather than retrying as-is', () => {
    assert.match(
      source,
      /gpuLevel\.current = Math\.min\(gpuLevel\.current \+ 1, GPU_STEPS\.length - 1\)/,
      'each recovery must ask for less than the attempt that just failed',
    )
  })

  test('giving up is only reachable after every rung has been tried', () => {
    assert.match(source, /autoTries\.current < GPU_STEPS\.length \+ 1/)
  })
})
