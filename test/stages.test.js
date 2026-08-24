/**
 * Pipeline stages and per-site custom fields.
 *
 * Both exist because CRE surveys do not share a shape: every broker names
 * their pipeline differently, and every listing publishes different numbers.
 */

import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'

import { createServer } from '../server/index.js'
import { useTempData } from './helpers.js'
import { DEFAULT_STAGES, MAX_CUSTOM_FIELDS } from '../app/lib/stages.js'

const temp = useTempData()
let app

const BASE = 'http://localhost'

before(async () => {
  app = await createServer({ DATA_DIR: temp.directory, DB_FILE: `${temp.directory}/test.db` })
})

after(() => temp.cleanup())

async function call(path, init) {
  const response = await app.fetch(new Request(BASE + path, init))
  const text = await response.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: response.status, body }
}

const asJson = (payload, method = 'POST') => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
})

async function newSurvey(name = 'Stage test') {
  const { body } = await call('/api/surveys', asJson({ name }))
  return body.survey
}

describe('deal stages', () => {
  test('a new survey opens with a usable pipeline, not an empty sidebar', async () => {
    const survey = await newSurvey()
    const { body } = await call(`/api/surveys/${survey.id}/stages`)

    assert.equal(body.stages.length, DEFAULT_STAGES.length)
    assert.deepEqual(
      body.stages.map((stage) => stage.name),
      DEFAULT_STAGES.map((stage) => stage.name),
    )
    // Position is what the sidebar orders by, so it must be set on seed.
    assert.deepEqual(body.stages.map((stage) => stage.position), [0, 1, 2, 3, 4])
  })

  test('stages are renamed and recoloured without touching their sites', async () => {
    const survey = await newSurvey()
    const { body: seeded } = await call(`/api/surveys/${survey.id}/stages`)
    const stage = seeded.stages[0]

    const { body: created } = await call(
      `/api/surveys/${survey.id}/properties`,
      asJson({ name: 'A site', lat: 32.78, lng: -96.79, stageId: stage.id }),
    )

    const { body: renamed } = await call(
      `/api/stages/${stage.id}`,
      asJson({ name: 'Shortlist', color: '#123456' }, 'PATCH'),
    )
    assert.equal(renamed.stage.name, 'Shortlist')
    assert.equal(renamed.stage.color, '#123456')

    const { body: after } = await call(`/api/surveys/${survey.id}`)
    const property = after.properties.find((row) => row.id === created.property.id)
    assert.equal(property.stageId, stage.id, 'the site stays filed under the renamed stage')
  })

  test('hiding a stage is remembered, so the map can leave its pins off', async () => {
    const survey = await newSurvey()
    const { body: seeded } = await call(`/api/surveys/${survey.id}/stages`)

    await call(`/api/stages/${seeded.stages[1].id}`, asJson({ hidden: true }, 'PATCH'))
    const { body } = await call(`/api/surveys/${survey.id}/stages`)

    assert.equal(body.stages[1].hidden, true)
    assert.equal(body.stages[0].hidden, false)
  })

  test('deleting a stage unstages its sites rather than deleting them', async () => {
    const survey = await newSurvey()
    const { body: seeded } = await call(`/api/surveys/${survey.id}/stages`)
    const stage = seeded.stages[0]

    const { body: created } = await call(
      `/api/surveys/${survey.id}/properties`,
      asJson({ name: 'Keep me', lat: 32.78, lng: -96.79, stageId: stage.id }),
    )

    const { status } = await call(`/api/stages/${stage.id}`, { method: 'DELETE' })
    assert.equal(status, 204)

    const { body } = await call(`/api/surveys/${survey.id}`)
    const property = body.properties.find((row) => row.id === created.property.id)
    assert.ok(property, 'the site survives its stage being deleted')
    assert.equal(property.stageId, null, 'and becomes unstaged')
  })

  test('reordering writes the whole order', async () => {
    const survey = await newSurvey()
    const { body: seeded } = await call(`/api/surveys/${survey.id}/stages`)
    const reversed = [...seeded.stages].reverse().map((stage) => stage.id)

    const { body } = await call(`/api/surveys/${survey.id}/stages`, asJson({ order: reversed }, 'PUT'))
    assert.deepEqual(body.stages.map((stage) => stage.id), reversed)
  })

  test('a stage needs a name', async () => {
    const survey = await newSurvey()
    const { status } = await call(`/api/surveys/${survey.id}/stages`, asJson({ name: '   ' }))
    assert.equal(status, 400)
  })
})

