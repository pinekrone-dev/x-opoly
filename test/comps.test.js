/**
 * Sale comps: imported by the broker, kept to their workspace.
 *
 * The tests that matter most here are the isolation ones. Comps are a
 * listing site's data reshaped by somebody's own browsing, and the moment one
 * team's comps become visible to another this stops being a broker's notebook
 * and starts being a redistributed database. So: two teams, and the second
 * must never see the first's rows or delete them.
 */

import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'

import { createServer } from '../server/index.js'
import { readComps } from '../app/lib/comps.js'
import { useTempData } from './helpers.js'

const temp = useTempData()
let app

function client() {
  let cookie = null
  const call = async (path, init = {}) => {
    const response = await app.fetch(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers || {}) },
      }),
    )
    const set = response.headers.get('set-cookie')
    if (set) cookie = set.split(';')[0]
    const text = await response.text()
    let body = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }
    return { status: response.status, body }
  }
  return call
}

const asJson = (payload, method = 'POST') => ({ method, body: JSON.stringify(payload) })

/*
 * Self-serve signup opens only when billing and email sending are both
 * configured, and a second team is the whole point of this file — so both are
 * stubbed, and both accounts are exempt from the paywall they would otherwise
 * hit on the very first request.
 */
const ENV = {
  STRIPE_SECRET_KEY: 'sk_test_not_called_in_these_tests',
  RESEND_API_KEY: 're_test_stub',
  STRIPE_EXEMPT_EMAILS: 'bob@example.com',
}

const sentEmails = []
const realFetch = globalThis.fetch

let alice
let bob

before(async () => {
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.resend.com/')) {
      sentEmails.push(JSON.parse(init.body))
      return new Response(JSON.stringify({ id: `email_${sentEmails.length}` }), { status: 200 })
    }
    return realFetch(url, init)
  }

  app = await createServer({ DATA_DIR: temp.directory, DB_FILE: `${temp.directory}/test.db`, ...ENV })

  // The first account claims the instance and is exempt by the owner rule.
  alice = client()
  await alice(
    '/api/auth/register',
    asJson({ name: 'Alice', email: 'alice@example.com', password: 'a long enough password' }),
  )

  // The second is self-serve, its own team, and signed in by the emailed link.
  bob = client()
  await bob(
    '/api/auth/register',
    asJson({ name: 'Bob', email: 'bob@example.com', password: 'another long password' }),
  )
  const mail = sentEmails[sentEmails.length - 1]
  const token = new URL(mail.text.match(/https?:\/\/\S+/)[0]).searchParams.get('verify')
  await bob('/api/auth/verify-email', asJson({ token }))
})
after(() => {
  globalThis.fetch = realFetch
  temp.cleanup()
})

