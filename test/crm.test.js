/**
 * People, companies, places and deals: the records that outlive a survey.
 *
 * Two things are worth proving here. That a deal really is the join — people,
 * companies and places brought together in named roles — and that none of it
 * crosses a team boundary, since a CRM is the most damaging thing to leak.
 */

import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'

import { createServer } from '../server/index.js'
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

let alice
let mallory
let company
let person
let place
let deal

before(async () => {
  // A signup token is the cheapest way to open a second, separate team here;
  // the email-verification path is exercised in teams.test.js.
  app = await createServer({
    DATA_DIR: temp.directory,
    DB_FILE: `${temp.directory}/test.db`,
    SIGNUP_TOKEN: 'open-sesame',
  })

  alice = client()
  await alice('/api/auth/register', asJson({ name: 'Alice', email: 'alice@example.com', password: 'a long enough password' }))
  mallory = client()
  const joined = await mallory(
    '/api/auth/register',
    asJson({ name: 'Mallory', email: 'm@example.com', password: 'a long enough password', inviteToken: 'open-sesame' }),
  )
  assert.equal(joined.status, 201, 'the second team registers')
})

after(() => temp.cleanup())

describe('the CRM objects', () => {
  test('a company is created with a custom profile', async () => {
    const created = await alice(
      '/api/crm/companies',
      asJson({ name: 'Vega Foods', industry: 'Grocery', fields: [{ label: 'Store count', value: '42' }] }),
    )
    assert.equal(created.status, 201)
    company = created.body.record
    assert.equal(company.name, 'Vega Foods')
    assert.equal(company.fields.length, 1)
    assert.equal(company.fields[0].label, 'Store count')
  })

  test('a nameless company is refused rather than stored blank', async () => {
    const bad = await alice('/api/crm/companies', asJson({ industry: 'Grocery' }))
    assert.equal(bad.status, 400)
  })

  test('a person belongs to a company', async () => {
    const created = await alice(
      '/api/crm/people',
      asJson({ firstName: 'Dana', lastName: 'Reyes', email: 'dana@vega.example', companyId: company.id }),
    )
    assert.equal(created.status, 201)
    person = created.body.record
    assert.equal(person.companyId, company.id)
  })

  test('a place records what the team knows about a building', async () => {
    const created = await alice(
      '/api/crm/places',
      asJson({
        name: 'Harbor & 21st',
        address: '2101 Harbor Blvd',
        city: 'Costa Mesa',
        lat: 33.66,
        lng: -117.92,
        sizeSqft: 4200,
        askingRate: 38,
        rateUnit: 'sf-yr',
        fields: [{ label: 'Drive-thru', value: 'Yes' }],
      }),
    )
    assert.equal(created.status, 201)
    place = created.body.record
    assert.equal(place.sizeSqft, 4200)
  })

  test('one search finds a contact whichever list it is filed under', async () => {
    const { status, body } = await alice('/api/crm/search?q=vega')
    assert.equal(status, 200)
    assert.equal(body.companies.length, 1, 'the company by name')
    assert.equal(body.people.length, 1, 'the person by her email domain')
    assert.equal(body.places.length, 0)
    assert.deepEqual(body.deals, [])

    const harbor = await alice('/api/crm/search?q=harbor')
    assert.equal(harbor.body.places[0].name, 'Harbor & 21st')

    const blank = await alice('/api/crm/search?q=')
    assert.deepEqual(blank.body, { people: [], companies: [], places: [], deals: [] })

    const theirs = await mallory('/api/crm/search?q=vega')
    assert.equal(theirs.body.companies.length + theirs.body.people.length, 0, 'never across the team boundary')
  })

  test('editing replaces the custom profile wholesale', async () => {
    const patched = await alice(
      `/api/crm/places/${place.id}`,
      asJson({ fields: [{ label: 'Drive-thru', value: 'Yes' }, { label: 'Patio', value: '600 sf' }] }, 'PATCH'),
    )
    assert.equal(patched.status, 200)
    assert.equal(patched.body.record.fields.length, 2)
    assert.equal(patched.body.record.fields[1].label, 'Patio')

    const cleared = await alice(`/api/crm/places/${place.id}`, asJson({ fields: [] }, 'PATCH'))
    assert.equal(cleared.body.record.fields.length, 0)
    // Put it back for the tests below.
    await alice(`/api/crm/places/${place.id}`, asJson({ fields: [{ label: 'Drive-thru', value: 'Yes' }] }, 'PATCH'))
  })

  test('a deal is people, companies and places brought together', async () => {
    const created = await alice('/api/crm/deals', asJson({ name: 'Vega — Costa Mesa', kind: 'Tenant Rep' }))
    assert.equal(created.status, 201)
    deal = created.body.record

    for (const party of [
      { kind: 'company', refId: company.id, role: 'Tenant' },
      { kind: 'person', refId: person.id, role: 'Decision maker' },
      { kind: 'place', refId: place.id, role: 'Candidate site' },
    ]) {
      const added = await alice(`/api/crm/deals/${deal.id}/parties`, asJson(party))
      assert.equal(added.status, 201)
    }

    const { body } = await alice(`/api/crm/deals/${deal.id}`)
    assert.equal(body.record.parties.length, 3)
    assert.deepEqual(
      body.record.parties.map((party) => party.kind).sort(),
      ['company', 'person', 'place'],
    )
    // Each party carries the record itself, not just an id to chase.
    const site = body.record.parties.find((party) => party.kind === 'place')
    assert.equal(site.record.name, 'Harbor & 21st')
    assert.equal(site.role, 'Candidate site')
  })

  test('adding the same party twice does not duplicate it', async () => {
    await alice(`/api/crm/deals/${deal.id}/parties`, asJson({ kind: 'place', refId: place.id, role: 'Candidate site' }))
    const { body } = await alice(`/api/crm/deals/${deal.id}`)
    assert.equal(body.record.parties.length, 3)
  })

  test('a party must be a person, company or place', async () => {
    const bad = await alice(`/api/crm/deals/${deal.id}/parties`, asJson({ kind: 'survey', refId: place.id }))
    assert.equal(bad.status, 400)
  })
})

