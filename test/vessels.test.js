/**
 * Live ship positions: reading the feed, sharing one connection, and the
 * route that hands a market its ships.
 *
 * The feed's rules are the reason for most of this. Three connections per
 * account, a subscription within three seconds, no faster than one update a
 * second, and no key in a browser. The hub is driven here with a fake socket
 * and a fake clock, so each rule is checked without a network.
 */

import assert from 'node:assert/strict'
import test, { after, before, describe } from 'node:test'

import { FRESH_MS, VesselHub, WATCH_MS, readMessage } from '../app/lib/vessels.js'
import { COASTAL_MARKETS, marketBox, shipGroup, snapView, vesselFeatures, viewTooWide } from '../src/lib/vessels.ts'
import { createServer } from '../server/index.js'
import { useTempData } from './helpers.js'

const NOW = Date.parse('2026-09-30T17:00:00Z')

function position(mmsi, lat, lng, extra = {}) {
  return {
    MessageType: 'PositionReport',
    MetaData: { MMSI: mmsi, ShipName: 'EVER GIVEN@@@@', latitude: lat, longitude: lng, time_utc: '2026-09-30 16:59:30.123456789 +0000 UTC' },
    Message: { PositionReport: { UserID: mmsi, Latitude: lat, Longitude: lng, Sog: 12.4, Cog: 86.7, TrueHeading: 87, NavigationalStatus: 0, Valid: true, ...extra } },
  }
}

describe('reading the feed', () => {
  test('a position report moves a ship, with the not-available values dropped', () => {
    const change = readMessage(position(368207620, 40.68, -74.02, { Sog: 102.3, TrueHeading: 511 }), NOW)
    assert.equal(change.mmsi, 368207620)
    assert.equal(change.patch.la, 40.68)
    assert.equal(change.patch.lo, -74.02)
    assert.equal(change.patch.sog, null, '102.3 knots is the beacon saying it does not know')
    assert.equal(change.patch.hdg, null, 'heading 511 is not a heading')
    assert.equal(change.patch.cog, 86.7)
    assert.equal(change.patch.n, 'EVER GIVEN', 'the @ padding AIS uses for short names is trimmed')
    assert.equal(change.patch.t, Date.parse('2026-09-30T16:59:30.123Z'), 'the stream clock, not ours')
  })

  test('no fix is no position', () => {
    assert.equal(readMessage(position(1, 91, 181), NOW), null)
    assert.equal(readMessage(position(1, 0, 0), NOW), null)
    assert.equal(readMessage(position(1, 40, -74, { Valid: false }), NOW), null)
  })

  test('a static report names and types a ship without moving it', () => {
    const change = readMessage(
      {
        MessageType: 'ShipStaticData',
        MetaData: { MMSI: 538001, ShipName: 'MAERSK X' },
        Message: { ShipStaticData: { Name: 'MAERSK X', Type: 71, Destination: 'USNYC@@', Dimension: { A: 300, B: 66, C: 20, D: 29 }, CallSign: 'V7AB', ImoNumber: 9000001, Valid: true } },
      },
      NOW,
    )
    assert.deepEqual(change.patch, { n: 'MAERSK X', ty: 71, de: 'USNYC', len: 366, cs: 'V7AB', imo: 9000001 })
    assert.equal('la' in change.patch, false)
  })

  test('the ship type code reads as a trade', () => {
    assert.equal(shipGroup(71), 'Cargo')
    assert.equal(shipGroup(84), 'Tanker')
    assert.equal(shipGroup(60), 'Passenger')
    assert.equal(shipGroup(52), 'Tug and towing')
    assert.equal(shipGroup(37), 'Pleasure and sailing')
    assert.equal(shipGroup(0), 'Not yet reported')
    assert.equal(shipGroup(null), 'Not yet reported')
  })

  test('a view snaps outward to a shared grid, and a county is too wide', () => {
    assert.deepEqual(snapView([-74.013, 40.701, -73.951, 40.749]), [-74.02, 40.7, -73.94, 40.76])
    assert.equal(viewTooWide([-74.1, 40.6, -73.95, 40.75]), false)
    assert.equal(viewTooWide([-74.5, 40.4, -73.4, 41.1]), true)
  })

  test('ships become points with the fields the card reads', () => {
    const geo = vesselFeatures([{ m: 1, la: 40.7, lo: -74, sog: 3, ty: 80, st: 1, t: NOW - 120000 }], NOW)
    const props = geo.features[0].properties
    assert.deepEqual(geo.features[0].geometry.coordinates, [-74, 40.7])
    assert.equal(props.Type, 'Tanker')
    assert.equal(props.Status, 'At anchor')
    assert.equal(props['Last report'], '2 minutes ago')
  })
})

