# Data plan: healthcare practice leads + parcel owner of record

Scoped 3 September 2026. Nothing here changes an app feature. It adds a data
layer the app can later publish as market layers through the existing ingest
door (`/api/gis/ingest`, one fixed file set per market slug).

## The one rule that shapes everything

**NPPES and NUCC are a provider directory. They do not say who owns a building.**
A practice's address is where a clinician sees patients, usually as a tenant.
Ownership comes only from the county assessor roll and the recorder index. The
join from a practice point to a parcel produces a *candidate* owner of record for
the parcel under that point, and the record keeps both sides separate: the
practice, the parcel, and the confidence of the match. Unmatched rows are kept
unmatched. No owner is ever inferred from an NPI record.

**B2B practice sites only.** NPPES carries two addresses per NPI: the practice
location and a mailing address. The mailing address of an individual (entity
type 1) is often a home. It is excluded from every derived table. Only the
practice location of organisations (entity type 2) and of individuals whose
practice address is a commercial site is used, and the residential test is
done against the parcel's land-use code, not guessed from the address string.

## Procurement status

Run `node scripts/procure-data.mjs` from a machine that can reach
`download.cms.gov` and `nucc.org`. The sandbox this was built in blocks both
hosts (and `data.cms.gov` and `geocoding.geo.census.gov`), so **no real file
has been downloaded yet** and nothing has been purchased. The script resolves
the dated file names from the official pages at run time, streams each file
into `data/sources/<source>/`, and records URL, size, SHA-256, version and
licence note in `data/sources/manifest.json`. `data/` is gitignored.

## Loading what was procured

`scripts/load-providers.mjs` mirrors the files into `data/providers.db`, a
SQLite file separate from the app's database, and builds the per-market layer:

| Step | Command | What it does |
| --- | --- | --- |
| Taxonomy | `load-providers.mjs nucc` | `nucc_taxonomy` lookup with version and licence note |
| Mirror | `load-providers.mjs nppes [--states TX,FL]` | Monthly file replaces the provider tables; each weekly in date order is an upsert; a row carrying only a deactivation date deactivates. Individual mailing addresses are dropped at load |
| Geocode | `load-providers.mjs geocode [--states] [--zips] [--limit]` | Census batch geocoder, one call per 5,000 distinct practice addresses, cached in `geocode_cache`, misses and ties kept |
| Join | `load-providers.mjs join --market <slug> --parcels parcels.geojson --meta meta.json` | Point in polygon against the market's parcels; `provider_parcels` rows carry the roll's owner, mailing, value and use, or `unmatched` |
| Export | `load-providers.mjs export --market <slug>` | `layer-healthcare.geojson` plus `healthcare-layer.json`, the entry to merge into the market's `layers.json` and publish through the ingest door |
| Refresh | `procure-data.mjs --only nppes-weekly` then `load-providers.mjs nppes` | Files already in `load_log` are skipped, so this is the whole weekly routine |

The loader streams the CSV straight out of the ZIP with `unzip -p`, so the
nine-gigabyte monthly file is never extracted to disk. `test/provider-data.test.js`
exercises every step on fixture files laid out exactly like the real releases.
Federal property layers (IOLP, FRPP) are not loaded by this script and are not
merged into `provider_parcels`; when adopted they become their own layer file.

| Source | Current release (from CMS and NUCC pages, via search on 3 Sep 2026) | Size |
| --- | --- | --- |
| NPPES monthly full replacement, V.2 | dated 10 Aug 2026 | about 1,098 MB zipped |
| NPPES weekly incremental, V.2 | one per week since the monthly | tens of MB each |
| NPPES deactivation report | monthly | small |
| NUCC taxonomy CSV | version 26.1, 1 Jul 2026 | under 1 MB |

V.1 files were discontinued 3 March 2026; only V.2 exists now. Field lengths
grew for first name and legal business name, so any loader must read the header
and not assume fixed widths.

## Source register

Columns: bulk vs API vs scrape | licence | cost | refresh | fields that matter |
join key | geo | private owner | federal owner | keep or drop.

