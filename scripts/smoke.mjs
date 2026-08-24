// Post-deploy smoke test: proves the deployed app actually loads in a browser
// and that the street basemap paints, rather than inferring it from config.
//
//   node scripts/smoke.mjs https://x-opoly.example.workers.dev
//
// Exits non-zero with a readable report if anything fails. Creates a survey
// through the live API, opens it, checks the map, and deletes it again, so a
// run leaves no trace behind.

import { chromium } from 'playwright'

const BASE = (process.argv[2] || process.env.SMOKE_URL || '').replace(/\/$/, '')
if (!BASE) {
  console.error('Usage: node scripts/smoke.mjs <base-url>')
  process.exit(2)
}

const results = []
let failed = false

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (!ok) failed = true
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function api(path, init) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers || {}) },
  })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text.slice(0, 400)
  }
  return { status: response.status, body }
}

// Two real coordinates so the map has something to fit to. Downtown Dallas,
// far enough apart to force a sensible zoom level.
const PINS = [
  {
    name: 'Smoke test — Main St',
    address: '1600 Main St, Dallas, TX',
    lat: 32.7808,
    lng: -96.7972,
    brokerEmail: 'broker@example.com',
    brokerPhone: '(214) 555-0100',
    fields: [
      { label: 'Available SF', value: '9,822 SF' },
      { label: 'Lease Rate', value: '32/SF' },
    ],
  },
  {
    name: 'Smoke test — Ross Ave',
    address: '2100 Ross Ave, Dallas, TX',
    lat: 32.7889,
    lng: -96.7969,
    fields: [{ label: 'Year Built', value: '2019' }],
  },
]


/**
 * A minimal one-page PDF, inline so the test carries no binary fixture.
 * pdf.js has to actually parse and render this, so a malformed document
 * fails the run rather than passing quietly.
 */
const FLYER_PDF = Uint8Array.from(atob('JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA1IDAgUiA+PiA+PiAvQ29udGVudHMgNCAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA3NiA+PgpzdHJlYW0KQlQgL0YxIDI0IFRmIDcyIDcwMCBUZCAoU21va2UgVGVzdCBGbHllcikgVGogRVQKMCAwIDEgcmcgNzIgNDAwIDQwMCAyNTAgcmUgZgplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDM2NyAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQzNwolJUVPRgo='), (c) => c.charCodeAt(0))

/** A 1x1 PNG, for the image-upload path. */
const TINY_PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
)

async function upload(path, bytes, contentType, headers = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': contentType, ...headers },
    body: bytes,
  })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text.slice(0, 300)
  }
  return { status: response.status, body }
}

let surveyId = null
let browser = null

