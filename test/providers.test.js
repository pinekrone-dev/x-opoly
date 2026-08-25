import assert from 'node:assert/strict'
import test, { describe } from 'node:test'

import { GeocodeError, geocode } from '../app/lib/geocode.js'
import { extractFromFlyer, toPropertyInput } from '../app/lib/flyer.js'

/** Minimal stand-in for fetch. */
function stubFetch(response) {
  return async () => response
}

const NOMINATIM_ROW = {
  lat: '30.4014',
  lon: '-97.7128',
  display_name: '4100 Parmer Ln, Austin, Travis County, Texas, 78727',
  address: { house_number: '4100', road: 'Parmer Ln', city: 'Austin', state: 'Texas', postcode: '78727' },
}

describe('geocoding', () => {
  test('maps a provider result onto property fields', async () => {
    const results = await geocode('4100 Parmer', {
      fetchImpl: stubFetch({ ok: true, status: 200, json: async () => [NOMINATIM_ROW] }),
    })

    assert.equal(results.length, 1)
    assert.equal(results[0].lat, 30.4014)
    assert.equal(results[0].address, '4100 Parmer Ln')
    assert.equal(results[0].city, 'Austin')
    assert.equal(results[0].zip, '78727')
  })

  test('refuses a query too short to be an address', async () => {
    await assert.rejects(() => geocode('ab'), GeocodeError)
  })

  test('reports rate limiting as retryable', async () => {
    await assert.rejects(
      () => geocode('austin', { fetchImpl: stubFetch({ ok: false, status: 429 }) }),
      (error) => error instanceof GeocodeError && error.retryable === true,
    )
  })

  test('explains an unreachable geocoder instead of returning nothing', async () => {
    await assert.rejects(
      () => geocode('austin', { fetchImpl: async () => { throw new Error('blocked by proxy') } }),
      (error) => error instanceof GeocodeError && /by hand/.test(error.message),
    )
  })

  test('a blocked Nominatim falls through to the Census geocoder', async () => {
    // The live failure this guards: Nominatim's public instance refuses cloud
    // provider IPs, so address search worked in every test and failed on the
    // deployed Worker. The Census geocoder answers instead.
    const asked = []
    const fetchImpl = async (url) => {
      asked.push(url)
      if (url.includes('nominatim')) return { ok: false, status: 403 }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          result: {
            addressMatches: [
              {
                matchedAddress: '1600 MAIN ST, DALLAS, TX, 75201',
                coordinates: { x: -96.7972, y: 32.7808 },
                addressComponents: { streetNumber: '1600', streetName: 'MAIN', suffixType: 'ST', city: 'DALLAS', state: 'TX', zip: '75201' },
              },
            ],
          },
        }),
      }
    }

    const results = await geocode('1600 Main St, Dallas TX', { fetchImpl })
    assert.equal(results.length, 1)
    assert.equal(results[0].lat, 32.7808)
    assert.equal(results[0].lng, -96.7972)
    assert.equal(results[0].city, 'DALLAS')
    assert.ok(asked.some((url) => url.includes('geocoding.geo.census.gov')))
  })

  test('an empty Nominatim answer also tries the Census parser', async () => {
    // A formal "123 N Something Rd" often misses on fuzzy search and hits on
    // the Census parser; an empty [] must not be treated as the final word.
    const fetchImpl = async (url) =>
      url.includes('nominatim')
        ? { ok: true, status: 200, json: async () => [] }
        : {
            ok: true,
            status: 200,
            json: async () => ({
              result: {
                addressMatches: [
                  { matchedAddress: 'X', coordinates: { x: -97.1, y: 30.1 }, addressComponents: {} },
                ],
              },
            }),
          }

    const results = await geocode('130 E Travis St', { fetchImpl })
    assert.equal(results.length, 1)
  })

  test('when both providers fail, the useful message survives', async () => {
    // The Nominatim path carries the curated messages ("check outbound
    // access", "rate limited"); the fallback failing second must not replace
    // them with a generic HTTP code.
    await assert.rejects(
      () => geocode('austin', { fetchImpl: stubFetch({ ok: false, status: 403 }) }),
      (error) => error instanceof GeocodeError && /not allowed to reach the geocoder/.test(error.message),
    )
  })

  test('a genuinely unmatched address returns empty, not an error', async () => {
    const fetchImpl = async (url) =>
      url.includes('nominatim')
        ? { ok: true, status: 200, json: async () => [] }
        : { ok: true, status: 200, json: async () => ({ result: { addressMatches: [] } }) }
    assert.deepEqual(await geocode('nowhere at all', { fetchImpl }), [])
  })
})

