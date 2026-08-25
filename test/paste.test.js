/**
 * Pasted listing text becoming a filled-in site.
 *
 * The heuristic parser is what runs on a deployment with no Anthropic key —
 * which is the common case — so its behaviour is pinned field by field.
 */

import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'

import { parseListingText } from '../app/lib/paste.js'
import { createServer } from '../server/index.js'
import { useTempData } from './helpers.js'

const BLURB = `Pecan Professional Office Suites | Bldg. 4
10601 Pecan Park Boulevard, Austin, TX 78750
Flexible medical or professional office space. Available immediately.
8,780 SF total, demised into three suites. Built in 2007. Zoned GR-2.
Lease rate: $28.50/SF, NNN: $8.25. 1.2 acres, 42 parking spaces.
Contact Bethany Babcock, (210) 816-2734, bbabcock@foresitecre.com`

describe('parsing pasted listing text', () => {
  const fields = parseListingText(BLURB)

  test('pulls the address, city, state and zip', () => {
    assert.equal(fields.address, '10601 Pecan Park Boulevard')
    assert.equal(fields.city, 'Austin')
    assert.equal(fields.state, 'TX')
    assert.equal(fields.zip, '78750')
  })

  test('reads the money and the measurements', () => {
    assert.equal(fields.rentRate, 28.5)
    assert.equal(fields.nnn, 8.25)
    assert.equal(fields.sizeSqft, 8780)
    assert.equal(fields.acreage, 1.2)
    assert.equal(fields.parkingSpaces, 42)
    assert.equal(fields.yearBuilt, 2007)
    assert.equal(fields.zoning, 'GR-2')
  })

  test('names the property from the headline line', () => {
    assert.equal(fields.name, 'Pecan Professional Office Suites | Bldg. 4')
  })

  test('finds the broker contact details', () => {
    assert.equal(fields.brokerEmail, 'bbabcock@foresitecre.com')
    assert.equal(fields.brokerPhone, '(210) 816-2734')
  })

  test('never claims confidence a regex cannot have', () => {
    assert.equal(fields.confidence, 'low')
    assert.ok(fields.uncertainFields.includes('rentRate'))
  })

  test('keeps the pasted text as the notes', () => {
    assert.ok(fields.notes.includes('Flexible medical or professional office space'))
  })

  test('text with nothing recognisable in it is refused, not filed empty', () => {
    assert.throws(
      () => parseListingText('hello there, following up on our call last week about lunch'),
      /Nothing recognisable/,
    )
  })

  test('picks the building size over the suite sizes', () => {
    const parsed = parseListingText(
      'Big Plaza\n100 Main St, Dallas, TX\nSuite A: 1,200 SF. Suite B: 2,960 SF. 24,839 SF total.',
    )
    assert.equal(parsed.sizeSqft, 24839)
  })
})

describe('the paste endpoint', () => {
  const temp = useTempData()
  let app

  before(async () => {
    app = await createServer({ DATA_DIR: temp.directory, DB_FILE: `${temp.directory}/test.db` })
  })
  after(() => temp.cleanup())

  async function call(path, payload) {
    const response = await app.fetch(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    )
    return { status: response.status, body: await response.json() }
  }

  test('pasted text files a placed property with custom fields', async () => {
    const { body: created } = await call('/api/surveys', { name: 'Paste', centerLat: 30.3, centerLng: -97.7 })

    const { status, body } = await call(`/api/surveys/${created.survey.id}/paste`, {
      text: BLURB,
      mapCenter: { lat: 30.45, lng: -97.79 },
    })

    assert.equal(status, 201)
    assert.equal(body.property.name, 'Pecan Professional Office Suites | Bldg. 4')
    assert.equal(body.property.rentRate, 28.5)
    assert.equal(typeof body.property.lat, 'number', 'the site is placed, never invisible')
    assert.equal(body.extraction.source, 'heuristic', 'no key on this server, so the parser ran')
    assert.ok(body.property.fields.length > 0, 'extras land as custom fields')
  })

  test('a paste too short to mean anything is a clear 422', async () => {
    const { body: created } = await call('/api/surveys', { name: 'Short paste' })
    const { status, body } = await call(`/api/surveys/${created.survey.id}/paste`, { text: 'nice' })
    assert.equal(status, 422)
    assert.match(body.error, /not enough/)
  })
})
