/**
 * City of Los Angeles zoning report: the single-family zones (RA, RE9-RE40,
 * RS, R1 and its variation zones), on flat lots and in the Hillside Area.
 *
 * Every number here is quoted from the code, as collected in prospector's
 * research/la-zoning/lamc-residential.md (government code index excerpts,
 * cross-checked against City Planning's Generalized Summary of Zoning
 * Regulations, January 2026, and Planning's Hillside checklist CP-4061).
 * Where the code text could not be read, the line says so and asks for
 * review instead of guessing: the corner lot street-side yard and the flag
 * lot front line (12.22 C), and floor area in Height Districts 2 to 4.
 *
 * Input:
 *   zone  parseZone() output
 *   lot   { area_sf, width_ft, depth_ft, type, hillside, coastal (true,
 *           false or undefined when not checked), face: { prevailing_ft,
 *           share, lots_on_face, range_ft }, slope: { bands: [{band, sf}] } }
 * Output: { covered, family, lines: [...], flags: [...] }, each line
 *   { topic, label, value, unit, status, cite: { section, ord }, basis }
 *   status: 'computed' | 'estimate' (rests on measured lot data) | 'review'
 */

const SUMMARY = 'Planning, Generalized Summary of Zoning Regulations (Jan 2026)'
const CHECKLIST = 'Planning, Hillside Development Standards checklist CP-4061'

const round = (n) => Math.round(n * 10) / 10
const sf = (n) => Math.round(n)

// The zone's own section and its front yard cap, key lot distance (non-Hillside).
const SECTION = {
  RA: { sec: '12.07', frontCap: 25, keyFt: 100, minArea: 17500, minWidth: 70 },
  RE9: { sec: '12.07.01', frontCap: 25, keyFt: 85, minArea: 9000, minWidth: 65 },
  RE11: { sec: '12.07.01', frontCap: 25, keyFt: 85, minArea: 11000, minWidth: 70 },
  RE15: { sec: '12.07.01', frontCap: 25, keyFt: 85, minArea: 15000, minWidth: 80 },
  RE20: { sec: '12.07.01', frontCap: 25, keyFt: 85, minArea: 20000, minWidth: 80 },
  RE40: { sec: '12.07.01', frontCap: 25, keyFt: 85, minArea: 40000, minWidth: 80 },
  RS: { sec: '12.07.1', frontCap: 25, keyFt: 85, minArea: 7500, minWidth: 60 },
  R1: { sec: '12.08', frontCap: 20, keyFt: 65, minArea: 5000, minWidth: 50 },
}

// Table 12.21 C.10-2a (and 2b for R1H): RFAR by slope band, Hillside Area.
const BANDS = ['0-14.99', '15-29.99', '30-44.99', '45-59.99', '60-99.99', '100+']
const HILLSIDE_RFAR = {
  R1: [0.45, 0.45, 0.40, 0.35, 0.30, 0], RS: [0.45, 0.40, 0.35, 0.30, 0.25, 0],
  RE9: [0.40, 0.35, 0.30, 0.25, 0.20, 0], RE11: [0.40, 0.35, 0.30, 0.25, 0.20, 0],
  RE15: [0.35, 0.30, 0.25, 0.20, 0.15, 0], RE20: [0.35, 0.30, 0.25, 0.20, 0.15, 0],
  RE40: [0.35, 0.30, 0.25, 0.20, 0.15, 0], RA: [0.25, 0.20, 0.15, 0.10, 0.05, 0],
  R1H1: [0.65, 0.60, 0.55, 0.50, 0.45, 0], R1H2: [0.55, 0.50, 0.45, 0.40, 0.35, 0],
  R1H3: [0.45, 0.45, 0.40, 0.35, 0.30, 0], R1H4: [0.40, 0.35, 0.30, 0.25, 0.20, 0],
}
// Table 12.21 C.10-3: guaranteed minimum RFA, share of lot size (or 800 sq ft).
const GUARANTEED = { R1: 0.25, RS: 0.23, RE9: 0.20, RE11: 0.20, RE15: 0.18, RE20: 0.18, RE40: 0.18, RA: 0.13 }

// Tables 12.08 C.5(b)-(d): R1 variation zones, RFAR and lot coverage by lot size.
const VARIATION_RFAR = { 1: [0.65, 0.63, 0.61, 0.59, 0.57, 0.55], 2: [0.55, 0.53, 0.51, 0.49, 0.47, 0.45],
  3: [0.45, 0.43, 0.41, 0.39, 0.37, 0.35], 4: [0.40, 0.38, 0.36, 0.34, 0.32, 0.30] }
