/**
 * A parcel's permit history and code cases, from the city that keeps them.
 *
 * Asked live when a card opens, not stored: cities update these daily, the
 * questions are one parcel at a time, and holding every city's permit
 * history in the parcel store would cost write budget this product does not
 * have. Each source is a public open-data API (Socrata, CKAN, Carto) queried
 * by the most exact key the city publishes for the parcel — New York's BBL,
 * Philadelphia's OPA account, Los Angeles's APN, Boston's parcel id,
 * Travis's TCAD id — and by street address only where the city publishes
 * nothing better (Chicago, Dallas, the code cases in Los Angeles, Boston and
 * Austin). An address match can miss a record filed under a range or a
 * misspelling; the card says which sources matched by address.
 *
 * Every source is read independently and a failure is reported as that
 * source's, so one city server being down never blanks the section.
 */

const TIMEOUT_MS = 10000
const PER_SOURCE = 25

const SUFFIXES = new Set([
  'ST', 'STREET', 'AVE', 'AV', 'AVENUE', 'BLVD', 'BOULEVARD', 'RD', 'ROAD', 'DR', 'DRIVE', 'LN', 'LANE',
  'CT', 'COURT', 'PL', 'PLACE', 'PKWY', 'PARKWAY', 'WAY', 'TER', 'TERRACE', 'CIR', 'CIRCLE', 'HWY',
  'HIGHWAY', 'SQ', 'PLZ', 'PLAZA', 'TRL', 'TRAIL', 'XING', 'EXPY', 'FWY', 'ROW', 'WALK', 'LOOP', 'PATH',
])
const DIRECTIONS = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW'])

/**
 * A street address in the pieces city datasets file them under. "76-84
 * Boylston St" is number 76, name BOYLSTON; "7810 S Jeffery Blvd" is 7810, S,
 * JEFFERY, BLVD. Only letters, digits and spaces survive, which is also what
 * makes the pieces safe to put in a query.
 */
