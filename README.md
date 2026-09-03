# Land Quotient

A site survey and deal mapping tool for tenant rep brokers. One survey per client
requirement: map the candidate properties, keep each one moving through the deal stages,
plan the tour you will drive, and send the client a branded read-only link.

## Running it

```bash
npm install
npm run dev      # API on :8080, UI on :5173 with /api proxied
```

```bash
npm run build && npm start   # one process serving the API and the built UI on $PORT
npm test                     # node tests, no network required
```

Locally, data lives in `./data` — a SQLite file plus the uploaded flyers and photos.

## Deploying to Cloudflare

The API is written once with Hono and runs unchanged in both places. Only the plumbing
differs: `node:sqlite` and a directory locally, D1 and R2 on Cloudflare.

```
app/routes.js         the API — one definition, both runtimes
app/lib/sql.js        node:sqlite adapter | D1 adapter
app/lib/storage.js    disk adapter        | R2 adapter
server/index.js       Node entry point
worker/index.js       Cloudflare entry point
```

D1 is SQLite, so the schema is identical — `migrations/0001_init.sql` is generated from
`app/lib/schema.js` by `npm run migrations`, so the two cannot drift.

The D1 database and R2 bucket are already provisioned and wired into `wrangler.toml`, and
the tables exist. Only the deploy is left.

### Deploying without a terminal

Either of these works entirely in the browser.

**Cloudflare builds from GitHub.** Workers & Pages → Create → Workers → Import a
repository → pick this repo and branch. Cloudflare builds and deploys on every push, and
no API token is involved at all.

**Or GitHub Actions**, using `.github/workflows/deploy.yml` in this repo:

1. Cloudflare → My Profile → API Tokens → Create Token → "Edit Cloudflare Workers".
2. GitHub → Settings → Secrets and variables → Actions → add `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID` (the Account ID is in the Workers & Pages sidebar).
3. GitHub → Actions → "Deploy to Cloudflare" → Run workflow.

The workflow runs the tests before deploying, so a broken build never reaches production.

Either way, add `ANTHROPIC_API_KEY` once in the Cloudflare dashboard afterwards — Workers &
Pages → sitesurvey-cre → Settings → Variables and Secrets, type "Secret". Keeping it there
rather than in GitHub means the key lives in exactly one place.

### Deploying from a terminal instead

```bash
npx wrangler login

# Secrets — never in wrangler.toml, which is in git
npx wrangler secret put ANTHROPIC_API_KEY     # for reading flyers
npx wrangler secret put TILE_KEY              # only for a keyed basemap

npm run deploy
```

Starting from scratch in a different account instead:

```bash
npx wrangler d1 create sitesurvey-cre          # paste the id into wrangler.toml
npx wrangler r2 bucket create sitesurvey-cre-uploads
npm run cf:migrate                             # creates the tables
npm run deploy
```

`npm run deploy` builds the UI and uploads it as static assets alongside the Worker, with
`not_found_handling = "single-page-application"` so deep links like `/survey/:id` and
`/s/:token` resolve instead of 404ing.

**GitHub Pages cannot host this.** It serves static files only, and this needs a database,
file storage, and a server-side API key. GitHub is the right home for the code and CI; the
running app needs Cloudflare or another host that runs code.

### Moving to landquotient.com

The app builds every outbound link — verification emails, Stripe return URLs, client share
links — from the host the request arrived on, so it follows a new domain on its own. What
does not follow automatically, in the order it has to happen:

1. **Get the zone into this Worker's account.** The domain was registered through
   Cloudflare Registrar under a different account, and a custom domain can only name a zone
   its own account holds. Cloudflare allows an inter-account registrar transfer once the
   domain is more than 10 days old: add landquotient.com as a website in the target account
   first, keep DNSSEC off, then submit the move from **Manage Domain → Configuration**. The
   gaining account approves by email within five days.
