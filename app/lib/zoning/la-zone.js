/**
 * City of Los Angeles zone strings, read into their parts.
 *
 * A zone on the City's map is one string that carries several regulations
 * at once: "[Q]R1-1D-HCR" is a permanent Qualified condition, the R1 zone,
 * Height District 1 with a Development Limitation, inside the Hillside
 * Construction Regulation district. The report needs each part separately,
 * because each part points at a different place in the code and some parts
 * (Q and D conditions, specific plans) can only be read in their own
 * ordinance.
 *
 * Strings in square brackets end to end ("[LM4-GW1-4][IX6-8][CPIO]") are
 * zones of the new zoning code, Chapter 1A, which applies in Downtown and
 * the community plans adopted under it. They are recognised and labelled,
 * not computed: the report covers Chapter 1 first.
 */

// LAMC 12.32: T and Q classifications come before the zone; square brackets
// are permanent, parentheses tentative.
// (F) marks a zone change awaiting funded public improvements.
const PREFIX = /^(\[T\]|\(T\)|\[Q\]|\(Q\)|\(F\)|Q(?=[A-Z]))/

// The zone classes of Chapter 1 (LAMC 12.04), longest first so RE40 is not
// read as RE. A variation suffix (R1V2, R1H1, R1F3, R1R2) and a community
// qualifier in parentheses (R3(PV), CM(GM)) may follow.
const CLASSES = [
  'RE40', 'RE20', 'RE15', 'RE11', 'RE9', 'RAS3', 'RAS4', 'RMP', 'RW1', 'RW2',
  'RD1.5', 'RD2', 'RD3', 'RD4', 'RD5', 'RD6', 'RZ2.5', 'RZ3', 'RZ4', 'RZ5', 'RU',
  'R1P', 'R2P', 'R3P', 'R4P', 'R5P', 'RAP', 'RSP', 'RDP', 'A2P', 'A1P',
  'R1', 'R2', 'R3', 'R4', 'R5', 'RA', 'RS', 'RE',
  'C1.5', 'C1', 'C2', 'C4', 'C5', 'CR', 'CM', 'CW', 'CEC',
  'MR1', 'MR2', 'M1', 'M2', 'M3', 'A1', 'A2', 'PF', 'PB', 'P', 'OS', 'SL', 'GM', 'HJ', 'HR', 'NI', 'UV', 'UI', 'UC',
  'ADP', 'LASED', 'LAX', 'WC', 'USC', 'PVSP', 'CCS', 'CSA',
]

const HEIGHT = /^(1SS|1XL|1VL|1L|1|2|3|4)(D?)$/

// What an overlay suffix is and where it lives. Only the ones the report
// treats differently need to be named; the rest are kept as given.
export const OVERLAYS = {
  O: 'Oil Drilling District (LAMC 13.01)',
  G: 'Surface Mining District (LAMC 13.03)',
  K: 'Equinekeeping District (LAMC 13.05)',
  CA: 'Commercial and Artcraft District (LAMC 13.06)',
  POD: 'Pedestrian Oriented District (LAMC 13.07)',
  CDO: 'Community Design Overlay (LAMC 13.08)',
  MU: 'Mixed Use District (LAMC 13.09)',
  NSO: 'Neighborhood Stabilization Overlay (LAMC 13.12)',
  RFA: 'Residential Floor Area District (LAMC 13.13)',
  CPIO: 'Community Plan Implementation Overlay (LAMC 13.14)',
  MPR: 'Modified Parking Requirement District (LAMC 13.15)',
  SN: 'Sign District (LAMC 13.11)',
  RIO: 'River Improvement Overlay (LAMC 13.17)',
  CUGU: 'Clean Up Green Up Overlay (LAMC 13.18)',
  HCR: 'Hillside Construction Regulation District (LAMC 13.20)',
  HPOZ: 'Historic Preservation Overlay Zone (LAMC 12.20.3)',
  RG: 'Rear Detached Garage District (LAMC 13.19)',
  H: 'Hillside Standards Overlay',
  FH: 'Fence Height District (LAMC 12.22 C.20(f))',
  SP: 'Specific Plan',
}

