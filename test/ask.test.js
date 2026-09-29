import assert from 'node:assert/strict'
import test, { describe } from 'node:test'

import { aiPlan, describePlan, heuristicPlan, needsOverlay, normalizePlan, passesAttributes, passesOverlay, planPrompt } from '../app/lib/ask.js'
import { compareAddress, guessColumns, parseAddress } from '../app/lib/addresses.js'

/*
 * The brain panel's two halves that run without a network: reading a
 * question into a plan, and matching a spreadsheet's addresses. Every name
 * here is invented.
 */

const VOCAB = {
  assetTypes: ['Vacant Land', 'Commercial', 'Industrial', 'Multifamily'],
  zoningCategories: ['Commercial', 'Industrial', 'Residential', 'Planned development'],
  zoningCodes: ['C-2', 'M-1', 'PD', 'RS-50'],
  hasFlood: true,
}

describe('reading a question without a model', () => {
  test('outside the flood zone is out; in the flood zone is in', () => {
    assert.equal(heuristicPlan('vacant land not in the flood zone', VOCAB).plan.flood, 'out')
    assert.equal(heuristicPlan('lots outside the floodplain', VOCAB).plan.flood, 'out')
    assert.equal(heuristicPlan('flood free industrial', VOCAB).plan.flood, 'out')
    assert.equal(heuristicPlan('parcels in the flood zone', VOCAB).plan.flood, 'in')
  })

  test('zoning is read by category and by code, and is not mistaken for land use', () => {
    const plan = heuristicPlan('industrial zoned lots over 5 acres', VOCAB).plan
    assert.deepEqual(plan.zoningCategories, ['Industrial'])
    assert.deepEqual(plan.assetTypes, [], 'industrial zoning is not the assessor calling it industrial')
    assert.equal(plan.acresMin, 5)
    assert.deepEqual(heuristicPlan('anything zoned C-2 or PD', VOCAB).plan.zoningCodes, ['C-2', 'PD'])
  })

  test('export, count and show are told apart', () => {
    assert.equal(heuristicPlan('export commercial over $2M', VOCAB).plan.action, 'export')
    assert.equal(heuristicPlan('how many industrial parcels', VOCAB).plan.action, 'count')
    assert.equal(heuristicPlan('commercial over $2M', VOCAB).plan.action, 'show')
  })

  test('a market without flood data never claims a flood filter', () => {
    assert.equal(heuristicPlan('land outside the flood zone', { ...VOCAB, hasFlood: false }).plan.flood, null)
  })

  test('a plan can only name what the county publishes', () => {
    const plan = normalizePlan(
      { assetTypes: ['vacant land', 'Castles'], zoningCategories: ['industrial', 'Spaceport'], zoningCodes: ['c-2', 'Z-9'], action: 'launch' },
      VOCAB,
    )
    assert.deepEqual(plan.assetTypes, ['Vacant Land'])
    assert.deepEqual(plan.zoningCategories, ['Industrial'])
    assert.deepEqual(plan.zoningCodes, ['C-2'])
    assert.equal(plan.action, 'show')
  })

  test('upload columns come from the header, and a model cannot name one that is not there', () => {
    const headers = ['Owner', 'Site', 'Postal']
    const plan = normalizePlan({ columns: { address: 'site', zip: 'Postal', city: 'Town' } }, VOCAB, headers)
    assert.equal(plan.columns.address, 'Site')
    assert.equal(plan.columns.zip, 'Postal')
    assert.equal(plan.columns.city, null)
    assert.equal(normalizePlan({}, VOCAB, ['Property Address', 'ZIP']).columns.address, 'Property Address')
  })

  test('the plan is described in a sentence when no model wrote one', () => {
    const plan = heuristicPlan('export industrial zoned land over 5 acres outside the flood zone', VOCAB).plan
    assert.match(describePlan(plan), /zoned Industrial.*outside FEMA flood hazard areas, as a file/)
    assert.equal(needsOverlay(plan), true)
  })
})

