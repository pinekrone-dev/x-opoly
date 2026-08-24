import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'

import { useTempData } from './helpers.js'

const temp = useTempData()
const { resetDb } = await import('../server/lib/db.js')
const {
  createProperty,
  createSurvey,
  deleteSurvey,
  listProperties,
  listSurveys,
  resolveShare,
  setTourOrder,
  updateProperty,
  updateShare,
} = await import('../server/lib/surveys.js')

let survey

before(() => {
  survey = createSurvey({ name: 'Dental offices — north Austin', clientName: 'Dr. Reyes', brokerName: 'Sam Ortiz' })
})

after(() => {
  resetDb()
  temp.cleanup()
})

describe('surveys', () => {
  test('creates a survey with a share token that starts switched off', () => {
    assert.equal(survey.name, 'Dental offices — north Austin')
    assert.equal(survey.clientName, 'Dr. Reyes')
    assert.equal(survey.share.token.length, 32)
    assert.equal(survey.share.enabled, false)
    assert.equal(survey.brandColor, '#14b8a6')
  })

  test('lists surveys with a live pin count', () => {
    createProperty(survey.id, { name: 'Parmer Business Park', lat: 30.45, lng: -97.7 })
    const found = listSurveys().find((entry) => entry.id === survey.id)
    assert.equal(found.pinCount, 1)
  })
})

describe('properties', () => {
  test('stores the fields a broker records', () => {
    const property = createProperty(survey.id, {
      name: 'Round Rock Retail',
      address: '2100 N Mays St',
      city: 'Round Rock',
      state: 'TX',
      lat: 30.51,
      lng: -97.68,
      stage: 'touring',
      rentRate: 28.5,
      rentUnit: 'psf/yr',
      nnn: 8.25,
      sizeSqft: 3200,
      parkingSpaces: 189,
      zoning: 'C-1',
      yearBuilt: 1981,
    })

    assert.equal(property.stage, 'touring')
    assert.equal(property.rentRate, 28.5)
    assert.equal(property.sizeSqft, 3200)
    assert.equal(property.yearBuilt, 1981)
  })

  test('rejects an unknown stage instead of storing it', () => {
    const property = createProperty(survey.id, { name: 'Bad stage', stage: 'closed-won' })
    assert.equal(property.stage, 'prospect')
  })

  test('discards out-of-range coordinates rather than placing a wrong pin', () => {
    const property = createProperty(survey.id, { name: 'Bad geo', lat: 999, lng: -97.7 })
    assert.equal(property.lat, null)
  })

  test('updates only the fields supplied', () => {
    const property = createProperty(survey.id, { name: 'Keep me', notes: 'Original note', sizeSqft: 1000 })
    const updated = updateProperty(property.id, { stage: 'loi' })
    assert.equal(updated.stage, 'loi')
    assert.equal(updated.notes, 'Original note')
    assert.equal(updated.sizeSqft, 1000)
  })

  test('tour order survives a reorder and sorts the list', () => {
    const own = createSurvey({ name: 'Ordering' })
    const a = createProperty(own.id, { name: 'A', lat: 30.1, lng: -97.1 })
    const b = createProperty(own.id, { name: 'B', lat: 30.2, lng: -97.2 })
    const c = createProperty(own.id, { name: 'C', lat: 30.3, lng: -97.3 })

    setTourOrder(own.id, [c.id, a.id, b.id])
    assert.deepEqual(listProperties(own.id).map((property) => property.name), ['C', 'A', 'B'])
  })

  test('deleting a survey takes its properties with it', () => {
    const doomed = createSurvey({ name: 'Doomed' })
    createProperty(doomed.id, { name: 'Child' })
    deleteSurvey(doomed.id)
    assert.equal(listProperties(doomed.id).length, 0)
  })
})

describe('client sharing', () => {
  test('a link does not open until sharing is switched on', () => {
    assert.equal(resolveShare(survey.share.token).ok, false)
    assert.equal(resolveShare(survey.share.token).reason, 'disabled')

    updateShare(survey.id, { enabled: true })
    assert.equal(resolveShare(survey.share.token).ok, true)
  })

  test('an unknown token is reported as not found', () => {
    assert.equal(resolveShare('nope').reason, 'not_found')
  })

  test('an expired link stops opening', () => {
    const expiring = createSurvey({ name: 'Expiring' })
    updateShare(expiring.id, { enabled: true, expiresAt: '2020-01-01' })
    assert.equal(resolveShare(expiring.share.token).reason, 'expired')
  })

  test('regenerating the link breaks the old one', () => {
    const rotating = createSurvey({ name: 'Rotating' })
    updateShare(rotating.id, { enabled: true })
    const oldToken = rotating.share.token

    const rotated = updateShare(rotating.id, { regenerate: true })
    assert.notEqual(rotated.share.token, oldToken)
    assert.equal(resolveShare(oldToken).reason, 'not_found')
    assert.equal(resolveShare(rotated.share.token).ok, true)
  })

  test('the client payload carries no private notes and no internal ids', () => {
    const shared = createSurvey({ name: 'Shared', clientName: 'Client' })
    createProperty(shared.id, { name: 'Site', lat: 30.1, lng: -97.1, notes: 'Landlord is desperate — push on TI' })
    updateShare(shared.id, { enabled: true })

    const result = resolveShare(shared.share.token)
    assert.equal(result.ok, true)
    assert.equal(result.properties.length, 1)
    assert.ok(!('notes' in result.properties[0]), 'private notes are withheld')
    assert.ok(!('surveyId' in result.properties[0]), 'internal survey id is withheld')
    assert.ok(!('share' in result.survey), 'the token is not echoed back')
  })
})
