export type Stage = 'prospect' | 'touring' | 'loi' | 'under_contract' | 'passed'

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
  notes?: string | null
  flyerUrl: string | null
  flyerName: string | null
  photoUrl: string | null
  tourOrder: number | null
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
  share: { token: string | null; enabled: boolean; expiresAt: string | null; url: string | null }
  pinCount?: number
  createdAt: string
  updatedAt: string
}

export interface TourPlan {
  stops: Property[]
  unlocated: Property[]
  miles: number
  minutes: number
  legs: { fromId: string; toId: string; miles: number }[]
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

export interface Demographics {
  source: string
  area: string
  metrics: Record<string, number | null>
}

export interface TileConfig {
  provider: string
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
