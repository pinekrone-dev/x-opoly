#!/usr/bin/env node
/**
 * Procure the official public bulk files this project stores itself.
 *
 *   node scripts/procure-data.mjs                 # everything (monthly NPPES is ~1.1 GB)
 *   node scripts/procure-data.mjs --only nucc,nppes-weekly,nppes-deactivation
 *   node scripts/procure-data.mjs --dry-run       # resolve current file names, download nothing
 *   node scripts/procure-data.mjs --dir /mnt/data # somewhere other than ./data/sources
 *
 * What it fetches, and from where:
 *
 *   nppes-monthly        CMS NPPES Data Dissemination, full replacement (V.2)
 *   nppes-weekly         CMS NPPES weekly incremental (V.2)
 *   nppes-deactivation   CMS NPPES deactivated NPI report
 *                        all three from https://download.cms.gov/nppes/NPI_Files.html
 *   nucc                 NUCC Health Care Provider Taxonomy Code Set, CSV
 *                        from https://www.nucc.org (the CSV page)
 *
 * Rules this script is written to keep:
 *   - Bulk files only. It never pages the NPI Registry API; that API is for
 *     lookups, and cloning the registry through it is what the bulk file is for.
 *   - File names are resolved from the official pages at run time, because
 *     CMS dates the monthly and weekly archives and NUCC numbers the CSV.
 *   - Nothing here needs a credential, and nothing is read from .env.
 *   - Every download is recorded in data/sources/manifest.json with its URL,
 *     size, SHA-256, fetch time, version, and the licence note that governs it.
 *   - Idempotent: a file already present with the same byte count is kept.
 *
 * data/ is gitignored. These files must never be committed.
 *
 * Behind an HTTPS proxy, Node's fetch needs NODE_USE_ENV_PROXY=1 (Node >= 22.21).
 */

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const NPPES_PAGE = 'https://download.cms.gov/nppes/NPI_Files.html'
const NUCC_PAGE =
  'https://www.nucc.org/index.php/code-sets-mainmenu-41/provider-taxonomy-mainmenu-40/csv-mainmenu-57'

/**
 * Licence notes are stored beside the data on purpose: the NUCC file in
 * particular is free to download but its redistribution inside a commercial
 * product needs NUCC's licence, and that has to travel with the file.
 */
const LICENSES = {
  nppes:
    'CMS NPPES Data Dissemination. Public domain US federal data released under the ' +
    'NPI Final Rule (45 CFR 162). No charge, no registration. Practice-location data is ' +
    'business data; mailing addresses may be residential and are not to be used for ' +
    'consumer marketing lists.',
  nucc:
    'NUCC Health Care Provider Taxonomy Code Set. Free to download and to use for claims ' +
    'and internal lookup. Incorporating or redistributing the code set inside a commercial ' +
    'product requires a licence from NUCC via the request form on the CSV page. Record the ' +
    'version and keep this note with any derived table.',
}

const SOURCES = {
  'nppes-monthly': {
    page: NPPES_PAGE,
    // e.g. NPPES_Data_Dissemination_August_2026.zip, optionally suffixed _V2
    pattern: /href="([^"]*NPPES_Data_Dissemination_[A-Za-z]+_\d{4}(?:_V2)?\.zip)"/i,
    license: LICENSES.nppes,
    version: (name) => name.match(/Dissemination_([A-Za-z]+_\d{4})/)?.[1] ?? null,
  },
  'nppes-weekly': {
    page: NPPES_PAGE,
    // e.g. NPPES_Data_Dissemination_082426_083026_Weekly.zip
    pattern: /href="([^"]*NPPES_Data_Dissemination_\d{6}_\d{6}_Weekly(?:_V2)?\.zip)"/i,
    license: LICENSES.nppes,
    version: (name) => name.match(/(\d{6}_\d{6})_Weekly/)?.[1] ?? null,
    // Every weekly file listed, not only the first: a month can carry five,
    // and the incremental files only make sense as a complete run.
    all: true,
  },
  'nppes-deactivation': {
    page: NPPES_PAGE,
    // e.g. NPPES_Deactivated_NPI_Report_081026.zip
    pattern: /href="([^"]*NPPES_Deactivated_NPI_Report_\d{6}\.zip)"/i,
    license: LICENSES.nppes,
    version: (name) => name.match(/Report_(\d{6})/)?.[1] ?? null,
  },
  nucc: {
    page: NUCC_PAGE,
    // e.g. /images/stories/CSV/nucc_taxonomy_261.csv  ->  version 26.1
    pattern: /href="([^"]*nucc_taxonomy_(\d+)\.csv)"/i,
    license: LICENSES.nucc,
    version: (name) => {
      const digits = name.match(/nucc_taxonomy_(\d+)\.csv/)?.[1]
      return digits ? `${digits.slice(0, -1)}.${digits.slice(-1)}` : null
    },
  },
}

