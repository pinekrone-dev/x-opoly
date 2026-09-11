/**
 * The public pages, one per kind of reader.
 *
 * The product is one tool, but a tenant rep broker, an acquisitions analyst
 * and a developer walk in asking different questions, so each gets a page
 * that answers theirs first. Everything here is copy and picture choices; the
 * page that renders it is `views/Audience.tsx`, and the landing page for
 * brokers keeps its own layout because it came first.
 *
 * Every claim below describes something the product does today. The numbers
 * in the stats rows are read off the live catalogue when the page loads, so
 * they cannot drift from the markets that are actually published.
 */

export type AudienceSlug = 'investors' | 'developers' | 'investment-sales'

export interface Shot {
  src: string
  w: number
  h: number
  alt: string
  caption?: string
}

export interface Step {
  title: string
  body: string
  bullets?: string[]
  shot: Shot
}

export interface Card {
  title: string
  body: string
  icon: string
}

export interface Question {
  q: string
  a: string
}

export interface Stat {
  /** Which catalogue total to show; the label is the human reading of it. */
  key: 'parcels' | 'value' | 'portfolios' | 'markets' | 'zoning'
  label: string
}

export interface Audience {
  slug: AudienceSlug
  /** The nav and cross-link name. */
  name: string
  eyebrow: string
  title: string
  lede: string
  stats: Stat[]
  hero: Shot
  /** Heading over the numbered steps. */
  chapter: { eyebrow: string; title: string; intro: string }
  steps: Step[]
  also: { title: string; cards: Card[] }
  faq: { title: string; items: Question[] }
  /** What the pricing card lists for this reader. */
  included: string[]
  /** The <title> and description the page's own HTML carries, kept in step here. */
  meta: { title: string; description: string }
}

/* The screenshots, cropped once from a real session and shared across pages. */
const SHOTS = {
  gis: {
    src: '/shots/gis.jpg',
    w: 1440,
    h: 900,
    alt: 'The parcel map: a layer rail on the left, a county shaded by land use in the middle, and a legend on the right.',
  },
  map: {
    src: '/shots/gis-map.jpg',
    w: 680,
    h: 840,
    alt: 'Downtown parcels shaded by land use: commercial in blue, multifamily in orange, vacant land in green.',
  },
  layers: {
    src: '/shots/gis-layers.jpg',
    w: 316,
    h: 840,
    alt: 'The layer rail: market picker, saved views, and cards for assessor shading, ownership, demographics, zoning, development pipeline, entitlements, road projects, opportunity zones and schools.',
  },
  legend: {
    src: '/shots/gis-legend.jpg',
    w: 384,
    h: 240,
    alt: 'The legend panel listing land use colours: commercial, multifamily, vacant land, single family, other.',
  },
  survey: {
    src: '/shots/map.jpg',
    w: 1440,
    h: 660,
    alt: 'A market survey map with a stage rail of candidate sites and a half mile radius ring.',
  },
} as const satisfies Record<string, Shot>

const ICONS = {
  layers: 'M12 3 3 8l9 5 9-5-9-5z M3 13l9 5 9-5 M3 18l9 5 9-5',
  chart: 'M3 3v18h18 M7 14v4 M12 9v9 M17 5v13',
  water: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4z M12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  pin: 'M12 22s7-7.1 7-12a7 7 0 1 0-14 0c0 4.9 7 12 7 12z M12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7 M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  school: 'M3 9l9-5 9 5-9 5-9-5z M7 11v5c0 1.5 2.5 3 5 3s5-1.5 5-3v-5',
  people: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M22 21v-2a4 4 0 0 0-3-3.9 M16 3.1a4 4 0 0 1 0 7.8',
  table: 'M3 5h18v14H3z M3 10h18 M3 15h18 M9 5v14',
}