describe('comps', () => {
  test('reads the shapes a capture actually produces', () => {
    // A bare array, the bookmarklet's own field names, and the strings a
    // listing placard shows rather than numbers.
    const { rows, dropped } = readComps([
      {
        address: '1200 Main St, Houston, TX',
        name: 'Midtown Retail',
        priceStr: '$4,250,000',
        price: 4250000,
        saleLease: 'For Sale',
        propType: 'Retail',
        sqft: '12,500 SF',
        cap: '6.25%',
        year: '1998',
        url: 'https://example.test/listing/1',
        key: 'listing-1',
      },
      // No address and no name: a placard the page had not finished drawing.
      { priceStr: '$1' },
    ])
    assert.equal(rows.length, 1)
    assert.equal(dropped, 1, 'an entry with nothing to identify it is dropped, not stored')
    assert.equal(rows[0].price, 4250000)
    assert.equal(rows[0].sqft, 12500, 'a placard’s "12,500 SF" is a number')
    assert.equal(rows[0].cap_rate, 6.25, 'and "6.25%" is a rate')
    assert.equal(rows[0].year_built, 1998)
    assert.equal(rows[0].source_key, 'listing-1')
  })

  test('unwraps the object a localStorage dump comes out as', () => {
    const { rows } = readComps({ loopnetListings_v1: [{ address: '1 Elm St' }] })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].address, '1 Elm St')
  })

  test('an import lands, dedupes, and updates on re-import', async () => {
    const first = await alice(
      '/api/gis/comps',
      asJson({
        market: 'houston-tx',
        listings: [
          { key: 'a', address: '100 Travis St', priceStr: '$2,000,000', price: 2000000, propType: 'Office' },
          { key: 'b', address: '200 Travis St', price: 3000000, propType: 'Retail' },
          // The same placard twice, because the page was scrolled twice.
          { key: 'a', address: '100 Travis St', price: 2000000 },
        ],
      }),
    )
    assert.equal(first.status, 200)
    assert.equal(first.body.added, 2, 'the repeat within one import is not a second sale')

    // Re-importing the same page after a price change updates rather than doubles.
    const again = await alice(
      '/api/gis/comps',
      asJson({ listings: [{ key: 'a', address: '100 Travis St', price: 1900000 }] }),
    )
    assert.equal(again.body.added, 0)
    assert.equal(again.body.updated, 1)

    const listed = await alice('/api/gis/comps')
    assert.equal(listed.body.comps.length, 2)
    assert.equal(listed.body.comps.find((c) => c.address === '100 Travis St').price, 1900000)
    assert.equal(listed.body.unplaced, 2, 'nothing is on the map until it has been located')
  })

  test('a market filter still shows comps that predate any market', async () => {
    // 'b' was imported under houston-tx; the re-import of 'a' carried no
    // market. Both are this team's, so both must be listed.
    const listed = await alice('/api/gis/comps?market=houston-tx')
    assert.equal(listed.body.comps.length, 2)
  })

  test('a list with nothing usable in it is refused, not stored empty', async () => {
    const empty = await alice('/api/gis/comps', asJson({ listings: [{ priceStr: '$1' }] }))
    assert.equal(empty.status, 400)
    assert.match(empty.body.error, /address or a name/)

    const notAList = await alice('/api/gis/comps', asJson({ listings: 'nope' }))
    assert.equal(notAList.status, 400)
  })

  test("one team's comps are invisible to another", async () => {
    const bobsList = await bob('/api/gis/comps')
    assert.equal(bobsList.body.comps.length, 0, 'Bob sees none of Alice’s comps')

    // Even the same source key belongs to whoever imported it.
    await bob('/api/gis/comps', asJson({ listings: [{ key: 'a', address: 'Bob’s own 100 Travis St' }] }))
    const bobsAgain = await bob('/api/gis/comps')
    assert.equal(bobsAgain.body.comps.length, 1)
    assert.equal(bobsAgain.body.comps[0].address, 'Bob’s own 100 Travis St')

    const alices = await alice('/api/gis/comps')
    assert.equal(alices.body.comps.length, 2, 'and Alice’s are untouched')
    assert.equal(alices.body.comps.find((c) => c.address === '100 Travis St').price, 1900000)
  })

  test("a team cannot delete another team's comp", async () => {
    const alices = await alice('/api/gis/comps')
    const target = alices.body.comps[0].id

    const stolen = await bob(`/api/gis/comps/${target}`, { method: 'DELETE' })
    assert.equal(stolen.status, 404, 'not 403 — that would confirm the row exists')

    const still = await alice('/api/gis/comps')
    assert.equal(still.body.comps.length, 2)

    const removed = await alice(`/api/gis/comps/${target}`, { method: 'DELETE' })
    assert.equal(removed.status, 200)
    assert.equal((await alice('/api/gis/comps')).body.comps.length, 1)
  })

  test('comps need a session', async () => {
    const stranger = client()
    assert.equal((await stranger('/api/gis/comps')).status, 401)
    assert.equal((await stranger('/api/gis/comps', asJson({ listings: [] }))).status, 401)
    assert.equal((await stranger('/api/gis/comps/place', asJson({}))).status, 401)
  })
})

describe('a listings file', () => {
  test('a CSV export imports, quoted commas and all', async () => {
    const csv = [
      'Address,Price,Property Type,SF,Cap Rate,Year Built',
      '"500 W 2nd St, Suite 1900, Austin, TX","$41,000,000",Office,"498,000",5.5%,2017',
      '"The ""Old"" Mill, Bastrop TX",$900000,Industrial,4000,,1954',
      '',
    ].join('\r\n')

    const res = await alice('/api/gis/comps', asJson({ csv, market: 'austin-tx' }))
    assert.equal(res.status, 200)
    assert.equal(res.body.added, 2, 'an address containing commas is one comp, not three')

    const listed = await alice('/api/gis/comps?market=austin-tx')
    const tower = listed.body.comps.find((c) => c.address?.startsWith('500 W 2nd'))
    assert.equal(tower.address, '500 W 2nd St, Suite 1900, Austin, TX')
    assert.equal(tower.price, 41000000, 'a spreadsheet’s "$41,000,000" is a number')
    assert.equal(tower.sqft, 498000)
    assert.equal(tower.capRate, 5.5)
    assert.equal(tower.yearBuilt, 2017)
    assert.equal(tower.propType, 'Office')

    // The doubled quote is one literal quote, not two and not a broken row.
    const mill = listed.body.comps.find((c) => c.address?.includes('Mill'))
    assert.equal(mill.address, 'The "Old" Mill, Bastrop TX')
  })

  test('a tab-separated export works too', async () => {
    const tsv = 'Address\tPrice\tProperty Type\n900 Congress Ave\t$1,200,000\tRetail'
    const res = await alice('/api/gis/comps', asJson({ csv: tsv }))
    assert.equal(res.body.added, 1)
  })

  test('an import arriving in chunks accumulates rather than replacing', async () => {
    const before = (await alice('/api/gis/comps')).body.comps.length
    for (const chunk of [
      [{ key: 'chunk-1', address: '1 Chunk Way' }, { key: 'chunk-2', address: '2 Chunk Way' }],
      [{ key: 'chunk-3', address: '3 Chunk Way' }],
    ]) {
      const res = await alice('/api/gis/comps', asJson({ listings: chunk }))
      assert.equal(res.status, 200)
    }
    const after = (await alice('/api/gis/comps')).body.comps.length
    assert.equal(after, before + 3, 'each chunk is a complete import in its own right')
  })
})
