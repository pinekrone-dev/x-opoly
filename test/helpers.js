import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Points the app at a throwaway data directory for each test file. */
export function useTempData() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sitesurvey-'))
  process.env.DATA_DIR = directory
  process.env.DB_FILE = path.join(directory, 'test.db')
  return {
    directory,
    cleanup() {
      fs.rmSync(directory, { recursive: true, force: true })
    },
  }
}
