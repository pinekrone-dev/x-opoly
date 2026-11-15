/*
 * A market's search index, read a shard at a time.
 *
 * A market outside the search store used to answer "123 Main St" by
 * downloading index.json whole (56 MB for Northwest Jersey) and looking
 * through it in the browser; the connector could not search such a market at
 * all. The pipeline now publishes what people type (the address, the owner's
 * name, the parcel number) as one sorted list of keys in gzipped shards,
 * search.pack, with search.json holding where each shard starts and the least
 * key that tells it from the one before (prospector's make_search.py).
 *
 * A search finds its shard in that list and reads it by byte range: a few
 * kilobytes. The same few lines run in the browser and in the Worker, and
 * nothing is looked up in the database.
 *
 * A market published before the index existed has no search.json;
 * `readSearchManifest` says so with null and the caller falls back.
 */

export interface SearchManifest {
  v: number
  n: number
  shards: number
  /** shards + 1 byte offsets into search.pack. */
  offsets: number[]
  /** Per shard, the shortest start of its first key that sorts after the shard before. */
  keys: string[]
  /** The pack's stamp, sent with every read so one build's ranges are never read against another's. */
  built: number
}

/** [key, id, kind, label?, under?] as the pipeline writes it. */
type Entry = [string, number | string, string, string?, string?]

export interface SearchHit {
  id: number | string
  /** 'address', 'owner' or 'number': what the typed text matched. */
  kind: 'address' | 'owner' | 'number'
  /** The matched text as the county writes it. */
  label: string
  /** The address, under an owner or a parcel number. */
  under: string
}

/** Upper case letters and digits, single-spaced: how a key and a search are both written. The pipeline computes the same. */
export function keyOf(text: string): string {
  return String(text ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()
}

const title = (words: string[]) => words.map((w) => w.slice(0, 1) + w.slice(1).toLowerCase()).join(' ')

/** What an entry shows: the text read back out of its key unless the pipeline kept it as written. */
export function hitOf(entry: Entry): SearchHit {
  const [key, id, kindCode, label, under] = entry
  const kind = kindCode[0] === 'o' ? 'owner' : kindCode[0] === 'p' ? 'number' : 'address'
  if (label) return { id, kind, label, under: under ?? '' }
  // The key is the text with `moved` words taken from the front to the back.
  const moved = Number(kindCode.slice(1)) || 0
  const words = key.split(' ')
  const text = moved ? [...words.slice(words.length - moved), ...words.slice(0, words.length - moved)] : words
  return { id, kind, label: title(text), under: under ?? '' }
}

/** What a manifest must be to be read from: a wrong one is treated as none. */
export function validSearchManifest(value: unknown): SearchManifest | null {
  const m = value as SearchManifest | null
  if (!m || typeof m !== 'object') return null
  if (!Number.isInteger(m.shards) || m.shards < 1) return null
  if (!Array.isArray(m.offsets) || m.offsets.length !== m.shards + 1) return null
  if (!Array.isArray(m.keys) || m.keys.length !== m.shards) return null
  for (let i = 1; i < m.offsets.length; i += 1) {
    if (!Number.isInteger(m.offsets[i]) || m.offsets[i] < m.offsets[i - 1]) return null
  }
  return m
}

export async function readSearchManifest(catalog: string, market: string, fetcher: typeof fetch = fetch): Promise<SearchManifest | null> {
  try {
    const res = await fetcher(`${catalog}/${market}/search.json`)
    if (!res.ok) return null
    return validSearchManifest(await res.json())
  } catch {
    return null
  }
}

async function gunzip(bytes: ArrayBuffer): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).text()
}

/** The shard a search starts in: the last whose least key sorts before the text. */
export function firstShard(manifest: SearchManifest, q: string): number {
  let lo = 0
  let hi = manifest.shards - 1
  let found = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (manifest.keys[mid] < q) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

// Shards already read, by market, build and shard: typing one more letter
// almost always lands in the shard the last letter read.
const held = new Map<string, Promise<Entry[]>>()
const HELD = 60

function readShard(
  catalog: string,
  market: string,
  manifest: SearchManifest,
  shard: number,
  fetcher: typeof fetch,
  inflate: (bytes: ArrayBuffer) => Promise<string>,
): Promise<Entry[]> {
  const key = `${market}:${manifest.built}:${shard}`
  const known = held.get(key)
  if (known) return known
  const from = manifest.offsets[shard]
  const to = manifest.offsets[shard + 1] - 1
  const asked = (async () => {
    if (to < from) return []
    const res = await fetcher(`${catalog}/${market}/search.pack?v=${manifest.built}`, { headers: { range: `bytes=${from}-${to}` } })
    // A server that ignored the range would hand back the whole pack.
    if (res.status !== 206) throw new Error(`search.pack answered ${res.status}`)
    return JSON.parse(await inflate(await res.arrayBuffer())) as Entry[]
  })()
  held.set(key, asked)
  asked.catch(() => held.delete(key))
  if (held.size > HELD) held.delete(held.keys().next().value as string)
  return asked
}

/**
 * The parcels whose address, owner or parcel number starts with the text, at
 * most `limit`, one per parcel. A parcel number is also tried with its
 * punctuation run together, as the index holds it. Reads one shard for most
 * searches and never more than `reach` in a row for one spelling.
 */
export async function searchPack(
  catalog: string,
  market: string,
  manifest: SearchManifest,
  text: string,
  limit = 8,
  fetcher: typeof fetch = fetch,
  inflate: (bytes: ArrayBuffer) => Promise<string> = gunzip,
  reach = 3,
): Promise<SearchHit[]> {
  const spaced = keyOf(text)
  if (!spaced) return []
  const spellings = spaced.includes(' ') && /\d/.test(spaced) ? [spaced, spaced.replace(/ /g, '')] : [spaced]
  const found: SearchHit[] = []
  const seen = new Set<string>()
  for (const q of spellings) {
    let shard = firstShard(manifest, q)
    for (let read = 0; read < reach && shard < manifest.shards && found.length < limit; read += 1, shard += 1) {
      const entries = await readShard(catalog, market, manifest, shard, fetcher, inflate)
      let past = false
      for (const entry of entries) {
        if (entry[0].startsWith(q)) {
          const id = String(entry[1])
          if (!seen.has(id) && found.length < limit) {
            seen.add(id)
            found.push(hitOf(entry))
          }
        } else if (entry[0] > q) {
          past = true
          break
        }
      }
      if (past) break
    }
  }
  return found
}
