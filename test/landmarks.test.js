/**
 * Landmarks near a site, from Wikidata: kinds matched by type, the figures
 * read, campuses kept whole, headquarters placed exactly or by city.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { clearTypeKinds, nearbyLandmarks, pointOf } from '../app/lib/landmarks.js'
import { landmarkFigure, landmarkPin, runTool } from '../app/lib/mcp.js'

const E = 'http://www.wikidata.org/entity/'
const lit = (value) => ({ value: String(value) })

/** A stand-in for the query service and Commons, answering by what the query asks. */
function wikidata() {
  const asked = []
  const fetchImpl = async (url, init = {}) => {
    const query = init.body ? decodeURIComponent(String(init.body).replace(/^query=/, '')) : ''
    asked.push(query || url)
    if (url.startsWith('https://commons.wikimedia.org/')) {
      return Response.json({ query: { pages: { 1: { title: 'File:GSU seal.svg', imageinfo: [{ thumburl: 'https://upload.wikimedia.org/x/128px-GSU_seal.svg.png' }] } } } })
    }
    if (query.includes('wdt:P279*')) {
      return Response.json({ results: { bindings: [
        { sub: lit(`${E}Q38723`), kind: lit('colleges') },
        { sub: lit(`${E}Q875538`), kind: lit('colleges') },
        { sub: lit(`${E}Q483110`), kind: lit('stadiums') },
        { sub: lit(`${E}Q16917`), kind: lit('hospitals') },
        { sub: lit(`${E}Q1248784`), kind: lit('airports') },
        { sub: lit(`${E}Q23002039`), kind: lit('colleges?') },
      ] } })
    }
    if (query.includes('SELECT ?place ?t')) {
      return new Response([
        '?place\t?t',
        `<${E}Q1>\t<${E}Q875538>`, // Georgia State, a public university
        `<${E}Q2>\t<${E}Q38723>`, // its law school
        `<${E}Q3>\t<${E}Q483110>`, // a stadium
        `<${E}Q4>\t<${E}Q1248784>`, // an airfield with no airline
        `<${E}Q5>\t<${E}Q5>`, // a person with coordinates, say
        `<${E}Q6>\t<${E}Q875538>`, // a state university in a state system
        `<${E}Q7>\t<${E}Q23002039>`, // a US public institution with an IPEDS id: a college
        `<${E}Q8>\t<${E}Q23002039>`, // one without: some other school
      ].join('\n'))
    }
    if (query.includes('VALUES ?item')) {
      return Response.json({ results: { bindings: [
        { item: lit(`${E}Q1`), itemLabel: lit('Georgia State University'), where: lit('Point(-84.386 33.753)'), st: lit(53619), logoFile: lit('http://commons.wikimedia.org/wiki/Special:FilePath/GSU%20seal.svg'), parents: lit(`${E}Q99`) },
        { item: lit(`${E}Q2`), itemLabel: lit('Georgia State University College of Law'), where: lit('Point(-84.387 33.754)'), parents: lit(`${E}Q1`) },
        { item: lit(`${E}Q3`), itemLabel: lit('Mercedes-Benz Stadium'), where: lit('Point(-84.4008 33.7554)'), capacity: lit(71000), teams: lit('Atlanta Falcons|Atlanta United FC') },
        { item: lit(`${E}Q4`), itemLabel: lit('Some Airfield'), where: lit('Point(-84.4 33.7)') },
        { item: lit(`${E}Q6`), itemLabel: lit('Georgia Tech'), where: lit('Point(-84.3947 33.7758)'), st: lit(36489), parents: lit(`${E}Q1`) },
        { item: lit(`${E}Q7`), itemLabel: lit('Georgia Gwinnett College'), where: lit('Point(-84.0028 33.9812)'), st: lit(12831), ipedsId: lit('488031') },
        { item: lit(`${E}Q8`), itemLabel: lit('Some Public School'), where: lit('Point(-84.39 33.75)'), st: lit(900) },
      ] } })
    }
    if (query.includes('ps:P159')) {
      return Response.json({ results: { bindings: [
        { co: lit(`${E}Q10`), coLabel: lit('The Coca-Cola Company'), employees: lit(69700), hqLoc: lit('Point(-84.396553 33.771)'), placeLoc: lit('Point(-84.39 33.75)'), inPlace: lit('Atlanta'), industries: lit('beverage industry'), types: lit(`${E}Q891723`) },
        { co: lit(`${E}Q11`), coLabel: lit('The Home Depot'), employees: lit(400000), placeLoc: lit('Point(-84.39 33.75)'), inPlace: lit('Atlanta'), types: lit(`${E}Q891723`) },
        { co: lit(`${E}Q12`), coLabel: lit('Far Away Corp'), employees: lit(5000), hqLoc: lit('Point(-80 30)'), placeLoc: lit('Point(-84.39 33.75)'), inPlace: lit('Atlanta') },
        { co: lit(`${E}Q13`), coLabel: lit('Emory University'), employees: lit(12953), placeLoc: lit('Point(-84.39 33.75)'), inPlace: lit('Atlanta'), types: lit(`${E}Q875538`) },
      ] } })
    }
    return new Response('?', { status: 404 })
  }
  return { fetchImpl, asked }
}