const SHARED_CARDS = {
  demographics: {
    title: 'Demographics by tract',
    body: 'Census population, income and growth shaded around any parcel, with the numbers in a side panel.',
    icon: ICONS.chart,
  },
  flood: {
    title: 'Flood and opportunity zones',
    body: 'FEMA flood zones and qualified opportunity zones as layers in the markets that publish them, filterable against parcels.',
    icon: ICONS.water,
  },
  snapshot: {
    title: 'Map snapshots',
    body: 'Save the map as PNG or PDF with a caption naming the market, the filter and the legend, for the memo or the meeting.',
    icon: ICONS.camera,
  },
  survey: {
    title: 'Surveys for the tour',
    body: 'Send parcels into a survey, stage them, order the drive and print the tour book.',
    icon: ICONS.pin,
  },
  share: {
    title: 'Share with partners',
    body: 'A link shows the live map to a partner or lender with no login.',
    icon: ICONS.link,
  },
  schools: {
    title: 'Schools and districts',
    body: 'Public and private schools and district boundaries, for residential and mixed use underwriting.',
    icon: ICONS.school,
  },
  comps: {
    title: 'Comps you bring',
    body: 'Paste a CSV or JSON of listings and sales and they plot as their own layer beside the parcels.',
    icon: ICONS.table,
  },
  zoning: {
    title: 'Zoning and the pipeline',
    body: 'Zoning districts, permits and entitlement cases as layers, so the upside on a parcel is visible before the call.',
    icon: ICONS.layers,
  },
}