| # | Source | URL | Access | Licence | Cost | Refresh | Fields | Join key | Geo? | Private owner? | Federal owner? | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | NPPES Data Dissemination (CMS) | https://download.cms.gov/nppes/NPI_Files.html | Bulk ZIP, monthly full + weekly incremental + deactivation | US federal public domain (45 CFR 162) | Free | Monthly, weekly deltas | NPI, entity type, org legal name, other name, practice address lines/city/state/zip/phone, mailing address, up to 15 taxonomy codes with primary flag, licence numbers, enumeration and last-update dates, sole proprietor flag, org parent LBN | `npi`; `taxonomy_code` to NUCC | No, address only | No | No | **Keep. Spine.** |
| 2 | NPI Registry API (CMS) | https://npiregistry.cms.hhs.gov/api/ | API, lookup only | Public domain | Free | Live | Same as 1 | `npi` | No | No | No | **Keep for single-record refresh only. Never paged to clone.** |
| 3 | NUCC Health Care Provider Taxonomy | https://www.nucc.org (Code Sets > Provider Taxonomy > CSV) | Bulk CSV | Free to use; commercial redistribution needs NUCC licence via their form | Free | Twice yearly, Jan and Jul | code, grouping, classification, specialisation, definition, effective/deactivation dates | `code` = NPPES taxonomy | No | No | No | **Keep. Store version 26.1 and licence note with it.** |
| 4 | Doctors and Clinicians national downloadable file (CMS PDC) | https://data.cms.gov/provider-data/dataset/mj5m-pzi6 | Bulk CSV, about 2.5 M rows | Public domain | Free | Roughly monthly | NPI, PAC ID, enrolment ID, group PAC ID, org legal name, group size, primary and secondary specialties, practice address, phone, med school and grad year, telehealth flag | `npi`; `group_pac_id` groups clinicians into practices | No | No | No | **Keep. Best free source for "which practice group is at this address".** Medicare-enrolled clinicians only. |
| 5 | data.gov catalog | https://catalog.data.gov | Catalog, DCAT JSON | Varies per dataset | Free | Continuous | Pointers to 4, 6, 7, 9 and state assessor datasets | none | n/a | n/a | n/a | **Keep as discovery index, not a data source.** |
| 6 | GSA IOLP, Inventory of Owned and Leased Properties | https://catalog.data.gov/dataset/inventory-of-owned-and-leased-properties-iolp and https://www.iolp.gsa.gov/iolp/ | Bulk CSV on data.gov (last updated Mar 2024) and a weekly web app | Public domain | Free | Web app weekly; data.gov file stale | location code, owned/leased, address, lat/lng, rentable sqft, lease effective and expiry dates | address, lat/lng | Yes | No | **Yes** | **Keep. Marks parcels with a federal tenant or federal owner, so an outreach list can exclude or flag them.** Check freshness before each build. |
| 7 | FRPP, Federal Real Property Profile summary | https://www.gsa.gov/real-estate/real-estate-services/real-property-policy-division-overview/federal-real-property-profile-frpp | Bulk XLSX/CSV, annual public summary | Public domain | Free | Annual | agency, asset type, address, city, state, zip, sqft, owned/leased (public version omits some coordinates) | address | Partial | No | **Yes** | **Keep, secondary to IOLP.** Covers agencies GSA does not house. |
| 8 | SAM.gov Entity Management public extract | https://open.gsa.gov/api/sam-entity-extracts-api/ (SAM_PUBLIC_MONTHLY_V2 and daily) | Bulk pipe-delimited ZIP via Data Services | Public (FOIA-releasable data) | Free, but needs a personal api.data.gov key | Monthly full, daily deltas | UEI, CAGE, legal business name, DBA, physical and mailing address, NAICS list, entity structure, POCs (public subset) | legal name + address to NPPES org name; NAICS 62xx flags healthcare | No | No | No | **Keep, later and optional.** Enriches organisations that also contract federally. Needs `SAM_GOV_API_KEY`; skipped when unset. |
| 9 | USASpending | https://www.usaspending.gov/download_center/custom_award_data and bulk archives at https://files.usaspending.gov/ | Bulk CSV, API for slices | Public domain | Free | Monthly archives | recipient name, UEI, recipient address, award amount, NAICS, place of performance | UEI to SAM, name+address to NPPES | Place of performance city/county only | No | No | **Drop for v1.** Only useful once SAM join exists. |
| 10 | Census TIGER/Line | https://www2.census.gov/geo/tiger/TIGER2025/ | Bulk shapefiles and geodatabase | Public domain | Free | Annual | tracts, block groups, counties, places, address ranges (EDGES/ADDRFEAT) | GEOID; already used by the pipeline for tracts | Yes | No | No | **Keep. Already in use; reuse for tract stamping of practice points.** |
| 11 | Census Geocoder, batch | https://geocoding.geo.census.gov/geocoder/ | API, batch CSV up to 10,000 rows and 5 MB per call | Public domain | Free, no key | Live | matched address, lat/lng, tract and block GEOIDs, match type and tie flag | address in, point out | Yes | No | No | **Keep. The geocoder for NPPES practice addresses.** Nominatim stays for interactive search only. |
| 12 | OpenAddresses | https://batch.openaddresses.io/data | Bulk CSV/GeoJSON per source | Mixed per source; mostly public domain or share-alike, licence file ships per source | Free | Continuous | address points with lat/lng, some with parcel id | address string; parcel id where present | Yes | No | No | **Keep as geocode fallback only for rows the Census geocoder cannot match**, and only from sources whose licence permits our use. Record the source licence per row. |
| 13 | County assessor GIS, already in the pipeline (see below) | per market | Bulk ArcGIS REST / open data downloads | County terms; public records | Free | Annual roll, some quarterly | APN, owner name, owner mailing address, site address, land use code, assessed value, geometry | APN; point-in-polygon | Yes | **Yes** | Flagged via exempt codes | **Keep. The only owner-of-record source.** |
| 14 | County recorder grantor/grantee index | per county, e.g. Orange County RecorderWorks | Portal search, one document at a time | Public records; images cost money | Free index, paid images | Live | grantor, grantee, doc type, instrument number, date | `DocRefNo` from parcel layer | No | **Yes** | No | **Keep for manual resolution where the roll withholds names (Orange County). Never bulk-scraped.** |

