/**
 * Permits and code cases, asked of the city's open data per parcel. The
 * cities are faked here: these tests pin how a parcel becomes a query and
 * how each city's answer becomes rows, not what the cities hold today.
 */
import assert from 'node:assert/strict'
import test, { describe } from 'node:test'

import { SOURCES, parcelRecords, recordsSupported, streetParts } from '../app/lib/records.js'

const reply = (body) => ({ ok: true, json: async () => body })

describe('reading an address', () => {
  test('the pieces cities file streets under', () => {
    assert.deepEqual(streetParts('7810 S Jeffery Blvd'), { number: '7810', direction: 'S', name: 'JEFFERY', suffix: 'BLVD' })
    assert.deepEqual(streetParts('76-84 Boylston St'), { number: '76', direction: '', name: 'BOYLSTON', suffix: 'ST' })
    assert.deepEqual(streetParts('911 W 51St Pl'), { number: '911', direction: 'W', name: '51ST', suffix: 'PL' })
    assert.deepEqual(streetParts('5000 Wasson Rd Unit 4'), { number: '5000', direction: '', name: 'WASSON', suffix: 'RD' })
    assert.equal(streetParts('John Street'), null, 'no house number, nothing to match on')
    assert.equal(streetParts("1 O'Brien Way; DROP")?.name.includes("'"), false, 'quotes never reach a query')
  })
})

describe('asking the cities', () => {
  test('New York matches by BBL and splits it the way each dataset files it', async () => {
    const asked = []
    const fetcher = async (url) => {
      asked.push(decodeURIComponent(url))
      if (url.includes('wvxf-dwi5')) return reply([{ violationid: '1', violationstatus: 'Open', currentstatus: 'NOV SENT', inspectiondate: '2026-01-02T00:00:00.000', class: 'C', novdescription: 'No heat' }])
      if (url.includes('ipu4-2q9a')) {
        return reply([
          { job__: '1', permit_sequence__: '01', issuance_date: '2019-01-01', expiration_date: '2020-01-01', permit_status: 'ISSUED' },
          { job__: '2', permit_sequence__: '01', issuance_date: '2026-03-01', expiration_date: '2099-01-01', permit_status: 'ISSUED' },
        ])
      }
      return reply([])
    }
    const answer = await parcelRecords('new-york-ny', { gid: '3030310015' }, { fetcher })
    assert.ok(asked.some((u) => u.includes('wvxf-dwi5') && u.includes('boroid=3') && u.includes('block=3031') && u.includes('lot=15')))
    assert.ok(asked.some((u) => u.includes('ipu4-2q9a') && u.includes('borough=BROOKLYN') && u.includes('block=03031') && u.includes('lot=00015')))
    const hpd = answer.sources.find((s) => s.label === 'HPD housing violations')
    assert.equal(hpd.open, 1)
    assert.equal(hpd.rows[0].type, 'Class C')
    const bis = answer.sources.find((s) => s.label === 'DOB permits (BIS)')
    assert.equal(bis.rows[0].date, '2026-03-01', 'newest first')
    assert.equal(bis.open, 1, 'an issued permit past its expiry is not open')
  })

  test('Chicago searches inside the parcel box, and by house number', async () => {
    const asked = []
    const fetcher = async (url) => {
      asked.push(decodeURIComponent(url))
      return reply([{ id: '9', violation_status: 'OPEN', violation_date: '2026-10-26T00:00:00.000', violation_description: 'Arrange inspection' }])
    }
    const answer = await parcelRecords('chicago-il', { ad: '7810 S Jeffery Blvd', bb: [-87.5765, 41.752, -87.575, 41.753] }, { fetcher })
    assert.ok(asked.every((u) => u.includes('within_box(location,') && u.includes("street_number='7810'")))
    assert.equal(answer.sources.find((s) => s.kind === 'case').open, 1)
  })

  test('a city that fails is reported as that city, and the others still answer', async () => {
    const fetcher = async (url) => {
      if (url.includes('violations')) throw new Error('down')
      return reply({ rows: [{ permitnumber: 'P-1', permitissuedate: '2025-05-07T04:00:00Z', status: 'Completed' }] })
    }
    const answer = await parcelRecords('philadelphia-pa', { gid: '888001944' }, { fetcher })
    const [permits, cases] = answer.sources
    assert.equal(permits.rows.length, 1)
    assert.equal(permits.open, 0)
    assert.equal(cases.error, 'could not be read just now')
  })

  test('a parcel without the key a city needs asks nothing of it', async () => {
    let calls = 0
    const answer = await parcelRecords('los-angeles-ca', { gid: 'not-an-apn', ad: '' }, { fetcher: async () => (calls++, reply([])) })
    assert.equal(calls, 0)
    assert.ok(answer.sources.every((s) => s.rows.length === 0))
  })

  test('markets without a source say so', async () => {
    assert.equal(recordsSupported('phoenix-az'), false)
    assert.equal((await parcelRecords('phoenix-az', {})).supported, false)
    for (const market of Object.keys(SOURCES)) assert.ok(SOURCES[market].length > 0)
  })
})