function parseArgs(argv) {
  const args = { only: null, dryRun: false, dir: path.join(process.cwd(), 'data', 'sources') }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--only') args.only = argv[++i]?.split(',').map((s) => s.trim()).filter(Boolean) ?? []
    else if (arg === '--dir') args.dir = path.resolve(argv[++i] ?? args.dir)
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: procure-data.mjs [--only a,b] [--dry-run] [--dir path]')
      process.exit(0)
    } else {
      console.error(`unknown argument ${arg}`)
      process.exit(2)
    }
  }
  if (args.only) {
    const unknown = args.only.filter((name) => !(name in SOURCES))
    if (unknown.length) {
      console.error(`unknown source(s): ${unknown.join(', ')}. Known: ${Object.keys(SOURCES).join(', ')}`)
      process.exit(2)
    }
  }
  return args
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'landquotient-procure/1.0 (+bulk-file download)' } })
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`)
  return response.text()
}

/** The official pages list dated file names; read them rather than guessing. */
async function resolve(name, source, pageCache) {
  if (!pageCache.has(source.page)) pageCache.set(source.page, await fetchText(source.page))
  const html = pageCache.get(source.page)
  const hrefs = []
  const global = new RegExp(source.pattern.source, 'gi')
  for (const match of html.matchAll(global)) {
    const href = new URL(match[1], source.page).toString()
    if (!hrefs.includes(href)) hrefs.push(href)
    if (!source.all) break
  }
  if (hrefs.length === 0) throw new Error(`${name}: no matching link on ${source.page}; the page layout may have changed`)
  return hrefs.map((url) => ({ name, url, file: path.basename(new URL(url).pathname), version: source.version(path.basename(url)) }))
}

async function download(url, target) {
  const response = await fetch(url, { headers: { 'user-agent': 'landquotient-procure/1.0 (+bulk-file download)' } })
  if (!response.ok || !response.body) throw new Error(`${url} answered HTTP ${response.status}`)
  const expected = Number(response.headers.get('content-length')) || null
  const hash = createHash('sha256')
  let bytes = 0
  const partial = `${target}.part`
  await pipeline(
    Readable.fromWeb(response.body),
    async function* (chunks) {
      for await (const chunk of chunks) {
        hash.update(chunk)
        bytes += chunk.length
        yield chunk
      }
    },
    createWriteStream(partial),
  )
  if (expected != null && bytes !== expected) {
    await fs.rm(partial, { force: true })
    throw new Error(`${url}: received ${bytes} bytes, expected ${expected}`)
  }
  await fs.rename(partial, target)
  return { bytes, sha256: hash.digest('hex') }
}

async function readManifest(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return { generatedBy: 'scripts/procure-data.mjs', entries: [] }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const names = args.only ?? Object.keys(SOURCES)
  const pageCache = new Map()

  const wanted = []
  for (const name of names) {
    try {
      wanted.push(...(await resolve(name, SOURCES[name], pageCache)))
    } catch (error) {
      console.error(`SKIP ${name}: ${error.message}`)
      process.exitCode = 1
    }
  }

  if (wanted.length === 0) {
    console.error('Nothing resolved. If every source failed with a network error, this machine cannot reach the official hosts; run from one that can.')
    process.exit(1)
  }

  for (const entry of wanted) console.log(`${args.dryRun ? 'would fetch' : 'fetch'}  ${entry.name.padEnd(20)} ${entry.version ?? ''}  ${entry.url}`)
  if (args.dryRun) return

  await fs.mkdir(args.dir, { recursive: true })
  const manifestFile = path.join(args.dir, 'manifest.json')
  const manifest = await readManifest(manifestFile)

  for (const entry of wanted) {
    const dir = path.join(args.dir, entry.name)
    await fs.mkdir(dir, { recursive: true })
    const target = path.join(dir, entry.file)
    const existing = manifest.entries.find((row) => row.file === entry.file && row.source === entry.name)
    const stat = await fs.stat(target).catch(() => null)
    if (stat && existing && stat.size === existing.bytes) {
      console.log(`keep   ${entry.file} (${stat.size} bytes, already fetched ${existing.fetchedAt})`)
      continue
    }
    console.log(`get    ${entry.file}`)
    try {
      const { bytes, sha256 } = await download(entry.url, target)
      const row = {
        source: entry.name,
        file: entry.file,
        url: entry.url,
        version: entry.version,
        bytes,
        sha256,
        fetchedAt: new Date().toISOString(),
        license: SOURCES[entry.name].license,
      }
      manifest.entries = manifest.entries.filter((other) => !(other.source === row.source && other.file === row.file))
      manifest.entries.push(row)
      manifest.updatedAt = row.fetchedAt
      await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n')
      console.log(`done   ${entry.file}  ${bytes} bytes  sha256 ${sha256.slice(0, 16)}…`)
    } catch (error) {
      console.error(`FAIL   ${entry.file}: ${error.message}`)
      process.exitCode = 1
    }
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
