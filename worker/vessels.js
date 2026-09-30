/**
 * The Durable Object that owns the ship feed's one connection.
 *
 * One instance for the whole deployment, so every viewer in every data
 * centre shares a single stream, which the feed's three-connection limit
 * requires anyway. It lives only while someone is watching: the alarm checks
 * every thirty seconds, and once the last viewer has stopped asking the
 * connection is closed and the object is left to be evicted, costing nothing
 * until the layer is next switched on.
 *
 * Nothing is written to storage. What the stream said is in memory and is
 * worth nothing a few minutes later; an evicted object starts the stream
 * again on the next request.
 */

import { STREAM_URL, VesselHub } from '../app/lib/vessels.js'

const SWEEP_MS = 30 * 1000

async function connect() {
  const answer = await fetch(STREAM_URL, { headers: { Upgrade: 'websocket' } })
  const socket = answer.webSocket
  if (!socket) throw new Error(`the stream answered ${answer.status} instead of opening`)
  socket.accept()
  return socket
}

export class VesselHubObject {
  constructor(state, env) {
    this.state = state
    this.hub = new VesselHub({ key: env.AISSTREAM_API_KEY, connect })
  }

  async fetch(request) {
    const url = new URL(request.url)
    const slug = url.searchParams.get('market') ?? ''
    const box = ['w', 's', 'e', 'n'].map((k) => Number(url.searchParams.get(k)))
    if (!/^[a-z0-9-]{2,40}$/.test(slug) || !box.every(Number.isFinite)) {
      return Response.json({ error: 'market and box are required.' }, { status: 400 })
    }
    const answer = await this.hub.watch(slug, box)
    if (answer.status !== 'off' && !(await this.state.storage.getAlarm())) {
      await this.state.storage.setAlarm(Date.now() + SWEEP_MS)
    }
    return Response.json(answer)
  }

  async alarm() {
    if (this.hub.sweep()) await this.state.storage.setAlarm(Date.now() + SWEEP_MS)
  }
}
