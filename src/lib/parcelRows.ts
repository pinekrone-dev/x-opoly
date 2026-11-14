/*
 * One parcel's record, read without the county.
 *
 * A market outside the search store used to answer a click from two files
 * downloaded whole: index.json when it opened and details.json on the first
 * click, a third of a gigabyte together for a county of a million parcels.
 * The pipeline now also publishes the same records packed: sorted into
 * shards of a few hundred parcels by a hash of the parcel id, each gzipped,
 * laid end to end in rows.pack, with rows.json saying where each starts
 * (prospector's make_rows.py). A click reads its one shard by byte range,
 * twenty-odd kilobytes, the way the map reads its tiles.
 *
 * A market published before the pack existed has no rows.json; `readManifest`
 * says so with null and the map falls back to the whole files.
 */

export interface RowsManifest {
  v: number
  n: number
  shards: number
  /** shards + 1 byte offsets into rows.pack. */
  offsets: number[]
  /** The pack's stamp, sent with every read so one build's ranges are never read against another's. */
  built: number
  /** Six value breaks at the sevenths of the valued parcels. */
  breaks?: number[]
}

export type ParcelRecord = Record<string, unknown>

/** The shard a parcel id is in: h = h * 31 + character code, in 32 bits. The pipeline computes the same. */
export function shardOf(id: string | number, shards: number): number {
  const text = String(id)
  let h = 0
  for (let i = 0; i < text.length; i += 1) h = (Math.imul(h, 31) + text.charCodeAt(i)) >>> 0
  return h % shards
}

/** What a manifest must be to be read from: a wrong one is treated as none. */
export function validManifest(value: unknown): RowsManifest | null {
  const m = value as RowsManifest | null
  if (!m || typeof m !== 'object') return null
  if (!Number.isInteger(m.shards) || m.shards < 1 || !Array.isArray(m.offsets) || m.offsets.length !== m.shards + 1) return null
  for (let i = 1; i < m.offsets.length; i += 1) {
    if (!Number.isInteger(m.offsets[i]) || m.offsets[i] < m.offsets[i - 1]) return null
  }
  return m
}

export async function readManifest(catalog: string, market: string, fetcher: typeof fetch = fetch): Promise<RowsManifest | null> {
  try {
    const res = await fetcher(`${catalog}/${market}/rows.json`)
    if (!res.ok) return null
    return validManifest(await res.json())
  } catch {
    return null
  }
}

async function gunzip(bytes: ArrayBuffer): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).text()
}

/*
 * Shards already read, by market, build and shard. A lot and its neighbours
 * are in different shards (the hash scatters them), so this is mostly for
 * going back to a parcel, and it is small: forty shards is about a megabyte.
 */
const held = new Map<string, Promise<Record<string, ParcelRecord>>>()
const HELD = 40

export function readShard(
  catalog: string,
  market: string,
  manifest: RowsManifest,
  shard: number,
  fetcher: typeof fetch = fetch,
  inflate: (bytes: ArrayBuffer) => Promise<string> = gunzip,
): Promise<Record<string, ParcelRecord>> {
  const key = `${market}:${manifest.built}:${shard}`
  const known = held.get(key)
  if (known) return known
  const from = manifest.offsets[shard]
  const to = manifest.offsets[shard + 1] - 1
  const asked = (async () => {
    if (to < from) return {}
    const res = await fetcher(`${catalog}/${market}/rows.pack?v=${manifest.built}`, { headers: { range: `bytes=${from}-${to}` } })
    // A server that ignored the range would hand back the whole pack.
    if (res.status !== 206) throw new Error(`rows.pack answered ${res.status}`)
    return JSON.parse(await inflate(await res.arrayBuffer())) as Record<string, ParcelRecord>
  })()
  held.set(key, asked)
  // A failed read is not kept: the next click asks again.
  asked.catch(() => held.delete(key))
  if (held.size > HELD) held.delete(held.keys().next().value as string)
  return asked
}

/** One parcel's whole record (its index row, its box under `bb`, its details), or null when the pack has no such parcel. */
export async function readRow(
  catalog: string,
  market: string,
  manifest: RowsManifest,
  id: string | number,
  fetcher: typeof fetch = fetch,
  inflate?: (bytes: ArrayBuffer) => Promise<string>,
): Promise<ParcelRecord | null> {
  const shard = await readShard(catalog, market, manifest, shardOf(id, manifest.shards), fetcher, inflate)
  return shard[String(id)] ?? null
}
