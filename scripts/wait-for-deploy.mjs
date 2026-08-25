// Waits until the deployed site is serving *this commit's* build.
//
//   node scripts/wait-for-deploy.mjs https://survey.example.com
//
// The obvious check — poll /api/health until it returns 200 — is worthless
// here, because the previous deployment also returns 200. It exits instantly
// against stale code, which produces two bad outcomes: checks for new
// endpoints fail as 404s, and, far worse, everything else passes and reports
// the old build as verified.
//
// Vite's asset hashes are content-derived, so the same commit always produces
// the same bundle filename. Building locally and waiting for the live page to
// serve that exact filename is therefore a precise "is my code live yet?".
//
// Failure direction matters: if the hashes could ever diverge, this times out
// and fails loudly rather than passing against something unverified.

import fs from 'node:fs'

const BASE = (process.argv[2] || process.env.SMOKE_URL || '').replace(/\/$/, '')
if (!BASE) {
  console.error('Usage: node scripts/wait-for-deploy.mjs <base-url>')
  process.exit(2)
}

const TIMEOUT_MS = Number(process.env.DEPLOY_WAIT_MS || 8 * 60 * 1000)
const INTERVAL_MS = 5000

/** The hashed main bundle Vite emitted, e.g. "index-B-bp-im6.js". */
function mainBundle(html) {
  const match = html.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/)
  return match ? match[1] : null
}

const local = mainBundle(fs.readFileSync('dist/index.html', 'utf8'))
if (!local) {
  console.error('Could not find the main bundle in dist/index.html — was the build run?')
  process.exit(2)
}

console.log(`Waiting for ${BASE} to serve ${local}`)

/**
 * The bundle hash cannot see a backend-only change: fix a server module and
 * the frontend build is byte-identical, so the hash matches the moment the
 * run starts and the smoke test races the rollout it thinks it waited for.
 *
 * /api/health reports the commit it was built from, which does move. This is
 * a warning rather than a failure: the stamp only lands if the Cloudflare
 * build runs `npm run build`, and turning a missing stamp into a red run
 * would block every push on a detail that has nothing to do with the code.
 */
async function waitForCommit() {
  const expected = process.env.GITHUB_SHA
  if (!expected) return

  const deadline = Date.now() + Number(process.env.COMMIT_WAIT_MS || 3 * 60 * 1000)
  const UNSTAMPED_GRACE_MS = 90 * 1000
  let seen = null
  let unstampedSince = null

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/health?deploy-check=${Date.now()}`, {
        headers: { 'cache-control': 'no-cache' },
      })
      const body = await response.json()
      if (body?.commit === expected) {
        console.log(`Backend is running ${expected.slice(0, 7)}`)
        return
      }
      if (body?.commit !== seen) {
        seen = body?.commit ?? null
        console.log(`  backend reports ${seen ?? 'no commit'}, waiting for ${expected.slice(0, 7)}…`)
      }
      // An unstamped build is either the one that predates this check or a
      // deployment whose build never runs the stamp. Give it a short grace
      // period — long enough for a rollout, short enough not to stall every
      // push — then say so and carry on.
      if (seen === 'dev' || seen == null) {
        if (unstampedSince == null) unstampedSince = Date.now()
        if (Date.now() - unstampedSince > UNSTAMPED_GRACE_MS) {
          console.log(
            '  this deployment does not stamp its commit, so the backend rollout cannot be ' +
              'confirmed from here. Continuing on the bundle hash alone.',
          )
          return
        }
      } else {
        unstampedSince = null
      }
    } catch (error) {
      console.log(`  health not reachable yet (${error.message})`)
    }
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS))
  }

  console.log(
    `  gave up waiting for the backend to report ${expected.slice(0, 7)}; ` +
      'the checks below may be testing the previous deployment.',
  )
}

const startedAt = Date.now()
let lastSeen = null

while (Date.now() - startedAt < TIMEOUT_MS) {
  try {
    // Cache-bust: an edge-cached index.html would otherwise hide the rollout.
    const response = await fetch(`${BASE}/?deploy-check=${Date.now()}`, {
      headers: { 'cache-control': 'no-cache' },
    })
    const live = mainBundle(await response.text())

    if (live === local) {
      const seconds = Math.round((Date.now() - startedAt) / 1000)
      console.log(`Live after ${seconds}s — serving ${live}`)
      await waitForCommit()
      process.exit(0)
    }

    if (live !== lastSeen) {
      lastSeen = live
      console.log(`  still serving ${live ?? 'no bundle'}…`)
    }
  } catch (error) {
    console.log(`  not reachable yet (${error.message})`)
  }

  await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS))
}

console.error(
  `\nTimed out after ${Math.round(TIMEOUT_MS / 1000)}s.\n` +
    `Expected ${local}, last saw ${lastSeen ?? 'nothing'}.\n` +
    'The deploy either has not finished or is not building this commit.',
)
process.exit(1)
