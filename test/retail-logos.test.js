/**
 * Nearby retail for the connector: brand logos from Wikidata, pins on a
 * saved map, and the nearby_retail tool's answer.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { brandLogos, clearLogoMemo, faviconFor, safeLogo, withLogos } from '../app/lib/logos.js'
import { MAX_PINS, TOOLS, businessPin, pinList, runTool, viewState } from '../app/lib/mcp.js'
import { buildQuery, loosePattern, parseElements, sectorOf } from '../app/lib/places.js'

const WALMART_THUMB = 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/ca/Walmart_logo.svg/128px-Walmart_logo.svg.png'

/** A stand-in for Wikidata and Commons. */
function wikimedia({ refuse = false } = {}) {
  const asked = []
  const fetchImpl = async (url) => {
    asked.push(url)
    if (refuse) return new Response('slow down', { status: 429 })
    if (url.startsWith('https://www.wikidata.org/')) {
      return Response.json({
        entities: {
          Q483551: {
            claims: {
              P154: [
                { rank: 'normal', mainsnak: { datavalue: { value: 'Walmart wordmark (2008).svg' } } },
                { rank: 'preferred', mainsnak: { datavalue: { value: 'Walmart_logo.svg' } } },
              ],
              P856: [{ rank: 'normal', mainsnak: { datavalue: { value: 'https://www.walmart.com/' } } }],
            },
          },
          Q1: { claims: { P856: [{ rank: 'normal', mainsnak: { datavalue: { value: 'https://example-brand.com' } } }] } },
        },
      })
    }
    if (url.startsWith('https://commons.wikimedia.org/')) {
      return Response.json({
        query: {
          normalized: [{ from: 'File:Walmart_logo.svg', to: 'File:Walmart logo.svg' }],
          pages: { 7: { title: 'File:Walmart logo.svg', imageinfo: [{ thumburl: `${WALMART_THUMB}?utm_source=commons.wikimedia.org`, url: 'x' }] } },
        },
      })
    }
    return new Response('?', { status: 404 })
  }
  return { fetchImpl, asked }
}

test('a brand logo is the preferred P154 file, as a Commons thumbnail, tracking stripped', async () => {
  clearLogoMemo()
  const { fetchImpl, asked } = wikimedia()
  const logos = await brandLogos(['Q483551', 'Q1', 'not-a-qid'], { fetchImpl })
  assert.equal(logos.get('Q483551').logo, WALMART_THUMB)
  assert.equal(logos.get('Q483551').website, 'https://www.walmart.com/')
  assert.equal(logos.get('Q1').logo, null)
  assert.equal(asked.length, 2)
  assert.ok(!asked[0].includes('not-a-qid'))
  // Remembered: a second ask goes nowhere.
  await brandLogos(['Q483551'], { fetchImpl })
  assert.equal(asked.length, 2)
})

test('a refusal leaves logos blank and is not remembered', async () => {
  clearLogoMemo()
  const refused = wikimedia({ refuse: true })
  assert.equal((await brandLogos(['Q483551'], { fetchImpl: refused.fetchImpl })).size, 0)
  const ok = wikimedia()
  assert.equal((await brandLogos(['Q483551'], { fetchImpl: ok.fetchImpl })).get('Q483551').logo, WALMART_THUMB)
})

test('logos: brand first, then the website favicon, else none', async () => {
  clearLogoMemo()
  const { fetchImpl } = wikimedia()
  const out = await withLogos(
    [
      { name: 'Walmart', brandWikidata: 'Q483551' },
      { name: 'Corner Books', website: 'https://www.cornerbooks.com/shop' },
      { name: 'Example', brandWikidata: 'Q1' },
      { name: 'No site' },
    ],
    { fetchImpl },
  )
  assert.deepEqual(out.map((r) => [r.logoSource, r.logo]), [
    ['brand', WALMART_THUMB],
    ['favicon', 'https://icons.duckduckgo.com/ip3/cornerbooks.com.ico'],
    ['favicon', 'https://icons.duckduckgo.com/ip3/example-brand.com.ico'],
    [null, null],
  ])
})

test('only trusted https logo hosts pass', () => {
  assert.equal(safeLogo(WALMART_THUMB), WALMART_THUMB)
  assert.equal(safeLogo('http://upload.wikimedia.org/a.png'), null)
  assert.equal(safeLogo('https://evil.example/pixel.gif'), null)
  assert.equal(safeLogo('javascript:alert(1)'), null)
  assert.equal(faviconFor('not a site'), null)
})