try {
  // 1. The Worker itself, with no static assets involved.
  const health = await api('/api/health')
  check('GET /api/health responds 200', health.status === 200, `status ${health.status}`)
  check('health reports ok', health.body?.ok === true, JSON.stringify(health.body?.checks || health.body))
  check('D1 database binding works', health.body?.checks?.database?.ok === true)
  check('R2 storage binding works', health.body?.checks?.storage?.ok === true)

  // 2. Seed a survey so there is a map worth loading.
  const created = await api('/api/surveys', {
    method: 'POST',
    body: JSON.stringify({ name: `Smoke test ${new Date().toISOString()}` }),
  })
  check('POST /api/surveys creates a survey', created.status === 201, `status ${created.status}`)
  surveyId = created.body?.survey?.id
  if (!surveyId) throw new Error(`No survey id came back: ${JSON.stringify(created.body)}`)

  // Stages are seeded with the survey; the sidebar is built around them.
  const stages = await api(`/api/surveys/${surveyId}/stages`)
  check('survey opens with a seeded pipeline', (stages.body?.stages?.length ?? 0) >= 2,
    `${stages.body?.stages?.length ?? 0} stages`)
  const firstStage = stages.body?.stages?.[0]

  const createdIds = []
  for (const [index, pin] of PINS.entries()) {
    const added = await api(`/api/surveys/${surveyId}/properties`, {
      method: 'POST',
      // File the first site under a stage, leave the second unstaged, so the
      // sidebar renders both a stage group and the unstaged bucket.
      body: JSON.stringify(index === 0 && firstStage ? { ...pin, stageId: firstStage.id } : pin),
    })
    check(`POST property "${pin.name}"`, added.status === 201, `status ${added.status}`)
    if (added.body?.property?.id) createdIds.push(added.body.property.id)

    if (pin.fields) {
      const stored = added.body?.property?.fields ?? []
      check(
        `custom fields stored for "${pin.name}"`,
        stored.length === pin.fields.length,
        `${stored.length}/${pin.fields.length} fields`,
      )
    }
  }

  // The tour endpoint must return a schedule, routed or estimated.
  const tour = await api(`/api/surveys/${surveyId}/tour`, {
    method: 'POST',
    body: JSON.stringify({ propertyIds: createdIds, startTime: '10:00', stopMinutes: 20 }),
  })
  check('tour endpoint returns a schedule', tour.status === 200 && Array.isArray(tour.body?.itinerary?.items),
    `status ${tour.status}`)
  check(
    'every stop has an arrival time',
    (tour.body?.itinerary?.items ?? []).every((item) => /^\d{1,2}:\d{2} (AM|PM)$/.test(item.arrive)),
    JSON.stringify(tour.body?.itinerary?.items?.map((item) => item.arrive)),
  )
  check('the route reports its source', ['osrm', 'estimate'].includes(tour.body?.routeSource),
    String(tour.body?.routeSource))

  // Flyer and images: what the tour book is built out of.
  const flyerAttached = await upload(
    `/api/properties/${createdIds[0]}/flyer`,
    FLYER_PDF,
    'application/pdf',
    { 'x-filename': 'smoke-flyer.pdf' },
  )
  check('a PDF flyer attaches to an existing site', flyerAttached.status === 200,
    `status ${flyerAttached.status}`)
  check('the flyer is served back for rendering',
    Boolean(flyerAttached.body?.property?.flyerUrl), String(flyerAttached.body?.property?.flyerUrl))

  // The extract button's endpoint. Without ANTHROPIC_API_KEY this must answer
  // with a clear "not configured" rather than a 500 — the button has to fail
  // in a way that tells the broker what to do.
  const extracted = await api(`/api/properties/${createdIds[0]}/extract`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
  check(
    'the flyer extract endpoint answers sensibly',
    extracted.status === 200 || extracted.status === 422,
    `status ${extracted.status}: ${JSON.stringify(extracted.body).slice(0, 160)}`,
  )
  if (extracted.status === 200) {
    check('extraction filled fields', Array.isArray(extracted.body?.extraction?.filled),
      JSON.stringify(extracted.body?.extraction?.filled))
  }

  const extractNoFlyer = await api(`/api/properties/${createdIds[1]}/extract`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
  check('extracting with no flyer attached is refused clearly', extractNoFlyer.status === 400,
    `status ${extractNoFlyer.status}`)

  const imageAdded = await upload(
    `/api/properties/${createdIds[0]}/images`,
    TINY_PNG,
    'image/png',
    { 'x-source': 'flyer-crop', 'x-caption': encodeURIComponent('Front elevation') },
  )
  check('a cropped image stores against the site', imageAdded.status === 201,
    `status ${imageAdded.status}`)
  check('and is credited to the flyer', imageAdded.body?.image?.source === 'flyer-crop',
    String(imageAdded.body?.image?.source))

  // 3. Load it in a real browser.
  browser = await chromium.launch()
  // acceptDownloads is explicit rather than relied on: the export check
  // depends on it, and a default that changes would fail as a mystery timeout.
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  })
  const page = await context.newPage()

  const tileRequests = []
  page.on('response', (response) => {
    const url = response.url()
    if (/tile\.openstreetmap\.org|basemaps\.cartocdn\.com|\/api\/tiles\//.test(url)) {
      tileRequests.push({ url, status: response.status() })
    }
  })

  const consoleErrors = []
  page.on('pageerror', (error) => consoleErrors.push(error.message))

  const response = await page.goto(`${BASE}/survey/${surveyId}`, {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  })
  check('GET /survey/:id serves the app', response?.status() === 200, `status ${response?.status()}`)

  // The frontend booted at all — this is what a missing asset upload breaks.
  await page.waitForSelector('#root *', { timeout: 20000 })
  check('React app mounted', true)

  // 4. The map container and its tiles.
  await page.waitForSelector('[aria-label="Property map"]', { timeout: 20000 })
  check('map container rendered', true)

  await page.waitForSelector('img.leaflet-tile', { timeout: 20000 })
  // Give the tile grid a moment to finish filling in.
  await page.waitForTimeout(4000)

  const tiles = await page.$$eval('img.leaflet-tile', (nodes) =>
    nodes.map((node) => ({
      src: node.getAttribute('src') || '',
      loaded: node.complete && node.naturalWidth > 0,
      width: node.naturalWidth,
    })),
  )

  const loaded = tiles.filter((tile) => tile.loaded)
  check('tile elements exist', tiles.length > 0, `${tiles.length} tile <img> elements`)
  check(
    'tiles actually painted',
    loaded.length >= 4,
    `${loaded.length}/${tiles.length} loaded with non-zero pixels`,
  )

  const unresolved = tiles.filter((tile) => /\{[a-z]\}/.test(tile.src))
  check('no unresolved URL placeholders', unresolved.length === 0, unresolved[0]?.src || '')

  const osm = tiles.filter((tile) => tile.src.includes('tile.openstreetmap.org'))
  check(
    'base layer is the OpenStreetMap street basemap',
    osm.length > 0,
    `${osm.length} tiles from tile.openstreetmap.org; sample: ${tiles[0]?.src || 'none'}`,
  )

  const badTiles = tileRequests.filter((tile) => tile.status >= 400)
  check('no failing tile requests', badTiles.length === 0, badTiles.slice(0, 3).map((t) => `${t.status} ${t.url}`).join(', '))

  // 5. The UI around the map.
  const markers = await page.$$('.leaflet-marker-icon')
  check('property pins rendered on the map', markers.length >= PINS.length, `${markers.length} markers`)

  const basemapPicker = await page.$('[aria-label="Change basemap"]')
  check('basemap switcher present', Boolean(basemapPicker))

  // The pipeline sidebar, which replaced the flat list.
  const stageName = firstStage?.name
  if (stageName) {
    const stageHeading = await page.$(`text=${stageName}`)
    check(`sidebar renders the "${stageName}" stage`, Boolean(stageHeading))
    const hideToggle = await page.$(`[aria-label*="${stageName}"][aria-pressed]`)
    check('stage has a visibility toggle', Boolean(hideToggle))
  }

  const unstagedHeading = await page.$('text=Unstaged')
  check('sidebar renders the unstaged bucket', Boolean(unstagedHeading))

  // Custom fields should reach the rendered card, not just the database.
  try {
    await page.click(`text=${PINS[0].name}`, { timeout: 10000 })
  } catch (error) {
    check('the site card could be opened', false, error.message.split('\n')[0])
  }
  await page.waitForTimeout(1200)
  const cardText = await page.textContent('body')
  check('a custom field renders on the site card', cardText?.includes('Available SF') ?? false)
  check('the custom field value renders', cardText?.includes('9,822 SF') ?? false)
  check('broker contact renders', cardText?.includes('broker@example.com') ?? false)

  const zoomIn = await page.$('.leaflet-control-zoom-in')
  check('map controls present', Boolean(zoomIn))

  // Interact, to show the UI is live rather than a static paint.
  if (zoomIn) {
    await zoomIn.click()
    await page.waitForTimeout(2500)
    const afterZoom = await page.$$eval('img.leaflet-tile', (nodes) =>
      nodes.filter((node) => node.complete && node.naturalWidth > 0).length,
    )
    check('tiles reload after zooming', afterZoom >= 4, `${afterZoom} tiles loaded after zoom in`)
  }

  check('no uncaught page errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

  // The flyer viewer: pdf.js is a lazy chunk, so this also proves the split
  // bundle actually loads rather than 404ing.
  // Exact, case-sensitive: the tab's literal text is "flyer" (capitalised by
  // CSS), and a loose match also hits "Fill in from flyer" and "Listing flyer"
  // once the tab is open. Failures are reported rather than swallowed — a
  // silently skipped click made the last failure read as a missing canvas.
  try {
    await page.click('text="flyer"', { timeout: 10000 })
  } catch (error) {
    check('the flyer tab could be opened', false, error.message.split('\n')[0])
  }
  await page.waitForTimeout(4000)
  const flyerCanvas = await page.$('[aria-label="Flyer page"]')
  check('the flyer renders to a canvas', Boolean(flyerCanvas))
  if (flyerCanvas) {
    const painted = await flyerCanvas.evaluate((node) => node.width > 0 && node.height > 0)
    check('the PDF page actually rasterised', painted)
  }
  const viewerText = await page.textContent('body')
  check('the crop prompt is shown', viewerText?.includes('Drag a box') ?? false)
  const fillButton = await page.$('text=Fill in from flyer')
  check('the fill-from-flyer button is on the flyer tab', Boolean(fillButton))

  // Directions: the clickable half of the pair. The tour book PDF prints the
  // same destination as a QR, which paper needs and a screen does not.
  await page.click('text="details"').catch(() => undefined)
  await page.waitForTimeout(600)
  const directions = await page.$('a:has-text("Get directions")')
  check('a Get directions link is offered', Boolean(directions))
  if (directions) {
    const href = await directions.getAttribute('href')
    check(
      'directions point at the dropped pin, not just the street',
      Boolean(href?.includes('google.com/maps/dir/') && href?.includes(String(PINS[0].lat))),
      String(href),
    )
  }

  await page.screenshot({ path: 'smoke-map.png', fullPage: false })
  console.log('\nScreenshot written to smoke-map.png')

  // The tour book, which is the document the whole flyer-crop flow feeds.
  const bookResponse = await page.goto(`${BASE}/survey/${surveyId}/book`, {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  })
  check('the tour book route serves', bookResponse?.status() === 200, `status ${bookResponse?.status()}`)
  await page.waitForTimeout(3000)
  const bookText = await page.textContent('body')
  check('the book names the survey', bookText?.includes('Site tour') ?? false)
  check('the book lists a stop', bookText?.includes(PINS[0].name) ?? false)
  const bookImages = await page.$$eval('.book-page img', (nodes) =>
    nodes.filter((node) => node.complete && node.naturalWidth > 0).length,
  )
  check('the captured photo appears in the book', bookImages > 0, `${bookImages} images loaded`)

  // Exporting must produce a real file, and the file must contain the things
  // the book exists to carry. Byte size was the first check here and it was a
  // bad one: it only ever asserted "bigger than a number I guessed", and it
  // failed on a fixture using a 1x1 PNG while the export was working fine.
  // Parsing the PDF checks the actual claims instead.
  try {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 45000 }),
      page.click('text=Export PDF'),
    ])
    const file = await download.path()
    check('Export PDF downloads a file', Boolean(file), download.suggestedFilename())

    if (file) {
      const fs = await import('node:fs')
      const bytes = fs.readFileSync(file)
      check('the download is a PDF', bytes.subarray(0, 5).toString('latin1') === '%PDF-')

      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
      const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise

      check(
        'the book is a cover plus one page per stop',
        doc.numPages === PINS.length + 1,
        `${doc.numPages} pages for ${PINS.length} stops`,
      )

      let text = ''
      let artwork = 0
      for (let number = 1; number <= doc.numPages; number += 1) {
        const pdfPage = await doc.getPage(number)
        const content = await pdfPage.getTextContent()
        text += content.items.map((item) => item.str).join(' ')
        const ops = await pdfPage.getOperatorList()
        artwork += ops.fnArray.filter((fn) => fn === pdfjs.OPS.paintImageXObject).length
      }
      // charSpace and line breaks make exact matching brittle, so compare with
      // whitespace removed.
      const flat = text.replace(/\s+/g, '').toLowerCase()

      check('the book carries the street address', flat.includes('1600mainst'), text.slice(0, 120))
      check('the book carries the property details', flat.includes('availablesf'))
      check('the book carries the detail values', flat.includes('9,822sf'))
      check('the book carries the listing contact', flat.includes('broker@example.com'))
      check('the book offers directions', flat.includes('scanfordirections'))
      check('the book carries arrival times', /\d{1,2}:\d{2}(am|pm)/.test(flat))
      check(
        'photos and QR codes are embedded',
        artwork >= PINS.length,
        `${artwork} images across ${doc.numPages} pages`,
      )
    }
  } catch (error) {
    check('Export PDF downloads a file', false, error.message.split('\n')[0])
  }
  await page.screenshot({ path: 'smoke-book.png', fullPage: false })
} catch (error) {
  failed = true
  console.error(`\nSmoke test threw: ${error.stack || error.message}`)
} finally {
  if (surveyId) {
    const removed = await api(`/api/surveys/${surveyId}`, { method: 'DELETE' }).catch(() => null)
    console.log(`\nCleanup: deleted survey ${surveyId} (status ${removed?.status ?? 'unknown'})`)
  }
  if (browser) await browser.close()
}

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed against ${BASE}`)
process.exit(failed ? 1 : 0)
