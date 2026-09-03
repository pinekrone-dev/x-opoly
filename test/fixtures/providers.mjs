/**
 * Files shaped exactly like the real ones, for the loader tests.
 *
 * The NPPES header below is the V.2 layout as CMS publishes it — the loader
 * reads columns by name, so the fixture must carry the real names, in a
 * realistic order, with the same fifteen taxonomy slots.
 */
import { csvLine } from '../../scripts/lib/csv.mjs'

const TAXONOMY_COLUMNS = []
for (let n = 1; n <= 15; n++) {
  TAXONOMY_COLUMNS.push(
    `Healthcare Provider Taxonomy Code_${n}`,
    `Provider License Number_${n}`,
    `Provider License Number State Code_${n}`,
    `Healthcare Provider Primary Taxonomy Switch_${n}`,
  )
}

export const NPPES_HEADER = [
  'NPI', 'Entity Type Code', 'Replacement NPI', 'Employer Identification Number (EIN)',
  'Provider Organization Name (Legal Business Name)', 'Provider Last Name (Legal Name)', 'Provider First Name',
  'Provider Middle Name', 'Provider Name Prefix Text', 'Provider Name Suffix Text', 'Provider Credential Text',
  'Provider Other Organization Name', 'Provider Other Organization Name Type Code', 'Provider Other Last Name',
  'Provider Other First Name', 'Provider Other Middle Name', 'Provider Other Name Prefix Text',
  'Provider Other Name Suffix Text', 'Provider Other Credential Text', 'Provider Other Last Name Type Code',
  'Provider First Line Business Mailing Address', 'Provider Second Line Business Mailing Address',
  'Provider Business Mailing Address City Name', 'Provider Business Mailing Address State Name',
  'Provider Business Mailing Address Postal Code', 'Provider Business Mailing Address Country Code (If outside U.S.)',
  'Provider Business Mailing Address Telephone Number', 'Provider Business Mailing Address Fax Number',
  'Provider First Line Business Practice Location Address', 'Provider Second Line Business Practice Location Address',
  'Provider Business Practice Location Address City Name', 'Provider Business Practice Location Address State Name',
  'Provider Business Practice Location Address Postal Code',
  'Provider Business Practice Location Address Country Code (If outside U.S.)',
  'Provider Business Practice Location Address Telephone Number', 'Provider Business Practice Location Address Fax Number',
  'Provider Enumeration Date', 'Last Update Date', 'NPI Deactivation Reason Code', 'NPI Deactivation Date',
  'NPI Reactivation Date', 'Provider Gender Code', 'Authorized Official Last Name', 'Authorized Official First Name',
  'Authorized Official Middle Name', 'Authorized Official Title or Position', 'Authorized Official Telephone Number',
  ...TAXONOMY_COLUMNS,
  'Is Sole Proprietor', 'Is Organization Subpart', 'Parent Organization LBN', 'Parent Organization TIN',
  'Certification Date',
]

/** One NPPES row from a sparse description; everything unnamed is blank. */
export function nppesRow(values) {
  const record = Object.fromEntries(NPPES_HEADER.map((name) => [name, '']))
  for (const [key, value] of Object.entries(values)) {
    if (!(key in record)) throw new Error(`fixture names a column NPPES does not have: ${key}`)
    record[key] = value
  }
  return NPPES_HEADER.map((name) => record[name])
}

export function nppesCsv(rows) {
  return [csvLine(NPPES_HEADER), ...rows.map((row) => csvLine(nppesRow(row)))].join('\r\n') + '\r\n'
}

export function organisation(npi, { name, address, city, state, zip, phone = '5125550100', taxonomy = '261QU0200X', mailing = null }) {
  return {
    NPI: npi,
    'Entity Type Code': '2',
    'Provider Organization Name (Legal Business Name)': name,
    'Provider First Line Business Practice Location Address': address,
    'Provider Business Practice Location Address City Name': city,
    'Provider Business Practice Location Address State Name': state,
    'Provider Business Practice Location Address Postal Code': zip,
    'Provider Business Practice Location Address Country Code (If outside U.S.)': 'US',
    'Provider Business Practice Location Address Telephone Number': phone,
    'Provider First Line Business Mailing Address': mailing?.address ?? 'PO BOX 100',
    'Provider Business Mailing Address City Name': mailing?.city ?? city,
    'Provider Business Mailing Address State Name': mailing?.state ?? state,
    'Provider Business Mailing Address Postal Code': mailing?.zip ?? zip,
    'Provider Enumeration Date': '05/23/2007',
    'Last Update Date': '01/15/2026',
    'Healthcare Provider Taxonomy Code_1': taxonomy,
    'Healthcare Provider Primary Taxonomy Switch_1': 'Y',
    'Authorized Official Last Name': 'DOE',
  }
}

