import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseZone } from '../app/lib/zoning/la-zone.js'

test('a conditioned single-family zone with a D limitation and an overlay', () => {
  const z = parseZone('[Q]R1-1D-HCR')
  assert.equal(z.chapter, '1')
  assert.deepEqual(z.conditions, [{ kind: 'Q', permanent: true }])
  assert.equal(z.zone, 'R1')
  assert.equal(z.family, 'single-family')
  assert.equal(z.heightDistrict, '1')
  assert.equal(z.limitation, true)
  assert.equal(z.overlays[0].code, 'HCR')
})

test('tentative T and Q classifications in parentheses', () => {
  const z = parseZone('(T)(Q)C2-2D-O')
  assert.deepEqual(z.conditions.map((c) => [c.kind, c.permanent]), [['T', false], ['Q', false]])
  assert.equal(z.zone, 'C2')
  assert.equal(z.heightDistrict, '2')
})

test('R1 variation zones have no height district', () => {
  const z = parseZone('R1V3-RG-O')
  assert.equal(z.zone, 'R1')
  assert.equal(z.variation, 'V3')
  assert.equal(z.heightDistrict, null)
  assert.deepEqual(z.overlays.map((o) => o.code), ['RG', 'O'])
})

test('longest class first, community qualifiers and decimal classes', () => {
  assert.equal(parseZone('RE15-1-H').zone, 'RE15')
  assert.equal(parseZone('RD1.5-1XL').zone, 'RD1.5')
  assert.equal(parseZone('RD1.5-1XL').heightDistrict, '1XL')
  assert.equal(parseZone('R3(PV)-1VL').qualifier, 'PV')
})

test('new-code (Chapter 1A) zones are recognised and not computed', () => {
  const z = parseZone('[LM4-GW1-4][IX6-8][CPIO]')
  assert.equal(z.chapter, '1A')
  assert.deepEqual(z.parts, ['LM4-GW1-4', 'IX6-8', 'CPIO'])
  assert.equal(z.zone, null)
})

test('specific plan zones and rights of way', () => {
  assert.equal(parseZone('(WC)RIVER-SN-RIO').family, 'specific-plan')
  assert.equal(parseZone('MU(EC)').family, 'specific-plan')
  assert.equal(parseZone('FWY').family, 'right-of-way')
})

test('nothing recognised from nonsense', () => {
  assert.equal(parseZone('ZZ9').recognised, false)
  assert.equal(parseZone('').recognised, false)
})
