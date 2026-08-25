/**
 * Property images, including the crops taken out of a flyer.
 *
 * The tour book reads from these, so the ordering, the cover fallback, and
 * what happens when one is deleted all matter more than they look.
 */

import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'

import { createServer } from '../server/index.js'
import { useTempData } from './helpers.js'
import { MAX_IMAGES, coverOf } from '../app/lib/images.js'

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

/** A one-pixel PNG, so uploads exercise the real path without a fixture file. */
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  ),
  (character) => character.charCodeAt(0),
)

const upload = (headers = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'image/png', ...headers },
  body: PNG,
})

async function newProperty(name = 'Image test') {
  const { body: survey } = await call('/api/surveys', asJson({ name: 'Images' }))
  const { body } = await call(
    `/api/surveys/${survey.survey.id}/properties`,
    asJson({ name, lat: 30.2, lng: -97.8 }),
  )
  return body.property
}

describe('property images', () => {
  test('an uploaded crop comes back on the property', async () => {
    const property = await newProperty()

    const added = await call(
      `/api/properties/${property.id}/images`,
      upload({ 'x-source': 'flyer-crop', 'x-caption': encodeURIComponent('Front elevation') }),
    )

    assert.equal(added.status, 201)
    assert.equal(added.body.image.caption, 'Front elevation')
    assert.equal(added.body.image.source, 'flyer-crop', 'the tour book credits a crop to its flyer')
    assert.ok(added.body.image.url.startsWith('/api/files/'))
    assert.equal(added.body.property.images.length, 1)
  })

  test('images keep the order they were added, then the order they are dragged into', async () => {
    const property = await newProperty()
    const ids = []
    for (const caption of ['One', 'Two', 'Three']) {
      const { body } = await call(
        `/api/properties/${property.id}/images`,
        upload({ 'x-caption': caption }),
      )
      ids.push(body.image.id)
    }

    const listed = await call(`/api/properties/${property.id}/images`)
    assert.deepEqual(listed.body.images.map((image) => image.caption), ['One', 'Two', 'Three'])

    const reversed = [...ids].reverse()
    const reordered = await call(
      `/api/properties/${property.id}/images`,
      asJson({ order: reversed }, 'PUT'),
    )
    assert.deepEqual(reordered.body.images.map((image) => image.id), reversed)
  })

  test('a non-image is refused rather than stored', async () => {
    const property = await newProperty()
    const { status } = await call(`/api/properties/${property.id}/images`, {
      method: 'POST',
      headers: { 'content-type': 'application/pdf' },
      body: PNG,
    })
    assert.equal(status, 400)
  })

  test('deleting the cover clears it, so the book falls back rather than to nothing', async () => {
    const property = await newProperty()
    const first = await call(`/api/properties/${property.id}/images`, upload({ 'x-caption': 'A' }))
    const second = await call(`/api/properties/${property.id}/images`, upload({ 'x-caption': 'B' }))

    await call(
      `/api/properties/${property.id}`,
      asJson({ coverImageId: first.body.image.id }, 'PATCH'),
    )

    const removed = await call(`/api/images/${first.body.image.id}`, { method: 'DELETE' })
    assert.equal(removed.status, 204)

    const { body } = await call(`/api/surveys/${property.surveyId}`)
    const updated = body.properties.find((row) => row.id === property.id)
    assert.equal(updated.coverImageId, null, 'a dangling cover would show as a missing photo')
    assert.equal(updated.images.length, 1)
    assert.equal(updated.images[0].id, second.body.image.id)
  })

  test('a caption can be edited after the crop is taken', async () => {
    const property = await newProperty()
    const { body } = await call(`/api/properties/${property.id}/images`, upload())

    const renamed = await call(
      `/api/images/${body.image.id}`,
      asJson({ caption: 'Site plan, page 2' }, 'PATCH'),
    )
    assert.equal(renamed.body.image.caption, 'Site plan, page 2')
  })

  test('listing a survey carries every property’s images', async () => {
    const { body: survey } = await call('/api/surveys', asJson({ name: 'Book' }))
    const made = []
    for (const name of ['One', 'Two']) {
      const { body } = await call(
        `/api/surveys/${survey.survey.id}/properties`,
        asJson({ name, lat: 30.2, lng: -97.8 }),
      )
      made.push(body.property)
      await call(`/api/properties/${body.property.id}/images`, upload({ 'x-caption': name }))
    }

    const { body } = await call(`/api/surveys/${survey.survey.id}`)
    for (const property of body.properties) {
      assert.equal(property.images.length, 1, `${property.name} should carry its image`)
    }
  })

  test('uploading a flyer produces a pin, even when it cannot be read', async () => {
    // The bug this guards: a flyer upload created a property with no
    // coordinates, so no pin appeared on the map and the site was invisible to
    // the tour planner. It looked like the upload had done nothing at all.
    const { body: survey } = await call(
      '/api/surveys',
      asJson({ name: 'Flyer pins', centerLat: 32.7808, centerLng: -96.7972 }),
    )

    const uploaded = await call(`/api/surveys/${survey.survey.id}/flyer`, {
      method: 'POST',
      headers: { 'content-type': 'application/pdf', 'x-filename': 'listing.pdf' },
      body: PNG,
    })

    // Without an API key the read fails, which is the common case — but the
    // property must still exist and still be placed.
    assert.ok([201, 422].includes(uploaded.status), `status ${uploaded.status}`)
    const property = uploaded.body.property
    assert.ok(property, 'a property is created either way')
    assert.equal(typeof property.lat, 'number', 'and it has a latitude')
    assert.equal(typeof property.lng, 'number', 'and a longitude')

    // Which means the tour planner can see it.
    const tour = await call(
      `/api/surveys/${survey.survey.id}/tour`,
      asJson({ propertyIds: [property.id] }),
    )
    assert.equal(tour.body.stops.length, 1, 'a flyer-created site can be toured')
  })

  test('a flyer on a survey with no centre still creates the property', async () => {
    // Nothing to fall back to, so it stays unplaced — but losing the upload
    // would be worse than an unplaced pin.
    const { body: survey } = await call('/api/surveys', asJson({ name: 'No centre' }))
    const uploaded = await call(`/api/surveys/${survey.survey.id}/flyer`, {
      method: 'POST',
      headers: { 'content-type': 'application/pdf', 'x-filename': 'listing.pdf' },
      body: PNG,
    })
    assert.ok(uploaded.body.property, 'the upload is never wasted')
    assert.ok(uploaded.body.property.flyerUrl, 'and the file is kept')
  })

  test('a flyer attaches to a property that already exists', async () => {
    const property = await newProperty()
    const { status, body } = await call(`/api/properties/${property.id}/flyer`, {
      method: 'POST',
      headers: { 'content-type': 'application/pdf', 'x-filename': 'listing.pdf' },
      body: PNG,
    })

    assert.equal(status, 200)
    assert.equal(body.property.flyerName, 'listing.pdf')
    assert.ok(body.property.flyerUrl.startsWith('/api/files/'), 'and is fetchable to render')
  })
})

describe('choosing the cover', () => {
  const images = [
    { id: 'a', caption: 'A' },
    { id: 'b', caption: 'B' },
  ]

  test('uses the chosen cover', () => {
    assert.equal(coverOf(images, 'b').id, 'b')
  })

  test('falls back to the first when none was chosen', () => {
    assert.equal(coverOf(images, null).id, 'a')
  })

  test('falls back to the first when the chosen one is gone', () => {
    assert.equal(coverOf(images, 'deleted').id, 'a')
  })

  test('a property with no images has no cover', () => {
    assert.equal(coverOf([], 'a'), null)
  })

  test('the cap is a real number', () => {
    assert.ok(MAX_IMAGES > 0)
  })
})