export function individual(npi, { first, last, address, city, state, zip, home, taxonomy = '207Q00000X', secondary = null }) {
  const row = {
    NPI: npi,
    'Entity Type Code': '1',
    'Provider Last Name (Legal Name)': last,
    'Provider First Name': first,
    'Provider Credential Text': 'M.D.',
    'Provider First Line Business Practice Location Address': address,
    'Provider Business Practice Location Address City Name': city,
    'Provider Business Practice Location Address State Name': state,
    'Provider Business Practice Location Address Postal Code': zip,
    'Provider Business Practice Location Address Country Code (If outside U.S.)': 'US',
    // The mailing address of a person: typically a home, and the thing the
    // loader must throw away.
    'Provider First Line Business Mailing Address': home.address,
    'Provider Business Mailing Address City Name': home.city,
    'Provider Business Mailing Address State Name': home.state,
    'Provider Business Mailing Address Postal Code': home.zip,
    'Provider Enumeration Date': '06/01/2010',
    'Last Update Date': '02/02/2026',
    'Provider Gender Code': 'F',
    'Healthcare Provider Taxonomy Code_1': taxonomy,
    'Provider License Number_1': 'L12345',
    'Provider License Number State Code_1': state,
    'Healthcare Provider Primary Taxonomy Switch_1': 'Y',
    'Is Sole Proprietor': 'N',
  }
  if (secondary) {
    row['Healthcare Provider Taxonomy Code_2'] = secondary
    row['Healthcare Provider Primary Taxonomy Switch_2'] = 'N'
  }
  return row
}

/** A deactivation, as NPPES publishes it: the NPI and the date, nothing else. */
export function deactivation(npi, date = '08/20/2026') {
  return { NPI: npi, 'NPI Deactivation Reason Code': 'DT', 'NPI Deactivation Date': date }
}

export const NUCC_HEADER = ['Code', 'Grouping', 'Classification', 'Specialization', 'Definition', 'Notes', 'Display Name', 'Section', 'Effective Date', 'Deactivation Date', 'Last Modified Date']

export function nuccCsv(rows) {
  return [csvLine(NUCC_HEADER), ...rows.map((row) => csvLine(NUCC_HEADER.map((name) => row[name] ?? '')))].join('\n') + '\n'
}

export const NUCC_ROWS = [
  { Code: '207Q00000X', Grouping: 'Allopathic & Osteopathic Physicians', Classification: 'Family Medicine', Specialization: '', Definition: 'A physician who, "by training", cares for the whole family.', 'Display Name': 'Family Medicine Physician', Section: 'Individual', 'Effective Date': '1/1/2003' },
  { Code: '1223G0001X', Grouping: 'Dental Providers', Classification: 'Dentist', Specialization: 'General Practice', Definition: 'A general dentist.', 'Display Name': 'General Practice Dentistry', Section: 'Individual', 'Effective Date': '7/1/2003' },
  { Code: '261QU0200X', Grouping: 'Ambulatory Health Care Facilities', Classification: 'Clinic/Center', Specialization: 'Urgent Care', Definition: 'Urgent care, walk-in.', 'Display Name': 'Urgent Care Clinic/Center', Section: 'Non-Individual', 'Effective Date': '1/1/2003' },
  { Code: '2085R0202X', Grouping: 'Allopathic & Osteopathic Physicians', Classification: 'Radiology', Specialization: 'Diagnostic Radiology', Definition: 'Reads images.', 'Display Name': 'Diagnostic Radiology Physician', Section: 'Individual', 'Effective Date': '1/1/2003' },
]

/** A tiny market: three square parcels around downtown Austin. */
export function parcels() {
  const square = (id, lng, lat, props) => ({
    type: 'Feature',
    properties: { id, ...props },
    geometry: {
      type: 'Polygon',
      coordinates: [[[lng, lat], [lng + 0.002, lat], [lng + 0.002, lat + 0.002], [lng, lat + 0.002], [lng, lat]]],
    },
  })
  return {
    type: 'FeatureCollection',
    features: [
      square('P-1', -97.744, 30.267, { ow: 'CONGRESS AVENUE HOLDINGS LLC', ma: 'PO BOX 1 AUSTIN TX 78701', mv: 12500000, at: 'Office' }),
      square('P-2', -97.740, 30.267, { ow: 'MEDICAL ARTS PARTNERS LP', ma: '200 MAIN ST DALLAS TX 75201', mv: 4300000, at: 'Medical office' }),
      // A parcel with a hole, so the hole is tested too.
      {
        type: 'Feature',
        properties: { id: 'P-3', ow: 'CITY OF AUSTIN', ma: '', mv: 0, at: 'Exempt' },
        geometry: {
          type: 'MultiPolygon',
          coordinates: [[
            [[-97.736, 30.267], [-97.730, 30.267], [-97.730, 30.273], [-97.736, 30.273], [-97.736, 30.267]],
            [[-97.734, 30.269], [-97.732, 30.269], [-97.732, 30.271], [-97.734, 30.271], [-97.734, 30.269]],
          ]],
        },
      },
    ],
  }
}

/** A geocoder that answers from a table instead of the Census. */
export function stubGeocoder(answers) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const file = init.body.get('addressFile')
    const text = await file.text()
    calls.push(text)
    const lines = text.trim().split('\n')
    const out = lines.map((line) => {
      const [id, street, city, state, zip] = line.split(',').map((s) => s.replace(/^"|"$/g, ''))
      const key = `${street}|${city}|${state}|${zip}`.toLowerCase()
      const hit = answers[key]
      if (!hit) return csvLine([id, `${street}, ${city}, ${state}, ${zip}`, 'No_Match'])
      if (hit.tie) return csvLine([id, `${street}, ${city}, ${state}, ${zip}`, 'Tie'])
      return csvLine([id, `${street}, ${city}, ${state}, ${zip}`, 'Match', 'Exact', `${street.toUpperCase()}, ${city.toUpperCase()}, ${state}, ${zip}`, `${hit.lng},${hit.lat}`, '12345', 'L', '48', '453', '001100', '1001'])
    })
    return new Response(out.join('\n') + '\n', { status: 200 })
  }
  return { fetchImpl, calls }
}