test('landmarks are matched by type, figures read, campuses kept whole', async () => {
  clearTypeKinds()
  const { fetchImpl } = wikidata()
  const r = await nearbyLandmarks({ lat: 33.749, lng: -84.388, radiusMiles: 5, fetchImpl })
  const names = r.landmarks.map((l) => l.name)
  // Largest draw first, across kinds.
  assert.equal(names[0], 'The Home Depot')
  assert.ok(names.includes('Georgia State University'))
  assert.ok(names.includes('Georgia Tech'), 'a campus with its own students stays, whatever it is part of')
  assert.ok(!names.includes('Georgia State University College of Law'), 'a school inside a nearby campus is the campus')
  assert.ok(!names.includes('Some Airfield'), 'no IATA code, no airline service')
  assert.ok(names.includes('Georgia Gwinnett College'), 'a loosely typed US college with an IPEDS id counts')
  assert.ok(!names.includes('Some Public School'), 'without one it does not')
  assert.ok(!names.includes('Far Away Corp'), 'an exact HQ outside the radius is out')
  assert.ok(!names.includes('Emory University') || r.landmarks.find((l) => l.name === 'Emory University').kind !== 'headquarters', 'a university is not an HQ')
  const gsu = r.landmarks.find((l) => l.name === 'Georgia State University')
  assert.equal(gsu.students, 53619)
  assert.equal(gsu.logo, 'https://upload.wikimedia.org/x/128px-GSU_seal.svg.png')
  const mbs = r.landmarks.find((l) => l.name === 'Mercedes-Benz Stadium')
  assert.deepEqual(mbs.teams, ['Atlanta Falcons', 'Atlanta United FC'])
  assert.equal(r.landmarks.find((l) => l.name === 'The Coca-Cola Company').located, 'exact')
  assert.equal(r.landmarks.find((l) => l.name === 'The Home Depot').located, 'city: Atlanta')
  assert.deepEqual(r.byKind, { headquarters: 2, colleges: 3, stadiums: 1 })
})

test('only headquarters asked for: no place queries', async () => {
  clearTypeKinds()
  const { fetchImpl, asked } = wikidata()
  const r = await nearbyLandmarks({ lat: 33.749, lng: -84.388, kinds: ['headquarters'], fetchImpl, logos: false })
  assert.ok(!asked.some((q) => String(q).includes('SELECT ?place ?t')))
  assert.ok(r.landmarks.every((l) => l.kind === 'headquarters'))
})

test('a refusal from Wikidata is an error, not an empty list', async () => {
  clearTypeKinds()
  const fetchImpl = async () => new Response('slow down', { status: 429 })
  await assert.rejects(nearbyLandmarks({ lat: 33.7, lng: -84.4, fetchImpl }), /rate limiting/)
})

