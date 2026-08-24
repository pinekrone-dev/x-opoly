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
npm test                     # 45 tests, no network required
```

Data lives in `./data` — a SQLite file plus the uploaded flyers and photos. Point
`DATA_DIR` somewhere persistent before deploying.

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
| `TILE_URL`, `TILE_ATTRIBUTION` | Map tiles. Defaults to OpenStreetMap, which needs no key. Swap in your own tile server or a paid provider. |
| `GEOCODER_URL`, `GEOCODER_KEY` | Address search. Defaults to Nominatim, which needs no key. |
| `CENSUS_API_KEY` | Raises the rate limit on trade-area demographics (US Census ACS, free and keyless for light use). |
| `DATA_DIR`, `DB_FILE`, `PORT` | Where data lives and which port to serve. |

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
  lib/demographics.js   census trade-area lookup
src/
  views/                survey list, broker workspace, client share view
  components/           map canvas, property panel, table, tour planner, share settings
test/                   45 tests over storage, sharing, routing, providers and the API
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

Uploads are sent as a raw body with the filename in an `X-Filename` header, which avoids a
multipart dependency. Stored files are given generated names and served only from the
uploads directory.
