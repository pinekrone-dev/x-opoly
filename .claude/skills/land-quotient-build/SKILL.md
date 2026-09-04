---
name: land-quotient-build
description: How Land Quotient is built and run — the two repositories (x-opoly product, prospector data factory), Cloudflare bindings, the data contract between them, the branches and deploy path, and the repeatable pathways (add a market, add or merge a layer, probe a government source, ship a UI change, file a records request). Load this before touching either repository in a fresh session.
---

# Land Quotient: architecture and pathways

Land Quotient is a commercial real estate site-survey and parcel-intelligence
tool. Two repositories make it, and they are not copies of each other:

| Repository | Role | Where it runs |
|---|---|---|
| `pinekrone-dev/x-opoly` | **The product.** Hono API + React/MapLibre UI on a Cloudflare Worker. CRM, surveys, tours, the GIS map, billing. | Worker `x-opoly`, `survey.realestateaistudio.com` (future `landquotient.com`) |
| `pinekrone-dev/prospector` | **The data factory.** Python pipeline that pulls county parcel rolls and city/state layers, cuts tiles, writes a catalogue, and publishes to R2 and D1. | GitHub Actions runners; output on `data.realestateaistudio.com` (R2 bucket `prospector-data`) |

The product never fetches from a county. The pipeline never renders a page the
customer uses. The catalogue in R2 is the contract between them.

## Standing rules (these override convenience)

- **Cost.** Keep Cloudflare consumption as low as possible without losing function: D1 reads bounded (list limit 1000, FTS5 for text search, summaries reused), edge cache on search and catalogue tile ranges, nothing per-keystroke to the server. Measure before and after any change on a hot path.
- **Secrets.** Never write an API key, token or JWT into source, logs, README, tests or git. Keys live in Cloudflare (`npx wrangler secret put`), GitHub repository secrets, or `.env.local`.
- **Blocked sources.** A 403, a robots refusal, a TLS failure or a bot wall is reported, never routed around. No relays, proxies, archive mirrors or disabled certificate checks. No account creation on any site.
- **Owners.** Never invent an owner, an address or an email. Read contact addresses verbatim off the agency's own page (use `probe-page`, below).
- **Branches.** x-opoly: develop on `claude/gis-db-optimization-xb0kf7` (dev), ship by cherry-picking onto `claude/sitemapcre-tool-clone-qyq7jy` (live, auto-deploys). prospector: `main`. Never open a pull request unless asked.
- **Sandbox egress.** The coding sandbox cannot reach `.gov`, ArcGIS or most public data hosts (proxy 403). Every read of an outside source happens on a GitHub runner through a probe workflow, and the log is read back.

## x-opoly: the product

### Runtime and bindings (`wrangler.toml`)

- Entry `worker/index.js` (Cloudflare) and `server/index.js` (Node dev). Both mount the same Hono app from `app/routes.js`.
- `app/lib/sql.js` adapts `node:sqlite` and D1 behind one interface; `app/lib/schema.js` is the schema (tables, additive columns, idempotent repairs) with a version marker so warm isolates skip the sweep. `npm run migrations` regenerates `migrations/0001_init.sql` from it.
- Bindings: `DB` → D1 `sitesurvey-cre` (CRM, surveys, users); `PARCELS` → D1 `landquotient-parcels` (searchable parcel rows, refilled by the pipeline; optional, the GIS falls back to the published index); `BUCKET` → R2 `sitesurvey-cre-uploads`; `PROSPECTOR_DATA` → R2 `prospector-data`, served through the Worker at `/catalog/*` with byte-range support for pmtiles (browser and edge cache 300 s for `markets.json` and `*/layers.json`, a day for everything else); `ASSETS` → `dist/` as a single-page app.
- `[vars] TILE_PROVIDER` picks the keyless basemap (osm, carto-*, satellite). Keyed providers need the `TILE_KEY` secret.
- `[env.staging]` is a second Worker with its own D1 and R2 and no routes.
- Cloudflare secrets (all optional, every feature has a free default): `ANTHROPIC_API_KEY` (flyer reading), `GOOGLE_MAPS_API_KEY`, `CENSUS_API_KEY`, `TILE_KEY`, Stripe and SMS keys. GitHub secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SMOKE_EMAIL`, `SMOKE_PASSWORD`.

### Code map

```
app/routes.js            every API route (auth, CRM, surveys, tours, GIS catalogue, ingest)
app/lib/crm.js           people/companies/places/deals, custom fields, parcel links, search, LIST_LIMIT
app/lib/surveys.js       surveys, properties, share tokens
app/lib/parcels.js       parcel search over D1 (FTS5), summaries
app/lib/edgecache.js     cache wrappers for search and catalogue
src/api.ts               typed client for every route
src/lib/crm.ts           OBJECTS: the CRM object specs (segment, create fields, detail fields)
src/views/Home.tsx       the CRM: cross-kind search table, per-kind filterable table, create form
src/views/RecordView.tsx one CRM record, details saved on blur, custom fields, deal parties
src/views/SurveyWorkspace.tsx  a survey: map, property panel, tour
src/views/Gis.tsx        the parcel map: markets, assessor shading, owners, census, published layers,
                         category palettes, zoning pivot filter, saved views, export