test('OpenStreetMap brand:wikidata is kept on each business', () => {
  const [b] = parseElements(
    [{ type: 'node', id: 1, lat: 30.27, lon: -97.74, tags: { name: 'Target', shop: 'department_store', brand: 'Target', 'brand:wikidata': 'Q1046951' } }],
    { lat: 30.27, lng: -97.74 },
  )
  assert.equal(b.brandWikidata, 'Q1046951')
})

test('pins are cleaned, capped and logo-checked before a map keeps them', () => {
  const pins = pinList([
    { lat: 30.1234567, lng: -97.7, label: '  Target  ', detail: 'department store', logo: WALMART_THUMB },
    { lat: 30, lng: -97, label: 'Bad logo', logo: 'https://evil.example/x.png' },
    { lat: 'x', lng: -97, label: 'No lat' },
    { lat: 95, lng: -97, label: 'Off the globe' },
    { lat: 30, lng: -97, label: '' },
  ])
  assert.deepEqual(pins, [
    { lat: 30.123457, lng: -97.7, label: 'Target', detail: 'department store', logo: WALMART_THUMB },
    { lat: 30, lng: -97, label: 'Bad logo' },
  ])
  const many = Array.from({ length: 300 }, (_, i) => ({ lat: 30, lng: -97, label: `P${i}`, logo: WALMART_THUMB, detail: 'x'.repeat(80) }))
  const capped = viewState({ market: 'austin-tx', pins: many })
  assert.equal(capped.pins.length, MAX_PINS)
  assert.ok(JSON.stringify(capped).length < 64 * 1024, 'fits a saved view')
})

test('a business becomes a pin with its brand and distance', () => {
  assert.deepEqual(businessPin({ name: 'Target Express', brand: 'Target', category: 'department store', miles: 0.42, lat: 1, lng: 2, logo: WALMART_THUMB }), {
    lat: 1, lng: 2, label: 'Target Express', detail: 'Target · department store · 0.42 mi', logo: WALMART_THUMB,
  })
  assert.equal(businessPin({ name: 'Shop', category: null, miles: 1, lat: 1, lng: 2 }).detail, '1 mi')
})

/** The app, as the connector calls it. */
function app(routes) {
  const seen = []
  const call = async (path, init = {}) => {
    seen.push({ path, init })
    for (const [prefix, answer] of Object.entries(routes)) {
      if (path.startsWith(prefix)) {
        const [status, body] = typeof answer === 'function' ? answer(path, init) : answer
        return Response.json(body, { status })
      }
    }
    return Response.json({ error: 'not here' }, { status: 404 })
  }
  return { call, seen }
}

const NEARBY = {
  results: [
    { name: 'Target', brand: 'Target', brandWikidata: 'Q1046951', sector: 'Department & big box', category: 'department store', address: '1 Main St', miles: 0.3, lat: 30.27, lng: -97.74, logo: WALMART_THUMB, logoSource: 'brand' },
    { name: "Zaxby's", brand: "Zaxby's", brandWikidata: 'Q8067525', sector: 'Quick service', category: 'fast food', miles: 0.6, lat: 30.275, lng: -97.74, logo: WALMART_THUMB, logoSource: 'brand' },
    { name: 'Target Express', brand: 'Target', brandWikidata: 'Q1046951', sector: 'Department & big box', category: 'department store', miles: 0.8, lat: 30.28, lng: -97.74, logo: WALMART_THUMB, logoSource: 'brand' },
  ],
  rings: [{ miles: 1, count: 3 }, { miles: 3, count: 3 }, { miles: 5, count: 3 }],
  radiusMiles: 2,
  source: 'OpenStreetMap via Overpass',
}

test('nearby_retail defaults to chains, with sectors and each brand\'s nearest store', async () => {
  const { call, seen } = app({
    '/api/geocode': [200, { results: [{ label: '100 Congress Ave, Austin', lat: 30.26, lng: -97.74 }] }],
    '/api/places/nearby': [200, NEARBY],
  })
  const out = await runTool('nearby_retail', { address: '100 Congress Ave, Austin TX', radiusMiles: 2 }, { call, origin: 'https://lq.test' })
  assert.ok(!out.isError, JSON.stringify(out))
  const asked = new URL(`https://x${seen[1].path}`)
  assert.equal(asked.searchParams.get('logos'), '1')
  assert.equal(asked.searchParams.get('category'), 'chains')
  assert.equal(asked.searchParams.get('radius'), '2')
  const b = out.structuredContent
  assert.equal(b.center.place, '100 Congress Ave, Austin')
  assert.equal(b.found, 3)
  assert.deepEqual(b.sectors, { 'Department & big box': 2, 'Quick service': 1 })
  assert.deepEqual(b.brands[0], { brand: 'Target', sector: 'Department & big box', count: 2, nearestMiles: 0.3, logo: WALMART_THUMB })
  assert.deepEqual(b.withinMiles, { 1: 3, 3: 3, 5: 3 })
  assert.equal(b.stores[1].sector, 'Quick service')
})

