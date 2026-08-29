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

/** Holds the session cookie once signed in, the way a browser would. */
let sessionCookie = null

async function api(path, init) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(sessionCookie ? { cookie: sessionCookie } : {}),
      ...(init?.headers || {}),
    },
  })
  const setCookie = response.headers.get('set-cookie')
  if (setCookie) sessionCookie = setCookie.split(';')[0]
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
    headers: {
      'content-type': contentType,
      ...(sessionCookie ? { cookie: sessionCookie } : {}),
      ...headers,
    },
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

  /*
   * Password hashing, exercised without creating anything.
   *
   * An unknown address still runs the full key derivation against a dummy
   * hash, so the timing does not give away which addresses exist — which
   * makes this the one way to test the hashing on the real runtime without
   * registering an account on someone's deployment. It matters because
   * Cloudflare rejects a PBKDF2 call above 100,000 iterations outright, so
   * this path threw on the Worker while passing every test on Node.
   */
  const unknown = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      email: `smoke-${Date.now()}@example.invalid`,
      password: 'not a real password',
    }),
  })
  check(
    'password hashing runs on this runtime',
    unknown.status === 401 || unknown.status === 400,
    `status ${unknown.status}: ${JSON.stringify(unknown.body).slice(0, 160)}`,
  )

  // Accounts: an unclaimed instance is open, a claimed one needs credentials.
  // Failing loudly here matters — silently skipping the API checks would make
  // a locked-out run look like a passing one.
  const account = await api('/api/auth/me')
  const unclaimed = Boolean(account.body?.setupRequired)

  if (unclaimed) {
    check('the workspace is unclaimed, so the API is open', true, 'no account exists yet')
  } else if (process.env.SMOKE_EMAIL && process.env.SMOKE_PASSWORD) {
    const signedIn = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: process.env.SMOKE_EMAIL,
        password: process.env.SMOKE_PASSWORD,
      }),
    })
    if (signedIn.body?.twoFactor) {
      throw new Error(
        'The smoke account has two-factor enabled, which this test cannot complete. ' +
          'Use a dedicated account without 2FA for automated checks.',
      )
    }
    check('signed in as the smoke account', signedIn.status === 200 && Boolean(sessionCookie),
      `status ${signedIn.status}`)
  } else {
    throw new Error(
      'This workspace has an account, so the API needs credentials. ' +
        'Add SMOKE_EMAIL and SMOKE_PASSWORD as repository secrets.',
    )
  }

  // 2. Seed a survey so there is a map worth loading.
  const created = await api('/api/surveys', {
    method: 'POST',
    body: JSON.stringify({ name: `Smoke test ${new Date().toISOString()}` }),
  })
  check('POST /api/surveys creates a survey', created.status === 201, `status ${created.status}`)
  surveyId = created.body?.survey?.id
  const surveyName = created.body?.survey?.name ?? ''
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
  check('the route reports its source', ['google', 'osrm', 'estimate'].includes(tour.body?.routeSource),
    `${tour.body?.routeSource}${tour.body?.routeNote ? ` — ${tour.body.routeNote}` : ''}`)

  // Address search, against the real geocoders. This exact path failed live
  // while passing every test: Nominatim refuses cloud IPs, which only a
  // request from the deployed Worker can reveal. The Census geocoder is the
  // fallback, so between them a plain Dallas street address must resolve.
  const looked = await api(`/api/geocode?q=${encodeURIComponent('1600 Main St, Dallas, TX')}`)
  check(
    'an address search returns pins to click',
    looked.status === 200 && (looked.body?.results?.length ?? 0) > 0,
    `status ${looked.status}: ${JSON.stringify(looked.body).slice(0, 160)}`,
  )

  // Census demographics, against the real ACS. The API is keyless for light
  // use, so this is expected to work with or without CENSUS_API_KEY; the key
  // only raises the rate limit. Reported either way so adding it later is
  // visibly confirmed rather than assumed.
  const integrations = health.body?.features?.integrations ?? {}
  check('health reports which integrations are configured',
    typeof integrations.census === 'boolean',
    JSON.stringify(integrations))

  const demographics = await api(`/api/demographics?lat=${PINS[0].lat}&lng=${PINS[0].lng}`)
  if (demographics.status === 200) {
    const rings = demographics.body?.radii ?? []
    check('census demographics come back for three rings', rings.length === 3,
      `${rings.length} rings${integrations.census ? ' (keyed)' : ' (keyless)'}`)
    check('the rings carry a population figure',
      rings.every((ring) => Number.isFinite(ring?.metrics?.population)),
      JSON.stringify(rings.map((ring) => ring?.metrics?.population)))
    check('rings grow outward, as a trade area does',
      rings.length === 3 && rings[0].metrics.population <= rings[2].metrics.population,
      JSON.stringify(rings.map((ring) => `${ring.miles}mi:${ring.metrics.population}`)))
    check('the figures name their source', typeof demographics.body?.source === 'string',
      String(demographics.body?.source))

    // The map shades block-group polygons with L.geoJSON, which draws nothing
    // for esriJSON rings — silently. This is the check that catches a format
    // regression before a broker wonders why the choropleth never appears.
    const shapes = (demographics.body?.areas ?? []).filter((area) => area.geometry)
    check('block groups carry geometry the map can draw',
      shapes.length > 0 && shapes.every((area) =>
        area.geometry.type && Array.isArray(area.geometry.coordinates)),
      `${shapes.length} shapes, first: ${JSON.stringify(shapes[0]?.geometry?.type ?? null)}`)
  } else if (!integrations.census && demographics.status === 503) {
    /*
     * The designed degradation, not an outage. Without CENSUS_API_KEY the
     * app calls ACS keyless, and the Census Bureau throttles keyless calls
     * from shared egress IPs — Workers and CI runners chief among them. The
     * server answered with its honest 503 and a message saying exactly what
     * to configure, which is the behavior the no-key posture promises.
     * Staging runs keyless on purpose, so failing the gate here would block
     * every deploy on a third party's rate limiter. A keyed deployment
     * (production) still fails hard below, because there a 503 is real.
     */
    check('census demographics degrade honestly without a key', true,
      `keyless, status 503: ${JSON.stringify(demographics.body?.error ?? '').slice(0, 120)}`)
  } else {
    // A census outage on a keyed deployment fails the build: the key is
    // configured, so an error here is the integration actually broken.
    check('census demographics are reachable', false,
      `status ${demographics.status}: ${JSON.stringify(demographics.body).slice(0, 200)}`)
  }

  // The client share link, and the promise that a hidden site never reaches it.
  {
    const buried = createdIds[1]
    await api(`/api/properties/${buried}`, {
      method: 'PATCH',
      body: JSON.stringify({ hidden: true }),
    })
    const share = await api(`/api/surveys/${surveyId}/share`, {
      method: 'POST',
      body: JSON.stringify({ enabled: true }),
    })
    const token = share.body?.survey?.share?.token
    check('sharing switches on and mints a token', Boolean(token), `status ${share.status}`)

    if (token) {
      const clientView = await api(`/api/share/${token}`)
      const names = (clientView.body?.properties ?? []).map((property) => property.name)
      check('the client link opens', clientView.status === 200, `status ${clientView.status}`)
      check('a hidden site never reaches the client', !names.includes(PINS[1].name),
        JSON.stringify(names))
      check('the shown sites do', names.includes(PINS[0].name), JSON.stringify(names))
      check('the hidden flag itself stays private',
        (clientView.body?.properties ?? []).every((property) => !('hidden' in property)))
    }

    // Put it back so the later UI checks see both pins.
    await api(`/api/properties/${buried}`, {
      method: 'PATCH',
      body: JSON.stringify({ hidden: false }),
    })
  }

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

  // The reported bug: a flyer upload produced a property with no coordinates,
  // so no pin appeared and the tour planner could not see it.
  const flyerProperty = flyerAttached.body?.property
  const flyerPin = await api(`/api/surveys/${surveyId}/flyer`, {
    method: 'POST',
    headers: { 'content-type': 'application/pdf', 'x-filename': 'pin-check.pdf' },
    body: FLYER_PDF,
  })
  const fromFlyer = flyerPin.body?.property
  check('uploading a flyer creates a property', Boolean(fromFlyer), `status ${flyerPin.status}`)
  check(
    'and places it on the map',
    typeof fromFlyer?.lat === 'number' && typeof fromFlyer?.lng === 'number',
    `lat ${fromFlyer?.lat}, lng ${fromFlyer?.lng}`,
  )
  if (fromFlyer?.id) {
    const tourable = await api(`/api/surveys/${surveyId}/tour`, {
      method: 'POST',
      body: JSON.stringify({ propertyIds: [fromFlyer.id] }),
    })
    check('so the tour planner can include it', tourable.body?.stops?.length === 1,
      `${tourable.body?.stops?.length ?? 0} stops`)
    // Removed again so the map and book checks below see the two seeded pins.
    await api(`/api/properties/${fromFlyer.id}`, { method: 'DELETE' })
  }
  void flyerProperty

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

  // 3. Load it in a real browser. CI installs Playwright's own build; a
  // sandbox with a system Chromium can point at it instead.
  browser = await chromium.launch({ executablePath: process.env.SMOKE_CHROMIUM || undefined })
  // acceptDownloads is explicit rather than relied on: the export check
  // depends on it, and a default that changes would fail as a mystery timeout.
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  })

  if (sessionCookie) {
    const [name, value] = sessionCookie.split('=')
    await context.addCookies([
      { name, value, url: BASE, httpOnly: true, sameSite: 'Lax' },
    ])
  }
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

  /*
   * The interface is behind a login now. On an unclaimed workspace that means
   * the claim form, which is worth asserting — it was unreachable until
   * recently, so nobody could create an account at all — but it also means the
   * rest of the UI cannot be reached from here.
   *
   * Deliberately not registering an account to get past it: this runs against
   * the real deployment on every push, and claiming someone's workspace with a
   * test account would take it away from them.
   */
  if (unclaimed && !sessionCookie) {
    /*
     * Wait for the sign-in panel itself, not merely for something to exist
     * inside #root: the app renders a "Starting up…" placeholder while the
     * session request is in flight, and `#root *` matches that placeholder, so
     * the assertion used to read the loading text and report a missing login.
     */
    const wall = await page
      .waitForFunction(
        () => {
          const text = document.body.textContent ?? ''
          return /Claim this workspace|Sign in to your surveys/.test(text) ? text : false
        },
        { timeout: 20000 },
      )
      .then((handle) => handle.jsonValue())
      .catch(() => null)
    const shown = wall ?? (await page.textContent('body')) ?? ''
    check(
      'an unclaimed workspace offers the claim form',
      shown.includes('Claim this workspace'),
      wall ? shown.slice(0, 120) : `the sign-in panel never rendered; the page showed: ${shown.slice(0, 120)}`,
    )
    check(
      'the deployment can be verified end to end',
      false,
      'This workspace has not been claimed. Create the account in the browser, then add ' +
        'SMOKE_EMAIL and SMOKE_PASSWORD as repository secrets so these checks can sign in. ' +
        'Until then everything below the login cannot be exercised.',
    )
    await page.screenshot({ path: 'smoke-map.png', fullPage: false })
    throw new Error('Workspace unclaimed — UI checks need credentials. See the check above.')
  }

  // The frontend booted at all — this is what a missing asset upload breaks.
  await page.waitForSelector('#root *', { timeout: 20000 })
  check('React app mounted', true)

  // 4. The map container and its tiles.
  await page.waitForSelector('[aria-label="Property map"]', { timeout: 20000 })
  check('map container rendered', true)

  // MapLibre draws to a WebGL canvas, so tiles are asserted at the network
  // layer rather than as <img> elements the way the old Leaflet map allowed.
  await page.waitForSelector('canvas.maplibregl-canvas', { timeout: 20000 })
  // Give the tile fetches a moment to land.
  await page.waitForTimeout(4000)

  const canvasSize = await page.$eval('canvas.maplibregl-canvas', (node) => ({
    w: node.width,
    h: node.height,
  }))
  check('the map canvas has real pixels', canvasSize.w > 0 && canvasSize.h > 0, `${canvasSize.w}×${canvasSize.h}`)

  const tilesOk = tileRequests.filter((tile) => tile.status >= 200 && tile.status < 400)
  check('basemap tiles were fetched', tilesOk.length >= 4, `${tilesOk.length} tile responses`)

  const unresolved = tileRequests.filter((tile) => /\{[a-z]\}/.test(tile.url))
  check('no unresolved URL placeholders', unresolved.length === 0, unresolved[0]?.url || '')

  const badTiles = tileRequests.filter((tile) => tile.status >= 400)
  check('no failing tile requests', badTiles.length === 0, badTiles.slice(0, 3).map((t) => `${t.status} ${t.url}`).join(', '))

  // The self-healing basemap posts a notice when a tile host stops
  // answering; its absence is the positive signal that the basemap drew.
  const mapText = (await page.textContent('body')) ?? ''
  check('no basemap failure notice', !mapText.includes('is not responding'))

  // 5. The UI around the map.
  const markers = await page.$$('.maplibregl-marker')
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
  check('the broker still sees the listing contact', cardText?.includes('broker@example.com') ?? false)

  const zoomIn = await page.$('.maplibregl-ctrl-zoom-in')
  check('map controls present', Boolean(zoomIn))

  // Interact, to show the UI is live rather than a static paint: a zoom
  // changes the tile grid, so new tile requests are the proof it happened.
  if (zoomIn) {
    const before = tileRequests.length
    await zoomIn.click()
    await page.waitForTimeout(2500)
    check(
      'tiles reload after zooming',
      tileRequests.length > before,
      `${tileRequests.length - before} new tile requests after zoom in`,
    )
  }

  check('no uncaught page errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

  // UI checks, ordered so the modal comes last. Opening the clipping dialog
  // earlier and leaving it open made every later click time out against the
  // overlay — three failures that looked like missing features and were not.
  const openSite = async () => {
    await page.click(`text=${PINS[0].name}`, { timeout: 10000 }).catch(() => undefined)
    await page.waitForTimeout(900)
  }

  await openSite()

  await page.click('text="flyer"', { timeout: 10000 }).catch(() => undefined)
  await page.waitForTimeout(900)
  const fillButton = await page.$('text=Fill in from flyer')
  check('the fill-from-flyer button is on the flyer tab', Boolean(fillButton))

  // Directions: the clickable half of the pair. The tour book PDF prints the
  // same destination as a QR, which paper needs and a screen does not.
  await page.click('text="details"', { timeout: 10000 }).catch(() => undefined)
  await page.waitForTimeout(700)
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

  // The share tab carries the book, not just the link.
  await page.click('text="Share"', { timeout: 10000 }).catch(() => undefined)
  await page.waitForTimeout(1000)
  const shareText = await page.textContent('body')
  check('the share tab offers the tour book', shareText?.includes('Tour book') ?? false)
  check('with a PDF download', shareText?.includes('Download tour book') ?? false)

  // Clipping last, because it opens a modal over everything else.
  await page.click('text="Map"', { timeout: 10000 }).catch(() => undefined)
  await page.waitForTimeout(700)
  await openSite()
  await page.click('text="flyer"', { timeout: 10000 }).catch(() => undefined)
  await page.waitForTimeout(900)

  const clipButton = await page.$('text=Clip photos from flyer')
  check('clipping opens in a dialog rather than the sidebar', Boolean(clipButton))
  if (clipButton) {
    await clipButton.click()
    await page.waitForTimeout(4000)

    const flyerCanvas = await page.$('[aria-label="Flyer page"]')
    check('the flyer renders to a canvas', Boolean(flyerCanvas))
    if (flyerCanvas) {
      const painted = await flyerCanvas.evaluate((node) => node.width > 0 && node.height > 0)
      check('the PDF page actually rasterised', painted)
      const box = await flyerCanvas.boundingBox()
      // The whole point of the change: bigger than the sidebar column it used
      // to be squeezed into.
      check('the page is rendered large enough to crop accurately', (box?.width ?? 0) > 500,
        `${Math.round(box?.width ?? 0)}px wide`)
    }
    const viewerText = await page.textContent('body')
    check('the crop prompt is shown', viewerText?.includes('Drag a box') ?? false)

    // Close it, or everything after this clicks the overlay instead.
    await page.click('text="Done"', { timeout: 10000 }).catch(() => undefined)
    await page.waitForTimeout(600)
  }

  await page.screenshot({ path: 'smoke-map.png', fullPage: false })
  console.log('\nScreenshot written to smoke-map.png')

  // The tour book, which is the document the whole flyer-crop flow feeds.
  const bookResponse = await page.goto(`${BASE}/survey/${surveyId}/book`, {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  })
  check('the tour book route serves', bookResponse?.status() === 200, `status ${bookResponse?.status()}`)
  // The book fills in as its fetches land — survey, properties, then the
  // schedule — and on a cold worker that can take well over the guessed
  // pause this used to be. Wait for the content itself; the arrival times
  // come last, so they get their own wait before anything reads the page.
  await page.waitForSelector('text=SITE TOUR', { timeout: 30000 }).catch(() => undefined)
  await page
    .waitForFunction(() => /\d{1,2}:\d{2}\s?(AM|PM)/i.test(document.body.innerText), { timeout: 30000 })
    .catch(() => undefined)
  await page.waitForTimeout(500)
  const bookText = await page.textContent('body')
  check('the book names the survey', bookText?.includes(surveyName) ?? false)
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

      // The designed book: a cover, an itinerary page, then one page per stop.
      check(
        'the book is a cover, an itinerary, and one page per stop',
        doc.numPages === PINS.length + 2,
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
      check('the book withholds the listing contact from the client', !flat.includes('broker@example.com'))
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

  /*
   * The GIS, which this test did not open until it had already shipped a
   * broken one.
   *
   * The parcel search moved to the server, and a market only takes that path
   * once its rows are published and sealed. Every run of this test until then
   * had been exercising the fallback — the browser downloading the county —
   * because no market was ready yet. So the path that real users would hit
   * first was the one path never opened here, and it reached them broken.
   *
   * What this checks is deliberately blunt: the map paints, no script threw,
   * and no request the view depends on came back an error. A blank map with a
   * clean console is still a blank map, so the canvas is measured rather than
   * merely found.
   */
  const gisErrors = []
  const gisFailures = []
  page.on('pageerror', (error) => gisErrors.push(error.message))
  page.on('response', (response) => {
    const url = response.url()
    if (response.status() < 400) return
    if (!/\/api\/gis\/|\/catalog\/|index\.json|meta\.json|\.pmtiles/.test(url)) return
    /*
     * Overlay layers are the one catalog file a market may honestly not
     * have. They are published by a separate job from the county build, so
     * a market always exists for a while before its layers do — Orange
     * County blocked this gate on exactly that, with a map that was
     * otherwise perfect: the parcels drew, the count was right, the tiles
     * read. The GIS offers no overlays when it 404s here and carries on.
     *
     * Only a missing one is forgiven. A 500 means the file is there and
     * the catalog is broken, which is the failure this check exists for,
     * and every other file stays a hard dependency.
     */
    if (response.status() === 404 && /\/layers\.json$/.test(url)) return
    gisFailures.push(`${response.status()} ${url.replace(BASE, '')}`)
  })

  /*
   * The parcel tiles, counted per market.
   *
   * A basemap paints whether or not a single parcel arrives, so "the canvas
   * has pixels" is not evidence that the map has the county on it. What a
   * person means by the map not loading is usually this: streets, no parcels.
   * pmtiles are read by HTTP range request, so a market that drew anything
   * leaves a trail of 200s and 206s here and one that drew nothing leaves
   * none.
   */
  const tiles = { ok: 0, bad: [] }
  page.on('response', (response) => {
    if (!/\.pmtiles/.test(response.url())) return
    if (response.status() === 200 || response.status() === 206) tiles.ok += 1
    else tiles.bad.push(`${response.status()} ${response.url().split('/').pop()}`)
  })

  const gis = await page.goto(`${BASE}/gis`, { waitUntil: 'domcontentloaded', timeout: 45000 })
  check('GET /gis serves the app', gis?.status() === 200, `status ${gis?.status()}`)

  const gisMap = await page
    .waitForSelector('canvas.maplibregl-canvas', { timeout: 40000 })
    .catch(() => null)
  check('the GIS map paints a canvas', gisMap != null,
    gisMap ? '' : ((await page.textContent('body')) ?? '').slice(0, 300))

  if (gisMap) {
    // Long enough for the market status, the tiles and the first search to
    // settle. A map that is going to fail generally fails in this window.
    await page.waitForTimeout(9000)
    const size = await page.$eval('canvas.maplibregl-canvas', (node) => ({
      w: node.clientWidth, h: node.clientHeight,
    }))
    check('the GIS map has real size', size.w > 400 && size.h > 300, `${size.w}x${size.h}`)

    /*
     * The catalogue, asked for from inside the page.
     *
     * Every market in the picker comes from this one file, so if it does not
     * answer as JSON then no market loads and the failure looks like "the map
     * is broken" rather than "one file is missing". It has to be read from
     * the page because it is served from another origin that a runner may
     * reach differently.
     */
    const catalogue = await page.evaluate(async () => {
      // The address the app actually reads, which is now this origin. It used
      // to read the data domain directly, and that is exactly what broke: a
      // cross-origin refusal there arrives as `TypeError: Failed to fetch`
      // with status 0, the market list comes back empty, and the view is
      // blank because the app was told there are no counties. The direct
      // address is still probed, but only for the record — a refusal there is
      // no longer the product's problem.
      const bases = ['/catalog', 'https://data.realestateaistudio.com']
      const out = []
      for (const base of bases) {
        try {
          const res = await fetch(`${base}/markets.json`, { cache: 'no-store' })
          const body = await res.text()
          let slugs = null
          try {
            slugs = (JSON.parse(body).markets || []).map((m) => `${m.slug}:${m.status}`)
          } catch { slugs = null }
          out.push({ base, status: res.status, type: res.headers.get('content-type') || '',
                     slugs, head: slugs ? '' : body.slice(0, 120) })
        } catch (error) {
          out.push({ base, status: 0, type: '', slugs: null, head: String(error).slice(0, 120) })
        }
      }
      return out
    })
    for (const answer of catalogue) {
      const ok = answer.status === 200 && Array.isArray(answer.slugs) && answer.slugs.length > 0
      const detail = `status ${answer.status} ${answer.type} ${answer.slugs ? answer.slugs.join(' ') : answer.head}`
      if (answer.base === '/catalog') {
        check('the market catalogue answers as JSON from this origin', ok, detail)
      } else {
        // Reported, never asserted. Whether another origin's bucket will talk
        // to this one is that bucket's business now, not the product's.
        console.log(`NOTE  the data domain direct: ${detail}`)
      }
    }

    // The onboarding tour sits over the panel on a workspace that has never
    // chosen a county, and a click that lands on it is not a click on the map.
    for (const label of ['Skip', 'Done']) {
      await page.click(`button:has-text("${label}")`, { timeout: 2500 }).catch(() => undefined)
    }
    await page.click('[data-tour="layers"], text=Layers', { timeout: 5000 }).catch(() => undefined)
    await page.waitForTimeout(600)

    const picker = await page.$('#gis-market')
    check('the market picker is on the panel', picker != null)
    if (picker) {
      const options = await page.$$eval('#gis-market option', (nodes) =>
        nodes.map((n) => n.value).filter(Boolean))
      check('the picker lists the published markets', options.length > 0, options.join(' '))

      /*
       * Every market, not just the first.
       *
       * "None of them load" is a different fault from "one of them loads",
       * and a test that only ever opens the market that happens to sort first
       * cannot tell the two apart.
       */
      /*
       * The market already showing goes last.
       *
       * Selecting the option that is already selected changes nothing, so no
       * tiles are read and the count for it comes back zero — not because
       * that county is broken but because nothing happened. Starting at the
       * second option and coming back to the first makes every step in this
       * loop a real change of market, which is the thing being tested.
       */
      for (const slug of [...options.slice(1), options[0]]) {
        await page.selectOption('#gis-market', slug).catch(() => undefined)
        // The market's meta, its server status and its first search, in that
        // order. Generous because a cold Worker adds a second on the first ask.
        await page.waitForTimeout(7000)

        /*
         * In past the zoom where parcels are drawn.
         *
         * A county opens at the gate itself, and a tile is only fetched once
         * the view moves inside it — so counting at the opening view counts
         * zero, correctly, and says nothing about whether the county draws.
         *
         * Zoomed with the map's own control rather than by writing the
         * address bar. Writing the hash looked like the tidier way to ask and
         * moved nothing at all: every market reported no tiles, which read as
         * eight broken counties rather than one instruction the map never
         * received. The control is what the survey map's own check already
         * uses, and that one has been passing all along.
         */
        const zoomOf = async () =>
          Number(/^#([\d.]+)/.exec(await page.evaluate(() => window.location.hash))?.[1] ?? NaN)
        const opened = await zoomOf()
        const before = tiles.ok

        /*
         * Zoomed with the wheel, over the map itself.
         *
         * Two tidier-looking ways failed silently before this one. Writing the
         * address bar moved nothing. Clicking the zoom control hit the panel
         * that sits over the top-left corner of this page, and a click that
         * lands on the wrong element throws, which was being swallowed. Both
         * reported eight counties failing to draw when nothing had asked them
         * to draw anything.
         *
         * The wheel goes to whatever is under the pointer, so putting the
         * pointer in the middle of the canvas is unambiguous about who is
         * being asked.
         */
        const box = await (await page.$('canvas.maplibregl-canvas'))?.boundingBox()
        if (box) {
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
          for (let step = 0; step < 4; step += 1) {
            await page.mouse.wheel(0, -400)
            await page.waitForTimeout(900)
          }
        }
        await page.waitForTimeout(4000)
        const reached = await zoomOf()
        const text = ((await page.textContent('body')) ?? '').replace(/\s+/g, ' ')
        const count = text.match(/([\d,]{4,})\s*parcels/i)
        check(`${slug}: the panel states a parcel count`, count != null,
          count ? count[1] : text.slice(0, 240))
        check(`${slug}: nothing on the panel reports a failure`,
          !/Could not load that market|Could not reach the parcel catalogue|Loading parcels…/.test(text),
          text.slice(0, 240))
        // The zoom is reported either way. Without it a failure cannot say
        // whether the county would not draw or was never asked to, and those
        // are opposite problems that look identical from here.
        check(`${slug}: the parcel tiles are read once past the zoom gate`, tiles.ok > before,
          `${tiles.ok - before} pmtiles responses, zoom ${opened} -> ${reached}`)
      }
      check('no parcel tile came back an error', tiles.bad.length === 0,
        tiles.bad.slice(0, 4).join(' | '))

      /*
       * The no-GPU path's server half, against the real archive.
       *
       * The basic map asks the server for one tile's worth of parcels as
       * GeoJSON instead of drawing the archive through WebGL. A browser
       * falls back to it precisely when everything else has failed, so this
       * is the one endpoint that must not be discovered broken at that
       * moment. Austin's downtown tile has thousands of parcels; zero
       * features here means the decode broke, whatever the status code says.
       */
      const lite = await page.evaluate(async () => {
        const lat = 30.2672, lng = -97.7431, z = 14
        const x = Math.floor(((lng + 180) / 360) * 2 ** z)
        const rad = (lat * Math.PI) / 180
        const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z)
        try {
          const res = await fetch(`/catalog/austin-tx/lite/${z}/${x}/${y}.json`)
          const doc = res.ok ? await res.json() : null
          return { status: res.status, features: doc?.features?.length ?? 0 }
        } catch (error) {
          return { status: 0, features: 0, error: String(error).slice(0, 120) }
        }
      })
      check('the basic map can get parcels with no GPU at all',
        lite.status === 200 && lite.features > 0,
        `status ${lite.status}, ${lite.features} features ${lite.error ?? ''}`)

      /*
       * A position left over from somewhere else.
       *
       * The map keeps its view in the URL so a refresh returns you to the
       * block you were reading. The hash outlives the tab, though, so one
       * belonging to another county used to be restored over a market a
       * thousand miles away — parcels loaded, camera in a different state,
       * and reloading put it straight back because the hash came too. A
       * failure a reload cannot clear is the worst kind, so it is pinned
       * here with a position no market of ours is anywhere near.
       */
      const target = options[0]
      // Away first, so this is a real document load.
      //
      // Navigating from /gis to /gis#... differs only by the fragment, which
      // the browser treats as a same-document navigation: nothing reloads, the
      // map is never rebuilt, and the case under test — a fresh visit carrying
      // somebody else's position — never happens. The first version of this
      // check did exactly that and reported a failure the product does not
      // have, while saying nothing about the one it did.
      await page.goto('about:blank')
      await page.goto(`${BASE}/gis#12/40.7128/-74.0060`, {
        waitUntil: 'domcontentloaded', timeout: 45000,
      })
      await page.waitForSelector('canvas.maplibregl-canvas', { timeout: 40000 }).catch(() => null)
      await page.waitForTimeout(9000)
      // The map writes its own position back, so the address bar is the
      // honest answer to where it actually ended up.
      const landed = await page.evaluate(() => window.location.hash)
      const parts = landed.replace('#', '').split('/')
      const lat = Number(parts[1])
      const lng = Number(parts[2])
      check('a hash from another part of the country does not strand the map',
        Number.isFinite(lat) && Number.isFinite(lng) &&
          (Math.abs(lat - 40.7128) > 1 || Math.abs(lng - -74.006) > 1),
        `${target} opened at ${landed || '(no hash written)'}`)
    }
  }

  check('no uncaught errors in the GIS', gisErrors.length === 0, gisErrors.slice(0, 3).join(' | '))
  check('no failed requests the GIS depends on', gisFailures.length === 0,
    gisFailures.slice(0, 4).join(' | '))
  await page.screenshot({ path: 'smoke-gis.png', fullPage: false })
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
