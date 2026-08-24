/**
 * Optional JavaScript rendering.
 *
 * A plain HTTP fetch sees whatever the server sends, which for a single-page
 * app is often an empty shell with no links in it. When `playwright-core` and a
 * Chromium build are available, the crawler can run pages in a real browser
 * instead and read the DOM after scripts have run.
 *
 * Everything here degrades quietly: if the package or the browser is missing,
 * `getRenderer()` returns null with a reason and the crawl carries on over
 * plain HTTP.
 */

import fs from 'node:fs'
import path from 'node:path'

const CANDIDATE_SUBPATHS = [
  'chrome-linux/chrome',
  'chrome-linux/headless_shell',
  'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  'chrome-win/chrome.exe',
]

/** Resources that never affect the links or metadata we read. */
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font'])

let cached = null

/** Looks for a Chromium build without triggering Playwright's own download. */
export function findChromium() {
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) {
    return process.env.CHROMIUM_PATH
  }

  const root = process.env.PLAYWRIGHT_BROWSERS_PATH
  if (!root || !fs.existsSync(root)) return null

  let entries
  try {
    entries = fs.readdirSync(root).filter((entry) => entry.startsWith('chromium'))
  } catch {
    return null
  }

  // Prefer a full Chromium over the headless shell, and newer builds first.
  entries.sort((a, b) => {
    const shellPenalty = Number(a.includes('headless')) - Number(b.includes('headless'))
    return shellPenalty !== 0 ? shellPenalty : b.localeCompare(a, undefined, { numeric: true })
  })

  for (const entry of entries) {
    for (const subpath of CANDIDATE_SUBPATHS) {
      const candidate = path.join(root, entry, subpath)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  return null
}

class Renderer {
  constructor(browser) {
    this.browser = browser
  }

  /**
   * Loads `url` in a browser page and returns the rendered DOM.
   * The shape matches what the crawler gets from a plain fetch so both paths
   * can feed the same parser.
   */
  async render(url, { timeout = 15000, userAgent, waitUntil = 'domcontentloaded' } = {}) {
    const context = await this.browser.newContext({ userAgent, javaScriptEnabled: true })
    const page = await context.newPage()
    const startedAt = Date.now()

    try {
      await page.route('**/*', (route) => {
        if (BLOCKED_RESOURCE_TYPES.has(route.request().resourceType())) route.abort()
        else route.continue()
      })

      const response = await page.goto(url, { timeout, waitUntil })

      // Give late XHR-driven content a brief chance to land, but never block
      // the crawl on a page that keeps a socket open.
      await page.waitForLoadState('networkidle', { timeout: Math.min(timeout, 5000) }).catch(() => {})

      // Playwright follows redirects internally, so walk back up the request
      // chain to recover the status the crawler should actually record.
      let initialStatus = response ? response.status() : 0
      if (response) {
        let cursor = response.request()
        while (cursor.redirectedFrom()) cursor = cursor.redirectedFrom()
        if (cursor !== response.request()) {
          const firstResponse = await cursor.response().catch(() => null)
          if (firstResponse) initialStatus = firstResponse.status()
        }
      }

      return {
        status: response ? response.status() : 0,
        initialStatus,
        headers: response ? response.headers() : {},
        html: await page.content(),
        finalUrl: page.url(),
        responseMs: Date.now() - startedAt,
      }
    } finally {
      await context.close().catch(() => {})
    }
  }

  async close() {
    await this.browser.close().catch(() => {})
  }
}

/**
 * Returns `{ renderer }` when browser rendering is usable, or `{ reason }`
 * explaining why it is not. The browser is launched once and shared.
 */
export async function getRenderer() {
  if (cached) return cached

  let playwright
  try {
    playwright = await import('playwright-core')
  } catch {
    cached = { renderer: null, reason: 'playwright-core is not installed — run npm install playwright-core to enable rendering.' }
    return cached
  }

  const executablePath = findChromium()
  try {
    const browser = await playwright.chromium.launch({
      ...(executablePath ? { executablePath } : {}),
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    cached = { renderer: new Renderer(browser), reason: null }
  } catch (error) {
    cached = {
      renderer: null,
      reason: `Chromium could not be started (${error.message.split('\n')[0]}). Set CHROMIUM_PATH or PLAYWRIGHT_BROWSERS_PATH.`,
    }
  }

  return cached
}

/** Releases the shared browser. Used by tests and on shutdown. */
export async function closeRenderer() {
  if (cached?.renderer) await cached.renderer.close()
  cached = null
}
