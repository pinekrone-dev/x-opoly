/**
 * Live ship positions, from one stream shared by everyone watching.
 *
 * aisstream.io relays AIS, the position beacon ships broadcast every few
 * seconds under way and every three minutes at anchor, free with a key. Its
 * rules shape everything here: three connections per account, three per
 * originating address, no connections from a browser, and the key kept on
 * the server. So the server holds one connection, subscribed to the boxes of
 * the markets someone is looking at right now, and hands each viewer the
 * ships inside their market. Nobody watching means no connection at all, so
 * the stream costs nothing while the layer is off.
 *
 * Positions accumulate in memory while the stream is open. A ship at anchor
 * reports every three minutes, so a viewer who opens the layer sees the
 * moving ships at once and the moored ones fill in over the first few
 * minutes; the answer says when the stream started so the map can say so.
 *
 * The hub below is plain logic with the socket handed in, so the tests can
 * drive it; worker/vessels.js wraps it in the Durable Object that owns the
 * connection.
 */

import { marketBox, REACH } from '../../src/lib/vessels.ts'

export const STREAM_URL = 'https://stream.aisstream.io/v0/stream'

/** A viewer who stops asking is gone after this long. */
export const WATCH_MS = 90 * 1000

/** A ship silent this long has left, switched off, or sailed out of range. */
export const FRESH_MS = 20 * 60 * 1000

/** More ships than any US port holds at once; a guard, not a budget. */
export const SHIP_CAP = 20000

const MESSAGE_TYPES = [
  'PositionReport',
  'StandardClassBPositionReport',
  'ExtendedClassBPositionReport',
  'ShipStaticData',
  'StaticDataReport',
]

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const text = (value) => {
  const clean = typeof value === 'string' ? value.replace(/@+$/g, '').trim() : ''
  return clean || null
}

/** AIS spends its top values on "not available": 102.3 knots, 360 degrees, heading 511. */
const speed = (value) => (num(value) != null && value < 102.2 ? Math.round(value * 10) / 10 : null)
const course = (value) => (num(value) != null && value >= 0 && value < 360 ? Math.round(value * 10) / 10 : null)
const heading = (value) => (num(value) != null && value >= 0 && value < 360 ? value : null)
const length = (dimension) => {
  const total = (num(dimension?.A) ?? 0) + (num(dimension?.B) ?? 0)
  return total > 0 && total < 500 ? total : null
}

function position(lat, lng) {
  if (num(lat) == null || num(lng) == null) return null
  // 91 and 181 are the beacon's own "no fix".
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null
  if (lat === 0 && lng === 0) return null
  return { la: Math.round(lat * 1e5) / 1e5, lo: Math.round(lng * 1e5) / 1e5 }
}

function reportedAt(meta, now) {
  // "2026-09-30 17:04:05.123456789 +0000 UTC": the stream's own clock.
  const stamp = typeof meta?.time_utc === 'string' ? Date.parse(meta.time_utc.replace(/(\.\d{3})\d*/, '$1').replace(' +0000 UTC', 'Z').replace(' ', 'T')) : NaN
  return Number.isFinite(stamp) && stamp <= now + 60000 ? stamp : now
}

/**
 * One stream message as a change to one ship, or null for anything else.
 *
 * A position report moves the ship; a static report names it, types it and
 * says where it is bound, and never moves it. Either may arrive first.
 */
