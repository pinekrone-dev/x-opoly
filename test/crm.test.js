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

  test('the building arrives as a site, with its profile', async () => {
    const sent = await alice(`/api/crm/places/${place.id}/send`, asJson({ surveyId }))
    assert.equal(sent.status, 201)
    assert.equal(sent.body.property.address, '2101 Harbor Blvd')
    assert.equal(sent.body.property.lat, 33.66)
    assert.equal(sent.body.property.rentRate, 38)

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