describe('sending a place into a survey', () => {
  let surveyId

  before(async () => {
    const { body } = await alice('/api/surveys', asJson({ name: 'Vega search' }))
    surveyId = body.survey.id
  })

  test('the building arrives as a site on the tour, with its profile', async () => {
    const sent = await alice(`/api/crm/places/${place.id}/send`, asJson({ surveyId }))
    assert.equal(sent.status, 201)
    assert.equal(sent.body.property.address, '2101 Harbor Blvd')
    assert.equal(sent.body.property.lat, 33.66)
    assert.equal(sent.body.property.rentRate, 38)
    // Sending a building to a survey is saying "we are looking at this one",
    // so it lands on the tour as well as the map.
    assert.ok(sent.body.property.tourOrder != null, 'it is on the tour')

    const { body } = await alice(`/api/surveys/${surveyId}`)
    assert.equal(body.properties.length, 1)
    assert.equal(body.properties[0].fields[0].label, 'Drive-thru')
  })

  test('it is a copy: working the site never rewrites what the team knows', async () => {
    const { body } = await alice(`/api/surveys/${surveyId}`)
    const site = body.properties[0]
    await alice(`/api/properties/${site.id}`, asJson({ name: 'Renamed on the survey', rentRate: 29 }, 'PATCH'))

    const { body: after } = await alice(`/api/crm/places/${place.id}`)
    assert.equal(after.record.name, 'Harbor & 21st', 'the place keeps its name')
    assert.equal(after.record.askingRate, 38, 'and its asking rate')
  })

  test('a survey belonging to another team is not a destination', async () => {
    const { body } = await mallory('/api/surveys', asJson({ name: 'Mallory deal' }))
    const sent = await alice(`/api/crm/places/${place.id}/send`, asJson({ surveyId: body.survey.id }))
    assert.equal(sent.status, 404)
  })

  test('a checked list lands together, in order, each on the tour', async () => {
    const second = await alice('/api/crm/places', asJson({ name: 'Bristol & 17th', address: '1700 Bristol St', lat: 33.68, lng: -117.88 }))
    const { body: fresh } = await alice('/api/surveys', asJson({ name: 'List search' }))

    const sent = await alice(`/api/surveys/${fresh.survey.id}/places`, asJson({ placeIds: [place.id, second.body.record.id] }))
    assert.equal(sent.status, 201)
    assert.equal(sent.body.properties.length, 2)
    assert.deepEqual(sent.body.missing, [])
    assert.deepEqual(
      sent.body.properties.map((property) => property.name),
      ['Harbor & 21st', 'Bristol & 17th'],
      'the order given is the order they arrive in',
    )
    assert.deepEqual(sent.body.properties.map((property) => property.tourOrder), [0, 1])
    // The profile travels with each, as it does one at a time.
    assert.equal(sent.body.properties[0].fields[0].label, 'Drive-thru')

    // A second batch appends to the tour rather than restarting it.
    const again = await alice(`/api/surveys/${fresh.survey.id}/places`, asJson({ placeIds: [second.body.record.id] }))
    assert.equal(again.body.properties[0].tourOrder, 2)

    // The tests below count the team's places; leave them as they were.
    await alice(`/api/crm/places/${second.body.record.id}`, { method: 'DELETE' })
  })

  test('ids that are not the team\'s places are reported, not fatal', async () => {
    const { body: fresh } = await alice('/api/surveys', asJson({ name: 'Mixed list' }))
    const { body: theirs } = await mallory('/api/crm/places', asJson({ name: 'Mallory tower', address: '1 Main St' }))

    const sent = await alice(`/api/surveys/${fresh.survey.id}/places`, asJson({ placeIds: [place.id, theirs.record.id, 'nope'] }))
    assert.equal(sent.status, 201)
    assert.equal(sent.body.properties.length, 1, 'only the caller\'s own place lands')
    assert.deepEqual(sent.body.missing.sort(), [theirs.record.id, 'nope'].sort())

    const none = await alice(`/api/surveys/${fresh.survey.id}/places`, asJson({ placeIds: [theirs.record.id] }))
    assert.equal(none.status, 404, 'nothing landed')
    const empty = await alice(`/api/surveys/${fresh.survey.id}/places`, asJson({ placeIds: [] }))
    assert.equal(empty.status, 400)

    // The boundary tests below expect Mallory's team to hold no places.
    await mallory(`/api/crm/places/${theirs.record.id}`, { method: 'DELETE' })
  })

  test('a list cannot be sent into another team\'s survey', async () => {
    const { body } = await mallory('/api/surveys', asJson({ name: 'Mallory list' }))
    const sent = await alice(`/api/surveys/${body.survey.id}/places`, asJson({ placeIds: [place.id] }))
    assert.equal(sent.status, 404)
  })
})