const VARIATION_COVERAGE = [0.50, 0.48, 0.46, 0.44, 0.42, 0.40]
const VARIATION_HEIGHT = {
  V: { table: '12.08 C.5(b)', height: { 1: 30, 2: 30, 3: 28, 4: 20 }, plane: { 1: 22, 2: 22, 3: 20, 4: 14 } },
  F: { table: '12.08 C.5(c)', height: { 1: 30, 2: 30, 3: 28, 4: 26 }, plane: { 1: 22, 2: 22, 3: 20, 4: 18 },
    rear: { 1: 24, 2: 24, 3: 20, 4: 18 } },
  R: { table: '12.08 C.5(d)', height: { 1: 30, 2: 30, 3: 28, 4: 26 }, plane: { 1: 22, 2: 22, 3: 20, 4: 18 },
    front: { 1: 24, 2: 24, 3: 20, 4: 18 } },
}

function sizeRow(area) {
  if (area <= 6000) return 0
  if (area <= 7000) return 1
  if (area <= 8000) return 2
  if (area <= 9000) return 3
  if (area <= 10000) return 4
  return 5
}

function line(topic, label, value, unit, status, section, basis, extra = {}) {
  return { topic, label, value, unit, status, cite: { section: `LAMC ${section}`, ...(extra.cite || {}) }, basis, ...extra.more }
}

