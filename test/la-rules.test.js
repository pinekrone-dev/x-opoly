import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseZone } from '../app/lib/zoning/la-zone.js'
import { laReport } from '../app/lib/zoning/la-rules.js'

const pick = (r, label) => r.lines.find((l) => l.label === label)

test('flat R1 lot: yards, height and floor area with citations', () => {
  const r = laReport(parseZone('R1-1'), { area_sf: 6000, width_ft: 50, depth_ft: 120, type: 'interior', hillside: false, coastal: false })
  assert.equal(r.covered, true)
  assert.equal(pick(r, 'Front yard (base)').value, 20)               // 20% of 120 = 24, capped at 20
  assert.equal(pick(r, 'Front yard (base)').cite.section, 'LAMC 12.08 C.1')
  assert.equal(pick(r, 'Side yards (each)').value, 5)
  assert.equal(pick(r, 'Rear yard').value, 15)
  assert.equal(pick(r, 'Height').value, 33)
  assert.equal(pick(r, 'Residential floor area (max)').value, 2700)   // 0.45 x 6,000
  assert.equal(pick(r, 'Residential floor area (max)').cite.section, 'LAMC 12.08 C.5(a)')
})

test('narrow R1 lot side yard: 10% of width, not under 3 ft', () => {
  const r = laReport(parseZone('R1-1'), { area_sf: 4000, width_ft: 40, depth_ft: 100, hillside: false, coastal: false })
  assert.equal(pick(r, 'Side yards (each)').value, 4)
  assert.ok(r.flags.some((f) => /minimum lot size/.test(f)))
})

test('prevailing front yard replaces the base, capped at 40 ft', () => {
  const r = laReport(parseZone('RS-1'), { area_sf: 8000, width_ft: 60, depth_ft: 140, hillside: false, coastal: false,
    face: { prevailing_ft: 46, share: 0.6 } })
  assert.equal(pick(r, 'Front yard (prevailing)').value, 40)
  assert.equal(pick(r, 'Front yard (base)').value, 25)               // 20% of 140 = 28, capped at 25
})

test('RE11 lot over 15,000 sq ft: 35% or 6,000 sq ft, plus the bonus', () => {
  const r = laReport(parseZone('RE11-1'), { area_sf: 16000, width_ft: 100, depth_ft: 160, hillside: false, coastal: false })
  assert.equal(pick(r, 'Residential floor area (max)').value, 6000)
  assert.equal(pick(r, 'With the design bonus').value, 7200)
  assert.equal(pick(r, 'Side yards (each)').value, 7)
  assert.equal(pick(r, 'Height').value, 36)
})

test('R1 variation zone: table ratio and lot coverage by lot size', () => {
  const r = laReport(parseZone('R1V2'), { area_sf: 6500, width_ft: 50, depth_ft: 130, hillside: false, coastal: false })
  assert.equal(pick(r, 'Residential floor area (max)').value, Math.round(6500 * 0.53))
  assert.equal(pick(r, 'Lot coverage (max)').value, 48)
  assert.equal(pick(r, 'Height').value, 30)
})

test('Hillside R1 lot: slope bands, guaranteed minimum and the 5 ft prevailing floor', () => {
  const lot = { area_sf: 4541, width_ft: 67, depth_ft: 67, hillside: true, coastal: false, face: { prevailing_ft: 2, share: 0.5 },
    slope: { bands: [{ band: '0-14.99', sf: 612 }, { band: '15-29.99', sf: 1621 }, { band: '30-44.99', sf: 1717 }, { band: '45-59.99', sf: 590 }] } }
  const r = laReport(parseZone('R1-1-HCR'), lot)
  const rfa = pick(r, 'Residential floor area (max)')
  assert.equal(rfa.status, 'estimate')
  assert.equal(rfa.value, Math.round(612 * 0.45 + 1621 * 0.45 + 1717 * 0.40 + 590 * 0.35))
  assert.equal(pick(r, 'Front yard (prevailing)').value, 5)
  assert.equal(pick(r, 'Height (envelope)').value, 33)
  assert.ok(r.flags.some((f) => /Hillside Construction Regulation/.test(f)))
})

test('key, corner and flag lots ask for review rather than guess', () => {
  const key = laReport(parseZone('RA-1'), { area_sf: 20000, width_ft: 100, depth_ft: 200, type: 'key', hillside: false, coastal: false })
  assert.match(pick(key, 'Key lot front yard').basis, /100 ft/)
  const corner = laReport(parseZone('R1-1'), { area_sf: 5000, width_ft: 50, depth_ft: 100, type: 'corner', hillside: false, coastal: false })
  assert.equal(pick(corner, 'Street-side yard (corner lot)').status, 'review')
})

test('height district 2 floor area is flagged, not computed', () => {
  const r = laReport(parseZone('R1-2'), { area_sf: 6000, width_ft: 50, depth_ft: 120, hillside: false, coastal: false })
  assert.equal(pick(r, 'Residential floor area').status, 'review')
})

test('zones not yet covered say so', () => {
  assert.equal(laReport(parseZone('[LM4-GW1-4][IX6-8][CPIO]'), {}).covered, false)
  assert.equal(laReport(parseZone('C2-1VL'), {}).covered, false)
})