Verified live from this session: none of the URLs above could be fetched here
(egress policy). Items 1, 3, 4, 6, 8 and 11 were confirmed through web search
results dated 2026. Items 13 and 14 are the sources the prospector pipeline
already builds from and documents in its own source index.

Dropped outright: commercial NPI mirrors and "dump" sites, paid parcel
aggregators, any scrape of a host whose robots or terms refuse it, and the NPI
API as a bulk source.

## Existing parcel coverage and what is missing

Live markets in the prospector pipeline, from its `make_markets.py`:

| Market slug | County | Owner name in roll? | Owner mailing? | Coverage |
| --- | --- | --- | --- | --- |
| austin-tx | Travis County, TX | Yes (TCAD roll) | Yes | Central Austin slice only |
| washington-dc | District of Columbia | Yes (OTR roll, common ownership layer) | Yes | Core of the District only |
| nashville-tn | Davidson County, TN | Yes | Yes | Core neighbourhoods only |
| orange-county-ca | Orange County, CA | **No, withheld by county policy** | Yes (tax bill address) | Whole county |
| fort-lauderdale-fl | Broward County, FL | Yes | Yes | Fort Lauderdale addresses only |
| houston-tx | Harris County, TX | Yes | Yes | Whole county except single-family |
| las-vegas-nv | Clark County, NV | Yes | Yes | Whole county except detached single-family |
| phoenix-az | Maricopa County, AZ | Yes | Yes | Whole county |

Missing for a healthcare-lead build, and why it matters:

- **Austin, DC, Nashville are slices.** A practice outside the built slice has no
  parcel to join to. Those three need full-county rebuilds before the join is
  meaningful there.
- **Orange County has no owner names.** Practice points there yield APN, value
  and tax-bill mailing address, then a manual recorder lookup per parcel.
- **Broward is city-limited.** Practices in Hollywood, Pompano, Plantation and
  the rest of the county fall outside.
- **No coverage at all** in any other county. Target states and counties are
  the open decision; each new county is a `pipeline/fetch_<market>.py` in the
  prospector repo plus its code-map, following that repo's "Adding a market".

## Free pipeline, end to end

Every step runs on public files and free services. Nothing is purchased.

1. **Procure.** `node scripts/procure-data.mjs` fetches NPPES monthly + weeklies
   + deactivation and the NUCC CSV into `data/sources/` with a manifest.
   Subsequent runs fetch only new weeklies until the next monthly lands.
