import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slopeBands, areaSqft } from '../app/lib/zoning/slope.js'

// A 100 ft square lot at Los Angeles's latitude.
const lat = 34.1
const ft = 0.3048
const dLon = (100 * ft) / (111320 * Math.cos((lat * Math.PI) / 180))
const dLat = (100 * ft) / 110540
const lot = { type: 'Polygon', coordinates: [[[-118.36, lat], [-118.36 + dLon, lat], [-118.36 + dLon, lat + dLat], [-118.36, lat + dLat], [-118.36, lat]]] }

function plane(gradePct) {
  // A fake elevation service: a plane rising northward at the given grade.
  return async (url) => {
    const p = new URL(url).searchParams
    const [w, h] = p.get('size').split(',').map(Number)
    const [, y0, , y1] = p.get('bbox').split(',').map(Number)
    const z = new Float32Array(w * h)
    for (let r = 0; r < h; r += 1) {
      const northM = ((y1 - y0) * (1 - (r + 0.5) / h)) * 110540
      for (let c = 0; c < w; c += 1) z[r * w + c] = 200 + northM * (gradePct / 100)
    }
    return { ok: true, arrayBuffer: async () => z.buffer }
  }
}

test('lot area in square feet', () => {
  assert.ok(Math.abs(areaSqft(lot) - 10000) < 50)
})

test('a 20% slope falls in the 15-30% band', async () => {
  const r = await slopeBands(lot, { fetchImpl: plane(20) })
  const band = r.bands.find((b) => b.band === '15-29.99')
  assert.ok(band.sf > 9900, JSON.stringify(r.bands))
  assert.ok(Math.abs(r.mean_slope_pct - 20) < 0.5)
  assert.ok(Math.abs(r.relief_ft - 20) < 2)       // 100 ft at 20%
})

test('flat ground is all in the first band', async () => {
  const r = await slopeBands(lot, { fetchImpl: plane(0) })
  assert.ok(r.bands[0].sf > 9900)
})

test('a failing service gives no estimate rather than a wrong one', async () => {
  const r = await slopeBands(lot, { fetchImpl: async () => ({ ok: false }), tries: 2 })
  assert.equal(r, null)
})
