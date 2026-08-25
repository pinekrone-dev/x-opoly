// Stamps the current commit into app/lib/build-info.js before a build.
//
// Backend-only changes leave the frontend bundle hash untouched, so waiting
// for that hash cannot tell "the new Worker is live" from "the old one is
// still serving". A commit reported by /api/health can.
//
// Only writes when a CI system supplies the SHA — Workers Builds injects
// WORKERS_CI_COMMIT_SHA, GitHub Actions sets GITHUB_SHA. Running the build
// locally leaves the file as committed, so `git status` stays clean.

import fs from 'node:fs'

const sha = process.env.WORKERS_CI_COMMIT_SHA || process.env.GITHUB_SHA || ''
if (!sha) {
  console.log('build-info: no CI commit in the environment, leaving the stamp alone')
  process.exit(0)
}

const target = new URL('../app/lib/build-info.js', import.meta.url)
const source = fs.readFileSync(target, 'utf8')
const stamped = source.replace(
  /export const BUILD_COMMIT = '[^']*'/,
  `export const BUILD_COMMIT = '${sha.replace(/[^0-9a-f]/gi, '').slice(0, 40)}'`,
)
if (stamped === source) {
  console.error('build-info: could not find the stamp to replace')
  process.exit(1)
}
fs.writeFileSync(target, stamped)
console.log(`build-info: stamped ${sha.slice(0, 7)}`)
