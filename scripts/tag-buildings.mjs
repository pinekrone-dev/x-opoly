/**
 * Tag every parcel in the markets given with what stands on it, from
 * Overture Maps' building footprints.
 *
 *   node scripts/tag-buildings.mjs <slug> [slug...]
 *
 * Runs in GitHub Actions (.github/workflows/tag-parcels.yml), not on the
 * Worker, and that is the whole design. The parcel store is not in map order,
 * so a batch of parcels taken from it touches as many building tiles as it
 * has parcels, and a county would pull its building tiles thousands of times
 * over from Overture's public CDN. Here the market's parcel boxes are read
 * once, grouped by the building tile under them, and walked tile by tile in
 * map order, so each tile is fetched and decoded once. Only the answers go
 * to the store, and the store writes only the parcels whose answer changed.
 *
 * Auth is the run's own OIDC token, as for every ingest call. The footprints
 * are ODbL (OpenStreetMap contributors, Overture Maps Foundation); this
 * script is the method by which the tags are made, published with the app.
 */

import { PMTiles, FetchSource } from 'pmtiles'
import { BUILDING_ZOOM, OVERTURE_BUILDINGS_URL, buildingsFor } from '../src/lib/buildings.ts'
import { decodeTile } from '../src/lib/tileDecode.ts'

const BASE = process.env.LQ_BASE || 'https://landquotient.com'
const AUDIENCE = 'landquotient-ingest'
const AGENT = 'LandQuotient-Tagger/1.0 (+https://landquotient.com)'
const FLUSH = 5000
const TILE_CACHE = 600

let token = null
let mintedAt = 0

async function mint() {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL
  const bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  if (!url || !bearer) throw new Error('no OIDC issuer here: this runs inside GitHub Actions')
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const answer = await fetch(`${url}&audience=${AUDIENCE}`, { headers: { authorization: `bearer ${bearer}`, 'user-agent': AGENT } })
      const value = (await answer.json())?.value
      if (value) {
        token = value
        mintedAt = Date.now()
        return value
      }
    } catch (error) {
      console.error(`  could not mint a token (attempt ${attempt}): ${error.message}`)
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 4000))
  }
  throw new Error('GitHub would not issue an OIDC token')
}

async function post(path, body, what) {
  if (!token || Date.now() - mintedAt > 4 * 60 * 1000) await mint()
  for (let attempt = 1; attempt <= 5; attempt++) {
    const answer = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': AGENT },
      body: JSON.stringify(body),
    }).catch((error) => ({ ok: false, status: 0, text: async () => error.message }))
    if (answer.ok) return answer.json()
    const detail = (await answer.text()).slice(0, 300)
    if (answer.status === 401 && attempt < 5) {
      await mint()
      continue
    }
    if ([0, 429, 500, 502, 503, 504].includes(answer.status) && attempt < 5) {
      console.error(`  ${what}: HTTP ${answer.status}, retrying`)
      await new Promise((resolve) => setTimeout(resolve, attempt * 5000))
      continue
    }
    throw new Error(`${what} -> HTTP ${answer.status}: ${detail}`)
  }
  throw new Error(`${what} failed after retries`)
}

/** A tile reader over the Overture archive, keeping the most recent tiles decoded. */
function reader() {
  const archive = new PMTiles(new FetchSource(OVERTURE_BUILDINGS_URL))
  const cache = new Map()
  let fetched = 0
  const read = (z, x, y) => {
    const key = `${z}/${x}/${y}`
    const held = cache.get(key)
    if (held) {
      cache.delete(key)
      cache.set(key, held)
      return held
    }
    const pending = archive
      .getZxy(z, x, y)
      .then((tile) => {
        fetched += 1
        return decodeTile(tile?.data, 'building')
      })
      .catch(() => {
        cache.delete(key)
        return null
      })
    cache.set(key, pending)
    if (cache.size > TILE_CACHE) cache.delete(cache.keys().next().value)
    return pending
  }
  return { read, fetched: () => fetched }
}

function tileOf(lng, lat, z) {
  const n = 2 ** z
  const rad = (lat * Math.PI) / 180
  return [Math.floor(((lng + 180) / 360) * n), Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n)]
}