/**
 * Read one zone string. Returns
 *   { raw, chapter: '1' | '1A' | null, conditions: [{ kind: 'Q'|'T', permanent }],
 *     zone, family, variation, qualifier, heightDistrict, limitation (D),
 *     overlays: [{ code, name }], recognised }
 */
export function parseZone(raw) {
  const text = String(raw ?? '').trim().toUpperCase()
  const out = {
    raw: text, chapter: null, conditions: [], zone: null, family: null, variation: null,
    qualifier: null, heightDistrict: null, limitation: false, overlays: [], recognised: false,
  }
  if (!text) return out
  if (/^\[[^\]]+\](\[[^\]]+\])+$/.test(text)) {
    out.chapter = '1A'
    out.recognised = true
    out.parts = text.slice(1, -1).split('][')
    return out
  }
  let rest = text
  for (;;) {
    const m = rest.match(PREFIX)
    if (!m) break
    const tag = m[1]
    out.conditions.push({ kind: tag.replace(/[^QTF]/g, ''), permanent: tag.startsWith('[') || tag === 'Q' })
    rest = rest.slice(tag.length)
  }
  const parts = rest.split('-').filter(Boolean)
  const head = parts.shift() || ''
  // Freeways and flood control channels carry a label, not a zone.
  if (/^(FWY|FRWY|LACFCD)$/.test(head)) {
    Object.assign(out, { chapter: '1', zone: head, family: 'right-of-way', recognised: true })
    out.overlays = parts.map((code) => ({ code, name: OVERLAYS[code] ?? null }))
    return out
  }
  // A specific plan's own zones ("(WC)RIVER", "MU(EC)", "PPSP"): the plan,
  // not Chapter 1, holds their standards.
  if (/^\(WC\)/.test(head) || /^[A-Z]+\((EC|CA|PV)\)$/.test(head) || /SP$/.test(head) || head === 'CCA' || /^(CCA|GW|NMU|MU|M)\(/.test(head)) {
    Object.assign(out, { chapter: '1', zone: head, family: 'specific-plan', recognised: true })
    out.overlays = parts.map((code) => ({ code, name: OVERLAYS[code] ?? null }))
    return out
  }
  const cls = CLASSES.find((c) => head.startsWith(c))
  if (!cls) return out
  out.chapter = '1'
  out.zone = cls
  let tail = head.slice(cls.length)
  const variation = tail.match(/^([VFRH])(\d)/)
  if (variation && cls === 'R1') {
    out.variation = variation[1] + variation[2]
    tail = tail.slice(2)
  }
  const qualifier = tail.match(/^\(([A-Z0-9]+)\)/)
  if (qualifier) {
    out.qualifier = qualifier[1]
    tail = tail.slice(qualifier[0].length)
  }
  if (tail) return out
  out.family = family(cls)
  // The height district is the first part after the zone, when it is one;
  // R1 variation zones have none (LAMC 12.21.1, Table 2 note).
  if (parts.length && HEIGHT.test(parts[0])) {
    const [, hd, d] = parts.shift().match(HEIGHT)
    out.heightDistrict = hd
    out.limitation = d === 'D'
  }
  for (const code of parts) out.overlays.push({ code, name: OVERLAYS[code] ?? null })
  out.recognised = true
  return out
}

/** Which family of rules a zone class belongs to. */
export function family(cls) {
  if (/^(RA|RE\d*|RS|R1|R1P|RSP|RAP)$/.test(cls)) return 'single-family'
  if (/^(RU|RZ|RW1|RMP)/.test(cls)) return 'small-lot'
  if (/^(A1P|A2P)$/.test(cls)) return 'parking'
  if (/^(R2|RW2|RD|R3|RAS3|R4|RAS4|R5|R2P|R3P|R4P|R5P|RDP)/.test(cls)) return 'multi-family'
  if (/^(C|CR|CM|CW|CEC)/.test(cls)) return 'commercial'
  if (/^(M|MR)/.test(cls)) return 'industrial'
  if (/^(A1|A2)$/.test(cls)) return 'agricultural'
  return 'other'
}