test('nearby_retail finds particular brands, forgiving spelling, and says which are absent', async () => {
  const { call, seen } = app({ '/api/places/nearby': [200, NEARBY] })
  const out = await runTool('nearby_retail', { lat: 30.27, lng: -97.74, category: 'retail', brands: ['Zaxbys', 'Chick-fil-A'] }, { call, origin: 'https://lq.test' })
  const asked = new URL(`https://x${seen[0].path}`)
  assert.equal(asked.searchParams.get('category'), 'chains')
  assert.equal(asked.searchParams.get('brands'), 'Zaxbys|Chick-fil-A')
  const [zax, cfa] = out.structuredContent.lookingFor
  assert.equal(zax.found, 1)
  assert.equal(zax.nearestMiles, 0.6)
  assert.equal(cfa.found, 0)
})

test('a chains search asks OpenStreetMap for brand-tagged storefronts only', () => {
  const q = buildQuery({ lat: 30, lng: -97, radiusMeters: 1609, category: 'chains' })
  assert.match(q, /nwr\["brand:wikidata"\]\["amenity"!~"\^\(atm\|/)
  assert.match(q, /out center 300;/)
  const brands = buildQuery({ lat: 30, lng: -97, radiusMeters: 1609, category: 'chains', keyword: ["Zaxby's", 'Target'] })
  assert.ok(brands.includes(loosePattern("Zaxby's")))
  assert.ok(!brands.includes('"amenity"!~'), 'a brand search is the brands, nothing else')
  assert.equal(loosePattern('Chick-fil-A'), 'c[^[:alnum:]]*h[^[:alnum:]]*i[^[:alnum:]]*c[^[:alnum:]]*k[^[:alnum:]]*f[^[:alnum:]]*i[^[:alnum:]]*l[^[:alnum:]]*a')
})

test('stores are sorted into sectors', () => {
  assert.equal(sectorOf({ amenity: 'fast_food' }), 'Quick service')
  assert.equal(sectorOf({ shop: 'department_store' }), 'Department & big box')
  assert.equal(sectorOf({ shop: 'supermarket' }), 'Grocery & club')
  assert.equal(sectorOf({ amenity: 'fuel' }), 'Convenience & fuel')
  assert.equal(sectorOf({ shop: 'variety_store' }), 'Discount & dollar')
  assert.equal(sectorOf({ amenity: 'bank' }), 'Banks')
})

test('nearby_retail needs a point', async () => {
  const { call } = app({})
  const out = await runTool('nearby_retail', {}, { call, origin: 'https://lq.test' })
  assert.equal(out.isError, true)
})

test('make_map nearby pins the businesses around the circle', async () => {
  let saved = null
  const { call } = app({
    '/api/places/nearby': [200, NEARBY],
    '/api/gis/views': (_path, init) => {
      saved = JSON.parse(init.body)
      return [201, { view: { id: 'v1', name: saved.name } }]
    },
  })
  const out = await runTool(
    'make_map',
    { market: 'austin-tx', name: 'Retail near site', circle: { lat: 30.27, lng: -97.74, miles: 1 }, nearby: {}, pins: [{ lat: 30.27, lng: -97.74, label: 'Site' }] },
    { call, origin: 'https://lq.test', scope: ['maps'] },
  )
  assert.ok(!out.isError, JSON.stringify(out))
  assert.equal(out.structuredContent.pins, 4)
  assert.equal(out.structuredContent.nearbyPinned, 3)
  assert.equal(saved.state.pins[0].label, 'Site')
  assert.equal(saved.state.pins[1].logo, WALMART_THUMB)
  assert.equal(out.structuredContent.link, 'https://lq.test/gis/austin-tx?view=v1')
})

test('make_map nearby with nowhere to search is refused', async () => {
  const { call } = app({})
  const out = await runTool('make_map', { market: 'austin-tx', name: 'x', nearby: {} }, { call, origin: 'https://lq.test', scope: ['maps'] })
  assert.equal(out.isError, true)
})

test('the tools are listed', () => {
  const names = TOOLS.map((t) => t.name)
  assert.ok(names.includes('nearby_retail'))
  assert.ok(TOOLS.find((t) => t.name === 'make_map').inputSchema.properties.pins)
})