export function readMessage(message, now = Date.now()) {
  const type = message?.MessageType
  const meta = message?.MetaData ?? {}
  const body = message?.Message?.[type]
  const mmsi = num(meta.MMSI) ?? num(body?.UserId) ?? num(body?.UserID)
  if (!mmsi || !body) return null
  const name = text(meta.ShipName)

  if (type === 'PositionReport' || type === 'StandardClassBPositionReport' || type === 'ExtendedClassBPositionReport') {
    if (body.Valid === false) return null
    const fix = position(body.Latitude ?? meta.latitude ?? meta.Latitude, body.Longitude ?? meta.longitude ?? meta.Longitude)
    if (!fix) return null
    const patch = {
      ...fix,
      sog: speed(body.Sog),
      cog: course(body.Cog),
      hdg: heading(body.TrueHeading),
      t: reportedAt(meta, now),
    }
    if (type === 'PositionReport') patch.st = num(body.NavigationalStatus)
    if (type === 'ExtendedClassBPositionReport') {
      if (num(body.Type)) patch.ty = body.Type
      if (length(body.Dimension)) patch.len = length(body.Dimension)
      if (text(body.Name)) patch.n = text(body.Name)
    }
    if (name && !patch.n) patch.n = name
    return { mmsi, patch }
  }

  if (type === 'ShipStaticData') {
    if (body.Valid === false) return null
    const patch = {}
    if (text(body.Name) || name) patch.n = text(body.Name) || name
    if (num(body.Type)) patch.ty = body.Type
    if (text(body.Destination)) patch.de = text(body.Destination)
    if (length(body.Dimension)) patch.len = length(body.Dimension)
    if (text(body.CallSign)) patch.cs = text(body.CallSign)
    if (num(body.ImoNumber)) patch.imo = body.ImoNumber
    return { mmsi, patch }
  }

  if (type === 'StaticDataReport') {
    const patch = {}
    const a = body.ReportA
    const b = body.ReportB
    if (a?.Valid && text(a.Name)) patch.n = text(a.Name)
    if (b?.Valid) {
      if (num(b.ShipType)) patch.ty = b.ShipType
      if (text(b.CallSign)) patch.cs = text(b.CallSign)
      if (length(b.Dimension)) patch.len = length(b.Dimension)
    }
    if (!patch.n && name) patch.n = name
    return Object.keys(patch).length ? { mmsi, patch } : null
  }

  return null
}

/** Whether a market's box, [west, south, east, north], holds a point. */
const inside = (box, la, lo) => lo >= box[0] && lo <= box[2] && la >= box[1] && la <= box[3]

/** The stream wants each box as two [lat, lng] corners. */
const streamBox = (box) => [
  [box[1], box[0]],
  [box[3], box[2]],
]

export { marketBox, REACH }

/**
 * The shared connection and what it has heard.
 *
 * `connect()` returns an open WebSocket-like object (send, close,
 * addEventListener); `key` is the stream's API key. Everything else is
 * state, advanced by `watch` when a viewer asks and by `sweep` on a timer.
 */
export class VesselHub {
  constructor({ key, connect, now = () => Date.now(), later = (fn, ms) => setTimeout(fn, ms) }) {
    this.key = key || null
    this.connect = connect
    this.now = now
    this.later = later
    this.watches = new Map()
    this.ships = new Map()
    this.socket = null
    this.state = 'idle'
    this.error = null
    this.since = null
    this.failures = 0
    this.retryAt = 0
    this.subscribed = ''
    this.subscribedAt = 0
    this.resubscribing = false
    this.opening = null
  }

  /** A viewer's poll: keep their market in the subscription and answer with its ships. */
  async watch(slug, box) {
    const now = this.now()
    this.watches.set(slug, { box, until: now + WATCH_MS })
    this.sweep(now)
    await this.ensure()
    return this.answer(slug, box)
  }

  answer(slug, box) {
    if (!this.key) {
      return { status: 'off', note: 'Live ship positions are not switched on here yet.', ships: [] }
    }
    const now = this.now()
    const ships = []
    for (const [m, ship] of this.ships) {
      if (ship.la == null || now - ship.t > FRESH_MS) continue
      if (!inside(box, ship.la, ship.lo)) continue
      const { s, ...shown } = ship
      ships.push({ m, ...shown })
    }
    const status = this.state === 'live' ? 'live' : this.state === 'error' ? 'error' : 'connecting'
    return {
      status,
      note: status === 'error' ? this.error : null,
      since: this.since,
      ships,
    }
  }

  /** The subscription the stream should hold: one box per market being watched. */
  subscription() {
    const boxes = [...this.watches.keys()].sort().map((slug) => streamBox(this.watches.get(slug).box))
    return { APIKey: this.key, BoundingBoxes: boxes, FilterMessageTypes: MESSAGE_TYPES }
  }

  async ensure() {
    if (!this.key || !this.watches.size) return
    if (this.socket) {
      this.resubscribe()
      return
    }
    if (this.opening) return this.opening
    if (this.now() < this.retryAt) return
    this.state = 'connecting'
    this.opening = this.open().finally(() => {
      this.opening = null
    })
    return this.opening
  }

