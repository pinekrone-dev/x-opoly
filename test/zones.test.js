/**
 * Non-compete zones: labelled radius circles on the survey map.
 */

import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'

import { createServer } from '../server/index.js'
import { useTempData } from './helpers.js'

const temp = useTempData()
let app

async function call(path, init) {
  const response = await app.fetch(new Request(`http://localhost${path}`, init))
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

const asJson = (payload, method = 'POST') => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
})

before(async () => {
  app = await createServer({ DATA_DIR: temp.directory, DB_FILE: `${temp.directory}/test.db` })
})
after(() => temp.cleanup())

describe('zones', () => {
  test('a labelled circle is stored, listed, shared, and deletable', async () => {
    const { body: created } = await call('/api/surveys', asJson({ name: 'Zones' }))
    const surveyId = created.survey.id

    const added = await call(
      `/api/surveys/${surveyId}/zones`,
      asJson({ label: 'Starbucks non-compete', lat: 33.64, lng: -117.91, radiusMiles: 1 }),
    )
    assert.equal(added.status, 201)
    assert.equal(added.body.zone.label, 'Starbucks non-compete')
    assert.equal(added.body.zone.radiusMiles, 1)

    const opened = await call(`/api/surveys/${surveyId}`)
    assert.equal(opened.body.zones.length, 1, 'the survey payload carries its zones')

    // The client's map shows them too — a non-compete is part of the story.
    await call(`/api/surveys/${surveyId}/share`, asJson({ enabled: true }))
    const { body: survey } = await call(`/api/surveys/${surveyId}`)
    const shared = await call(`/api/share/${survey.survey.share.token}`)
    assert.equal(shared.body.zones.length, 1)
    assert.ok(!('surveyId' in shared.body.zones[0]), 'internal ids stay internal')

    const removed = await call(`/api/zones/${added.body.zone.id}`, { method: 'DELETE' })
    assert.equal(removed.status, 204)
    const emptied = await call(`/api/surveys/${surveyId}`)
    assert.equal(emptied.body.zones.length, 0)
  })

  test('a zone with no label or a silly radius is refused', async () => {
    const { body: created } = await call('/api/surveys', asJson({ name: 'Bad zones' }))
    const surveyId = created.survey.id

    assert.equal(
      (await call(`/api/surveys/${surveyId}/zones`, asJson({ lat: 33, lng: -117, radiusMiles: 1 }))).status,
      400,
    )
    assert.equal(
      (await call(`/api/surveys/${surveyId}/zones`, asJson({ label: 'x', lat: 33, lng: -117, radiusMiles: 900 }))).status,
      400,
    )
  })
})