2. **Load providers.** Read the NPPES CSV by header name. Keep entity type,
   names, practice address, phone, all taxonomy codes and the primary flag,
   enumeration and update dates, and the deactivation list. Drop mailing
   addresses for entity type 1 at load time so they never enter a derived table.
   Apply weeklies in date order, then the deactivation file.
3. **Classify.** `taxonomy_code` joins `NUCC.code` for grouping, classification
   and specialisation. Store the NUCC version used. Filter to the practice types
   the lead plan wants (dental, physician groups, urgent care, imaging, PT,
   behavioural, veterinary is not in NUCC) by classification, not by name text.
4. **Group into practices.** Same normalised practice address + phone, or the
   same `group_pac_id` from the CMS clinician file, collapses individual NPIs
   into one practice site with a clinician count. Organisation NPIs (type 2)
   anchor the site when present.
5. **Geocode.** Census Geocoder batch, 10,000 addresses per call, returning
   point plus tract GEOID. Store match type and tie flag; a "Tie" or "No_Match"
   stays unplaced. OpenAddresses fallback only where its source licence allows.
6. **Stamp parcel.** Point-in-polygon against the market's parcel polygons
   (the pipeline already does this for tracts). Attach `apn`, `owner_name`,
   `owner_mailing`, `land_use`, `assessed_value`, and a `match` field:
   `point-in-parcel`, `address-exact`, `address-fuzzy`, or `unmatched`.
   Federal ownership is flagged from the roll's exempt codes and from an IOLP
   or FRPP address match; those rows are kept but marked.
7. **Publish.** One `layer-healthcare.geojson` per market plus its `layers.json`
   entry, through the existing ingest door. The app then draws it like any other
   published layer, colourable by a field (specialty grouping, clinician count,
   match quality), with no app change.
8. **Refresh.** Monthly on the NPPES cycle; NUCC on its January and July cycle;
   parcels on each county rebuild. Deactivated NPIs are removed, not hidden.

## Joins, exactly

```
nppes.taxonomy_code_n            ->  nucc.code                     (exact)
nppes.practice_address           ->  census_geocoder               (batch) -> point, tract GEOID
point                            ->  parcels.geometry              (point in polygon) -> apn
apn                              ->  roll.owner_name, owner_mailing, land_use, value
cms_clinicians.npi               ->  nppes.npi                     (exact) -> group_pac_id, group size
iolp.address / frpp.address      ->  parcels.site_address          (normalised) -> federal flag
sam.legal_name + address         ->  practice.org_name + address   (optional, needs key)
```

Unmatched at any hop is a valid state and is written as such.

## Legal and outreach notes

- **No outreach is built or sent from this data.** The plan produces a map layer
  and records; contacting anyone is a separate, approved step.
- **TCPA**: practice phone numbers from NPPES are business lines, but any
  autodialled or prerecorded call, and any text, still needs consent under
  47 U.S.C. 227 regardless of B2B status. Do not load these numbers into a
  dialer without a consent rule.
- **CAN-SPAM**: commercial email needs a working opt-out, a physical postal
  address, and no misleading headers. NPPES publishes no email addresses and
  none are inferred.
- **State real-estate broker rules**: soliciting a property owner to sell or
  lease is licensed activity in every state; owner-of-record data supports a
  licensed broker's work and does not replace the licence. Some states
  (Texas, Florida among the current markets) also regulate advertising and
  require the broker's licence disclosure on solicitations.
- **NUCC licence**: the taxonomy code set may need NUCC's commercial licence if
  it is redistributed inside the product. Storing it for internal lookup is
  fine; shipping the code table to customers is the case to check.
- **NPPES privacy**: CMS publishes the data under FOIA with the individual's
  mailing address included. This plan deliberately drops individual mailing
  addresses at load so no home-address list can be built from it.
- **County terms**: each market's assessor terms are recorded in the prospector
  repo's source index. Orange County withholds owner names by written policy
  and that is honoured, not routed around.

## Env vars

None are required for the NPPES and NUCC steps. `.env.example` lists every
optional variable the app and the scripts read, all empty. The one new
placeholder is `SAM_GOV_API_KEY`, used only if the optional SAM.gov extract step
is approved; unset means the step is skipped.

## Open decisions

1. Target states and counties for the first build.
2. Whether to rebuild Austin, DC and Nashville to full-county coverage first.
3. Which NUCC classifications define "healthcare practice" for the layer.
4. Whether the SAM.gov step is wanted at all.
