import assert from 'node:assert/strict'
import test, { before, describe } from 'node:test'

import { DatabaseSync } from 'node:sqlite'

import { BOOK_DEFAULTS, normalizeBookStyle } from '../app/lib/bookstyle.js'
import { nodeAdapter } from '../app/lib/sql.js'
import { createSurvey, updateSurvey } from '../app/lib/surveys.js'

let db

before(async () => {
  db = nodeAdapter(new DatabaseSync(':memory:'))
  await db.migrate()
})

describe('book style', () => {
  test('nothing at all is the designed preset', () => {
    assert.deepEqual(normalizeBookStyle(undefined), BOOK_DEFAULTS)
    assert.deepEqual(normalizeBookStyle('garbage'), BOOK_DEFAULTS)
  })

  test('valid levers move; invented ones do not survive', () => {
    const style = normalizeBookStyle({
      cover: 'light',
      accent: '#228B22',
      showQr: false,
      intro: '  Three stops, all under lease.  ',
      fontSize: 72,
    })
    assert.equal(style.cover, 'light')
    assert.equal(style.accent, '#228b22')
    assert.equal(style.showQr, false)
    assert.equal(style.showSchedule, true)
    assert.equal(style.intro, 'Three stops, all under lease.')
    assert.equal('fontSize' in style, false)
  })

  test('a bad cover, a css colour name, and a novel intro are all refused politely', () => {
    const style = normalizeBookStyle({ cover: 'chartreuse', accent: 'teal', intro: 'x'.repeat(400) })
    assert.equal(style.cover, 'navy')
    assert.equal(style.accent, BOOK_DEFAULTS.accent)
    assert.equal(style.intro.length, 280)
  })

  test('a survey carries its book style through a save and read', async () => {
    const survey = await createSurvey(db, { name: 'Warehouse tour', clientName: 'Acme' })
    assert.deepEqual(survey.book, BOOK_DEFAULTS)
    const updated = await updateSurvey(db, survey.id, { bookStyle: { cover: 'light', accent: '#143366' } })
    assert.equal(updated.book.cover, 'light')
    assert.equal(updated.book.accent, '#143366')
    assert.equal(updated.book.showQr, true)
  })
})
