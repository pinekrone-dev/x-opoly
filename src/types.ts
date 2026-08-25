/** The signed-in broker. The phone is only ever a hint, never the number. */
/** A one-time signup link for a colleague, shown on the Share tab. */
export interface Invite {
  id: string
  email: string
  createdAt: string
  expiresAt: string
  used: boolean
}

export interface Account {
  id: string
  email: string
  name: string | null
  phoneHint: string | null
  hasPhone: boolean
  sms2fa: boolean
  totp: boolean
  secondFactor: 'sms' | 'totp' | null
  createdAt: string
  lastLoginAt: string | null
}

export type Stage = 'prospect' | 'touring' | 'loi' | 'under_contract' | 'passed'

/** A pipeline column. Named, coloured and ordered by the broker. */
export interface DealStage {
  id: string
  surveyId?: string
  name: string
  color: string
  position: number
  hidden: boolean
}

/** What reading a flyer produced, and what it did with it. */
export interface FlyerExtraction {
  model?: string
  confidence: 'high' | 'medium' | 'low'
  /** Fields the model was unsure of, for the broker to confirm. */
  uncertainFields: string[]
  /** Fields this run wrote. */
  filled: string[]
  /** Fields left alone because they already had a value. */
  skipped: string[]
}

/** A stored photo. Either uploaded whole or cut out of a rendered flyer page. */
export interface PropertyImage {
  id: string
  propertyId?: string
  url: string
  path?: string
  caption: string | null
  position: number
  source: 'flyer-crop' | 'upload' | null
  createdAt?: string
}

/** One arbitrary row on a site card — "Available SF", "Lease Rate". */
export interface CustomField {
  label: string
  value: string | null
}

export interface Property {
  id: string
  surveyId?: string
  name: string | null
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  lat: number | null
  lng: number | null
  stage: Stage
  rentRate: number | null
  rentUnit: string | null
  nnn: number | null
  sizeSqft: number | null
  acreage: number | null
  parkingSpaces: number | null
  zoning: string | null
  yearBuilt: number | null
  availability: string | null
  listingBroker: string | null
  brokerEmail: string | null
  brokerPhone: string | null
  stageId: string | null
  tourMinutes: number | null
  fields: CustomField[]
  images: PropertyImage[]
  coverImageId: string | null
  notes?: string | null
  flyerUrl: string | null
  flyerName: string | null
  photoUrl: string | null
  tourOrder: number | null
  /** Kept off the client share link; the broker still sees it, dimmed. */
  hidden?: boolean
  createdAt: string
  updatedAt: string
}

export interface Survey {
  id: string
  name: string
  clientName: string | null
  brokerName: string | null
  companyName: string | null
  brandColor: string
  center: { lat: number; lng: number } | null
  zoom: number
  share: {
    token: string | null
    enabled: boolean
    expiresAt: string | null
    url: string | null
    /** Shade census block groups on the client's map. */
    showDemographics?: boolean
    /** Print a QR directions code on each tour book stop. */
    showQr?: boolean
  }
  tour: {
    startTime: string
    stopMinutes: number
    start: TourAnchor | null
    end: TourAnchor | null
  }
  pinCount?: number
  createdAt: string
  updatedAt: string
}

/** Where a tour begins or ends — an address, not necessarily one of the sites. */
export interface TourAnchor {
  address: string | null
  lat: number
  lng: number
}

/** What the planner asks the server to schedule. */
export interface TourRequest {
  propertyIds?: string[]
  startId?: string | null
  startTime?: string
  stopMinutes?: number
  optimize?: boolean
  start?: TourAnchor | null
  end?: TourAnchor | null
}

export interface TourStopSchedule {
  id: string
  driveMinutes: number
  stopMinutes: number
  arriveMinutes: number
  arrive: string
  depart: string
}

export interface Itinerary {
  items: TourStopSchedule[]
  startTime: string
  endTime: string
  driveMinutes: number
  totalMinutes: number
  driveLabel: string
  totalLabel: string
}

export interface TourPlan {
  stops: Property[]
  unlocated: Property[]
  miles: number
  minutes: number
  legs: { fromId: string; toId: string; miles: number }[]
  itinerary: Itinerary
  geometry: [number, number][]
  routeSource: 'osrm' | 'estimate' | 'none'
  driveMiles: number
  start: TourAnchor | null
  end: TourAnchor | null
}

export interface GeocodeResult {
  label: string
  lat: number
  lng: number
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
}

export interface RingMetrics {
  miles: number
  metrics: Record<string, number | null>
  blockGroups: number
}

/** One census block group: the unit the choropleth colours. */
export interface DemographicArea {
  geoid: string
  lat: number
  lng: number
  miles: number
  metrics: Record<string, number | null> | null
  geometry: unknown | null
}

export interface Demographics {
  source: string
  radii: RingMetrics[]
  areas: DemographicArea[]
}

export interface MetricDefinition {
  key: string
  label: string
  format: 'count' | 'money' | 'percent' | 'decimal'
  approximate?: boolean
}

export interface TileConfig {
  provider: string
  label?: string
  url: string
  attribution: string
  maxZoom: number
  darkNative: boolean
  placeholder: boolean
  notice?: string
}

export interface AppFeatures {
  flyerExtraction: boolean
  tiles: TileConfig
  basemaps: TileConfig[]
  tileUrl: string
  tileAttribution: string
}

export interface SharePayload {
  survey: {
    name: string
    clientName: string | null
    brokerName: string | null
    companyName: string | null
    brandColor: string
    center: { lat: number; lng: number } | null
    zoom: number
    expiresAt: string | null
    showDemographics?: boolean
  }
  properties: Property[]
}

export interface NearbyBusiness {
  id: string
  name: string
  category: string | null
  address: string | null
  brand: string | null
  website: string | null
  lat: number
  lng: number
  miles: number
  ring: number | null
}

export interface CompetitionResult {
  results: NearbyBusiness[]
  rings: { miles: number; count: number }[]
  radiusMiles: number
  source: string
}

export interface PlaceCategory {
  id: string
  label: string
}