2. **Routes.** Uncomment the two `[[routes]]` blocks in `wrangler.toml` and push; the deploy
   provisions the DNS records and certificates. Never add a DNS record for either hostname
   by hand — a custom domain cannot attach to a name that already has one. Note that
   enabling these too early fails *quietly*: the Cloudflare build errors, the previous
   deployment keeps serving, and a wrangler-only change leaves the bundle hash unchanged so
   the smoke test's rollout check sees nothing wrong.
3. **SendGrid.** Authenticate landquotient.com under Sender Authentication, add the DNS
   records it prints, then set the `EMAIL_FROM` secret to
   `Land Quotient <support@landquotient.com>`. Until the domain is authenticated, sends are
   refused and signup reports that the email could not be sent.
4. **Google Maps key.** Add `https://landquotient.com/*` to the key's website restrictions,
   and set the `GOOGLE_REFERER` secret to `https://landquotient.com/`. The Worker sends that
   header on every Google call because a server-side request carries no referer of its own;
   miss this and routing silently falls back to OSRM.
5. **Smoke test.** Point the matrix in `.github/workflows/smoke.yml` at the new host.

The old address keeps working throughout — its route stays in `wrangler.toml` — so nothing
breaks mid-move. Any `www.` variant 301s to the bare name, keeping path and query.

## What it does

**Surveys.** A survey is one client's search. It holds the candidate sites, the client's
name for the header, and the share settings.

**Properties.** Each site carries what a broker actually records: address and coordinates,
deal stage, asking rate and unit, NNN, size, acreage, parking, zoning, year built,
availability, listing broker, a photo, the flyer, and private notes.

**Stages.** Prospect → touring → LOI out → under contract, plus passed. The stage drives
the pin colour on the map and the filters in the list.

**Flyer intake.** Drop a listing flyer in as a PDF or a screenshot and the fields are read
out of it into a new site record. This calls Claude with a structured output schema, so
what comes back is typed rather than parsed out of prose. Fields the flyer does not state
come back `null` — the prompt forbids inferring them — and anything ambiguous is listed in
`uncertainFields` for the broker to confirm. If extraction is unavailable the flyer is
still filed against a stub record, so the upload is never lost.

**Tour planning.** Orders the stops into a sensible drive and draws the route on the map,
with per-leg mileage and a time estimate. This runs entirely on the server with no routing
API: straight-line distances, nearest-neighbour from every candidate start, then 2-opt to
remove crossings. Pinning a start is honoured even when it costs distance.

**Scope the competition.** Search for businesses around any pin by category or name,
with 1 / 3 / 5-mile rings drawn on the map and a distance-ranked list of what is nearby.
Backed by OpenStreetMap's Overpass API — free, no key. When the directory cannot be
reached you get an error, never an empty list: "no results" and "we could not look" mean
very different things to someone deciding on a site.

**Client link.** A token URL at `/s/<token>` that opens a read-only map with the broker's
name on it and no sign-in. Sharing is off until switched on, the link can carry an expiry
date, and reissuing it breaks the old one wherever it was forwarded. The client payload is
built separately from the internal one: private notes and internal ids are never in it.

## Configuration

Everything below is optional. The tool runs without any of it — these only switch on the
parts that need an outside service.

| Variable | Effect |
| --- | --- |
| `ANTHROPIC_API_KEY` | Enables reading flyers automatically. Without it the upload still files, and fields are entered by hand. |
| `ANTHROPIC_MODEL` | Overrides the extraction model (default `claude-opus-5`). |
| `TILE_PROVIDER`, `TILE_KEY`, `TILE_STYLE` | Basemap. See the table below. Defaults to OpenStreetMap, which needs no key. |
| `TILE_URL`, `TILE_ATTRIBUTION`, `TILE_MAX_ZOOM`, `TILE_DARK` | A self-hosted or unlisted tile server. Overrides `TILE_PROVIDER`. |
| `GEOCODER_URL`, `GEOCODER_KEY` | Address search. Defaults to Nominatim, which needs no key. |
| `OVERPASS_URL` | Business directory for competition scoping. Defaults to the public Overpass API. |
| `CENSUS_API_KEY` | Raises the rate limit on trade-area demographics (US Census ACS, free and keyless for light use). |
| `DATA_DIR`, `DB_FILE`, `PORT` | Node only: where data lives and which port to serve. |