/** The report lines for one single-family lot. */
export function singleFamily(zone, lot) {
  const flags = []
  const lines = []
  const cls = zone.zone === 'RE' ? 'RE11' : zone.zone   // 12.07.01 C.4: a bare RE is RE11
  const base = SECTION[cls]
  if (!base) return { covered: false, family: zone.family, lines, flags: ['zone not yet covered'] }
  const hill = lot.hillside === true
  const coastal = lot.coastal === true
  const A = lot.area_sf
  const W = lot.width_ft
  const D = lot.depth_ft
  const variation = zone.variation  // e.g. 'V2', 'H1'
  if (lot.coastal === undefined) flags.push('Coastal Zone not checked: a lot in the Coastal Zone outside the Hillside Area follows different side-yard, height and floor-area rules.')
  for (const c of zone.conditions || []) {
    flags.push(c.kind === 'Q' ? 'Qualified [Q] condition: an ordinance for this lot may change these standards; read it before relying on them.'
      : c.kind === 'T' ? 'Tentative [T] classification: the zone takes effect only when its conditions are met.'
      : 'Zone change awaiting funded public improvements (F).')
  }
  if (zone.limitation) flags.push('Development limitation (D) on the height district: its ordinance may cap height, floor area or coverage below these figures.')
  for (const o of zone.overlays || []) {
    if (['HPOZ', 'CPIO', 'CDO', 'RFA', 'SP', 'NSO', 'H', 'HCR'].includes(o.code)) flags.push(`${o.name || o.code}: may add or override standards on this lot.`)
  }
  const sec = base.sec

  // ---------------------------------------------------------------- front yard
  const frontCite = hill ? '12.21 C.10(a), Table 12.21 C.10-1' : `${sec} C.1`
  if (D) {
    const req = Math.min(0.2 * D, base.frontCap)
    lines.push(line('front', 'Front yard (base)', round(req), 'ft', 'estimate', frontCite,
      `20% of the lot depth (${round(D)} ft), need not exceed ${base.frontCap} ft`))
  }
  const p = lot.face && lot.face.prevailing_ft
  if (p != null) {
    const v = hill ? Math.min(Math.max(p, 5), 40) : Math.min(p, 40)
    lines.push(line('front', 'Front yard (prevailing)', round(v), 'ft', 'estimate',
      hill ? '12.21 C.10(a)(1)' : `${sec} C.1`,
      `existing front yards on this block face within 10 ft of each other cover ${Math.round((lot.face.share || 0) * 100)}% of the frontage; ` +
      `the shallowest such group averages ${round(p)} ft (capped at 40 ft${hill ? ', not less than 5 ft' : ''}). ` +
      'Measured from 2016-17 LARIAC building footprints to the roofline; a survey of existing setbacks governs.'))
  } else if (lot.face) {
    lines.push(line('front', 'Front yard (prevailing)', null, null, 'computed', hill ? '12.21 C.10(a)(1)' : `${sec} C.1`,
      'no group of existing front yards within 10 ft of each other covers 40% of this block face, so the base front yard applies'))
  }
  if (lot.type === 'key') {
    lines.push(line('front', 'Key lot front yard', null, null, 'review', hill ? '12.21 C.10(a)(3)' : `${sec} C.1`,
      `may be the average of the adjoining interior lot's required front yard and the reversed corner lot's street-side yard, ` +
      `for not more than ${hill ? 85 : base.keyFt} ft from the reversed corner lot's rear line${hill ? ', and not less than 5 ft' : ''}`))
  }
  if (lot.type === 'through') {
    lines.push(line('front', 'Through lot', null, null, 'computed', hill ? '12.21 C.10(a)(4)' : '12.21 C (item (h))',
      'a front yard at each street end; only one where the lot backs onto a primary, major or secondary highway whose access ' +
      'rights were given up by tract restriction. No rear yard where the lot is under 150 ft deep or is one building site with both front yards provided.'))
  }
  if (lot.type === 'corner' || lot.type === 'reversed corner') {
    lines.push(line('side', 'Street-side yard (corner lot)', null, null, 'review', '12.22 C',
      'set by the yard exceptions of LAMC 12.22 C, whose text this report does not yet carry. The front lot line is the narrowest street frontage (LAMC 12.03 "Lot Line, Front").'))
  }
  if (lot.type === 'flag') {
    lines.push(line('front', 'Flag lot front line', null, null, 'review', '12.22 C',
      'which line is the front of a flag lot is set by LAMC 12.22 C, not yet carried here; yards below assume the access strip\'s street line.'))
  }

  // ---------------------------------------------------------------- side yards
  let side = null
  let sideBasis = ''
  if (cls === 'R1' || cls === 'RS') {
    side = 5
    sideBasis = '5 ft'
    if (W && W < 50) { side = Math.max(3, 0.1 * W); sideBasis = `10% of the lot width (${round(W)} ft), not less than 3 ft` }
  } else if (cls === 'RE9' || cls === 'RE11') {
    if (hill || !coastal) {
      side = 7; sideBasis = '7 ft'
      if (W && W < 70) { side = Math.max(3, 0.1 * W); sideBasis = `10% of the lot width (${round(W)} ft), not less than 3 ft` }
    } else {
      side = 5; sideBasis = '5 ft (Coastal Zone)'
      if (W && W < 50) { side = Math.max(3, 0.1 * W); sideBasis = `10% of the lot width (${round(W)} ft), not less than 3 ft` }
    }
  } else if (cls === 'RE15') {
    side = W ? Math.min(10, Math.max(5, 0.1 * W)) : null
    sideBasis = '10% of the lot width, not less than 5 ft, need not exceed 10 ft'
  } else if (cls === 'RE20' || cls === 'RE40') {
    side = 10; sideBasis = '10 ft'
  } else if (cls === 'RA') {
    side = 10; sideBasis = '10 ft'
    if (W && W < 70) sideBasis += `; a lot under 70 ft wide of record before 1 July 1966 may use 10% of its width (here ${round(Math.max(3, 0.1 * W))} ft), not less than 3 ft`
  }
  if (side != null) {
    const more = (cls === 'RE40' && !hill)
      ? 'plus 1 ft for each story above the second (LAMC 12.07.01 C.2(c))'
      : 'plus 1 ft for each 10 ft (or part) of building height above 18 ft'
    lines.push(line('side', 'Side yards (each)', round(side), 'ft', 'estimate',
      hill ? 'Table 12.21 C.10-1' : `${sec} C.2`, `${sideBasis}; ${more}. Side walls over 14 ft high and 45 ft long need a 5 ft x 10 ft offset.`))
  }

  // ---------------------------------------------------------------- rear yard
  if (cls === 'R1' || cls === 'RS') {
    const r = cls === 'R1' ? 15 : 20
    lines.push(line('rear', 'Rear yard', r, 'ft', 'computed', hill ? 'Table 12.21 C.10-1' : `${sec} C.3`, `${r} ft`))
  } else if (D) {
    lines.push(line('rear', 'Rear yard', round(Math.min(0.25 * D, 25)), 'ft', 'estimate',
      hill ? 'Table 12.21 C.10-1' : `${sec} C.3`, `25% of the lot depth (${round(D)} ft), need not exceed 25 ft`))
  }

  // ---------------------------------------------------------------- height
  const hd = zone.heightDistrict
  const tall = !['R1', 'RS', 'RE9'].includes(cls)  // RE11 and up, RA: 36/30
  if (variation && /^[VFR]\d$/.test(variation)) {
    const v = VARIATION_HEIGHT[variation[0]]
    const n = variation[1]
    lines.push(line('height', 'Height', v.height[n], 'ft', 'computed', v.table,
      `R1${variation}: ${v.height[n]} ft${v.front ? ` (front mass ${v.front[n]} ft)` : ''}${v.rear ? ` (rear mass ${v.rear[n]} ft)` : ''}; ` +
      `encroachment plane from ${v.plane[n]} ft at 45 degrees. R1 variation zones are in no height district.`))
  } else if (hill) {
    const t = hd === '1SS' ? [22, 18] : hd === '1XL' ? [30, tall ? 30 : 28] : [tall ? 36 : 33, tall ? 30 : 28]
    lines.push(line('height', 'Height (envelope)', t[0], 'ft', 'computed', '12.21 C.10(d), Table 12.21 C.10-4',
      `${t[0]} ft where the roof slopes 25% or more, ${t[1]} ft where it slopes less; measured from Hillside Area Grade` +
      (cls === 'R1' ? '; R1 encroachment plane from 20 ft at 45 degrees' : '')))
  } else if (coastal) {
    lines.push(line('height', 'Height', 45, 'ft', 'computed', '12.21.1 A.1', 'Coastal Zone, outside the Hillside Area: 45 ft'))
  } else {
    const t = hd === '1SS' ? [18, 18] : hd === '1XL' ? [30, tall ? 30 : 28] : [tall ? 36 : 33, tall ? 30 : 28]
    lines.push(line('height', 'Height', t[0], 'ft', 'computed', '12.21.1 A.1',
      `${t[0]} ft where the roof slopes 25% or more, ${t[1]} ft where it slopes less` +
      (cls === 'R1' ? '; encroachment plane from 20 ft at 45 degrees along the front and side yards (12.08 C.5(a))' : '') +
      '. Where 40% of the houses on both sides of the block are taller, the block\'s average of those may apply (prevailing height).'))
  }

  // ---------------------------------------------------------------- floor area
  if (['2', '3', '4'].includes(hd)) {
    lines.push(line('floor', 'Residential floor area', null, null, 'review', '12.21.1 A.2-A.4',
      `Height District ${hd}: Planning's summary shows no residential floor area cap here and a floor area ratio of ${hd === '2' ? 6 : hd === '3' ? 10 : 13}:1; ` +
      'the code text read so far does not say so. Confirm before relying on a figure.'))
  } else if (hill && A) {
    const col = variation && variation[0] === 'H' ? `R1${variation}` : cls
    const ratios = HILLSIDE_RFAR[col]
    const guaranteed = Math.max(A * (GUARANTEED[cls] || 0), 800)
    if (lot.slope && Array.isArray(lot.slope.bands) && ratios) {
      const byBand = BANDS.map((b, i) => {
        const area = (lot.slope.bands.find((x) => x.band === b || x.band.replace(/\.\d+$/, '') === b.replace(/\.\d+$/, '')) || {}).sf || 0
        return { band: b, sf: area, rfar: ratios[i], rfa: area * ratios[i] }
      })
      const sum = byBand.reduce((t, b) => t + b.rfa, 0)
      const max = Math.max(sum, guaranteed)
      lines.push(line('floor', 'Residential floor area (max)', sf(max), 'sq ft', 'estimate',
        '12.21 C.10(b), Tables 12.21 C.10-2a/2b/2c and C.10-3',
        `slope bands from USGS 3DEP lidar: ${byBand.filter((b) => b.sf).map((b) => `${b.band}%: ${sf(b.sf)} sq ft x ${b.rfar}`).join('; ')} = ${sf(sum)} sq ft; ` +
        `guaranteed minimum ${sf(guaranteed)} sq ft. The City requires a slope analysis map stamped by a civil engineer or surveyor (12.21 C.10(b)(1)); this is an estimate of it.`,
        { more: { bands: byBand } }))
    } else {
      lines.push(line('floor', 'Residential floor area (max)', null, null, 'review', '12.21 C.10(b)',
        `set by the lot's slope bands, not yet measured for this lot; the guaranteed minimum is ${sf(guaranteed)} sq ft (Table 12.21 C.10-3)`))
    }
  } else if (coastal && A) {
    lines.push(line('floor', 'Floor area', null, null, 'review', '12.21.1 A.1',
      'Coastal Zone outside the Hillside Area: three times the buildable area, not residential floor area'))
  } else if (A) {
    let ratio
    let basis
    let cite = `${sec} C.5`
    if (variation && /^[VFR]\d$/.test(variation)) {
      const row = sizeRow(A)
      ratio = VARIATION_RFAR[variation[1]][row]
      cite = VARIATION_HEIGHT[variation[0]].table
      basis = `R1${variation}, lot of ${sf(A)} sq ft: ratio ${ratio}`
      lines.push(line('coverage', 'Lot coverage (max)', Math.round(VARIATION_COVERAGE[row] * 100), '%', 'computed', cite,
        `${Math.round(VARIATION_COVERAGE[row] * 100)}% for a lot of this size: ${sf(A * VARIATION_COVERAGE[row])} sq ft of structures over 6 ft above grade`))
    } else if (cls === 'R1') { ratio = 0.45; basis = 'ratio 0.45'; cite = '12.08 C.5(a)' }
    else if (cls === 'RS') { ratio = A < 9000 ? 0.45 : 0.40; basis = A < 9000 ? 'lot under 9,000 sq ft: 45%' : '40%, or 4,050 sq ft if greater' }
    else if (cls === 'RE9' || cls === 'RE11') { ratio = A < 15000 ? 0.40 : 0.35; basis = A < 15000 ? 'lot under 15,000 sq ft: 40%' : '35%, or 6,000 sq ft if greater' }
    else if (['RE15', 'RE20', 'RE40'].includes(cls)) { ratio = 0.35; basis = '35%' }
    else if (cls === 'RA') { ratio = A < 20000 ? 0.25 : 0.20; basis = A < 20000 ? 'lot under 20,000 sq ft: 25%' : '20%, or 5,000 sq ft if greater' }
    let max = A * ratio
    if (cls === 'RS' && A >= 9000) max = Math.max(max, 4050)
    if ((cls === 'RE9' || cls === 'RE11') && A >= 15000) max = Math.max(max, 6000)
    if (cls === 'RA' && A >= 20000) max = Math.max(max, 5000)
    lines.push(line('floor', 'Residential floor area (max)', sf(max), 'sq ft', 'estimate', cite,
      `${basis} of ${sf(A)} sq ft of lot (lot area from the City's parcel shape)`))
    if (['RS', 'RA', 'RE9', 'RE11', 'RE15', 'RE20', 'RE40'].includes(cls) && !variation) {
      lines.push(line('floor', 'With the design bonus', sf(max * 1.2), 'sq ft', 'estimate', `${sec} C.5`,
        'an extra 20% where upper stories are each at most 75% of the base floor, or the front facade steps back as the code sets out; one bonus per property'))
    }
  }

  // ---------------------------------------------------------------- density and lot size
  if (A) {
    lines.push(line('density', 'Dwelling units (by zone)', 1, 'unit', 'computed', `${sec} C.4`,
      `one dwelling: the minimum lot area per dwelling unit is the zone's minimum lot area, ${base.minArea.toLocaleString('en-US')} sq ft. ` +
      'State law (accessory dwelling units, SB 9 lot splits) may allow more and is not computed here.'))
    if (A < base.minArea || (W && W < base.minWidth)) {
      flags.push(`Below the zone's minimum lot size (${base.minArea.toLocaleString('en-US')} sq ft, ${base.minWidth} ft wide): a recorded lot may still hold one dwelling.`)
    }
  }
  return { covered: true, family: 'single-family', hillside: hill, lines, flags }
}

/** The report for any City of Los Angeles zone, as far as this module covers it. */
export function laReport(zone, lot) {
  if (!zone || !zone.recognised) return { covered: false, lines: [], flags: ['zone string not recognised'] }
  if (zone.chapter === '1A') return { covered: false, lines: [], flags: ['New zoning code (Chapter 1A) zone: not yet covered by this report.'] }
  if (zone.family === 'specific-plan') return { covered: false, lines: [], flags: ['A specific plan sets this lot\'s standards: read the plan.'] }
  if (zone.family === 'single-family') return singleFamily(zone, lot || {})
  return { covered: false, family: zone.family, lines: [], flags: [`${zone.zone} (${zone.family}) is not yet covered; single-family zones come first.`] }
}

export { SUMMARY, CHECKLIST }