/** A socket that records what was sent and lets the test speak for the feed. */
function fakeSocket() {
  const handlers = {}
  return {
    sent: [],
    closed: null,
    send(data) {
      this.sent.push(JSON.parse(data))
    },
    close(code, reason) {
      this.closed = { code, reason }
      handlers.close?.({ code, reason })
    },
    addEventListener(name, fn) {
      handlers[name] = fn
    },
    feed(message) {
      handlers.message?.({ data: new TextEncoder().encode(JSON.stringify(message)).buffer })
    },
    /** A frame as Cloudflare's runtime delivers it: a Blob, read asynchronously. */
    feedBlob(message) {
      handlers.message?.({ data: new Blob([JSON.stringify(message)]) })
    },
    drop(reason) {
      handlers.close?.({ code: 1006, reason })
    },
  }
}

function rig({ key = 'test-key' } = {}) {
  let clock = NOW
  const sockets = []
  const timers = []
  const hub = new VesselHub({
    key,
    connect: async () => {
      const socket = fakeSocket()
      sockets.push(socket)
      return socket
    },
    now: () => clock,
    later: (fn, ms) => timers.push({ fn, at: clock + ms }),
  })
  return {
    hub,
    sockets,
    advance(ms) {
      clock += ms
      for (const timer of timers.splice(0)) {
        if (timer.at <= clock) timer.fn()
        else timers.push(timer)
      }
    },
  }
}

const NYC = marketBox([-73.97, 40.74])
const LA = marketBox([-118.24, 34.05])

