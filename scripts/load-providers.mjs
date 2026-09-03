#!/usr/bin/env node
/**
 * Loads the procured provider files into data/providers.db and builds the
 * per-market healthcare layer.
 *
 *   node scripts/load-providers.mjs nucc                         # newest NUCC CSV in data/sources
 *   node scripts/load-providers.mjs nppes [--states TX,FL]       # monthly, then each weekly, from the manifest
 *   node scripts/load-providers.mjs nppes --file path.zip|.csv [--replace]
 *   node scripts/load-providers.mjs geocode [--states TX] [--zips 787,786] [--limit N]
 *   node scripts/load-providers.mjs join --market austin-tx --parcels parcels.geojson [--meta meta.json]
 *   node scripts/load-providers.mjs export --market austin-tx --out ./out
 *   node scripts/load-providers.mjs status
 *
 * Every step is idempotent: a file already in the load log is skipped, a
 * geocoded address is never sent twice, and a join replaces the market's
 * previous answer. Weekly refresh is therefore the same two commands each
 * time: `procure-data.mjs --only nppes-weekly` then `load-providers.mjs nppes`.
 *
 * Nothing here needs a key. Behind an HTTPS proxy set NODE_USE_ENV_PROXY=1
 * for the geocoder call.
 */

import fs from 'node:fs'
import path from 'node:path'
import { createReadStream } from 'node:fs'
import {
  alreadyLoaded,
  defaultDbPath,
  exportLayer,
  geocodeProviders,
  joinParcels,
  loadNppes,
  loadNucc,
  openNppesSource,
  openProviders,
  status,
} from './lib/providers.mjs'

function parseArgs(argv) {
  const [command, ...rest] = argv
  const options = {}
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = rest[i + 1]
    if (next == null || next.startsWith('--')) options[key] = true
    else {
      options[key] = next
      i += 1
    }
  }
  return { command, options }
}

const list = (value) => (typeof value === 'string' ? value.split(',').map((s) => s.trim()).filter(Boolean) : null)

function readManifest(sourcesDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(sourcesDir, 'manifest.json'), 'utf8'))
  } catch {
    return { entries: [] }
  }
}

/** Weekly files sort by their date span; the manifest's version is MMDDYY_MMDDYY. */
function weeklyOrder(version) {
  const [from] = String(version ?? '').split('_')
  return from.length === 6 ? `20${from.slice(4)}${from.slice(0, 2)}${from.slice(2, 4)}` : ''
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2))
  const cwd = process.cwd()
  const sourcesDir = path.resolve(options.sources ?? path.join(cwd, 'data', 'sources'))
  const dbPath = path.resolve(options.db ?? defaultDbPath(cwd))
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = openProviders(dbPath)
  const manifest = readManifest(sourcesDir)
  const entries = manifest.entries ?? []

  if (command === 'nucc') {
    const entry = entries.filter((e) => e.source === 'nucc').sort((a, b) => (a.fetchedAt < b.fetchedAt ? 1 : -1))[0]
    const file = options.file ? path.resolve(options.file) : entry ? path.join(sourcesDir, 'nucc', entry.file) : null
    if (!file || !fs.existsSync(file)) throw new Error('No NUCC CSV found. Run scripts/procure-data.mjs --only nucc first, or pass --file.')
    const result = await loadNucc(db, createReadStream(file), {
      file: path.basename(file),
      version: options.version ?? entry?.version ?? null,
      license: entry?.license ?? 'NUCC Health Care Provider Taxonomy Code Set; commercial redistribution needs a NUCC licence.',
    })
    console.log(`nucc: ${result.rows} taxonomy codes from ${path.basename(file)}`)
    return
  }

  if (command === 'nppes') {
    const states = list(options.states)
    const progress = ({ rows, stored, deactivated }) => console.log(`  … ${rows} rows read, ${stored} stored, ${deactivated} deactivated`)
    const files = []
    if (options.file) {
      files.push({ file: path.resolve(options.file), replace: Boolean(options.replace) })
    } else {
      const monthly = entries.filter((e) => e.source === 'nppes-monthly').sort((a, b) => (a.fetchedAt < b.fetchedAt ? 1 : -1))[0]
      if (monthly) files.push({ file: path.join(sourcesDir, 'nppes-monthly', monthly.file), replace: true })
      const weeklies = entries
        .filter((e) => e.source === 'nppes-weekly')
        .sort((a, b) => weeklyOrder(a.version).localeCompare(weeklyOrder(b.version)))
      for (const weekly of weeklies) files.push({ file: path.join(sourcesDir, 'nppes-weekly', weekly.file), replace: false })
    }
    if (files.length === 0) throw new Error('No NPPES files found. Run scripts/procure-data.mjs first, or pass --file.')
    for (const { file, replace } of files) {
      const name = path.basename(file)
      if (!fs.existsSync(file)) {
        console.log(`skip ${name}: not on disk`)
        continue
      }
      if (alreadyLoaded(db, name) && !options.force) {
        console.log(`skip ${name}: already loaded`)
        continue
      }
      console.log(`${replace ? 'replace with' : 'apply'} ${name}${states ? ` (states ${states.join(', ')})` : ''}`)
      const result = await loadNppes(db, openNppesSource(file), { file: name, replace, states, onProgress: progress })
      console.log(`  ${result.rows} rows: ${result.stored} stored, ${result.deactivated} deactivated, ${result.skipped} outside the state filter`)
    }
    return
  }

  if (command === 'geocode') {
    const result = await geocodeProviders(db, {
      states: list(options.states),
      zips: list(options.zips),
      limit: options.limit ? Number(options.limit) : null,
      batch: options.batch ? Number(options.batch) : 5000,
      onProgress: ({ sent, total, matched }) => console.log(`  … ${sent}/${total} addresses sent, ${matched} matched`),
    })
    console.log(`geocode: ${result.addresses} addresses needed a point, ${result.sent} sent, ${result.matched} matched`)
    return
  }

  if (command === 'join') {
    if (!options.market || !options.parcels) throw new Error('join needs --market <slug> and --parcels <parcels.geojson>')
    const collection = JSON.parse(fs.readFileSync(path.resolve(options.parcels), 'utf8'))
    const meta = options.meta ? JSON.parse(fs.readFileSync(path.resolve(options.meta), 'utf8')) : null
    const result = joinParcels(db, options.market, collection.features ?? [], { idKey: meta?.idKey ?? null })
    console.log(
      `join ${options.market}: ${result.parcels} parcels, ${result.points} practice points in the envelope, ` +
        `${result.matched} in a parcel, ${result.unmatched} unmatched`,
    )
    return
  }

  if (command === 'export') {
    if (!options.market) throw new Error('export needs --market <slug>')
    const out = path.resolve(options.out ?? path.join(cwd, 'data', 'layers', options.market))
    fs.mkdirSync(out, { recursive: true })
    const { collection, entry } = exportLayer(db, options.market)
    fs.writeFileSync(path.join(out, entry.file), JSON.stringify(collection))
    fs.writeFileSync(path.join(out, 'healthcare-layer.json'), JSON.stringify(entry, null, 2) + '\n')
    console.log(`export ${options.market}: ${entry.count} features → ${path.join(out, entry.file)}`)
    console.log(`  catalog entry → ${path.join(out, 'healthcare-layer.json')} (merge into the market's layers.json)`)
    return
  }

  if (command === 'status' || !command) {
    console.log(JSON.stringify(status(db), null, 2))
    return
  }

  throw new Error(`unknown command "${command}"`)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
