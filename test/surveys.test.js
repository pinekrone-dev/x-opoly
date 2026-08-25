import assert from 'node:assert/strict'
import test, { before, describe } from 'node:test'

import { DatabaseSync } from 'node:sqlite'

import { nodeAdapter } from '../app/lib/sql.js'
import {
  createProperty,
  createSurvey,
  deleteSurvey,
  listProperties,
  listSurveys,
  resolveShare,
  setTourOrder,
  updateProperty,
  updateShare,
  updateSurvey,
} from '../app/lib/surveys.js'

let db
let survey

before(async () => {
  db = nodeAdapter(new DatabaseSync(':memory:'))
  await db.migrate()
  survey = await createSurvey(db, { name: 'Dental offices — north Austin', clientName: 'Dr. Reyes', brokerName: 'Sam Ortiz' })
})

describe('surveys', () => {
  test('creates a survey with a share token that starts switched off', async () => {
    assert.equal(survey.name, 'Dental offices — north Austin')
    assert.equal(survey.clientName, 'Dr. Reyes')
    assert.equal(survey.share.token.length, 32)
    assert.equal(survey.share.enabled, false)
    assert.equal(survey.brandColor, '#14b8a6')
  })

  test('lists surveys with a live pin count', async () => {
    await createProperty(db, survey.id, { name: 'Parmer Business Park', lat: 30.45, lng: -97.7 })
    const found = (await listSurveys(db)).find((entry) => entry.id === survey.id)
    assert.equal(found.pinCount, 1)
  })
})

describe('properties', () => {
  test('stores the fields a broker records', async () => {
    const property = await createProperty(db, survey.id, {
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

  test('rejects an unknown stage instead of storing it', async () => {
    const property = await createProperty(db, survey.id, { name: 'Bad stage', stage: 'closed-won' })
    assert.equal(property.stage, 'prospect')
  })

  test('discards out-of-range coordinates rather than placing a wrong pin', async () => {
    const property = await createProperty(db, survey.id, { name: 'Bad geo', lat: 999, lng: -97.7 })
    assert.equal(property.lat, null)
  })

  test('updates only the fields supplied', async () => {
    const property = await createProperty(db, survey.id, { name: 'Keep me', notes: 'Original note', sizeSqft: 1000 })
    const updated = await updateProperty(db, property.id, { stage: 'loi' })
    assert.equal(updated.stage, 'loi')
    assert.equal(updated.notes, 'Original note')
    assert.equal(updated.sizeSqft, 1000)
  })

  test('tour order survives a reorder and sorts the list', async () => {
    const own = await createSurvey(db, { name: 'Ordering' })
    const a = await createProperty(db, own.id, { name: 'A', lat: 30.1, lng: -97.1 })
    const b = await createProperty(db, own.id, { name: 'B', lat: 30.2, lng: -97.2 })
    const c = await createProperty(db, own.id, { name: 'C', lat: 30.3, lng: -97.3 })

    await setTourOrder(db, own.id, [c.id, a.id, b.id])
    assert.deepEqual((await listProperties(db, own.id)).map((property) => property.name), ['C', 'A', 'B'])
  })

  test('deleting a survey takes its properties with it', async () => {
    const doomed = await createSurvey(db, { name: 'Doomed' })
    await createProperty(db, doomed.id, { name: 'Child' })
    await deleteSurvey(db, doomed.id)
    assert.equal((await listProperties(db, doomed.id)).length, 0)
  })
})

describe('client sharing', () => {
  test('a link does not open until sharing is switched on', async () => {
    assert.equal((await resolveShare(db, survey.share.token)).ok, false)
    assert.equal((await resolveShare(db, survey.share.token)).reason, 'disabled')

    await updateShare(db, survey.id, { enabled: true })
    assert.equal((await resolveShare(db, survey.share.token)).ok, true)
  })

  test('an unknown token is reported as not found', async () => {
    assert.equal((await resolveShare(db, 'nope')).reason, 'not_found')
  })

  test('an expired link stops opening', async () => {
    const expiring = await createSurvey(db, { name: 'Expiring' })
    await updateShare(db, expiring.id, { enabled: true, expiresAt: '2020-01-01' })
    assert.equal((await resolveShare(db, expiring.share.token)).reason, 'expired')
  })

  test('regenerating the link breaks the old one', async () => {
    const rotating = await createSurvey(db, { name: 'Rotating' })
    await updateShare(db, rotating.id, { enabled: true })
    const oldToken = rotating.share.token

    const rotated = await updateShare(db, rotating.id, { regenerate: true })
    assert.notEqual(rotated.share.token, oldToken)
    assert.equal((await resolveShare(db, oldToken)).reason, 'not_found')
    assert.equal((await resolveShare(db, rotated.share.token)).ok, true)
  })

  test('the client payload carries no private notes and no internal ids', async () => {
    const shared = await createSurvey(db, { name: 'Shared', clientName: 'Client' })
    await createProperty(db, shared.id, { name: 'Site', lat: 30.1, lng: -97.1, notes: 'Landlord is desperate — push on TI' })
    await updateShare(db, shared.id, { enabled: true })

    const result = await resolveShare(db, shared.share.token)
    assert.equal(result.ok, true)
    assert.equal(result.properties.length, 1)
    assert.ok(!('notes' in result.properties[0]), 'private notes are withheld')
    assert.ok(!('surveyId' in result.properties[0]), 'internal survey id is withheld')
    assert.ok(!('share' in result.survey), 'the token is not echoed back')
  })

  test('report options round-trip and reach the client payload', async () => {
    const survey = await createSurvey(db, { name: 'Options' })
    assert.equal(survey.share.showDemographics, false, 'shading is opt-in')
    assert.equal(survey.share.showQr, true, 'QR codes default on')

    const updated = await updateSurvey(db, survey.id, { shareDemographics: true, shareQr: false })
    assert.equal(updated.share.showDemographics, true)
    assert.equal(updated.share.showQr, false)

    await updateShare(db, survey.id, { enabled: true })
    const shared = await resolveShare(db, survey.share.token)
    assert.equal(shared.survey.showDemographics, true, 'the client view knows to shade')
    assert.ok(!('showQr' in shared.survey), 'the PDF-only option stays out of the client payload')
  })

  test('a hidden site never reaches the client', async () => {
    // The walkthrough's promise: hide the unqualified site, share the link,
    // and the client sees only what the broker chose. Filtered server-side,
    // so it is absent from the payload — not just undrawn.
    const shared = await createSurvey(db, { name: 'Curated' })
    const shown = await createProperty(db, shared.id, { name: 'Qualified', lat: 30.1, lng: -97.1 })
    const buried = await createProperty(db, shared.id, { name: 'Unqualified', lat: 30.2, lng: -97.2 })
    await updateProperty(db, buried.id, { hidden: true })
    await updateShare(db, shared.id, { enabled: true })

    const result = await resolveShare(db, shared.share.token)
    assert.deepEqual(result.properties.map((p) => p.name), ['Qualified'])
    assert.ok(!('hidden' in result.properties[0]), 'the flag itself stays private')

    // Unhiding is the refresh-and-it-appears moment from the walkthrough.
    await updateProperty(db, buried.id, { hidden: false })
    const after = await resolveShare(db, shared.share.token)
    assert.equal(after.properties.length, 2)

    // The broker's own view still carries both, flagged.
    const mine = await listProperties(db, shared.id)
    assert.equal(mine.length, 2)
    assert.equal(mine.find((p) => p.id === shown.id).hidden, false)
  })
})