export const AUDIENCES: Record<AudienceSlug, Audience> = {
  investors: {
    slug: 'investors',
    name: 'Investors',
    eyebrow: 'For investors and acquisitions',
    title: 'Find the owner before the listing exists',
    lede:
      'The certified appraisal roll for ten markets, with every parcel’s owner of record, mailing address, assessed value and last deed date, grouped into the portfolios and back offices that actually hold them. Filter to your buy box, export the list, and work it in the CRM.',
    stats: [
      { key: 'parcels', label: 'parcels on the map' },
      { key: 'value', label: 'of assessed value' },
      { key: 'portfolios', label: 'owner portfolios resolved across the markets' },
    ],
    hero: SHOTS.gis,
    chapter: {
      eyebrow: 'How it works',
      title: 'From the county roll to a call list',
      intro: 'Public record, resolved into people and portfolios you can actually reach.',
    },
    steps: [
      {
        title: 'Owner of record, resolved into portfolios',
        body: 'The roll lists the same owner a dozen ways. Land Quotient resolves the names into portfolios and the mailing addresses into back offices, so one click on a parcel shows every other parcel that owner holds in the county and where the tax bill goes.',
        bullets: ['Austin alone resolves into 15,669 portfolios and 1,080 back offices holding 61,357 parcels.'],
        shot: SHOTS.map,
      },
      {
        title: 'Filter to the buy box',
        body: 'Asset type, assessed value, acreage and lot size, plus the fields each county carries: year built, building area, homestead flag, sale price and deed date. Search by address, owner or parcel id. What is left is the list.',
        bullets: [
          'Multifamily over 10 units held more than ten years',
          'Vacant commercial land inside an opportunity zone',
          'Owners whose mailing address is out of state',
        ],
        shot: SHOTS.layers,
      },
      {
        title: 'Export the list, or send it to the CRM',
        body: 'Export what the filter leaves as CSV with owner, mailing address, value, lot size and acreage columns. Or send a parcel into a deal: the built in CRM holds deals, people, companies and places, linked to the surveys and parcels they came from.',
        shot: SHOTS.gis,
      },
      {
        title: 'Bring your comps and shade the map by value',
        body: 'Paste a CSV or JSON of sales and listings and they plot as their own layer with price, cap rate, price per square foot and sale date. Assessor shading colours every parcel by asset type or value, and census demographics shade the tracts around it.',
        shot: SHOTS.legend,
      },
    ],
    also: {
      title: 'Also included',
      cards: [
        SHARED_CARDS.zoning,
        SHARED_CARDS.demographics,
        SHARED_CARDS.flood,
        SHARED_CARDS.snapshot,
        SHARED_CARDS.survey,
        SHARED_CARDS.share,
      ],
    },
    faq: {
      title: 'What investors ask about the owner data',
      items: [
        {
          q: 'Where does the owner data come from?',
          a: 'Each market is one county’s own appraisal or assessment roll, the same public record the county publishes, loaded whole. The market page names the roll and the year for every market.',
        },
        {
          q: 'Which markets carry owner names?',
          a: 'Austin, Broward County, Houston, Las Vegas, Nashville, New York, Phoenix and Washington. Orange County withholds owner names by written policy and New Jersey no longer publishes them, so those two markets carry the tax billing address instead.',
        },
        {
          q: 'Are phone numbers included?',
          a: 'No. The roll carries the owner of record and a mailing address. Phone numbers and emails are not public record and are not in the product.',
        },
        {
          q: 'How are portfolios built?',
          a: 'From the roll itself. Owner names are normalised and grouped, mailing addresses are grouped into back offices, and a parcel shows both. It is a reading of the public record, not a guess about who is behind an entity.',
        },
        {
          q: 'Can my acquisitions team share a map?',
          a: 'Yes. Teammates are invited into the workspace and included in the price, and a share link opens a live map for anyone outside it with no login.',
        },
      ],
    },
    included: [
      'Unlimited surveys and sites',
      'Parcel maps for ten markets, owner of record where the county publishes it',
      'Zoning, permit and entitlement layers',
      'Census demographic choropleths',
      'AI flyer and listing extraction',
      'Tour planning with drive times',
      'Client share links, tour books and comparison PDFs',
      'CSV export and saved map views',
      'Team members by invitation',
    ],
    meta: {
      title: 'Land Quotient for investors — find the owner before the listing exists',
      description:
        'Owner of record, portfolios and mailing addresses from the county roll for ten markets, filtered to your buy box and exported. $29/month, teammates included.',
    },
  },

  developers: {
    slug: 'developers',
    name: 'Developers',
    eyebrow: 'For developers',
    title: 'See what can be built, what is being built, and who owns the dirt',
    lede:
      'County parcel maps for ten markets with zoning districts, the permit and entitlement pipeline, flood zones and opportunity zones stacked as layers, and the assessor’s owner of record behind every parcel you click.',
    stats: [
      { key: 'parcels', label: 'parcels across ten markets' },
      { key: 'zoning', label: 'zoning districts on the map' },
      { key: 'markets', label: 'markets, each one county’s own roll' },
    ],
    hero: SHOTS.gis,
    chapter: {
      eyebrow: 'How it works',
      title: 'From a zoning map to a short list of owners',
      intro: 'The county record underneath, the city’s own operational layers on top, and nothing sketched on until you say so.',
    },
    steps: [
      {
        title: 'Start from the zoning, not the listing',
        body: 'Every zoning district the city publishes, drawn in the city’s own palette and filtered like a pivot table: city, then category, then the individual codes. Turn on C-1 and GR in Austin, or the MF districts, and the map shows only the parcels that could take the project.',
        bullets: [
          'City of Austin: 22,502 districts across 31 base codes',
          'Phoenix: 41,521 districts plus 71,074 existing land use polygons',
          'North Jersey: 43,588 districts, plus redevelopment areas and Urban Enterprise Zones',
          'Broward County: 19,457 districts from ten cities and the county',
        ],
        shot: SHOTS.map,
      },
      {
        title: 'Read the pipeline before the competition does',
        body: 'Building permits issued since 2025, plan review and entitlement cases, certificates of occupancy and road projects, each as its own layer with its own filter. Where the permits cluster is where the next deal is.',
        bullets: [
          'Development pipeline: 20,438 permits in Austin, 92,776 in Phoenix, 283,232 in New York',
          'Entitlements: 16,226 plan review cases in Austin opened since 2019',
          'Road projects, certificates of occupancy, code cases and business licences where the city publishes them',
        ],
        shot: SHOTS.layers,
      },
      {
        title: 'Click a parcel and meet the owner',
        body: 'Every parcel carries the certified appraisal roll: owner of record, mailing address, land use, assessed value, lot size, year built and the last deed date, as the county publishes them. Where the county groups an owner’s holdings, the panel shows the whole portfolio and the back office that manages it.',
        shot: SHOTS.gis,
      },
      {
        title: 'Filter to the site that pencils, then export it',
        body: 'Ask in plain English and the filter fills itself: commercial or office parcels over half an acre worth more than $10M, inside a zone or a radius. Export the parcels as CSV, save the view, or send them into a survey to walk the sites.',
        bullets: [
          'Flood zones in Las Vegas, Phoenix, New York, Washington, Orange County and North Jersey',
          'Opportunity zones in every market',
          'Traffic counts in Phoenix, Broward County and North Jersey',
        ],
        shot: SHOTS.legend,
      },
    ],
    also: {
      title: 'Also on the map',
      cards: [
        SHARED_CARDS.flood,
        { ...SHARED_CARDS.flood, title: 'Opportunity zones', body: 'Qualified opportunity zones as a layer in every market, so a site’s eligibility is visible before the model is built.' },
        SHARED_CARDS.schools,
        SHARED_CARDS.demographics,
        SHARED_CARDS.snapshot,
        SHARED_CARDS.comps,
      ],
    },
    faq: {
      title: 'What developers ask about the data',
      items: [
        {
          q: 'Where does the zoning come from?',
          a: 'Each city’s own GIS service, read directly and named as the source on the layer. Where a city publishes nothing, the district boundaries came by public records request and are carried the same way. Every layer shows its count and its source.',
        },
        {
          q: 'How current is the permit pipeline?',
          a: 'It is read from the city’s own feed, and the layer shows the date filter it was read with, typically permits issued since the start of last year. The catalogue records when each market’s layers were last refreshed.',
        },
        {
          q: 'Which markets are covered?',
          a: 'Austin, Broward County, Houston, Las Vegas, Nashville, New York, North Jersey, Orange County, Phoenix and Washington. The markets page lists what each one carries.',
        },
        {
          q: 'Can I export parcels?',
          a: 'Yes. What the filter leaves exports as CSV, up to five thousand rows at a time, with the columns the county publishes. Saved views keep the layers, colours and filters for the next open.',
        },
        {
          q: 'Is the owner name always there?',
          a: 'It is on eight of the ten markets. Orange County withholds it by written policy and New Jersey no longer publishes it; both carry the tax billing address instead.',
        },
      ],
    },
    included: [
      'Unlimited surveys and sites',
      'Parcel maps for ten markets, owner of record where the county publishes it',
      'Zoning, permit and entitlement layers',
      'Census demographic choropleths',
      'AI flyer and listing extraction',
      'Tour planning with drive times',
      'Client share links, tour books and comparison PDFs',
      'CSV export and saved map views',
      'Team members by invitation',
    ],
    meta: {
      title: 'Land Quotient for developers — zoning, entitlements and the permit pipeline on one parcel map',
      description:
        'What can be built, what is being built, and who owns the dirt. Zoning, permits, entitlements, flood and opportunity zones over the county roll for ten markets. $29/month.',
    },
  },

  'investment-sales': {
    slug: 'investment-sales',
    name: 'Investment sales brokers',
    eyebrow: 'For investment sales brokers',
    title: 'Every owner in your product type, before the listing',
    lede:
      'Pull the parcels in your asset class, see who holds them and how much else they hold, and build the pitch list from the county roll rather than from the last deal you closed. Then map the comps against it.',
    stats: [
      { key: 'parcels', label: 'parcels on the map' },
      { key: 'portfolios', label: 'owner portfolios resolved' },
      { key: 'value', label: 'of assessed value' },
    ],
    hero: SHOTS.gis,
    chapter: {
      eyebrow: 'How it works',
      title: 'From the roll to the pitch',
      intro: 'The owners in your product type, ranked by what they hold, with the comps beside them.',
    },
    steps: [
      {
        title: 'Filter the roll to your asset class',
        body: 'Multifamily, retail, office, industrial, hospitality or land, by the county’s own use codes, with assessed value, building area, lot size and year built as the dials. The map shows only what is left, shaded by value or use.',
        shot: SHOTS.map,
      },
      {
        title: 'Rank owners by what they hold',
        body: 'The ownership layer groups the roll into portfolios and back offices. Click a parcel and see every other parcel that owner holds in the county, the total assessed value behind them, and the address the tax bill goes to.',
        bullets: [
          'Houston: 18,039 portfolios holding 135,608 parcels',
          'Phoenix: 46,448 portfolios, 322,310 parcels in portfolio',
          'Broward County: 8,649 portfolios and 2,214 back offices',
        ],
        shot: SHOTS.layers,
      },
      {
        title: 'Map the comps against the roll',
        body: 'Paste your sales and listings as CSV or JSON and they plot as their own layer with price, cap rate and price per square foot. Assessor shading beside them shows which owners are sitting on an assessed value that the comps have already passed.',
        shot: SHOTS.legend,
      },
      {
        title: 'Export the list, or work it in the CRM',
        body: 'Export the parcels as CSV with owner, mailing address and value columns, or send them into deals in the built in CRM, with people, companies and places linked to the parcels they came from. Snapshot the map as a PNG or PDF for the pitch book.',
        shot: SHOTS.gis,
      },
    ],
    also: {
      title: 'Also included',
      cards: [
        SHARED_CARDS.zoning,
        SHARED_CARDS.demographics,
        SHARED_CARDS.flood,
        SHARED_CARDS.snapshot,
        SHARED_CARDS.survey,
        SHARED_CARDS.share,
      ],
    },
    faq: {
      title: 'What investment sales teams ask',
      items: [
        {
          q: 'Which markets carry owner names?',
          a: 'Austin, Broward County, Houston, Las Vegas, Nashville, New York, Phoenix and Washington carry the owner of record. Orange County and North Jersey carry the tax billing address instead, because those counties do not publish the name.',
        },
        {
          q: 'Can I get sale prices?',
          a: 'Where the county publishes them: Washington, Nashville, Las Vegas, Phoenix and North Jersey carry a last sale price on most parcels, and every market but Orange County carries a deed or sale date. Your own comps plot as a layer in every market.',
        },
        {
          q: 'Are phone numbers or emails included?',
          a: 'No. The product carries the public record: the owner of record and a mailing address. Contact details are not public record.',
        },
        {
          q: 'Can I keep a pitch list inside it?',
          a: 'Yes. The CRM holds deals, people, companies and places, and a parcel or a survey site can be sent straight into a deal. It is one table with filters, not a separate product.',
        },
        {
          q: 'Can a client or a partner see the map?',
          a: 'A share link opens the live map with no login. Teammates are invited into the workspace and included in the price.',
        },
      ],
    },
    included: [
      'Unlimited surveys and sites',
      'Parcel maps for ten markets, owner of record where the county publishes it',
      'Zoning, permit and entitlement layers',
      'Census demographic choropleths',
      'AI flyer and listing extraction',
      'Tour planning with drive times',
      'Client share links, tour books and comparison PDFs',
      'CSV export and saved map views',
      'Team members by invitation',
    ],
    meta: {
      title: 'Land Quotient for investment sales brokers — every owner in your product type',
      description:
        'The owners in your asset class ranked by what they hold, from the county roll, with your comps mapped against them. Ten markets, $29/month, teammates included.',
    },
  },
}

/** The cross-links at the foot of every public page, in the order they read best. */
export const ALSO_ON = [
  { href: '/', name: 'Tenant rep brokers', body: 'Market surveys, tours and share links.' },
  { href: '/developers', name: 'Developers', body: 'Zoning, entitlements and the permit pipeline.' },
  { href: '/investors', name: 'Investors', body: 'Owner of record, portfolios and mailing addresses.' },
  { href: '/investment-sales', name: 'Investment sales brokers', body: 'Owner lookup and comps.' },
  { href: '/markets', name: 'Markets', body: 'Ten counties, 6.2 million parcels.' },
]
