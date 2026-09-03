import test, { describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { parseCsv, parseCsvRecords } from '../scripts/lib/csv.mjs'
import { ParcelIndex, pointInGeometry } from '../scripts/lib/geo.mjs'
import { parseBatchResponse } from '../scripts/lib/census-geocoder.mjs'
import {
  addressKey,
  alreadyLoaded,
  exportLayer,
  geocodeProviders,
  joinParcels,
  loadNppes,
  loadNucc,
  openProviders,
  status,
} from '../scripts/lib/providers.mjs'
import {
  NUCC_ROWS,
  deactivation,
  individual,
  nppesCsv,
  nuccCsv,
  organisation,
  parcels,
  stubGeocoder,
} from './fixtures/providers.mjs'

const stream = (text) => Readable.from([text])

describe('the CSV reader', () => {
  test('handles quotes, doubled quotes, embedded newlines and CRLF', async () => {
    const rows = []
    for await (const row of parseCsv(stream('a,b,c\r\n1,"x, y","say ""hi""\nthere"\r\n,,\r\n'))) rows.push(row)
    assert.deepEqual(rows, [['a', 'b', 'c'], ['1', 'x, y', 'say "hi"\nthere'], ['', '', '']])
  })

  test('is not fooled by a chunk boundary inside a quoted field', async () => {
    const rows = []
    for await (const row of parseCsv(Readable.from(['id,name\n1,"Smi', 'th, ""Doc"" J', 'ones"\n']))) rows.push(row)
    assert.deepEqual(rows, [['id', 'name'], ['1', 'Smith, "Doc" Jones']])
  })

  test('keys records by the header', async () => {
    const records = []
    for await (const record of parseCsvRecords(stream('NPI,Entity Type Code\n1,2\n'))) records.push(record)
    assert.deepEqual(records, [{ NPI: '1', 'Entity Type Code': '2' }])
  })
})

describe('the parcel index', () => {
  const index = new ParcelIndex(parcels().features)

  test('finds the parcel under a point, honouring holes', () => {
    assert.equal(index.find(-97.743, 30.268).properties.id, 'P-1')
    assert.equal(index.find(-97.731, 30.268).properties.id, 'P-3')
    assert.equal(index.find(-97.733, 30.270), null, 'inside the hole is outside the parcel')
    assert.equal(index.find(-97.738, 30.268), null, 'the gap between parcels matches nothing')
    assert.equal(pointInGeometry(null, 0, 0), false)
  })

  test('knows the market envelope', () => {
    assert.equal(index.covers(-97.741, 30.268), true)
    assert.equal(index.covers(-96.797, 32.780), false)
    assert.equal(index.size, 3)
  })
})

describe('the Census batch response', () => {
  test('reads matches, ties and misses', async () => {
    const text =
      '"1","1 MAIN ST, DALLAS, TX, 75201","Match","Exact","1 MAIN ST, DALLAS, TX, 75201","-96.797,32.780","1","L","48","113","020100","2001"\n' +
      '"2","NOWHERE, TX","No_Match"\n' +
      '"3","AMBIGUOUS RD, TX","Tie"\n'
    const results = await parseBatchResponse(text)
    assert.equal(results.get('1').lat, 32.78)
    assert.equal(results.get('1').lng, -96.797)
    assert.equal(results.get('1').tract, '48113020100')
    assert.equal(results.get('2').indicator, 'No_Match')
    assert.equal(results.get('2').lat, null)
    assert.equal(results.get('3').indicator, 'Tie')
  })
})

describe('the provider store', () => {
  let dir, db

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'providers-'))
    db = openProviders(path.join(dir, 'providers.db'))
  })
  after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('loads the NUCC taxonomy as a lookup with its version and licence note', async () => {
    const result = await loadNucc(db, stream(nuccCsv(NUCC_ROWS)), { version: '26.1', license: 'NUCC licence note', file: 'nucc_taxonomy_261.csv' })
    assert.equal(result.rows, 4)
    const row = db.prepare('SELECT * FROM nucc_taxonomy WHERE code = ?').get('261QU0200X')
    assert.equal(row.specialization, 'Urgent Care')
    assert.equal(row.version, '26.1')
    assert.equal(row.license, 'NUCC licence note')
    assert.equal(db.prepare("SELECT definition FROM nucc_taxonomy WHERE code = '207Q00000X'").get().definition, 'A physician who, "by training", cares for the whole family.')
  })

  const monthly = [
    organisation('1000000001', { name: 'CONGRESS URGENT CARE PLLC', address: '100 CONGRESS AVE STE 200', city: 'AUSTIN', state: 'TX', zip: '787012400' }),
    individual('1000000002', { first: 'ANA', last: 'REYES', address: '100 Congress Ave, Ste 200', city: 'Austin', state: 'TX', zip: '78701', home: { address: '9 QUIET LN', city: 'AUSTIN', state: 'TX', zip: '78745' }, secondary: '2085R0202X' }),
    individual('1000000003', { first: 'BO', last: 'LIN', address: '500 MEDICAL ARTS DR', city: 'AUSTIN', state: 'TX', zip: '78701', home: { address: '1 HOME RD', city: 'ROUND ROCK', state: 'TX', zip: '78664' }, taxonomy: '1223G0001X' }),
    individual('1000000004', { first: 'CY', last: 'PARK', address: '77 UNKNOWN WAY', city: 'AUSTIN', state: 'TX', zip: '78701', home: { address: '2 HOME RD', city: 'AUSTIN', state: 'TX', zip: '78745' } }),
    organisation('1000000005', { name: 'DALLAS IMAGING LLC', address: '1600 MAIN ST', city: 'DALLAS', state: 'TX', zip: '75201', taxonomy: '2085R0202X' }),
    organisation('1000000006', { name: 'MIAMI DENTAL PA', address: '1 BISCAYNE BLVD', city: 'MIAMI', state: 'FL', zip: '33131', taxonomy: '1223G0001X' }),
    deactivation('1000000007', '01/05/2026'),
  ]

  test('mirrors the monthly file: every NPI, every taxonomy, no home addresses', async () => {
    const result = await loadNppes(db, stream(nppesCsv(monthly)), { file: 'NPPES_Data_Dissemination_August_2026.zip', replace: true })
    assert.deepEqual(result, { rows: 7, stored: 6, deactivated: 1, skipped: 0 })

    const summary = status(db)
    assert.equal(summary.providers, 6)
    assert.equal(summary.active, 6)
    assert.equal(summary.organisations, 3)
    assert.equal(summary.individualMailingAddresses, 0, 'no individual mailing address is ever stored')
    assert.equal(summary.taxonomy, 4)

    const org = db.prepare('SELECT * FROM providers WHERE npi = ?').get('1000000001')
    assert.equal(org.mailing_address1, 'PO BOX 100', 'an organisation keeps its mailing address')
    assert.equal(org.primary_taxonomy, '261QU0200X')

    const person = db.prepare('SELECT * FROM providers WHERE npi = ?').get('1000000002')
    assert.equal(person.mailing_address1, null)
    assert.equal(person.mailing_city, null)
    assert.equal(person.address_key, org.address_key, 'the same suite, differently typed, keys the same')
    assert.equal(person.address_key, addressKey({ address1: '100 Congress Ave, Ste 200', city: 'Austin', state: 'TX', zip: '78701-2400' }))
    assert.deepEqual(
      db.prepare('SELECT code, is_primary FROM provider_taxonomies WHERE npi = ? ORDER BY is_primary DESC').all('1000000002').map((row) => ({ ...row })),
      [{ code: '207Q00000X', is_primary: 1 }, { code: '2085R0202X', is_primary: 0 }],
    )
    assert.equal(alreadyLoaded(db, 'NPPES_Data_Dissemination_August_2026.zip'), true)
  })

  test('applies a weekly incremental: updates, additions and deactivations', async () => {
    const weekly = [
      // Moved offices.
      individual('1000000003', { first: 'BO', last: 'LIN', address: '100 CONGRESS AVE STE 200', city: 'AUSTIN', state: 'TX', zip: '78701', home: { address: '1 HOME RD', city: 'ROUND ROCK', state: 'TX', zip: '78664' }, taxonomy: '1223G0001X' }),
      // New this week.
      organisation('1000000008', { name: 'NEW CLINIC LLC', address: '500 MEDICAL ARTS DR', city: 'AUSTIN', state: 'TX', zip: '78701' }),
      // Retired.
      deactivation('1000000005', '08/28/2026'),
    ]
    const result = await loadNppes(db, stream(nppesCsv(weekly)), { file: 'NPPES_Data_Dissemination_082426_083026_Weekly.zip' })
    assert.deepEqual(result, { rows: 3, stored: 2, deactivated: 1, skipped: 0 })
    const summary = status(db)
    assert.equal(summary.providers, 7)
    assert.equal(summary.active, 6)
    assert.equal(summary.deactivated, 1)
    assert.equal(db.prepare('SELECT practice_address1 FROM providers WHERE npi = ?').get('1000000003').practice_address1, '100 CONGRESS AVE STE 200')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM provider_taxonomies WHERE npi = ?').get('1000000005').n, 0, 'a deactivated NPI drops its taxonomies')
  })

  test('a state filter keeps the mirror to the markets served', async () => {
    const other = openProviders(path.join(dir, 'texas.db'))
    const result = await loadNppes(other, stream(nppesCsv(monthly)), { file: 'monthly.csv', replace: true, states: ['tx'] })
    assert.equal(result.skipped, 1)
    assert.equal(status(other).providers, 5)
    other.close()
  })

  test('geocodes each distinct practice address once, keeping misses and ties', async () => {
    const { fetchImpl, calls } = stubGeocoder({
      '100 congress ave ste 200|austin|tx|78701': { lat: 30.268, lng: -97.743 },
      '500 medical arts dr|austin|tx|78701': { lat: 30.268, lng: -97.739 },
      '77 unknown way|austin|tx|78701': { tie: true },
      '1 biscayne blvd|miami|fl|33131': { lat: 25.774, lng: -80.187 },
    })
    const result = await geocodeProviders(db, { fetchImpl, batch: 3 })
    // Four distinct active addresses across six active NPIs; the Dallas one
    // was deactivated this week and is not sent.
    assert.equal(result.addresses, 4)
    assert.equal(result.sent, 4)
    assert.equal(result.matched, 3)
    assert.equal(calls.length, 2, 'batched three at a time')
    const again = await geocodeProviders(db, { fetchImpl })
    assert.equal(again.sent, 0, 'nothing is geocoded twice')
    const summary = status(db)
    assert.equal(summary.geocoded, 3)
    assert.equal(summary.geocodeMisses, 1)
  })

  test('joins practice points to the parcel under them and keeps the unmatched', () => {
    const result = joinParcels(db, 'austin-tx', parcels().features, { idKey: 'id' })
    // Five active Austin NPIs share two geocoded addresses in the envelope;
    // the tied one has no point. 100 Congress sits in P-1, Medical Arts in P-2.
    assert.equal(result.points, 4)
    assert.equal(result.matched, 4)
    assert.equal(result.unmatched, 0)

    const row = db.prepare('SELECT * FROM provider_parcels WHERE npi = ? AND market = ?').get('1000000001', 'austin-tx')
    assert.equal(row.parcel_id, 'P-1')
    assert.equal(row.owner_name, 'CONGRESS AVENUE HOLDINGS LLC')
    assert.equal(row.assessed_value, 12500000)
    assert.equal(row.match, 'point-in-parcel')

    // A point in the envelope but on no parcel is written as unmatched, with
    // no owner invented for it.
    db.prepare("INSERT OR REPLACE INTO geocode_cache (address_key, lat, lng, indicator, match_type, matched_address, tract, fetched_at) VALUES ('gap|austin|tx|78701', 30.268, -97.738, 'Match', 'Exact', 'GAP', NULL, '2026-09-03T00:00:00Z')").run()
    db.prepare("INSERT INTO providers (npi, entity_type, org_name, practice_address1, practice_city, practice_state, practice_zip, address_key) VALUES ('1000000009', 2, 'GAP CLINIC', 'GAP', 'AUSTIN', 'TX', '78701', 'gap|austin|tx|78701')").run()
    const second = joinParcels(db, 'austin-tx', parcels().features, { idKey: 'id' })
    assert.equal(second.unmatched, 1)
    const gap = db.prepare("SELECT * FROM provider_parcels WHERE npi = '1000000009'").get()
    assert.equal(gap.match, 'unmatched')
    assert.equal(gap.owner_name, null)
  })

  test('exports the market layer in the catalog shape, ownership from the roll only', () => {
    const { collection, entry } = exportLayer(db, 'austin-tx')
    assert.equal(collection.type, 'FeatureCollection')
    assert.equal(collection.features.length, 5)
    assert.equal(entry.file, 'layer-healthcare.geojson')
    assert.equal(entry.kind, 'point')
    assert.equal(entry.count, 5)

    const congress = collection.features.find((f) => f.properties.NPI === '1000000001').properties
    assert.equal(congress.Practice, 'CONGRESS URGENT CARE PLLC')
    assert.equal(congress.Specialty, 'Urgent Care')
    assert.equal(congress['Owner of record'], 'CONGRESS AVENUE HOLDINGS LLC')
    assert.equal(congress.Clinicians, 3, 'three active NPIs at that suite')
    assert.equal(congress.Match, 'point-in-parcel')

    const gap = collection.features.find((f) => f.properties.NPI === '1000000009').properties
    assert.equal(gap['Owner of record'], '')
    assert.equal(gap.Match, 'unmatched')

    const person = collection.features.find((f) => f.properties.NPI === '1000000002').properties
    assert.equal(person.Practice, 'ANA REYES')
    assert.equal(person.Specialty, 'Family Medicine')
    assert.ok(!Object.values(person).some((v) => typeof v === 'string' && v.includes('QUIET LN')), 'a home address never reaches the layer')

    assert.ok(collection.features.every((f) => f.properties.NPI !== '1000000005'), 'deactivated NPIs are not exported')
    assert.ok(collection.features.every((f) => f.properties.NPI !== '1000000006'), 'a Miami practice is not in the Austin layer')
    assert.deepEqual(entry.categories[0], { field: 'Match', values: [['point-in-parcel', 4], ['unmatched', 1]] })
  })
})
