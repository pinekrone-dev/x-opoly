import type { CrmRecord, Deal, Person, Place, RecordType } from '../types'

/**
 * What each CRM object is called, where it lives, and how to read one at a
 * glance. Kept in one table because the four objects differ in their columns,
 * not their behaviour — four hand-written copies of this is four places for
 * the labels to drift apart.
 */
export interface ObjectSpec {
  type: RecordType
  /** URL segment and API path: /deals, /people, … */
  segment: string
  label: string
  singular: string
  /** What an empty list should say, in the broker's terms. */
  empty: string
  /** The fields the "new record" form asks for. */
  create: DetailField[]
  /** Every typed column the profile shows and edits. */
  details: DetailField[]
}

export interface DetailField {
  key: string
  label: string
  placeholder?: string
  type?: 'text' | 'number' | 'date' | 'textarea'
}

export const OBJECTS: ObjectSpec[] = [
  {
    type: 'deal',
    segment: 'deals',
    label: 'Deals',
    singular: 'Deal',
    empty: 'A deal is where people, companies and places come together. Start one and add the parties.',
    create: [
      { key: 'name', label: 'Deal name', placeholder: 'Vega Foods — Costa Mesa' },
      { key: 'kind', label: 'Type', placeholder: 'Tenant Rep' },
    ],
    details: [
      { key: 'name', label: 'Deal name' },
      { key: 'kind', label: 'Type', placeholder: 'Tenant Rep' },
      { key: 'stage', label: 'Stage', placeholder: 'prospect' },
      { key: 'value', label: 'Value', type: 'number' },
      { key: 'closeDate', label: 'Expected close', type: 'date' },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  {
    type: 'person',
    segment: 'people',
    label: 'People',
    singular: 'Person',
    empty: 'The decision makers, the listing side, the people you actually call.',
    create: [
      { key: 'firstName', label: 'First name', placeholder: 'Dana' },
      { key: 'lastName', label: 'Last name', placeholder: 'Reyes' },
      { key: 'email', label: 'Email', placeholder: 'dana@vega.com' },
      { key: 'phone', label: 'Phone', placeholder: '(714) 555-0134' },
      { key: 'title', label: 'Title', placeholder: 'Director of Real Estate' },
    ],
    details: [
      { key: 'firstName', label: 'First name' },
      { key: 'lastName', label: 'Last name' },
      { key: 'title', label: 'Title' },
      { key: 'email', label: 'Email' },
      { key: 'phone', label: 'Phone' },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  {
    type: 'company',
    segment: 'companies',
    label: 'Companies',
    singular: 'Company',
    empty: 'Tenants, landlords, ownership entities — the names behind the people.',
    create: [
      { key: 'name', label: 'Company name', placeholder: 'Vega Foods' },
      { key: 'industry', label: 'Industry', placeholder: 'Grocery' },
      { key: 'website', label: 'Website', placeholder: 'vegafoods.com' },
      { key: 'phone', label: 'Phone' },
    ],
    details: [
      { key: 'name', label: 'Company name' },
      { key: 'industry', label: 'Industry' },
      { key: 'website', label: 'Website' },
      { key: 'phone', label: 'Phone' },
      { key: 'address', label: 'Address' },
      { key: 'city', label: 'City' },
      { key: 'state', label: 'State' },
      { key: 'zip', label: 'ZIP' },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  {
    type: 'place',
    segment: 'places',
    label: 'Places',
    singular: 'Place',
    empty: 'Buildings you know. Send one into any survey without retyping it.',
    create: [
      { key: 'name', label: 'Name', placeholder: 'Harbor & 21st' },
      { key: 'address', label: 'Address', placeholder: '2101 Harbor Blvd' },
      { key: 'city', label: 'City', placeholder: 'Costa Mesa' },
      { key: 'state', label: 'State', placeholder: 'CA' },
      { key: 'sizeSqft', label: 'Size (SF)', type: 'number' },
      { key: 'askingRate', label: 'Asking rate', type: 'number' },
    ],
    details: [
      { key: 'name', label: 'Name' },
      { key: 'address', label: 'Address' },
      { key: 'city', label: 'City' },
      { key: 'state', label: 'State' },
      { key: 'zip', label: 'ZIP' },
      { key: 'propertyType', label: 'Property type', placeholder: 'Retail' },
      { key: 'sizeSqft', label: 'Size (SF)', type: 'number' },
      { key: 'acreage', label: 'Acreage', type: 'number' },
      { key: 'askingRate', label: 'Asking rate', type: 'number' },
      { key: 'rateUnit', label: 'Rate unit', placeholder: 'sf-yr' },
      { key: 'availability', label: 'Availability' },
      { key: 'lat', label: 'Latitude', type: 'number' },
      { key: 'lng', label: 'Longitude', type: 'number' },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
]

export const objectFor = (type: RecordType): ObjectSpec =>
  OBJECTS.find((spec) => spec.type === type) ?? OBJECTS[0]

export const objectForSegment = (segment: string): ObjectSpec | undefined =>
  OBJECTS.find((spec) => spec.segment === segment)

/** The one line that identifies a record in a list. */
export function titleOf(type: RecordType, record: CrmRecord): string {
  if (type === 'person') {
    const person = record as Person
    const name = [person.firstName, person.lastName].filter(Boolean).join(' ').trim()
    return name || person.email || 'Unnamed person'
  }
  if (type === 'place') {
    const place = record as Place
    return place.name || place.address || 'Untitled place'
  }
  return (record as Deal).name || 'Untitled'
}

/** The quieter second line: context, not a repeat of the title. */
export function subtitleOf(type: RecordType, record: CrmRecord): string {
  if (type === 'person') {
    const person = record as Person
    return [person.title, person.email].filter(Boolean).join(' · ')
  }
  if (type === 'place') {
    const place = record as Place
    const where = [place.address, place.city, place.state].filter(Boolean).join(', ')
    const size = place.sizeSqft ? `${place.sizeSqft.toLocaleString()} SF` : ''
    return [where, size].filter(Boolean).join(' · ')
  }
  if (type === 'company') {
    const company = record as { industry?: string | null; website?: string | null }
    return [company.industry, company.website].filter(Boolean).join(' · ')
  }
  const deal = record as Deal
  const parties = deal.parties?.length ? `${deal.parties.length} parties` : ''
  return [deal.kind, deal.stage, parties].filter(Boolean).join(' · ')
}