describe('a survey informs the CRM back', () => {
  let surveyId

  before(async () => {
    const { body } = await alice('/api/surveys', asJson({ name: 'Back-fill search' }))
    surveyId = body.survey.id
  })

  test('a site added on a survey becomes a place the team keeps', async () => {
    await alice(
      `/api/surveys/${surveyId}/properties`,
      asJson({ name: 'Found on tour', address: '900 Bristol St', city: 'Costa Mesa', state: 'CA', lat: 33.6, lng: -117.9 }),
    )
    const { body } = await alice('/api/crm/places')
    const found = body.records.find((place) => place.address === '900 Bristol St')
    assert.ok(found, 'the building is now in places')
    assert.equal(found.city, 'Costa Mesa')
    assert.equal(found.lat, 33.6)
  })

  test('the same address twice does not duplicate the place', async () => {
    await alice(
      `/api/surveys/${surveyId}/properties`,
      // Same building, typed differently — punctuation and case must not
      // decide whether the team ends up with one record or two.
      asJson({ name: 'Same building', address: '900 bristol st.', city: 'COSTA MESA', state: 'ca' }),
    )
    const { body } = await alice('/api/crm/places')
    const matches = body.records.filter((place) => /bristol/i.test(place.address ?? ''))
    assert.equal(matches.length, 1, 'one building, one place')
  })

  test('a curated place is never overwritten by a survey site', async () => {
    const { body: before } = await alice('/api/crm/places')
    const bristol = before.records.find((place) => /bristol/i.test(place.address ?? ''))
    await alice(`/api/crm/places/${bristol.id}`, asJson({ name: 'Bristol Retail Center', notes: 'Owner is motivated' }, 'PATCH'))

    await alice(
      `/api/surveys/${surveyId}/properties`,
      asJson({ name: 'Yet another label', address: '900 Bristol St', city: 'Costa Mesa', state: 'CA' }),
    )

    const { body: after } = await alice(`/api/crm/places/${bristol.id}`)
    assert.equal(after.record.name, 'Bristol Retail Center', 'the curated name stands')
    assert.equal(after.record.notes, 'Owner is motivated', 'and the notes with it')
  })

  test('a site with no address is not filed as a place', async () => {
    const { body: before } = await alice('/api/crm/places')
    await alice(`/api/surveys/${surveyId}/properties`, asJson({ name: 'Just a dropped pin', lat: 33.7, lng: -117.8 }))
    const { body: after } = await alice('/api/crm/places')
    assert.equal(after.records.length, before.records.length, 'nothing to match on, nothing filed')
  })
})