describe('custom fields', () => {
  test('round-trip in the order they were arranged', async () => {
    const survey = await newSurvey()
    const fields = [
      { label: 'Available SF', value: '9,822 SF' },
      { label: 'Lease Rate', value: '32/SF' },
      { label: 'NNN', value: '12/SF' },
    ]

    const { body } = await call(
      `/api/surveys/${survey.id}/properties`,
      asJson({ name: 'Belterra', lat: 30.2, lng: -98.0, fields }),
    )
    assert.deepEqual(body.property.fields, fields)
  })

  test('a save replaces the list, so a removed row does not linger', async () => {
    const survey = await newSurvey()
    const { body: created } = await call(
      `/api/surveys/${survey.id}/properties`,
      asJson({
        name: 'Pecan',
        lat: 30.2,
        lng: -97.8,
        fields: [
          { label: 'Available SF', value: '8,780 SF' },
          { label: 'Year Built', value: '2007' },
        ],
      }),
    )

    const { body: updated } = await call(
      `/api/properties/${created.property.id}`,
      asJson({ fields: [{ label: 'Year Built', value: '2007' }] }, 'PATCH'),
    )
    assert.deepEqual(updated.property.fields, [{ label: 'Year Built', value: '2007' }])
  })

  test('a field with no label is dropped rather than stored blank', async () => {
    const survey = await newSurvey()
    const { body } = await call(
      `/api/surveys/${survey.id}/properties`,
      asJson({
        name: 'Sparse',
        lat: 30.2,
        lng: -97.8,
        fields: [{ label: '  ', value: 'orphan' }, { label: 'Zoning', value: 'GR' }],
      }),
    )
    assert.deepEqual(body.property.fields, [{ label: 'Zoning', value: 'GR' }])
  })

  test('a label with no value is kept, because the editor shows empty rows', async () => {
    const survey = await newSurvey()
    const { body } = await call(
      `/api/surveys/${survey.id}/properties`,
      asJson({ name: 'Pending', lat: 30.2, lng: -97.8, fields: [{ label: 'NNN', value: '' }] }),
    )
    assert.deepEqual(body.property.fields, [{ label: 'NNN', value: null }])
  })

  test('the field count is capped', async () => {
    const survey = await newSurvey()
    const tooMany = Array.from({ length: MAX_CUSTOM_FIELDS + 8 }, (_, index) => ({
      label: `Field ${index}`,
      value: String(index),
    }))

    const { body } = await call(
      `/api/surveys/${survey.id}/properties`,
      asJson({ name: 'Greedy', lat: 30.2, lng: -97.8, fields: tooMany }),
    )
    assert.equal(body.property.fields.length, MAX_CUSTOM_FIELDS)
  })

  test('listing a survey carries every site’s fields', async () => {
    const survey = await newSurvey()
    await call(
      `/api/surveys/${survey.id}/properties`,
      asJson({ name: 'One', lat: 30.2, lng: -97.8, fields: [{ label: 'A', value: '1' }] }),
    )
    await call(
      `/api/surveys/${survey.id}/properties`,
      asJson({ name: 'Two', lat: 30.3, lng: -97.9, fields: [{ label: 'B', value: '2' }] }),
    )

    const { body } = await call(`/api/surveys/${survey.id}`)
    const byName = Object.fromEntries(body.properties.map((row) => [row.name, row.fields]))
    assert.deepEqual(byName.One, [{ label: 'A', value: '1' }])
    assert.deepEqual(byName.Two, [{ label: 'B', value: '2' }])
  })
})