describe('one connection for everyone', () => {
  test('without a key nothing connects, and the answer says the layer is off', async () => {
    const { hub, sockets } = rig({ key: '' })
    const answer = await hub.watch('new-york-ny', NYC)
    assert.equal(answer.status, 'off')
    assert.equal(sockets.length, 0)
  })

  test('the first viewer opens the stream and subscribes at once, with the key and the market box', async () => {
    const { hub, sockets } = rig()
    const answer = await hub.watch('new-york-ny', NYC)
    assert.equal(answer.status, 'connecting')
    assert.equal(sockets.length, 1)
    const [subscription] = sockets[0].sent
    assert.equal(subscription.APIKey, 'test-key')
    assert.deepEqual(subscription.BoundingBoxes, [[[NYC[1], NYC[0]], [NYC[3], NYC[2]]]], 'corners as [lat, lng]')
    assert.ok(subscription.FilterMessageTypes.includes('PositionReport'))
  })

  test('ships heard are handed to the market they are in, and only that market', async () => {
    const { hub, sockets } = rig()
    await hub.watch('new-york-ny', NYC)
    sockets[0].feed({ MessageType: 'SubscriptionConfirmation', Message: { CompressionEnabled: true } })
    sockets[0].feed(position(111, 40.68, -74.02))
    sockets[0].feed(position(222, 33.74, -118.27))
    const ny = await hub.watch('new-york-ny', NYC)
    assert.equal(ny.status, 'live')
    assert.deepEqual(ny.ships.map((s) => s.m), [111])
    assert.equal('s' in ny.ships[0], false, 'bookkeeping stays on the server')
  })

  test('a frame that arrives as a Blob is read, as the Workers runtime delivers them', async () => {
    const { hub, sockets } = rig()
    await hub.watch('new-york-ny', NYC)
    sockets[0].feedBlob({ MessageType: 'SubscriptionConfirmation', Message: { CompressionEnabled: false } })
    sockets[0].feedBlob(position(111, 40.68, -74.02))
    await new Promise((resolve) => setTimeout(resolve, 10))
    const ny = await hub.watch('new-york-ny', NYC)
    assert.equal(ny.status, 'live')
    assert.deepEqual(ny.ships.map((s) => s.m), [111])
  })

  test('only the ships in view come back, and none when the view is a whole county', async () => {
    const { hub, sockets } = rig()
    await hub.watch('new-york-ny', NYC)
    sockets[0].feed(position(111, 40.68, -74.02))
    sockets[0].feed(position(222, 40.95, -73.8))
    const harbour = await hub.watch('new-york-ny', NYC, [-74.1, 40.6, -73.95, 40.75])
    assert.deepEqual(harbour.ships.map((s) => s.m), [111])
    assert.equal(harbour.total, 2, 'the market count still says what is out there')
    const county = await hub.watch('new-york-ny', NYC, [-74.5, 40.4, -73.4, 41.1])
    assert.equal(county.tooWide, true)
    assert.deepEqual(county.ships, [])
    assert.equal(county.total, 2)
  })

  test('a moving ship leaves a trail of where it has been; a still one does not', async () => {
    const { hub, sockets, advance } = rig()
    await hub.watch('new-york-ny', NYC)
    sockets[0].feed(position(111, 40.68, -74.02))
    sockets[0].feed(position(222, 40.7, -74.0))
    advance(60000)
    sockets[0].feed(position(111, 40.69, -74.01))
    sockets[0].feed(position(222, 40.7, -74.0))
    const answer = await hub.watch('new-york-ny', NYC, [-74.1, 40.6, -73.95, 40.75])
    const moving = answer.ships.find((s) => s.m === 111)
    const still = answer.ships.find((s) => s.m === 222)
    assert.equal(moving.tr.length, 2)
    assert.deepEqual(moving.tr[0], [-74.02, 40.68])
    assert.equal(still.tr, undefined)
  })

  test('a second market joins the same connection, with the update held to once a second', async () => {
    const { hub, sockets, advance } = rig()
    await hub.watch('new-york-ny', NYC)
    await hub.watch('los-angeles-ca', LA)
    assert.equal(sockets.length, 1, 'never a second connection')
    assert.equal(sockets[0].sent.length, 1, 'too soon after the first subscription to send another')
    advance(1200)
    assert.equal(sockets[0].sent.length, 2)
    assert.equal(sockets[0].sent[1].BoundingBoxes.length, 2)
  })

  test('the stream closes once nobody is watching, and stale ships are forgotten', async () => {
    const { hub, sockets, advance } = rig()
    await hub.watch('new-york-ny', NYC)
    sockets[0].feed(position(111, 40.68, -74.02))
    advance(WATCH_MS + 1000)
    assert.equal(hub.sweep(), false)
    assert.equal(sockets[0].closed?.reason, 'nobody watching')
    advance(FRESH_MS)
    hub.sweep()
    assert.equal(hub.ships.size, 0)
  })

  test('a close before the first message is named as a likely key problem', async () => {
    // What the live feed actually does with a bad key: opens, then closes
    // with 1006 and no message.
    const { hub, sockets } = rig()
    await hub.watch('new-york-ny', NYC)
    sockets[0].drop('')
    const answer = await hub.watch('new-york-ny', NYC)
    assert.equal(answer.status, 'error')
    assert.match(answer.note, /before sending anything.*key may be wrong/)
  })

  test('a refused key is reported, and the retry waits', async () => {
    const { hub, sockets, advance } = rig()
    await hub.watch('new-york-ny', NYC)
    sockets[0].feed({ error: 'Api Key Is Not Valid' })
    sockets[0].drop('')
    const answer = await hub.watch('new-york-ny', NYC)
    assert.equal(answer.status, 'error')
    assert.match(answer.note, /Api Key Is Not Valid/)
    assert.equal(sockets.length, 1, 'no reconnect inside the backoff')
    advance(3000)
    await hub.watch('new-york-ny', NYC)
    assert.equal(sockets.length, 2, 'and one after it')
  })
})