describe('flyer extraction', () => {
  const FIELDS = {
    name: 'Parmer Business Park',
    address: '4100 Parmer Ln',
    city: 'Austin',
    state: 'TX',
    zip: '78727',
    sizeSqft: 3200,
    acreage: 4.19,
    rentRate: 28.5,
    rentUnit: 'psf/yr',
    nnn: 8.25,
    parkingSpaces: 189,
    zoning: 'CS-1',
    yearBuilt: 1981,
    availability: 'Immediately',
    listingBroker: 'Highland Commercial',
    notes: 'Shadow anchored, undergoing renovation.',
    confidence: 'high',
    uncertainFields: ['nnn'],
  }

  function stubClient(captured) {
    return {
      messages: {
        async parse(request) {
          Object.assign(captured, request)
          return { parsed_output: FIELDS, model: 'claude-opus-5' }
        },
      },
    }
  }

  test('sends a PDF as a document block and returns structured fields', async () => {
    const captured = {}
    const { fields, model } = await extractFromFlyer(Buffer.from('%PDF-1.4 fake'), 'application/pdf', {
      client: stubClient(captured),
    })

    const [block] = captured.messages[0].content
    assert.equal(block.type, 'document')
    assert.equal(block.source.media_type, 'application/pdf')
    assert.equal(captured.model, 'claude-opus-5')
    assert.ok(captured.output_config.format, 'a structured output format is requested')
    assert.equal(fields.rentRate, 28.5)
    assert.equal(model, 'claude-opus-5')
  })

  test('sends a screenshot as an image block', async () => {
    const captured = {}
    await extractFromFlyer(Buffer.from('fakepng'), 'image/png', { client: stubClient(captured) })

    const [block] = captured.messages[0].content
    assert.equal(block.type, 'image')
    assert.equal(block.source.media_type, 'image/png')
  })

  test('refuses a file type it cannot read', async () => {
    await assert.rejects(
      () => extractFromFlyer(Buffer.from('x'), 'application/zip', { client: stubClient({}) }),
      /PDF, PNG or JPEG/,
    )
  })

  test('refuses an empty upload', async () => {
    await assert.rejects(() => extractFromFlyer(Buffer.alloc(0), 'application/pdf', { client: stubClient({}) }), /empty/)
  })

  test('says so when the model returns nothing parseable', async () => {
    const client = { messages: { parse: async () => ({ parsed_output: null, model: 'claude-opus-5' }) } }
    await assert.rejects(() => extractFromFlyer(Buffer.from('x'), 'application/pdf', { client }), /by hand/)
  })

  test('maps extracted fields onto property columns without inventing any', () => {
    const input = toPropertyInput(FIELDS)
    assert.equal(input.sizeSqft, 3200)
    assert.equal(input.listingBroker, 'Highland Commercial')
    assert.ok(!('confidence' in input), 'extraction metadata is not written to the record')
    assert.ok(!('uncertainFields' in input))
  })

  test('keeps a missing field null rather than guessing it', async () => {
    const sparse = { ...FIELDS, yearBuilt: null, rentRate: null }
    const client = { messages: { parse: async () => ({ parsed_output: sparse, model: 'claude-opus-5' }) } }
    const { fields } = await extractFromFlyer(Buffer.from('x'), 'application/pdf', { client })

    assert.equal(fields.yearBuilt, null)
    assert.equal(toPropertyInput(fields).rentRate, null)
  })
})

describe('geocoder access failures', () => {
  test('a blocked request is reported as our problem, not a bad query', async () => {
    await assert.rejects(
      () => geocode('austin texas', { fetchImpl: async () => ({ ok: false, status: 403 }) }),
      (error) => error instanceof GeocodeError && error.retryable === true && /not allowed to reach/.test(error.message),
    )
  })
})