test('a point reads from WKT', () => {
  assert.deepEqual(pointOf('Point(-84.4008 33.7554)'), { lng: -84.4008, lat: 33.7554 })
  assert.equal(pointOf('nonsense'), null)
})

test('figures and pins read like a broker would say them', () => {
  assert.equal(landmarkFigure({ capacity: 71000, teams: ['Atlanta Falcons', 'Atlanta United FC', 'x'] }), '71,000 seats · Atlanta Falcons, Atlanta United FC')
  assert.equal(landmarkFigure({ employees: 400000, located: 'city: Atlanta' }), '400,000 employees (HQ city)')
  assert.deepEqual(landmarkPin({ kind: 'colleges', name: 'Georgia Tech', students: 36489, miles: 1.9, lat: 1, lng: 2 }), {
    lat: 1, lng: 2, label: 'Georgia Tech', detail: 'College · 36,489 students · 1.9 mi', logo: undefined,
  })
})

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

const LANDMARKS = {
  landmarks: [
    { kind: 'headquarters', name: 'The Home Depot', employees: 400000, located: 'city: Atlanta', miles: 0.4, lat: 33.75, lng: -84.39 },
    { kind: 'stadiums', name: 'Mercedes-Benz Stadium', capacity: 71000, teams: ['Atlanta Falcons'], miles: 0.9, lat: 33.7554, lng: -84.4008 },
    { kind: 'colleges', name: 'Georgia State University', students: 53619, miles: 0.3, lat: 33.753, lng: -84.386, logo: 'https://upload.wikimedia.org/x.png' },
    { kind: 'colleges', name: 'Georgia Tech', students: 36489, miles: 1.9, lat: 33.7758, lng: -84.3947 },
  ],
  byKind: { headquarters: 1, stadiums: 1, colleges: 2 },
  radiusMiles: 5,
  source: 'Wikidata',
}

test('nearby_landmarks groups by kind, largest first, and says where an HQ is only a city', async () => {
  const { call, seen } = app({ '/api/places/landmarks': [200, LANDMARKS] })
  const out = await runTool('nearby_landmarks', { lat: 33.749, lng: -84.388, kinds: ['colleges', 'stadiums', 'headquarters', 'bogus'], perKind: 1 }, { call, origin: 'https://lq.test' })
  assert.ok(!out.isError, JSON.stringify(out))
  const asked = new URL(`https://x${seen[0].path}`)
  assert.equal(asked.searchParams.get('kinds'), 'colleges,stadiums,headquarters')
  const g = out.structuredContent.landmarks
  assert.equal(g.colleges.length, 1)
  assert.equal(g.colleges[0].name, 'Georgia State University')
  assert.match(g.headquarters[0].located, /city only/)
  assert.equal(g.stadiums[0].figure, '71,000 seats · Atlanta Falcons')
})

test('make_map landmarks pins them around the circle', async () => {
  let saved = null
  const { call } = app({
    '/api/places/landmarks': [200, LANDMARKS],
    '/api/gis/views': (_p, init) => {
      saved = JSON.parse(init.body)
      return [201, { view: { id: 'v2', name: saved.name } }]
    },
  })
  const out = await runTool('make_map', { market: 'atlanta-ga', name: 'Demand drivers', circle: '{"lat":33.749,"lng":-84.388,"miles":5}', landmarks: '{"kinds":["colleges","stadiums"]}' }, { call, origin: 'https://lq.test', scope: ['maps'] })
  assert.ok(!out.isError, JSON.stringify(out))
  assert.equal(out.structuredContent.landmarksPinned, 4)
  assert.equal(saved.state.pins[2].detail, 'College · 53,619 students · 0.3 mi')
  assert.equal(saved.state.pins[2].logo, 'https://upload.wikimedia.org/x.png')
})
