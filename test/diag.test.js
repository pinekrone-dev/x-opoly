/**
 * The map's own trouble reports.
 *
 * The property that matters is that a broken browser can file one: the beacon
 * fires at the exact moment the app is failing, possibly before anyone could
 * sign in, so it must work with no session — and expose nothing in return.
 */
import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'

import { createServer } from '../server/index.js'
import { useTempData } from './helpers.js'

const temp = useTempData()
let app

before(async () => {
  app = await createServer({ DATA_DIR: temp.directory, DB_FILE: `${temp.directory}/test.db` })
})
after(() => temp.cleanup())

const post = (body) =>
  app.fetch(new Request('http://localhost/api/diag/map', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  }))

describe('the map trouble beacon', () => {
  test('a report needs no session, because a broken app has none', async () => {
    const res = await post(JSON.stringify({ kind: 'context-lost', webgl: true }))
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { noted: true })
  })

  test('a report that is not JSON is refused', async () => {
    assert.equal((await post('kind=broken')).status, 400)
  })

  test('an enormous report is stored truncated, not refused', async () => {
    // The one moment this fires is not the moment to be strict about size.
    const res = await post(JSON.stringify({ kind: 'x', noise: 'y'.repeat(100000) }))
    assert.equal(res.status, 200)
  })

  test('nothing can be read back from the path', async () => {
    const res = await app.fetch(new Request('http://localhost/api/diag/map'))
    assert.notEqual(res.status, 200, 'the beacon is write-only')
  })
})