describe('one team never sees another', () => {
  test('lists hold only your own records', async () => {
    for (const segment of ['companies', 'people', 'places', 'deals']) {
      const { body } = await mallory(`/api/crm/${segment}`)
      assert.equal(body.records.length, 0, `${segment} is empty for a different team`)
    }
  })

  test('reading another team record by id is a 404, not a 403', async () => {
    for (const [segment, id] of [
      ['companies', company.id],
      ['people', person.id],
      ['places', place.id],
      ['deals', deal.id],
    ]) {
      assert.equal((await mallory(`/api/crm/${segment}/${id}`)).status, 404, `GET ${segment}`)
      assert.equal((await mallory(`/api/crm/${segment}/${id}`, asJson({ name: 'x' }, 'PATCH'))).status, 404, `PATCH ${segment}`)
      assert.equal((await mallory(`/api/crm/${segment}/${id}`, { method: 'DELETE' })).status, 404, `DELETE ${segment}`)
    }
  })

  test('a party cannot pull a record across the boundary', async () => {
    const { body } = await mallory('/api/crm/deals', asJson({ name: 'Mallory deal' }))
    const stolen = await mallory(`/api/crm/deals/${body.record.id}/parties`, asJson({ kind: 'place', refId: place.id }))
    assert.equal(stolen.status, 400)
  })

  test('signed out, the CRM answers nothing', async () => {
    const stranger = client()
    for (const segment of ['companies', 'people', 'places', 'deals']) {
      assert.equal((await stranger(`/api/crm/${segment}`)).status, 401)
    }
  })
})

describe('deleting', () => {
  test('a deleted record leaves no party row behind', async () => {
    const { body: made } = await alice('/api/crm/people', asJson({ firstName: 'Temp', lastName: 'Person' }))
    await alice(`/api/crm/deals/${deal.id}/parties`, asJson({ kind: 'person', refId: made.record.id }))

    const before = await alice(`/api/crm/deals/${deal.id}`)
    assert.equal(before.body.record.parties.length, 4)

    assert.equal((await alice(`/api/crm/people/${made.record.id}`, { method: 'DELETE' })).status, 204)
    const after = await alice(`/api/crm/deals/${deal.id}`)
    assert.equal(after.body.record.parties.length, 3, 'the party row goes with the record')
  })
})

/*
 * The join between the parcel map and the CRM.
 *
 * A parcel id is unique per county and nothing more, so the market is half of
 * the identifier rather than a label. These prove that, prove that a parcel
 * carries its deals back with it, and prove the lookup does not reach across
 * teams — the same boundary the rest of the CRM is held to.
 */
describe('a place pinned to a parcel', () => {
  let pinned

  test('a place records the market and parcel it came from', async () => {
    const created = await alice(
      '/api/crm/places',
      asJson({ name: '2407 Harris Blvd', market: 'austin-tx', parcelId: '114452', city: 'Austin' }),
    )
    assert.equal(created.status, 201)
    pinned = created.body.record
    assert.equal(pinned.market, 'austin-tx')
    assert.equal(pinned.parcelId, '114452')
  })

  test('the parcel looks up the place it belongs to', async () => {
    const found = await alice('/api/crm/parcel?market=austin-tx&parcel=114452')
    assert.equal(found.status, 200)
    assert.equal(found.body.place.id, pinned.id)
    assert.deepEqual(found.body.deals, [], 'no deal on it yet')
  })

  test('a parcel id alone is not an identifier', async () => {
    const noMarket = await alice('/api/crm/parcel?parcel=114452')
    assert.equal(noMarket.status, 400)
    const noParcel = await alice('/api/crm/parcel?market=austin-tx')
    assert.equal(noParcel.status, 400)
  })

  test('the same parcel id in another market is a different parcel', async () => {
    const elsewhere = await alice('/api/crm/parcel?market=fort-lauderdale-fl&parcel=114452')
    assert.equal(elsewhere.status, 200)
    assert.equal(elsewhere.body.place, null)
  })

  test('a deal on the place comes back with the parcel', async () => {
    const made = await alice('/api/crm/deals', asJson({ name: 'Harris Blvd assemblage' }))
    assert.equal(made.status, 201)
    const linked = await alice(
      `/api/crm/deals/${made.body.record.id}/parties`,
      asJson({ kind: 'place', refId: pinned.id, role: 'Subject' }),
    )
    assert.equal(linked.status, 201)

    const found = await alice('/api/crm/parcel?market=austin-tx&parcel=114452')
    assert.equal(found.body.deals.length, 1)
    assert.equal(found.body.deals[0].name, 'Harris Blvd assemblage')
  })

  test('another team sees nothing on the same parcel', async () => {
    const found = await mallory('/api/crm/parcel?market=austin-tx&parcel=114452')
    assert.equal(found.status, 200)
    assert.equal(found.body.place, null, 'the parcel is not theirs to see')
  })

  test('signing out closes the lookup', async () => {
    const stranger = client()
    const found = await stranger('/api/crm/parcel?market=austin-tx&parcel=114452')
    assert.equal(found.status, 401)
  })
})
