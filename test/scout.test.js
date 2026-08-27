/**
 * The parcel scout, pinned.
 *
 * The heuristic must never cross its lanes — an acreage figure read as
 * dollars, or a bound invented from a sentence that states none, puts a
 * confidently wrong map in front of a broker. And whatever a model answers,
 * the normaliser owns the boundary: county spellings, swapped bounds,
 * numbers arriving as strings.
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { heuristicScout, normalizeScout, parseMoney, runScout } from '../app/lib/scout.js'

const VOCAB = {
  assetTypes: ['Commercial', 'Multifamily', 'Vacant land', 'Single family', 'Other'],
  valueLabel: 'Assessed value',
}

describe('parseMoney', () => {
  test('reads shorthand and plain figures', () => {
    assert.equal(parseMoney('$2M'), 2_000_000)
    assert.equal(parseMoney('500k'), 500_000)
    assert.equal(parseMoney('1.2 million'), 1_200_000)
    assert.equal(parseMoney('$750,000'), 750_000)
    assert.equal(parseMoney('no number here'), null)
  })
})

describe('heuristicScout', () => {
  test('the canonical hunt: type, floor, ceiling', () => {
    const { filters, empty } = heuristicScout('vacant land over 5 acres under $2M', VOCAB)
    assert.equal(empty, false)
    assert.deepEqual(filters.assetTypes, ['Vacant land'])
    assert.equal(filters.acresMin, 5)
    assert.equal(filters.valueMax, 2_000_000)
    assert.equal(filters.valueMin, null)
    assert.equal(filters.acresMax, null)
  })

  test('acreage is never read as dollars', () => {
    const { filters } = heuristicScout('parcels under 10 acres', VOCAB)
    assert.equal(filters.acresMax, 10)
    assert.equal(filters.valueMax, null)
  })

  test('a bare number is never read as dollars either', () => {
    // "over 5" with no dollar sign or scale word states no value bound.
    const { filters } = heuristicScout('apartments over 5', VOCAB)
    assert.equal(filters.valueMin, null)
    assert.deepEqual(filters.assetTypes, ['Multifamily'])
  })

  test('"N+ acres" and ranges', () => {
    assert.equal(heuristicScout('3+ acres', VOCAB).filters.acresMin, 3)
    const between = heuristicScout('between 2 and 6 acres', VOCAB).filters
    assert.equal(between.acresMin, 2)
    assert.equal(between.acresMax, 6)
    const money = heuristicScout('worth between $500k and $2M', VOCAB).filters
    assert.equal(money.valueMin, 500_000)
    assert.equal(money.valueMax, 2_000_000)
  })

  test('an owner becomes the keyword the search box already runs', () => {
    const { filters } = heuristicScout('anything owned by the First Baptist Church over 1 acre', VOCAB)
    assert.equal(filters.keyword, 'First Baptist Church')
    assert.equal(filters.acresMin, 1)
  })

  test('asset words resolve against what the county publishes', () => {
    assert.deepEqual(heuristicScout('retail or office space', VOCAB).filters.assetTypes, ['Commercial'])
    // A county with no such label yields no type filter, not a dead one.
    assert.deepEqual(heuristicScout('warehouses', VOCAB).filters.assetTypes, [])
  })

  test('an unreadable hunt is empty, not invented', () => {
    const { filters, empty } = heuristicScout('somewhere my client will love', VOCAB)
    assert.equal(empty, true)
    assert.deepEqual(filters, {
      assetTypes: [],
      valueMin: null,
      valueMax: null,
      acresMin: null,
      acresMax: null,
      keyword: null,
    })
  })
})

describe('normalizeScout', () => {
  test('county spellings win and strangers are dropped', () => {
    const { filters } = normalizeScout({ assetTypes: ['VACANT LAND', 'Boatyard'] }, VOCAB)
    assert.deepEqual(filters.assetTypes, ['Vacant land'])
  })

  test('strings coerce and swapped bounds right themselves', () => {
    const { filters } = normalizeScout(
      { valueMin: '2,000,000', valueMax: '500000', acresMin: '10', acresMax: 2 },
      VOCAB,
    )
    assert.equal(filters.valueMin, 500_000)
    assert.equal(filters.valueMax, 2_000_000)
    assert.equal(filters.acresMin, 2)
    assert.equal(filters.acresMax, 10)
  })
})

describe('runScout', () => {
  test('no provider means the heuristic answers, and says so', async () => {
    const result = await runScout('vacant land over 5 acres', VOCAB, null, {})
    assert.equal(result.source, 'heuristic')
    assert.equal(result.provider, null)
    assert.equal(result.filters.acresMin, 5)
  })

  test('a provider answer is normalised at the boundary', async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          model: 'grok-4',
          choices: [
            {
              message: {
                content: JSON.stringify({
                  assetTypes: ['vacant land'],
                  valueMax: '2000000',
                  acresMin: 5,
                  keyword: null,
                  explanation: 'Vacant land of five acres or more, up to $2M.',
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    const result = await runScout(
      'vacant land over 5 acres under $2M',
      VOCAB,
      'grok',
      { XAI_API_KEY: 'test' },
      { fetchImpl },
    )
    assert.equal(result.source, 'ai')
    assert.equal(result.provider, 'grok')
    assert.deepEqual(result.filters.assetTypes, ['Vacant land'])
    assert.equal(result.filters.valueMax, 2_000_000)
    assert.equal(result.filters.acresMin, 5)
    assert.equal(result.explanation, 'Vacant land of five acres or more, up to $2M.')
  })

  test('a provider error surfaces as a message, not a stack', async () => {
    const fetchImpl = async () => new Response('{}', { status: 429 })
    await assert.rejects(
      runScout('anything', VOCAB, 'grok', { XAI_API_KEY: 'test' }, { fetchImpl }),
      /rate limiting/,
    )
  })
})