describe('the model reads the question once', () => {
  test('it is sent the question, the vocabulary and three sample rows, not the file', () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ Site: `${i} Elm St`, Owner: 'Example LLC' }))
    const { user } = planPrompt('which are outside the flood zone', VOCAB, { headers: ['Site', 'Owner'], sample: rows.slice(0, 3) })
    assert.match(user, /Upload columns: "Site", "Owner"/)
    assert.equal((user.match(/Sample row/g) || []).length, 3)
    assert.ok(!user.includes('49 Elm St'))
  })

  test('what it answers is clamped like any other plan', async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: JSON.stringify({ action: 'export', flood: 'out', zoningCodes: ['M-1', 'Q-7'], columns: { address: 'Site' }, explanation: 'Industrial sites that stay dry.' }) }],
        }),
        { status: 200 },
      )
    const plan = await aiPlan('dry M-1 sites', VOCAB, { headers: ['Site'], sample: [] }, 'anthropic', { ANTHROPIC_API_KEY: 'k' }, { fetchImpl })
    assert.equal(plan.action, 'export')
    assert.equal(plan.flood, 'out')
    assert.deepEqual(plan.zoningCodes, ['M-1'])
    assert.equal(plan.columns.address, 'Site')
  })
})

describe('checking a parcel against the plan', () => {
  const plan = normalizePlan({ assetTypes: ['Industrial'], acresMin: 5, flood: 'out', zoningCategories: ['Industrial'] }, VOCAB)
  const parcel = { at: 'Industrial', ac: 6, mv: 1e6, ad: '1 Mill Rd', ow: 'Example LLC' }

  test('a parcel that passes everything passes', () => {
    assert.equal(passesAttributes(parcel, plan), null)
    assert.equal(passesOverlay({ flood: { status: 'out', zones: [] }, zoning: { category: 'Industrial', code: 'M-1' } }, plan), null)
  })

  test('each failure says why', () => {
    assert.match(passesAttributes({ ...parcel, ac: 2 }, plan), /smaller/)
    assert.match(passesOverlay({ flood: { status: 'partly', zones: ['AE'] }, zoning: { category: 'Industrial' } }, plan), /AE/)
    assert.match(passesOverlay({ flood: { status: 'out', zones: [] }, zoning: { category: 'Commercial', code: 'C-2' } }, plan), /Zoned C-2/)
  })

  test('an unreadable overlay fails the parcel rather than passing it', () => {
    assert.match(passesOverlay({ flood: null, zoning: { category: 'Industrial' } }, plan), /could not be read/)
  })
})

describe('matching an address to the roll', () => {
  test('spelled-out and abbreviated forms agree', () => {
    const wanted = parseAddress('3401 Bayshore Boulevard, Unit 401, Tampa FL 33629')
    assert.equal(compareAddress(wanted, parseAddress('3401 Bayshore Blvd 401')), 'exact')
    assert.equal(compareAddress(parseAddress('5 East 42nd Street'), parseAddress('5 E 42ND ST')), 'exact')
    assert.equal(compareAddress(parseAddress('123 First Avenue'), parseAddress('123 1ST AVE')), 'exact')
  })

  test('a building without a unit matches the building, not a specific unit', () => {
    assert.equal(compareAddress(parseAddress('3401 Bayshore Blvd'), parseAddress('3401 Bayshore Blvd 401')), 'street')
  })

  test('a different number, street, direction or unit is not a match', () => {
    const base = parseAddress('100 N Main St')
    assert.equal(compareAddress(base, parseAddress('102 N Main St')), null)
    assert.equal(compareAddress(base, parseAddress('100 N Maine St')), null)
    assert.equal(compareAddress(base, parseAddress('100 S Main St')), null)
    assert.equal(compareAddress(parseAddress('1 Elm St #2'), parseAddress('1 Elm St 3')), null)
  })

  test('a PO box is not an address on the roll', () => {
    assert.equal(parseAddress('PO Box 12').number, null)
  })

  test('ordinary headers are read without a model', () => {
    assert.deepEqual(guessColumns(['Name', 'Property Address', 'City', 'ZIP Code', 'APN']), {
      address: 'Property Address',
      city: 'City',
      zip: 'ZIP Code',
      parcel: 'APN',
    })
  })
})