src/components/MapCanvas.tsx   MapLibre + pmtiles; parcels, extra layers, filters, paint
src/components/LayerFilter.tsx the zoning pivot dialog (city → category → code)
src/components/AddPropertyDialog.tsx  add a site by hand, by paste, or From CRM
src/components/SendPlaceToSurvey.tsx  the inverse: CRM places into a survey
test/*.test.js           node --test; Worker exercised over D1/R2 shims (test/cloudflare-shims.js)
```

### Commands

```
npm run dev        # API on Node + Vite
npm test           # node --test test/*.test.js  (expect every test green before a push)
npm run build      # tsc -b && vite build  (run before every push; revert tsconfig.tsbuildinfo)
npm run deploy     # build + wrangler deploy (CI does this; rarely by hand)
```

### Deploy path

`.github/workflows/deploy.yml` runs on a push to `main` or the live branch:
staging deploy → `scripts/smoke.mjs` drives staging in a real browser
(`wait-for-deploy.mjs` waits for the bundle hash) → production deploy. One run
per branch, queued not cancelled. A run takes about fifteen minutes. Read the
run with the GitHub Actions tools rather than polling.

### Shipping a UI or API change

1. Work on the dev branch. `npx tsc -b`, `npm run build`, `npm test`.
2. Commit with a message that explains why, not what. No model names in commits.
3. `git push -u origin claude/gis-db-optimization-xb0kf7`.
4. Cherry-pick onto live through a temporary branch:
   `git fetch origin <live> && git checkout -B live-tmp origin/<live> && git cherry-pick -x <sha> && git push origin live-tmp:<live>`; return to dev, delete `live-tmp`.
5. Schedule a check-in (send_later, about ten minutes) to read the deploy run and report.

### The GIS data contract (what the map reads from `/catalog`)

- `markets.json` — every market: slug, name, region, centre, sources.
- `<slug>/meta.json` — panel spec, labels, counts, `colorBy`, `tiles` and `heavyBase`.
- `<slug>/parcels.pmtiles` — the county, `source-layer` `parcels`, feature id = parcel id; properties `gp` (group), `mv` (value), `po`/`bo` (portfolio / back office ids).
- `<slug>/tracts.geojson`, `census.json`, `owners.json`.
- `<slug>/layers.json` — the published layers. Each entry: `id, label, note, kind (polygon|line|point), color, file, tiles, sourceLayer, minzoom, maxzoom, count, total, filter, attribution, fields, categories, pivot`.
  - `categories`: `[{field, values: [[value, count]…], colors?}]` — what the layer can be coloured by. A field with `colors` is painted by that palette whole; without, twelve colours and "other".
  - `pivot` (zoning only): `[{city, count, categories: [{category, count, codes: [[code, count]…]}]}]` — the tree behind the filter icon.
- Parcel rows reach D1 `PARCELS` through `POST /api/gis/ingest`, authenticated by the runner's GitHub OIDC token; no credential is stored on either side.

## prospector: the data factory

### Layout and build order

```
pipeline/county_sources.py   per-market county parcel service, fields, exclusions (the market's edge)
pipeline/layer_sources.py    BY_MARKET / NATIONAL / PROMOTED layer registry; sources_for(slug)
pipeline/make_layers.py      fetch → clip → categorise → tiles → layers.json (see below)
pipeline/fetch_county.py, make_<market>.py, make_sales.py, make_tracts.py, make_owners.py,
pipeline/make_census.py, make_tiles.py, publish_parcels.py      the market build stages
pipeline/build_<market>.sh   the stages in the only order that works (later stages write back into parcels.geojson)
make_meta.py, make_markets.py, make_pages.py, pipeline/blurbs.json   catalogue words and pages
pipeline/upload_r2.sh (CF_TOKEN) | upload_ingest.sh (OIDC)   heavy data to R2; markets.json last
pipeline/upload_layers.sh    layer files + layers.json to R2
site/<slug>/data/            the light files, committed (layers.json, meta.json, markets.json)
research/                    source index, records requests, who has been contacted
```

Workflows (`.github/workflows`): `build-<market>.yml` (tippecanoe, `CENSUS_KEY`, publish, commit light files, publish parcels to D1), `refresh-layers.yml` (input `markets`), `probe-page.yml` (input `urls`, whitespace-separated), `probe-hub.yml` (input `queries`: ArcGIS Hub terms or `socrata:<domain>:<words>`), `probe-layers.yml`, `harvest.yml`, `reindex-search.yml`. A runner's log is the only way to see an outside host: trigger, wait, read the job log.

### How a layer source is declared (`layer_sources.py`)

One dict per layer. Keys: `id, label, note, kind, color, url (…/query), fields {source: label}, cap, attribution`; optional `protocol: 'socrata'`, `where`, `note_filter`, `order` (all with `{recent_year}`), `coords` (a state plane in `STATE_PLANES`, e.g. `epsg:2223`, for tables with projected X/Y), `minzoom/maxzoom`, `categorize: 'zoning'`.

A merged layer has `parts`: a list of per-city dicts, each overriding `url, fields, where, note_filter, order, cap, coords, protocol, attribution`. Every feature gets a `City`; a part that fails costs that city, not the layer. This is how Phoenix has one Zoning (13 services), one Development pipeline (8), one Traffic counts (2), and North Jersey one Zoning from the NJTPA's county layers.

`categorize: 'zoning'` adds `Category` from `zoning_category(code, description)` (ordered `CATEGORY_RULES`: planned development, mixed use, mobile home, industrial, commercial, agricultural, multifamily, open space, public, residential, else Other), lifts the `Zoning` field past the 60-value legend cap, ships a per-code palette (`zoning_palette`: one hue per category from `CATEGORY_HUES`, shades by count) and the `pivot` tree (`zoning_pivot`).

### Pathway: add a layer to a market

1. Find the service. `probe-hub` for Hub-indexed data; for a city's own server, probe its Portal `rest/services?f=json`, then folders, then `…/<Layer>/MapServer/<n>?f=json` and a 3-row `query?…&f=json` to read the fields.
2. Declare it in `layer_sources.py` (as a part of the market's merged layer if one exists). Check `zoning_category` on its codes and add a rule if a common code lands in Other.
3. `python3 -c "from layer_sources import sources_for; …"` compiles; commit; push `main`.
4. Trigger `refresh-layers.yml` with `markets: <slug>`; read the log for per-part counts, `WARNING … skipped`, `N layer(s) published`; check `site/<slug>/data/layers.json` after the runner's "Map layers refreshed" commit (pull with `--rebase` before your next push).
5. Tell the user what the layer shows and to reload.

### Pathway: add or grow a market

1. `county_sources.py`: the county service, the fields, the exclusion (the market's edge is a choice; New Jersey is six counties by `COUNTY IN (…)`).
2. `make_<market>.py` maps county codes to the five map groups and `assettype.py`; add the market to `make_tracts.py`, `make_census.py`, `make_meta.py`, `make_markets.py`, `make_pages.py`, `blurbs.json`.
3. `build_<market>.sh` in the standard order; `build-<market>.yml` mirrors it. Trigger it; the parcel build takes thirty minutes to a few hours.
4. Then `refresh-layers.yml` for the slug, so its layers clip to the new envelope.
5. In the product nothing changes: the market appears from `markets.json` (browsers hold it five minutes).

### Pathway: a source that is not published

Try the Hub, the city's Portal server, Socrata, the county, the MPO (MAG for Phoenix, NJTPA for North Jersey), the state DOT. If nothing is public, and the user has authorised it, send a public-records request from the user's email: the statute for the state (Arizona A.R.S. § 39-121), a commercial purpose stated, the address read verbatim off the clerk's page by `probe-page`, no money, no em dash, Sent checked before and after. Record what was blocked (403, TLS) rather than working around it.

### Reading a runner's log

`actions_run_trigger` → `actions_list list_workflow_jobs` for the job id → `get_job_logs` with `return_content`. Logs of a job still running return 404; schedule a check-in (send_later) rather than polling in a loop.

## Check-ins and reporting

Long runs (a market build, a layer refresh, a deploy) are read by a scheduled check-in, never a sleep loop. Each check-in's prompt names the run id, what to verify, what to fix if red, and what to tell the user. Report outcomes plainly: what published, what was skipped and why, what request went out, and that the map needs a reload.
