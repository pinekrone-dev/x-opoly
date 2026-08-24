# SiteSurvey CRE

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
npm test                     # 83 tests, no network required
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

The D1 database and R2 bucket are already provisioned and wired into
`wrangler.toml`, and the tables exist. What remains needs credentials, so it runs from
your machine:

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
| `carto-voyager` | Street map, cleaner rendering of the same data | no |
| `carto-light` | Muted, for when the pins should dominate | no |
| `carto-dark` | Dark | no |
| `mapbox` | Mapbox styles (`TILE_STYLE`, default `dark-v11`) | yes |
| `here` | HERE explore.night | yes |
| `maptiler` | MapTiler (`TILE_STYLE`) | yes |
| `stadia` | Stadia Alidade Smooth Dark | yes |
| `offline` | Placeholder grid served by this app | no |

A keyed provider with no `TILE_KEY` falls back to the keyless default and says so, rather
than rendering a map of broken tiles. Whichever basemaps a deployment can actually load
are offered in a switcher on the map itself, and the viewer's choice is remembered.

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
server/
  index.js              Express app: surveys, properties, tour, sharing, uploads
  lib/db.js             SQLite schema and connection (node:sqlite, no dependency)
  lib/surveys.js        survey/property records, stages, share tokens
  lib/tour.js           route optimisation — haversine, multi-start NN, 2-opt
  lib/flyer.js          flyer → structured fields via Claude
  lib/geocode.js        address lookup provider
  lib/places.js         nearby-business search for competition scoping
  lib/tiles.js          basemap provider presets and placeholder tiles
  lib/demographics.js   census trade-area lookup
src/
  views/                survey list, broker workspace, client share view
  components/           map canvas, property panel, table, tour planner, share settings
test/                   83 tests, including the Worker exercised over D1 and R2 shims
```

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