On Cloudflare these come from bindings and secrets rather than the environment — `DB`
(D1), `BUCKET` (R2) and `ASSETS` in `wrangler.toml`, and `wrangler secret put` for keys.

### Basemaps

`TILE_PROVIDER` takes one of:

| Value | Basemap | Key needed |
| --- | --- | --- |
| `osm` *(default)* | Standard OpenStreetMap street map | no |
| `osm-hot` | OpenStreetMap, Humanitarian style (OSM France) | no |
| `opentopomap` | Terrain with contours (OpenTopoMap, CC-BY-SA) | no |
| `satellite` | Esri World Imagery | no |
| `esri-streets` | Esri World Street Map | no |
| `esri-topo` | Esri World Topographic | no |
| `esri-gray` | Esri Light Gray Canvas, a near-blank ground for parcels and layers | no |
| `esri-dark` | Esri Dark Gray Canvas | no |
| `esri-natgeo` | National Geographic world map | no |
| `usgs-imagery` | USGS orthoimagery, public domain, US only | no |
| `usgs-topo` | USGS topographic, public domain, US only | no |
| `usgs-hybrid` | USGS imagery with roads and names | no |
| `carto-voyager` | Street map, cleaner rendering of the same data | no, but throttled anonymously |
| `carto-light` | Muted, for when the pins should dominate | no, but throttled anonymously |
| `carto-dark` | Dark | no, but throttled anonymously |
| `mapbox` | Mapbox styles (`TILE_STYLE`, default `dark-v11`) | yes |
| `here` | HERE explore.night | yes |
| `maptiler` | MapTiler (`TILE_STYLE`) | yes |
| `stadia` | Stadia Alidade Smooth Dark | yes |
| `offline` | Placeholder grid served by this app | no |

A keyed provider with no `TILE_KEY` falls back to the keyless default and says so, rather
than rendering a map of broken tiles. Whichever basemaps a deployment can actually load
are offered in a switcher on the map itself, and the viewer's choice is remembered. Every
keyless basemap above is in the switcher; the Esri and USGS ones are ArcGIS tile services
(row before column in the URL) and carry the attribution their terms ask for. The USGS
layers stop at zoom 16, which is block scale; the map holds at the basemap's own limit.

The default is an ordinary street map, and the keyed providers default to their standard
street styles too. The map surface, zoom controls and attribution follow the basemap, so
a light basemap does not sit on a dark panel while its tiles load.

Basemaps are never colour-filtered. An earlier version forced light tiles dark with a CSS
invert, which inverted the street labels along with them — the one thing on a basemap that
has to stay readable.

**Before going to production**, check the current usage terms of whichever basemap you
point this at. The free public endpoints — OpenStreetMap's especially — publish usage
policies that are generally not intended for commercial products at volume, and expect
you to move to a provider plan or your own tile server. That is a licensing decision, not
a technical one: the code switches with one variable.

`offline` serves a neutral labelled grid from `/api/tiles/{z}/{x}/{y}.svg`. It exists for
development, air-gapped installs, and networks that filter outbound traffic — the pins
still sit in the right relative positions, and the attribution says plainly that no
basemap is loaded. It never draws invented streets or coastlines.

Two deliberate choices about outside services. The map keeps a visible grid ground when
tiles cannot load, so a firewalled or offline deployment still shows its pins rather than a
blank void. And nothing here estimates: if the geocoder is unreachable the UI says so and
offers manual entry, and if census data cannot be fetched the panel says that too. A pin in
the wrong place, or a demographic figure a broker repeats to a client, is worse than an
honest gap.

## Layout