export function streetParts(address) {
  const text = String(address ?? '')
    .toUpperCase()
    .replace(/\s+(#|UNIT|APT|STE|SUITE)\s*\S+$/, '')
    .replace(/[^A-Z0-9 -]/g, ' ')
    .trim()
  const tokens = text.split(/\s+/).filter(Boolean)
  const lead = /^(\d+)/.exec(tokens[0] ?? '')
  if (!lead) return null
  tokens.shift()
  let direction = ''
  if (tokens.length > 1 && DIRECTIONS.has(tokens[0])) direction = tokens.shift()
  let suffix = ''
  if (tokens.length > 1 && SUFFIXES.has(tokens[tokens.length - 1])) suffix = tokens.pop()
  const name = tokens.join(' ').replace(/-/g, ' ').trim()
  if (!name) return null
  return { number: lead[1], direction, name, suffix }
}

const digits = (value) => String(value ?? '').replace(/\D/g, '')

// One retry: these servers answer the first query after a quiet spell
// slowly and the same query a moment later in half a second.
async function getJson(url, fetcher, tries = 2) {
  try {
    const res = await fetcher(url, {
      headers: { accept: 'application/json', 'user-agent': 'LandQuotient/1.0 (+https://landquotient.com)' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`${res.status}`)
    return await res.json()
  } catch (cause) {
    if (tries > 1) return getJson(url, fetcher, tries - 1)
    throw cause
  }
}

const soda = (host, dataset, params) => {
  const query = new URLSearchParams({ $limit: String(PER_SOURCE), ...params })
  return `https://${host}/resource/${dataset}.json?${query.toString()}`
}

const day = (value) => {
  const text = String(value ?? '')
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(text)
  if (iso) return iso[1]
  const us = /^(\d{2})\/(\d{2})\/(\d{2,4})$/.exec(text)
  if (us) return `${us[3].length === 2 ? `20${us[3]}` : us[3]}-${us[1]}-${us[2]}`
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(text)
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`
  return null
}

/*
 * A Socrata geo filter around the parcel: its box from the store, widened by
 * about thirty metres because a permit is geocoded to the street frontage,
 * not the lot. Chicago's permit history is searched this way because a
 * street filter alone scans every permit the city has issued (13 to 30
 * seconds); inside a box the city's spatial index answers in half a second.
 * The house number is still required, so the widened box cannot pull in the
 * neighbours.
 */
const PAD = 0.0003
function nearParcel(parcel, column = 'location') {
  const bb = Array.isArray(parcel.bb) ? parcel.bb.map(Number) : null
  if (!bb || bb.length !== 4 || !bb.every(Number.isFinite)) return null
  const [w, s, e, n] = bb
  return `within_box(${column},${(n + PAD).toFixed(6)},${(w - PAD).toFixed(6)},${(s - PAD).toFixed(6)},${(e + PAD).toFixed(6)})`
}

// No expiry on file reads as unexpired: the status already said open.
const unexpired = (value) => {
  const date = day(value)
  return !date || date >= new Date().toISOString().slice(0, 10)
}

const newestFirst = (rows) =>
  rows.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? ''))).slice(0, PER_SOURCE)

const clean = (value) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text || null
}

/*
 * The sources, by market. Each has a `kind` (permit or case), a label, how
 * it matches (`by`), a portal a person can check by hand, and `read(parcel,
 * fetch)` returning rows of { id, date, type, status, open, description }.
 */
const NYC_BOROUGHS = { 1: 'MANHATTAN', 2: 'BRONX', 3: 'BROOKLYN', 4: 'QUEENS', 5: 'STATEN ISLAND' }
const bbl = (parcel) => {
  const id = digits(parcel.gid || parcel.id)
  if (id.length !== 10) return null
  return { boro: id[0], block: id.slice(1, 6), lot: id.slice(6) }
}

export const SOURCES = {
  'new-york-ny': [
    {
      kind: 'permit',
      label: 'DOB NOW permits',
      by: 'BBL',
      portal: 'https://a810-dobnow.nyc.gov/publish/',
      async read(parcel, fetcher) {
        const key = bbl(parcel)
        if (!key) return []
        const rows = await getJson(
          soda('data.cityofnewyork.us', 'rbx6-tga4', { bbl: `${key.boro}${key.block}${key.lot}`, $order: 'issued_date DESC' }),
          fetcher,
        )
        return rows.map((r) => ({
          id: clean(r.work_permit) ?? clean(r.job_filing_number),
          date: day(r.issued_date ?? r.approved_date),
          type: clean(r.work_type),
          status: clean(r.permit_status),
          open: !/signed.?off|expired|revoked/i.test(r.permit_status ?? '') && unexpired(r.expired_date),
          description: clean(r.job_description),
        }))
      },
    },
    {
      kind: 'permit',
      label: 'DOB permits (BIS)',
      by: 'BBL',
      portal: 'https://a810-bisweb.nyc.gov/bisweb/',
      async read(parcel, fetcher) {
        const key = bbl(parcel)
        if (!key || !NYC_BOROUGHS[key.boro]) return []
        const rows = await getJson(
          // No $order: the dataset is 3.9 million permits and sorting on
          // its text date timed out. A lot rarely has more than a couple of
          // hundred, so they are fetched whole and sorted here.
          soda('data.cityofnewyork.us', 'ipu4-2q9a', {
            borough: NYC_BOROUGHS[key.boro],
            block: key.block,
            lot: key.lot.padStart(5, '0'),
            $limit: '200',
          }),
          fetcher,
        )
        return newestFirst(rows.map((r) => ({
          id: clean(r.job__) && clean(r.permit_sequence__) ? `${r.job__}-${r.permit_sequence__}` : clean(r.job__),
          date: day(r.issuance_date),
          type: [clean(r.job_type), clean(r.work_type)].filter(Boolean).join(' · ') || null,
          status: clean(r.permit_status),
          // An issued permit is open only until it expires; most of a lot's
          // BIS history is permits issued and long since lapsed.
          open: /issued|in process/i.test(r.permit_status ?? '') && unexpired(r.expiration_date),
          description: clean(r.permit_type),
        })))
      },
    },
    {
      kind: 'case',
      label: 'HPD housing violations',
      by: 'BBL',
      portal: 'https://hpdonline.nyc.gov/',
      async read(parcel, fetcher) {
        const key = bbl(parcel)
        if (!key) return []
        const rows = await getJson(
          soda('data.cityofnewyork.us', 'wvxf-dwi5', {
            boroid: key.boro,
            block: String(Number(key.block)),
            lot: String(Number(key.lot)),
            $order: 'inspectiondate DESC',
          }),
          fetcher,
        )
        return rows.map((r) => ({
          id: clean(r.violationid),
          date: day(r.inspectiondate),
          type: r.class ? `Class ${r.class}` : null,
          status: clean(r.currentstatus) ?? clean(r.violationstatus),
          open: /^open$/i.test(r.violationstatus ?? ''),
          description: clean(r.novdescription),
        }))
      },
    },
    {
      kind: 'case',
      label: 'DOB violations',
      by: 'BBL',
      portal: 'https://a810-bisweb.nyc.gov/bisweb/',
      async read(parcel, fetcher) {
        const key = bbl(parcel)
        if (!key) return []
        const rows = await getJson(
          soda('data.cityofnewyork.us', '3h2n-5cm9', {
            boro: key.boro,
            block: key.block,
            lot: key.lot.padStart(5, '0'),
            $order: 'issue_date DESC',
          }),
          fetcher,
        )
        return rows.map((r) => ({
          id: clean(r.number) ?? clean(r.violation_number),
          date: day(r.issue_date),
          type: clean(r.violation_type)?.split(/\s{2,}/)[0] ?? null,
          status: clean(r.violation_category),
          open: /active/i.test(r.violation_category ?? ''),
          description: clean(r.description),
        }))
      },
    },
  ],

  'chicago-il': [
    {
      kind: 'permit',
      label: 'Building permits',
      by: 'address and location',
      portal: 'https://webapps1.chicago.gov/buildingrecords/',
      async read(parcel, fetcher) {
        const at = streetParts(parcel.ad)
        if (!at) return []
        // Exact names, and sorted here: a LIKE with an $order over the
        // whole permit history timed out. The dataset files the street with
        // its type ("JEFFERY BLVD"), so both spellings are asked for.
        const names = [...new Set([`${at.name} ${at.suffix}`.trim(), at.name])].map((n) => `'${n}'`).join(',')
        const box = nearParcel(parcel)
        const where = box
          ? [box, `street_number='${at.number}'`]
          : [`street_number='${at.number}'`, `street_name in (${names})`]
        if (at.direction && !box) where.push(`street_direction='${at.direction}'`)
        const rows = await getJson(
          soda('data.cityofchicago.org', 'ydr8-5enu', { $where: where.join(' AND '), $limit: '200' }),
          fetcher,
        )
        return newestFirst(rows.map((r) => ({
          id: clean(r.permit_),
          date: day(r.issue_date),
          type: clean(r.permit_type)?.replace(/^PERMIT - /, '') ?? null,
          status: clean(r.permit_status),
          open: /^active$/i.test(r.permit_status ?? ''),
          description: clean(r.work_description),
        })))
      },
    },
    {
      kind: 'case',
      label: 'Building violations',
      by: 'address and location',
      portal: 'https://webapps1.chicago.gov/buildingrecords/',
      async read(parcel, fetcher) {
        const at = streetParts(parcel.ad)
        if (!at) return []
        // Exact match and sorted here, for the same reason as the permits.
        const box = nearParcel(parcel)
        const where = box ? [box, `street_number='${at.number}'`] : [`street_number='${at.number}'`, `street_name='${at.name}'`]
        if (at.direction && !box) where.push(`street_direction='${at.direction}'`)
        const rows = await getJson(
          soda('data.cityofchicago.org', '22u3-xenr', { $where: where.join(' AND '), $limit: '200' }),
          fetcher,
        )
        return newestFirst(rows.map((r) => ({
          id: clean(r.id),
          date: day(r.violation_date),
          type: clean(r.department_bureau),
          status: clean(r.violation_status),
          open: /^open$/i.test(r.violation_status ?? ''),
          description: clean(r.violation_description),
        })))
      },
    },
  ],

  'philadelphia-pa': [
    {
      kind: 'permit',
      label: 'L&I permits',
      by: 'OPA account',
      portal: 'https://atlas.phila.gov/',
      async read(parcel, fetcher) {
        const opa = digits(parcel.gid)
        if (opa.length !== 9) return []
        const sql = `SELECT permitnumber, permittype, typeofwork, approvedscopeofwork, permitissuedate, status
          FROM permits WHERE opa_account_num = '${opa}' ORDER BY permitissuedate DESC LIMIT ${PER_SOURCE}`
        const body = await getJson(`https://phl.carto.com/api/v2/sql?q=${encodeURIComponent(sql)}`, fetcher)
        return (body.rows ?? []).map((r) => ({
          id: clean(r.permitnumber),
          date: day(r.permitissuedate),
          type: [clean(r.permittype), clean(r.typeofwork)].filter(Boolean).join(' · ') || null,
          status: clean(r.status),
          open: !/completed|expired|cancel/i.test(r.status ?? ''),
          description: clean(r.approvedscopeofwork),
        }))
      },
    },
    {
      kind: 'case',
      label: 'L&I violations',
      by: 'OPA account',
      portal: 'https://atlas.phila.gov/',
      async read(parcel, fetcher) {
        const opa = digits(parcel.gid)
        if (opa.length !== 9) return []
        const sql = `SELECT casenumber, violationnumber, violationcodetitle, violationstatus, casestatus, violationdate
          FROM violations WHERE opa_account_num = '${opa}' ORDER BY violationdate DESC LIMIT ${PER_SOURCE}`
        const body = await getJson(`https://phl.carto.com/api/v2/sql?q=${encodeURIComponent(sql)}`, fetcher)
        return (body.rows ?? []).map((r) => ({
          id: clean(r.violationnumber) ?? clean(r.casenumber),
          date: day(r.violationdate),
          type: clean(r.casestatus),
          status: clean(r.violationstatus),
          open: /^open$/i.test(r.violationstatus ?? ''),
          description: clean(r.violationcodetitle),
        }))
      },
    },
  ],

  'los-angeles-ca': [
    {
      kind: 'permit',
      label: 'LADBS permits',
      by: 'APN',
      portal: 'https://www.ladbsservices2.lacity.org/OnlineServices/',
      async read(parcel, fetcher) {
        const apn = digits(parcel.gid || parcel.id)
        if (apn.length !== 10) return []
        const rows = await getJson(soda('data.lacity.org', 'pi9x-tg5x', { apn, $order: 'issue_date DESC' }), fetcher)
        return rows.map((r) => ({
          id: clean(r.permit_nbr),
          date: day(r.issue_date ?? r.submitted_date),
          type: [clean(r.permit_type), clean(r.permit_sub_type)].filter(Boolean).join(' · ') || null,
          status: clean(r.status_desc),
          open: !/cofo issued|permit finaled|expired|closed/i.test(r.status_desc ?? ''),
          description: clean(r.work_desc) ?? clean(r.use_desc),
        }))
      },
    },
    {
      kind: 'case',
      label: 'LADBS open code cases',
      by: 'address',
      portal: 'https://www.ladbsservices2.lacity.org/OnlineServices/',
      async read(parcel, fetcher) {
        const at = streetParts(parcel.ad)
        if (!at) return []
        const where = [`stno='${at.number}'`, `upper(stname)='${at.name}'`]
        if (at.direction) where.push(`predir='${at.direction}'`)
        const rows = await getJson(
          soda('data.lacity.org', 'u82d-eh7z', { $where: where.join(' AND '), $order: 'adddttm DESC' }),
          fetcher,
        )
        return rows.map((r) => ({
          id: clean(r.apno),
          date: day(r.adddttm),
          type: clean(r.aptype),
          status: r.stat === 'O' ? 'Open' : clean(r.stat),
          open: r.stat === 'O',
          description: null,
        }))
      },
    },
  ],

  'boston-ma': [
    {
      kind: 'permit',
      label: 'ISD building permits',
      by: 'parcel id',
      portal: 'https://www.boston.gov/departments/inspectional-services',
      async read(parcel, fetcher) {
        const pid = digits(parcel.gid)
        if (!pid) return []
        const sql = `SELECT permitnumber, permittypedescr, worktype, description, comments, issued_date, status
          FROM "6ddcd912-32a0-43df-9908-63574f8c7e77" WHERE parcel_id = '${Number(pid)}' ORDER BY issued_date DESC LIMIT ${PER_SOURCE}`
        const body = await getJson(`https://data.boston.gov/api/3/action/datastore_search_sql?sql=${encodeURIComponent(sql)}`, fetcher)
        return (body.result?.records ?? []).map((r) => ({
          id: clean(r.permitnumber),
          date: day(r.issued_date),
          type: clean(r.permittypedescr),
          status: clean(r.status),
          open: /^open$/i.test(r.status ?? ''),
          description: clean(r.comments)?.slice(0, 240) ?? clean(r.description),
        }))
      },
    },
    {
      kind: 'case',
      label: 'Building and property violations',
      by: 'address',
      portal: 'https://www.boston.gov/departments/inspectional-services',
      async read(parcel, fetcher) {
        const at = streetParts(parcel.ad)
        if (!at) return []
        const sql = `SELECT case_no, status, status_dttm, code, description FROM "800a2663-1d6a-46e7-9356-bedb70f5332c"
          WHERE violation_stno = '${at.number}' AND upper(violation_street) = '${at.name}' ORDER BY status_dttm DESC LIMIT ${PER_SOURCE}`
        const body = await getJson(`https://data.boston.gov/api/3/action/datastore_search_sql?sql=${encodeURIComponent(sql)}`, fetcher)
        return (body.result?.records ?? []).map((r) => ({
          id: clean(r.case_no),
          date: day(r.status_dttm),
          type: clean(r.code),
          status: clean(r.status),
          open: /^open$/i.test(r.status ?? ''),
          description: clean(r.description),
        }))
      },
    },
  ],

  'austin-tx': [
    {
      kind: 'permit',
      label: 'Construction permits',
      by: 'TCAD id',
      portal: 'https://abc.austintexas.gov/web/permit/public-search-other',
      async read(parcel, fetcher) {
        const tcad = digits(parcel.gid)
        if (tcad.length !== 10) return []
        const rows = await getJson(
          soda('data.austintexas.gov', '3syk-w9eu', { tcad_id: tcad, $order: 'issue_date DESC' }),
          fetcher,
        )
        return rows.map((r) => ({
          id: clean(r.permit_number),
          date: day(r.issue_date ?? r.applieddate),
          type: [clean(r.permit_type_desc), clean(r.work_class)].filter(Boolean).join(' · ') || null,
          status: clean(r.status_current),
          open: !/final|expired|void|withdrawn|closed/i.test(r.status_current ?? ''),
          description: clean(r.description),
        }))
      },
    },
    {
      kind: 'case',
      label: 'Code enforcement cases',
      by: 'address',
      portal: 'https://www.austintexas.gov/department/code',
      async read(parcel, fetcher) {
        const at = streetParts(parcel.ad)
        if (!at) return []
        const street = [at.number, at.direction, at.name].filter(Boolean).join(' ')
        const rows = await getJson(
          soda('data.austintexas.gov', '6wtj-zbtb', { $where: `upper(address) like '${street}%'`, $order: 'opened_date DESC' }),
          fetcher,
        )
        return rows.map((r) => ({
          id: clean(r.case_id),
          date: day(r.opened_date),
          type: clean(r.description) ?? clean(r.case_type),
          status: clean(r.status),
          open: !/closed/i.test(r.status ?? ''),
          description: clean(r.last_update),
        }))
      },
    },
  ],

  'dallas-tx': [
    {
      kind: 'permit',
      label: 'Building permits',
      by: 'address',
      portal: 'https://dallascityhall.com/departments/sustainabledevelopment/buildinginspection/',
      async read(parcel, fetcher) {
        const at = streetParts(parcel.ad)
        if (!at) return []
        const street = [at.number, at.direction, at.name].filter(Boolean).join(' ')
        const rows = await getJson(
          soda('www.dallasopendata.com', 'e7gq-4sah', { $where: `upper(street_address) like '${street}%'` }),
          fetcher,
        )
        return newestFirst(
          rows.map((r) => ({
            id: clean(r.permit_number),
            date: day(r.issued_date),
            type: clean(r.permit_type),
            status: null,
            open: false,
            description: clean(r.work_description),
          })),
        )
      },
    },
  ],
}

/*
 * Mortgages on record: the recorded instrument that secures a promissory
 * note. The note itself is a private contract and is filed nowhere; the
 * mortgage names the borrower (almost always who signed the note) and the
 * lender, and a later satisfaction says it was paid off. Only cities that
 * publish their recorder's index as open data are here — New York (ACRIS,
 * keyed by borough, block and lot) and Philadelphia (the Records
 * Department's transfer index, keyed by OPA account). Elsewhere the index
 * is behind a portal or sold, and is not routed around.
 *
 * Each loan row: { id, date, type, amount, borrowers, lenders, satisfied,
 * satisfiedOn }. `satisfied` is true when a satisfaction or release was
 * recorded later naming the same lender, null when none was: a
 * missing satisfaction is not proof the loan is open (lenders file them
 * late, and a refinance can pay off through a consolidation instead).
 */
const PARTY_NOISE = /\b(THE|INC|LLC|L L C|LP|L P|LLP|CORP|CORPORATION|CO|COMPANY|N ?A|NATIONAL ASSOCIATION|FSB|ITS SUCCESSORS AND ASSIGNS|AS NOMINEE FOR)\b/g
const partyKey = (name) =>
  String(name ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(PARTY_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
export function sameParty(a, b) {
  const x = partyKey(a)
  const y = partyKey(b)
  if (!x || !y) return false
  if (x === y || x.includes(y) || y.includes(x)) return true
  const head = (k) => k.split(' ').slice(0, 2).join(' ')
  return head(x).length > 5 && head(x) === head(y)
}

/*
 * Pair loans with their satisfactions. A satisfaction is the lender's
 * document, so it is matched on the lender's name, never the borrower's: a
 * borrower with three loans would otherwise see one payoff mark all three
 * paid. Oldest loan first, and each satisfaction pays off one loan only.
 */
function settle(loans, releases) {
  const used = new Set()
  const byDate = (a, b) => String(a.date ?? '').localeCompare(String(b.date ?? ''))
  const ordered = [...releases].sort(byDate)
  for (const loan of [...loans].sort(byDate)) {
    const match = ordered.find(
      (r, i) =>
        !used.has(i) &&
        (!loan.date || !r.date || r.date >= loan.date) &&
        r.parties.some((p) => loan.lenders.some((n) => sameParty(p, n))),
    )
    if (match) used.add(ordered.indexOf(match))
    loan.satisfied = match ? true : null
    loan.satisfiedOn = match?.date ?? null
  }
  return loans
}

const ACRIS_LOANS = new Set(['MTGE', 'M&CON', 'AGMT', 'SMTG'])
const ACRIS_RELEASES = new Set(['SAT', 'PSAT'])
const ACRIS_TYPES = { MTGE: 'Mortgage', 'M&CON': 'Mortgage and consolidation', AGMT: 'Mortgage agreement', SMTG: 'Subordinate mortgage' }
const quoted = (ids) => ids.map((id) => `'${String(id).replace(/[^A-Za-z0-9_-]/g, '')}'`).join(',')

export const LOANS = {
  'new-york-ny': {
    label: 'ACRIS mortgages',
    by: 'BBL',
    portal: 'https://a836-acris.nyc.gov/DS/DocumentSearch/BBL',
    async read(parcel, fetcher) {
      const key = bbl(parcel)
      if (!key) return []
      const legals = await getJson(
        soda('data.cityofnewyork.us', '8h5j-fqxa', {
          borough: key.boro,
          block: String(Number(key.block)),
          lot: String(Number(key.lot)),
          $select: 'document_id',
          $limit: '300',
        }),
        fetcher,
      )
      const ids = [...new Set(legals.map((r) => r.document_id).filter(Boolean))]
      if (!ids.length) return []
      const types = [...ACRIS_LOANS, ...ACRIS_RELEASES].map((t) => `'${t}'`).join(',')
      const master = await getJson(
        soda('data.cityofnewyork.us', 'bnx9-e6tj', {
          $where: `document_id in (${quoted(ids)}) AND doc_type in (${types})`,
          $select: 'document_id,doc_type,document_date,document_amt',
          $limit: '200',
        }),
        fetcher,
      )
      if (!master.length) return []
      const parties = await getJson(
        soda('data.cityofnewyork.us', '636b-3b5g', {
          $where: `document_id in (${quoted(master.map((r) => r.document_id))})`,
          $select: 'document_id,party_type,name',
          $limit: '1000',
        }),
        fetcher,
      )
      const named = new Map()
      for (const p of parties) {
        const entry = named.get(p.document_id) ?? { 1: [], 2: [] }
        if (p.party_type === '1' || p.party_type === '2') entry[p.party_type].push(clean(p.name))
        named.set(p.document_id, entry)
      }
      const loans = []
      const releases = []
      for (const r of master) {
        const who = named.get(r.document_id) ?? { 1: [], 2: [] }
        if (ACRIS_RELEASES.has(r.doc_type)) {
          releases.push({ date: day(r.document_date), parties: [...who[1], ...who[2]].filter(Boolean) })
          continue
        }
        loans.push({
          id: r.document_id,
          date: day(r.document_date),
          type: ACRIS_TYPES[r.doc_type] ?? r.doc_type,
          amount: Number(r.document_amt) > 0 ? Number(r.document_amt) : null,
          // On an ACRIS mortgage, party 1 is the mortgagor (the borrower)
          // and party 2 the mortgagee (the lender).
          borrowers: [...new Set(who[1].filter(Boolean))],
          lenders: [...new Set(who[2].filter(Boolean))],
        })
      }
      return newestFirst(settle(loans, releases))
    },
  },

  'philadelphia-pa': {
    label: 'Recorded mortgages',
    by: 'OPA account',
    portal: 'https://epay.phila-records.com/phillyepay/web/',
    async read(parcel, fetcher) {
      const opa = digits(parcel.gid)
      if (opa.length !== 9) return []
      const sql = `SELECT document_id, document_type, grantors, grantees, document_date, recording_date
        FROM rtt_summary WHERE opa_account_num = '${opa}'
          AND document_type IN ('MORTGAGE', 'SATISFACTION OF MORTGAGE', 'RELEASE OF MORTGAGE')
        ORDER BY recording_date DESC LIMIT 80`
      const body = await getJson(`https://phl.carto.com/api/v2/sql?q=${encodeURIComponent(sql)}`, fetcher)
      const split = (text) => String(text ?? '').split(/\s*;\s*|\s*\|\s*/).map(clean).filter(Boolean)
      const loans = []
      const releases = []
      for (const r of body.rows ?? []) {
        const date = day(r.document_date ?? r.recording_date)
        if (r.document_type === 'MORTGAGE') {
          // The index files a mortgage's mortgagor as grantor and the
          // lender as grantee.
          loans.push({ id: String(r.document_id), date, type: 'Mortgage', amount: null, borrowers: split(r.grantors), lenders: split(r.grantees) })
        } else {
          releases.push({ date, parties: [...split(r.grantors), ...split(r.grantees)] })
        }
      }
      return newestFirst(settle(loans, releases))
    },
  },
}

/** Whether this market has a mortgage source. */
export const loansSupported = (market) => Boolean(LOANS[market])

/** One parcel's recorded mortgages, or null where the city publishes none. */
export async function parcelLoans(market, parcel, { fetcher = fetch } = {}) {
  const source = LOANS[market]
  if (!source) return null
  const base = { label: source.label, by: source.by, portal: source.portal }
  try {
    return { ...base, rows: await source.read(parcel, fetcher) }
  } catch {
    return { ...base, rows: [], error: 'could not be read just now' }
  }
}

/** Whether this market has any permit or code-case source. */
export const recordsSupported = (market) => Boolean(SOURCES[market] || LOANS[market])

/**
 * Read every source for one parcel. Sources run at once, each with its own
 * timeout, and each answers for itself: rows, or the reason it could not.
 */
export async function parcelRecords(market, parcel, { fetcher = fetch } = {}) {
  const sources = SOURCES[market] ?? []
  const loans = parcelLoans(market, parcel, { fetcher })
  const answers = await Promise.all(
    sources.map(async (source) => {
      const base = { kind: source.kind, label: source.label, by: source.by, portal: source.portal }
      try {
        const rows = (await source.read(parcel, fetcher)).filter((row) => row.id || row.description)
        return { ...base, rows, open: rows.filter((row) => row.open).length }
      } catch (cause) {
        return { ...base, rows: [], open: 0, error: 'could not be read just now' }
      }
    }),
  )
  return { market, supported: sources.length > 0 || Boolean(LOANS[market]), sources: answers, loans: await loans }
}