async function tagMarket(slug) {
  const started = Date.now()
  // Every parcel box, once.
  const boxes = []
  let after = 0
  for (;;) {
    const page = await post(`/api/gis/ingest/parcels?market=${slug}&action=boxes&after=${after}`, {}, `${slug} boxes`)
    boxes.push(...page.boxes.filter((b) => b.slice(1).every(Number.isFinite)))
    if (page.cursor == null) break
    after = page.cursor
  }
  if (!boxes.length) {
    console.log(`  ${slug}: no parcels in the store; skipped`)
    return
  }
  // Grouped by the building tile under each box's centre, walked column by
  // column in alternating direction so a tile's neighbours are still cached.
  const groups = new Map()
  for (const box of boxes) {
    const [x, y] = tileOf((box[1] + box[3]) / 2, (box[2] + box[4]) / 2, BUILDING_ZOOM)
    const key = `${x}/${y}`
    const list = groups.get(key)
    if (list) list.push(box)
    else groups.set(key, [box])
  }
  const keys = [...groups.keys()].map((k) => k.split('/').map(Number))
  keys.sort((a, b) => a[0] - b[0] || (a[0] % 2 ? b[1] - a[1] : a[1] - b[1]))

  const tiles = reader()
  let pending = []
  let tagged = 0
  let built = 0
  let unread = 0
  // Sent FLUSH rows at a time, the most one request takes; a group of tiles
  // can carry the pile past it before the next check.
  const flush = async (done = false) => {
    while (pending.length > FLUSH || (pending.length && !done)) {
      await post(`/api/gis/ingest/parcels?market=${slug}&action=building-tags`, pending.slice(0, FLUSH), `${slug} tags`)
      pending = pending.slice(FLUSH)
    }
    if (done) await post(`/api/gis/ingest/parcels?market=${slug}&action=building-tags&done=1`, pending, `${slug} tags`)
    pending = []
  }
  // A few tile groups at a time: their tiles are read together, eight in flight.
  for (let i = 0; i < keys.length; i += 8) {
    const chunk = keys.slice(i, i + 8).flatMap(([x, y]) => groups.get(`${x}/${y}`))
    const answers = await buildingsFor(chunk.map((b) => [b[1], b[2], b[3], b[4]]), tiles.read)
    answers.forEach((answer, j) => {
      if (!answer) {
        unread += 1
        return
      }
      pending.push([chunk[j][0], answer.count, answer.area, answer.tallest])
      tagged += 1
      if (answer.count) built += 1
    })
    if (pending.length >= FLUSH) {
      await flush()
      console.log(`  ${slug}: ${tagged.toLocaleString()} of ${boxes.length.toLocaleString()} tagged, ${tiles.fetched().toLocaleString()} tiles read`)
    }
  }
  await flush(true)
  const minutes = ((Date.now() - started) / 60000).toFixed(1)
  console.log(
    `  ${slug}: ${boxes.length.toLocaleString()} parcels, ${tagged.toLocaleString()} tagged (${built.toLocaleString()} with a building), ` +
      `${unread.toLocaleString()} unread, ${tiles.fetched().toLocaleString()} building tiles read, ${minutes} min`,
  )
}

/**
 * Zoning and flood, which the Worker works out itself a stretch at a time
 * (its own archives are in its bucket): this only walks it to the end.
 */
async function tagZoning(slug, reset) {
  let checked = 0
  let changed = 0
  let first = true
  for (;;) {
    const answer = await post(
      `/api/gis/ingest/parcels?market=${slug}&action=tag&rows=2000${reset && first ? '&reset=1' : ''}`,
      {},
      `${slug} zoning`,
    )
    first = false
    if (answer.missing || answer.nothing) {
      console.log(`  ${slug}: ${answer.missing ? 'not in the store' : 'no zoning or flood layer'}; zoning skipped`)
      return
    }
    checked += Number(answer.checked) || 0
    changed += Number(answer.changed) || 0
    if (checked && checked % 50000 < 2000) console.log(`  ${slug}: zoning and flood, ${checked.toLocaleString()} checked`)
    if (answer.done) {
      console.log(`  ${slug}: zoning and flood ${answer.already ? 'already tagged' : `tagged, ${checked.toLocaleString()} checked, ${changed.toLocaleString()} written`}`)
      return
    }
  }
}

const args = process.argv.slice(2)
const what = new Set((args.find((a) => a.startsWith('--what='))?.slice(7) || 'buildings').split(','))
const reset = args.includes('--reset')
const slugs = args.filter((s) => /^[a-z0-9-]{2,40}$/.test(s))
if (!slugs.length) {
  console.error('usage: node scripts/tag-buildings.mjs [--what=zoning,buildings] [--reset] <slug> [slug...]')
  process.exit(2)
}
for (const slug of slugs) {
  try {
    if (what.has('zoning')) await tagZoning(slug, reset)
    if (what.has('buildings')) await tagMarket(slug)
  } catch (error) {
    console.error(`  ${slug}: FAILED ${error.message}`)
    process.exitCode = 1
  }
}