```
app/
  routes.js             the Hono API — one definition, both runtimes
  lib/sql.js            node:sqlite adapter | D1 adapter, schema sweep with a version marker
  lib/schema.js         tables, indexes, additive column list, idempotent repairs
  lib/surveys.js        survey/property records, share tokens
  lib/crm.js            people, companies, places, deals; custom fields; parcel links
  lib/stages.js         deal stages and per-site custom fields
  lib/tour.js           route optimisation — haversine, multi-start NN, 2-opt
  lib/flyer.js          flyer → structured fields via an AI provider
  lib/geocode.js        address lookup provider
  lib/places.js         nearby-business search for competition scoping
  lib/demographics.js   census trade-area lookup
  lib/lookupcache.js    time-bounded cache for the three lookups above
  lib/tiles.js          basemap provider presets and placeholder tiles
server/index.js         Node entry point
worker/index.js         Cloudflare entry point
scripts/
  procure-data.mjs      fetches the official NPPES and NUCC bulk files into data/
  load-providers.mjs    mirrors them into data/providers.db, geocodes, joins to parcels
src/
  views/                survey list, broker workspace, GIS view, CRM records, client share view
  components/           map canvas, property panel, table, tour planner, share settings
test/                   node tests, including the Worker exercised over D1 and R2 shims
```

## Database round trips

D1 charges per statement and each one crosses the network, so the API is
written to a round-trip budget and `test/io.test.js` holds it there. What the
budget rests on:

- **Schema sweep once per version.** The schema is applied lazily on a
  Worker's first request. The result is recorded in `schema_meta`, so a later
  cold start reads one row and skips the sixty-odd CREATE, PRAGMA and repair
  statements. Change the schema lists and the fingerprint changes with them;
  delete the row and the sweep runs again.
- **One auth query per request.** The session and its user are read in one
  JOIN. The "does any account exist yet" check that gates setup mode is
  answered once per app instance, since the answer only ever moves from no to
  yes.
- **Writes go in batches.** A site, its survey's timestamp and its custom
  fields land in one `db.batch`; so do a CRM record and its fields, a delete
  and its dependents, and a deal party and the deal's timestamp. On D1 a batch
  is atomic; on Node it is a transaction.
- **Unchanged values are not written.** A PATCH is compared against the row
  it targets and only the columns that differ are sent. A pin dragged back to
  where it was, or a panel that re-saves the same text, costs no write and
  does not bump the survey's "last activity" time.
- **Lists are bounded and searched in SQL.** CRM lists take `?q=`, `?limit=`
  and `?offset=`, cap at 1,000 rows and report `truncated`. The navigation's
  counts come from `GET /api/crm/counts`, one query, rather than from
  downloading every list.
- **Places match by an indexed key.** `places.address_key` is the address
  flattened for comparison, kept in step on every write. Rows from before the
  column existed are keyed the first time a team's lookup misses.
- **A session is remembered for a minute.** The cookie-to-user read is skipped
  for a minute per isolate; sign-out and password change clear the memory.

### What a parcel search reads

The parcel store is the only table with a million rows in it, so it is where
reads scale with use. D1 bills rows read, and a `LIKE '%text%'` can never use
an index, so the search box used to read the whole county four times per
keystroke — on Phoenix, seven million rows to answer "main st", against a free
allowance of five million a day. What runs now, and what it reads:

| Request | Before | Now |
| --- | --- | --- |
| Open a market (empty form) | 2 full passes + 1 page | 1 summary row + 200 index rows |
| Text search, indexed market | 4 full passes | 2 walks of the matches + 200 key lookups |
| Text search, unindexed market | 4 full passes | 2 full passes + 200 key lookups |
| Value or acreage range | 4 index-range passes | 2 index-range passes + 200 key lookups |
| The same question again, anywhere in the region | all of the above | nothing: served from the edge cache |

- **The summary row answers the empty form.** The seal wrote the count, the
  value, the acreage and the asset breakdown; opening a market reads them
  rather than recomputing them.
- **Text goes through FTS5.** An external-content full-text index over the
  same haystack answers a token-prefix match (`"main"* "st"*`) from its own
  index, joined index-first so a search reads its matches and nothing else.
  A market is searched this way once it has been indexed (`fts` on its
  summary row). Indexing writes one entry per parcel, once, so it is spread
  over days: the prospector repository's `reindex-search.yml` runs daily and
  mirrors at most a budget of rows per run (90,000 by default, under D1's
  free 100,000 writes a day), the store keeping each market's cursor between
  runs. Every later publish keeps the index in step. An unindexed or
  half-indexed market is searched by LIKE as before.
