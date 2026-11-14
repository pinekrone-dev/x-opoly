/**
 * The Library's package download: a ZIP written by hand, read back by the
 * system's own unzip to prove it is one.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { zip } from '../src/lib/zip.ts'

test('an archive made here lists and extracts with unzip, bytes intact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lqzip-'))
  const png = Uint8Array.from({ length: 5000 }, (_, i) => (i * 37) % 256)
  const csv = new TextEncoder().encode('Measure,1 mile\nPopulation,1200\n')
  const file = path.join(dir, 'package.zip')
  fs.writeFileSync(file, zip([{ name: 'maps/parcel-map.png', data: png }, { name: 'data/demographics.csv', data: csv }]))
  const listing = execFileSync('unzip', ['-l', file]).toString()
  assert.match(listing, /maps\/parcel-map\.png/)
  assert.match(listing, /data\/demographics\.csv/)
  assert.doesNotThrow(() => execFileSync('unzip', ['-tq', file]))
  execFileSync('unzip', ['-q', file, '-d', dir])
  assert.deepEqual([...fs.readFileSync(path.join(dir, 'maps/parcel-map.png'))], [...png])
  assert.equal(fs.readFileSync(path.join(dir, 'data/demographics.csv'), 'utf8'), 'Measure,1 mile\nPopulation,1200\n')
  fs.rmSync(dir, { recursive: true, force: true })
})
