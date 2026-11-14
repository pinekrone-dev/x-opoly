/**
 * Where each layer sits in the map's panel, and the starting points that
 * switch a sensible handful on at once.
 *
 * The panel was one flat grid: every layer a market publishes, in the order
 * it was published, twenty-odd cards with nothing saying which belong
 * together. A layer now belongs to a section by what it is for. The market's
 * own catalogue may name the section (`section` on the layer); otherwise it
 * is read from the layer's id here, and a layer nobody has heard of lands
 * under More rather than nowhere.
 */

export interface Section {
  id: string
  label: string
  /** One line under the heading while the section is closed. */
  hint: string
}

export const SECTIONS: Section[] = [
  { id: 'property', label: 'Property & ownership', hint: 'Land use colours, who owns what' },
  { id: 'workspace', label: 'My map', hint: 'Your own lists, and pins for clients' },
  { id: 'boundaries', label: 'Boundaries', hint: 'Opportunity zones, districts, incentive areas' },
  { id: 'zoning', label: 'Zoning & land use', hint: 'Districts, overlays, plans' },
  { id: 'development', label: 'Development activity', hint: 'Permits, entitlements, projects' },
  { id: 'market', label: 'Market research', hint: 'Demographics, traffic, schools' },
  { id: 'infrastructure', label: 'Infrastructure', hint: 'Power lines, substations, plants' },
  { id: 'risk', label: 'Risk', hint: 'Flood zones, fuel tanks' },
  { id: 'more', label: 'More', hint: 'Everything else this market publishes' },
]

const BY_KEY: Record<string, string> = {
  parcels: 'property', ownership: 'property', buildings: 'property',
  lists: 'workspace', clients: 'workspace',
  'opportunity-zones': 'boundaries', 'opportunity-zones-2027': 'boundaries', 'school-districts': 'boundaries',
  tirz: 'boundaries', 'super-neighborhoods': 'boundaries', uez: 'boundaries', nez: 'boundaries', redevelopment: 'boundaries',
  zoning: 'zoning', 'land-use': 'zoning', overlays: 'zoning', landmarks: 'zoning', 'built-form': 'zoning', plans: 'zoning',
  permits: 'development', 'permits-sf': 'development', 'permits-mf': 'development', 'permits-bis': 'development',
  'plan-review': 'development', occupancy: 'development', demolitions: 'development', txdot: 'development',
  lara: 'development', 'city-land': 'development', 'code-cases': 'development',
  'Development pipeline': 'development', Entitlements: 'development',
  demographics: 'market', traffic: 'market', 'street-counts': 'market', schools: 'market', 'private-schools': 'market',
  'parks-rec': 'market', 'rail-stations': 'market', 'business-licenses': 'market', comps: 'market',
  'Market surveys': 'market', Absorption: 'market', 'Rent trends': 'market', Forecasts: 'market',
  transmission: 'infrastructure', substations: 'infrastructure', 'power-plants': 'infrastructure', ships: 'infrastructure', vessels: 'infrastructure',
  'flood-zones': 'risk', ust: 'risk', lust: 'risk',
}

/** A card's layer key: its id without the panel's `x:` or `g:` prefix. */
export const cardKey = (cardId: string): string => (/^[xg]:/.test(cardId) ? cardId.slice(2) : cardId)

/** The section a card belongs to. `named` is the catalogue's own say, when it has one. */
export function sectionOf(cardId: string, named?: string | null): string {
  if (named && SECTIONS.some((s) => s.id === named)) return named
  const key = cardKey(cardId)
  if (BY_KEY[key]) return BY_KEY[key]
  if (key.startsWith('traffic')) return 'market'
  if (key.startsWith('permits')) return 'development'
  return 'more'
}

/** Cards gathered under their sections, in section order, empty sections left out. */
export function bySection<T extends { id: string; section?: string }>(cards: T[]): { section: Section; cards: T[] }[] {
  return SECTIONS.map((section) => ({ section, cards: cards.filter((card) => (card.section ?? sectionOf(card.id)) === section.id) })).filter(
    (group) => group.cards.length > 0,
  )
}

export interface StartingPoint {
  /** Its saved-view id when it is the team's own, absent for the built-in ones. */
  id?: string
  name: string
  /** Layer keys (see cardKey) it switches on. */
  layers: string[]
  note?: string
}

/**
 * The built-in starting points. A team's own, saved under the same name,
 * takes a built-in one's place; deleting it brings the built-in back.
 */
export const STARTING_POINTS: StartingPoint[] = [
  { name: 'Site selection', note: 'Who lives here and what drives by', layers: ['demographics', 'traffic', 'schools', 'zoning'] },
  { name: 'Development pipeline', note: 'What is being built and entitled', layers: ['permits', 'plan-review', 'zoning', 'opportunity-zones', 'opportunity-zones-2027', 'occupancy', 'txdot'] },
  { name: 'Risk check', note: 'Flood and contamination', layers: ['flood-zones', 'ust', 'lust'] },
  { name: 'Power & industrial', note: 'Lines, substations and industrial zoning', layers: ['transmission', 'substations', 'power-plants', 'zoning'] },
]

/** The pseudo-market the team's own starting points are saved under, as saved views. */
export const STARTING_POINT_MARKET = 'layer-presets'

/** Built-in and the team's own together: the team's wins a shared name, and its extras follow. */
export function startingPoints(own: StartingPoint[]): StartingPoint[] {
  const mine = new Map(own.map((p) => [p.name.trim().toLowerCase(), p]))
  const out = STARTING_POINTS.map((p) => mine.get(p.name.toLowerCase()) ?? p)
  for (const p of own) if (!STARTING_POINTS.some((b) => b.name.toLowerCase() === p.name.trim().toLowerCase())) out.push(p)
  return out
}

/**
 * What applying a starting point changes: the ids of the cards to switch,
 * given the cards as they stand. Cards under My map are left as they are,
 * since a starting point is about data and not about the person's own pins.
 */
export function cardsToSwitch<T extends { id: string; state: string; section?: string }>(cards: T[], layers: string[]): string[] {
  const want = new Set(layers)
  return cards
    .filter((card) => card.state === 'on' || card.state === 'off')
    .filter((card) => (card.section ?? sectionOf(card.id)) !== 'workspace')
    .filter((card) => want.has(cardKey(card.id)) !== (card.state === 'on'))
    .map((card) => card.id)
}