  async open() {
    let socket
    try {
      socket = await this.connect()
    } catch (cause) {
      this.fail(`The ship feed could not be reached: ${cause?.message || cause}`)
      return
    }
    this.socket = socket
    this.since = this.now()
    socket.addEventListener('message', (event) => {
      // The feed sends binary frames, and Cloudflare's runtime hands a
      // binary frame over as a Blob, which has to be read before it can be
      // decoded. Decoding it as bytes instead throws, and every ship was
      // dropped that way while the layer sat on "connecting".
      const data = event.data
      if (data && typeof data !== 'string' && typeof data.text === 'function') {
        data.text().then(
          (raw) => this.receive(raw),
          () => {},
        )
      } else {
        this.receive(data)
      }
    })
    socket.addEventListener('close', (event) => {
      if (this.socket !== socket) return
      this.socket = null
      this.subscribed = ''
      // A refused key gets no message at all, only a close before the first
      // ship, so that case is named for what it most likely is.
      const early = this.state !== 'live'
      const reason = event?.reason ? `: ${event.reason}` : ''
      // A close we asked for is not a failure; anything else is.
      if (this.watches.size) {
        this.fail(
          this.error ||
            (early
              ? `The ship feed closed the connection before sending anything${reason}. The key may be wrong, or the feed busy.`
              : `The ship feed closed the connection${reason}.`),
        )
      } else {
        this.state = 'idle'
      }
    })
    socket.addEventListener('error', () => {
      if (this.socket !== socket) return
      this.error = this.error || 'The ship feed connection failed.'
    })
    // The stream closes a connection that has not subscribed within three
    // seconds, so the subscription goes at once.
    this.send()
  }

  send() {
    const subscription = this.subscription()
    const shape = JSON.stringify(subscription.BoundingBoxes)
    try {
      this.socket.send(JSON.stringify(subscription))
      this.subscribed = shape
      this.subscribedAt = this.now()
    } catch (cause) {
      this.fail(`The ship feed would not take the subscription: ${cause?.message || cause}`)
    }
  }

  /** A changed set of markets, sent no faster than the stream's once a second. */
  resubscribe() {
    if (!this.socket) return
    if (JSON.stringify(this.subscription().BoundingBoxes) === this.subscribed) return
    const wait = this.subscribedAt + 1100 - this.now()
    if (wait <= 0) {
      this.send()
      return
    }
    if (this.resubscribing) return
    this.resubscribing = true
    this.later(() => {
      this.resubscribing = false
      this.resubscribe()
    }, wait)
  }

  fail(reason) {
    this.state = 'error'
    this.error = reason
    this.failures += 1
    // Backing off, as the stream asks: 2, 4, 8 ... seconds, at most a minute.
    this.retryAt = this.now() + Math.min(60000, 1000 * 2 ** this.failures)
    const socket = this.socket
    this.socket = null
    this.subscribed = ''
    try {
      socket?.close(1000, 'closing')
    } catch {
      /* already gone */
    }
  }

  receive(data) {
    let message
    try {
      const raw = typeof data === 'string' ? data : new TextDecoder().decode(data)
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (message?.error) {
      // A refused key or subscription is said once, and then the socket closes.
      this.error = `The ship feed refused the request: ${String(message.error).slice(0, 160)}`
      return
    }
    if (message?.MessageType === 'SubscriptionConfirmation' || this.state !== 'live') {
      this.state = 'live'
      this.error = null
      this.failures = 0
    }
    const change = readMessage(message, this.now())
    if (!change) return
    const known = this.ships.get(change.mmsi)
    if (!known && this.ships.size >= SHIP_CAP) return
    // `s` is when anything was last heard from it, so a name that arrives
    // before the first position is kept until the position comes.
    this.ships.set(change.mmsi, { ...(known ?? { t: 0 }), ...change.patch, s: this.now() })
  }

  /**
   * Forget viewers who stopped asking and ships that stopped reporting, and
   * close the stream when nobody is left. Returns whether anyone is still
   * watching, which is whether the owner should keep a timer running.
   */
  sweep(now = this.now()) {
    for (const [slug, watch] of this.watches) if (watch.until < now) this.watches.delete(slug)
    for (const [m, ship] of this.ships) if (now - Math.max(ship.t, ship.s ?? 0) > FRESH_MS) this.ships.delete(m)
    if (!this.watches.size) {
      const socket = this.socket
      this.socket = null
      this.subscribed = ''
      this.state = 'idle'
      this.since = null
      try {
        socket?.close(1000, 'nobody watching')
      } catch {
        /* already gone */
      }
      return false
    }
    this.resubscribe()
    return true
  }
}