describe('GET /api/gis/vessels', () => {
  const temp = useTempData()
  let app
  let cookie
  const hubCalls = []
  const realFetch = globalThis.fetch

  const VESSELS = {
    idFromName: (name) => name,
    get: () => ({
      fetch: async (url) => {
        hubCalls.push(new URL(url))
        return Response.json({ status: 'live', since: NOW, ships: [{ m: 111, la: 40.68, lo: -74.02, t: NOW }] })
      },
    }),
  }

  const get = async (path) => {
    const response = await app.fetch(new Request(`http://localhost${path}`, { headers: cookie ? { cookie } : {} }))
    return { status: response.status, body: await response.json() }
  }

  before(async () => {
    // No parcel archive here, so the box falls back to one around the
    // market's centre; nothing in this file reaches the real catalogue.
    globalThis.fetch = async (url, init) =>
      String(url).endsWith('/new-york-ny/meta.json')
        ? Response.json({ center: [-73.9712, 40.7431] })
        : String(url).includes('data.realestateaistudio.com')
          ? new Response('missing', { status: 404 })
          : realFetch(url, init)
    app = await createServer({
      DATA_DIR: temp.directory,
      DB_FILE: `${temp.directory}/test.db`,
      VESSELS,
      AISSTREAM_API_KEY: 'test-key',
    })
    const response = await app.fetch(
      new Request('http://localhost/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'captain@example.com', password: 'a long enough password', name: 'Captain' }),
      }),
    )
    cookie = response.headers.get('set-cookie').split(';')[0]
  })

  after(() => {
    globalThis.fetch = realFetch
    temp.cleanup()
  })

  test('signing in is required', async () => {
    const saved = cookie
    cookie = null
    const res = await get('/api/gis/vessels?market=new-york-ny')
    cookie = saved
    assert.equal(res.status, 401)
  })

  test('the market extents answer even when no archive can be read', async () => {
    // Every archive 404s here: the answer is an empty list, never a guess
    // and never an error that would leave the map without its navigator.
    const res = await get('/api/gis/extents')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.extents, [])
  })

  test('an inland market has no ships to offer', async () => {
    assert.equal(COASTAL_MARKETS.has('phoenix-az'), false)
    const res = await get('/api/gis/vessels?market=phoenix-az')
    assert.equal(res.status, 404)
    assert.equal(hubCalls.length, 0)
  })

  test('a coastal market is asked for by its own box, built from its centre', async () => {
    const res = await get('/api/gis/vessels?market=new-york-ny&w=-180&s=-90&e=180&n=90')
    assert.equal(res.status, 200)
    assert.equal(res.body.status, 'live')
    assert.deepEqual(res.body.ships.map((s) => s.m), [111])
    const asked = hubCalls.at(-1)
    assert.equal(asked.searchParams.get('market'), 'new-york-ny')
    const box = ['w', 's', 'e', 'n'].map((k) => Number(asked.searchParams.get(k)))
    assert.deepEqual(box, marketBox([-73.9712, 40.7431]), 'the caller cannot widen the box')
    assert.deepEqual(
      ['vw', 'vs', 've', 'vn'].map((k) => Number(asked.searchParams.get(k))),
      snapView([-180, -90, 180, 90]),
      'the view only narrows what is sent back',
    )
  })
})

describe('without the feed configured', () => {
  const temp = useTempData()
  let app

  before(async () => {
    app = await createServer({ DATA_DIR: temp.directory, DB_FILE: `${temp.directory}/test.db` })
  })
  after(() => temp.cleanup())

  test('the route says the layer is off rather than failing', async () => {
    const reg = await app.fetch(
      new Request('http://localhost/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'deck@example.com', password: 'a long enough password', name: 'Deck' }),
      }),
    )
    const cookie = reg.headers.get('set-cookie').split(';')[0]
    const response = await app.fetch(new Request('http://localhost/api/gis/vessels?market=miami-fl', { headers: { cookie } }))
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.status, 'off')
  })
})