- **One grouped pass for every number.** Count, value, acreage and the asset
  breakdown come from a single `GROUP BY` over the matches; the page is the
  slice of the highlight list it belongs to, fetched by key.
- **Answers are kept at the edge.** `GET /api/gis/parcels`, `/api/gis/market`
  and the catalogue proxy (`/catalog/*`, byte ranges included) are cached
  with the Cache API, keyed on the question and never on who asked: ten
  minutes for a search, five for a market, a day for a tile archive. The
  sign-in check still runs first. `x-edge-cache: hit|miss` says which.

Measured on a synthetic 200,000-parcel county in `node:sqlite`: the text
search "main st" (25,000 matches) went from 331 ms of four full scans to 56 ms
of index-driven reads; opening the market from 19 ms of two full scans to 1 ms.
On D1 the same change moves the read count from four times the county per
search to roughly twice the match count.

Writes are unchanged in kind: a publish still writes only rows whose hash
moved. An indexed market writes each changed row to the text index as well,
which is one more row per parcel per change.

## Outside lookups: cache and rate limits

Census demographics, nearby businesses and geocoder answers are remembered in
memory per app instance (per isolate on Cloudflare): demographics and geocode
for a day, businesses for an hour, keyed by the coordinate rounded to about
eleven metres and by the query. Only successful answers are kept, so an
outage is reported every time rather than remembered. `/api/demographics` is
public — the shared client map uses it — and is rate-limited per address like
the geocoder.

## Client write behaviour

Nothing writes on a timer. The two inputs that used to write per keystroke
now coalesce: a CRM record's custom fields save 500 ms after typing pauses and
flush at once on blur, on window blur, on add or remove, and when the view
unmounts; the tour planner's start time and minutes-per-stop re-plan 350 ms
after the last change. Every other save is explicit or on blur, and the server
ignores a save that changes nothing.

## Provider data (healthcare practice leads)

`docs/data-sources.md` holds the source register, the joins and the legal
notes. The short version:

```bash
NODE_USE_ENV_PROXY=1 node scripts/procure-data.mjs            # NPPES monthly + weeklies + NUCC into data/sources
node scripts/load-providers.mjs nucc                          # taxonomy lookup
node scripts/load-providers.mjs nppes [--states TX,FL]        # monthly replace, then each weekly, idempotent
node scripts/load-providers.mjs geocode --states TX           # Census batch geocoder, cached per address
node scripts/load-providers.mjs join --market austin-tx --parcels parcels.geojson --meta meta.json
node scripts/load-providers.mjs export --market austin-tx     # layer-healthcare.geojson + catalog entry
node scripts/load-providers.mjs status
```

Weekly refresh is `procure-data.mjs --only nppes-weekly` followed by
`load-providers.mjs nppes`; files already in the load log are skipped.
Everything lands in the gitignored `data/` directory, in a SQLite file
separate from the app's database. The mailing address of an individual NPI
is never stored, ownership comes only from the county roll under a geocoded
practice point, and an unmatched practice stays unmatched.

## Notes on the API

| Endpoint | Purpose |
| --- | --- |
| `GET/POST /api/surveys` | list and create surveys |
| `GET/PATCH/DELETE /api/surveys/:id` | one survey and its properties |
| `POST /api/surveys/:id/properties` | add a site |
| `PATCH/DELETE /api/properties/:id` | edit or remove a site |
| `POST /api/surveys/:id/flyer` | upload a flyer and extract its fields |
| `POST /api/surveys/:id/tour` | plan a route; `PUT` the same path saves an order |
| `POST /api/surveys/:id/share` | enable, expire or reissue the client link |
| `GET /api/share/:token` | the read-only client payload |
| `GET /api/places/nearby` | businesses around a point, with ring counts |
| `GET /api/tiles/:z/:x/:y.svg` | placeholder basemap tiles |

Uploads are sent as a raw body with the filename in an `X-Filename` header, which avoids a
multipart dependency. Stored files are given generated names and served only from the
uploads directory.
