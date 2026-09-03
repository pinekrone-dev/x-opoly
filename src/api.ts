import type { BookStyle,
  Account,
  CrmRecord,
  Deal,
  Place,
  RecordType,
  BillingConfig,
  BillingStatus,
  Invite,
  TeamMember,
  Zone,
  AppFeatures,
  DealStage,
  Comp,
  CompetitionResult,
  MapView,
  MarketStatus,
  ParcelQuery,
  ParcelRow,
  ParcelSearch,
  Demographics,
  GeocodeResult,
  PlaceCategory,
  FlyerExtraction,
  Property,
  PropertyImage,
  SharePayload,
  Survey,
  TourPlan,
  TourRequest,
} from './types'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (response.status === 204) return undefined as T
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const error = new Error(body?.error || `Request failed with status ${response.status}`)
    Object.assign(error, { status: response.status, body })
    throw error
  }
  return body as T
}

const json = (payload: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
})

export const api = {
  health: () => request<{ features: AppFeatures }>('/api/health'),

  // --- accounts -------------------------------------------------------------
  me: () =>
    request<{ user: Account | null; setupRequired: boolean; smsConfigured: boolean; billing: BillingConfig }>(
      '/api/auth/me',
    ),
  register: (input: { email: string; password: string; name?: string; phone?: string; inviteToken?: string }) =>
    request<{
      user: Account
      adoptedSurveys?: number
      requiresVerification?: boolean
      emailFailed?: boolean
    }>('/api/auth/register', json(input)),

  /** Redeems the emailed verification link; signs the browser in on success. */
  verifyEmail: (token: string) => request<{ user: Account }>('/api/auth/verify-email', json({ token })),
  resendVerification: (email: string) =>
    request<{ ok: true; message: string }>('/api/auth/resend-verification', json({ email })),
  /** Operator only: sends a test email to the operator and reports the provider's verdict. */
  emailCheck: () =>
    request<{ ok: boolean; provider: string; id?: string | null; to?: string; sentAt?: string; error?: string }>(
      '/api/auth/email-check',
      { method: 'POST' },
    ),

  // --- billing --------------------------------------------------------------
  billingStatus: () => request<BillingStatus>('/api/billing'),
  /** `hosted` asks for the redirect flow, for when the embedded form cannot mount. */
  startCheckout: (options: { hosted?: boolean } = {}) =>
    request<{ clientSecret: string | null; url: string | null; embedded: boolean }>(
      '/api/billing/checkout',
      json(options),
    ),
  confirmCheckout: (sessionId: string) =>
    request<{ active: boolean; status: string }>(`/api/billing/confirm?session_id=${encodeURIComponent(sessionId)}`),
  billingPortal: () => request<{ url: string }>('/api/billing/portal', { method: 'POST' }),
  signIn: (input: { email: string; password: string }) =>
    request<{
      user?: Account
      twoFactor: boolean
      challengeId?: string
      phoneHint?: string
      method?: 'sms' | 'totp'
    }>('/api/auth/login', json(input)),

  startTotp: (password: string) =>
    request<{ secret: string; uri: string }>('/api/auth/totp/setup', json({ password })),
  confirmTotp: (code: string) =>
    request<{ user: Account }>('/api/auth/totp/confirm', json({ code })),
  disableTotp: (password: string) =>
    request<{ user: Account }>('/api/auth/totp/disable', json({ password })),
  verifyCode: (input: { challengeId: string; code: string }) =>
    request<{ user: Account }>('/api/auth/verify', json(input)),
  signOut: () => request<void>('/api/auth/logout', { method: 'POST' }),

  /** Who an invitation is addressed to; public, for the joining page. */
  checkInvite: (token: string) =>
    request<{ email: string }>(`/api/auth/invite/${encodeURIComponent(token)}`),
  listInvites: () => request<{ invites: Invite[] }>('/api/invites'),

  // --- the account's own settings ------------------------------------------
  account: {
    /** Everyone on this team, the owner first. */
    team: () => request<{ members: TeamMember[] }>('/api/account/team'),
    /** Persists a preference; the answer is the account as it now stands. */
    updateSettings: (patch: { defaultMarket?: string | null }) =>
      request<{ user: Account }>('/api/account/settings', { ...json(patch), method: 'PATCH' }),
  },
  createZone: (surveyId: string, zone: { label: string; lat: number; lng: number; radiusMiles: number; color?: string }) =>
    request<{ zone: Zone }>(`/api/surveys/${surveyId}/zones`, json(zone)),
  updateZone: (id: string, patch: { label?: string; color?: string }) =>
    request<{ zone: Zone }>(`/api/zones/${id}`, { ...json(patch), method: 'PATCH' }),
  deleteZone: (id: string) => request<void>(`/api/zones/${id}`, { method: 'DELETE' }),
  createInvite: (email: string) =>
    request<{ invite: Invite; url: string }>('/api/invites', json({ email })),
  revokeInvite: (id: string) => request<void>(`/api/invites/${id}`, { method: 'DELETE' }),
  setTwoFactor: (input: { enabled: boolean; password: string; phone?: string }) =>
    request<{ user: Account }>('/api/auth/2fa', json(input)),
  changePassword: (input: { currentPassword: string; newPassword: string }) =>
    request<{ ok: true }>('/api/auth/password', json(input)),

  // --- CRM ------------------------------------------------------------------
  /** The four object types share one shape, so they share one set of calls. */
  crm: {
    /**
     * A bounded list, newest first. `truncated` says more exist past the
     * server's limit; `limit` and `offset` page through them.
     */
    list: <T = CrmRecord>(segment: string, search = '', page?: { limit?: number; offset?: number }) => {
      const params = new URLSearchParams()
      if (search) params.set('q', search)
      if (page?.limit != null) params.set('limit', String(page.limit))
      if (page?.offset != null) params.set('offset', String(page.offset))
      const query = params.toString()
      return request<{ records: T[]; truncated: boolean }>(`/api/crm/${segment}${query ? `?${query}` : ''}`)
    },
    /** How many of each record type the team holds, and how many surveys. One request. */
    counts: () => request<{ counts: Record<string, number>; surveys: number }>('/api/crm/counts'),
    get: <T = CrmRecord>(segment: string, id: string) => request<{ record: T }>(`/api/crm/${segment}/${id}`),
    create: <T = CrmRecord>(segment: string, input: Record<string, unknown>) =>
      request<{ record: T }>(`/api/crm/${segment}`, json(input)),
    update: <T = CrmRecord>(segment: string, id: string, patch: Record<string, unknown>) =>
      request<{ record: T }>(`/api/crm/${segment}/${id}`, { ...json(patch), method: 'PATCH' }),
    remove: (segment: string, id: string) => request<void>(`/api/crm/${segment}/${id}`, { method: 'DELETE' }),
    addParty: (dealId: string, input: { kind: RecordType; refId: string; role?: string }) =>
      request<{ deal: Deal }>(`/api/crm/deals/${dealId}/parties`, json(input)),
    removeParty: (dealId: string, partyId: string) =>
      request<void>(`/api/crm/deals/${dealId}/parties/${partyId}`, { method: 'DELETE' }),
    /**
     * What the CRM already knows about a parcel.
     *
     * Both halves are required because a parcel id is unique per county and
     * nothing more: without the market, Austin 114452 and Broward 114452 are
     * the same lookup.
     */
    parcel: (market: string, parcelId: string) =>
      request<{ place: Place | null; deals: Deal[] }>(
        `/api/crm/parcel?market=${encodeURIComponent(market)}&parcel=${encodeURIComponent(parcelId)}`,
      ),
    /** Copies a known building into a survey and onto that survey's tour. */
    sendPlace: (placeId: string, input: { surveyId: string }) =>
      request<{ property: Property }>(`/api/crm/places/${placeId}/send`, json(input)),
  },

  /** A parcel hunt in plain English, answered as the GIS view's own filters. */
  gisScout: (input: { prompt: string; assetTypes: string[]; valueLabel?: string }) =>
    request<{
      filters: {
        assetTypes: string[]
        valueMin: number | null
        valueMax: number | null
        acresMin: number | null
        acresMax: number | null
        keyword: string | null
      }
      empty: boolean
      explanation: string | null
      source: 'ai' | 'heuristic' | 'rules'
      provider: string | null
      model: string | null
      /** Today's AI spend, present only when a model was actually called. */
      budget?: { used: number; cap: number }
    }>('/api/gis/scout', json(input)),

  /*
   * Sale comps the broker collected themselves.
   *
   * Nothing here fetches from a listing site. `importComps` takes what their
   * own capture produced, and it lands in their workspace only — comps are
   * never pooled across teams.
   */
  comps: {
    list: (market?: string) =>
      request<{ comps: Comp[]; unplaced: number }>(
        market ? `/api/gis/comps?market=${encodeURIComponent(market)}` : '/api/gis/comps',
      ),
    /** `listings` for parsed records, `csv` for the raw text of an export. */
    import: (input: {
      listings?: unknown
      csv?: string
      market?: string
      source?: string
    }) =>
      request<{ added: number; updated: number; dropped: number; truncated: number }>(
        '/api/gis/comps',
        json(input),
      ),
    /** One geocoding pass. Call again while `remaining` is above zero. */
    place: () =>
      request<{ placed: number; failed: number; remaining: number }>(
        '/api/gis/comps/place',
        json({}),
      ),
    remove: (id: string) =>
      request<{ removed: number }>(`/api/gis/comps/${id}`, { method: 'DELETE' }),
  },

  /*
   * Saved map views: a market, configured, under a name.
   *
   * The state is an opaque blob on both sides. The server bounds and scopes
   * it; only the map knows what is in it.
   */
  views: {
    list: (market?: string) =>
      request<{ views: MapView[] }>(
        market ? `/api/gis/views?market=${encodeURIComponent(market)}` : '/api/gis/views',
      ),
    save: (input: { market: string; name: string; state: Record<string, unknown> }) =>
      request<{ view: MapView }>('/api/gis/views', json(input)),
    rename: (id: string, name: string) =>
      request<{ view: MapView }>(`/api/gis/views/${id}`, {
        ...json({ name }),
        method: 'PATCH',
      }),
    remove: (id: string) =>
      request<{ removed: number }>(`/api/gis/views/${id}`, { method: 'DELETE' }),
  },

  /*
   * The county, asked rather than downloaded.
   *
   * A market whose rebuild has reached the server answers these; one that has
   * not answers `ready: false`, and the GIS falls back to downloading the
   * published index the old way. That fallback is why every call here is
   * allowed to fail quietly.
   */
  parcels: {
    /** What a market is, and whether the server can answer for it at all. */
    market: (market: string) =>
      request<MarketStatus>(`/api/gis/market?market=${encodeURIComponent(market)}`),

    /** One search: a page of parcels, the ids to highlight, and the totals. */
    search: (market: string, filters: ParcelQuery = {}, page: { limit?: number; offset?: number } = {}) => {
      const params = new URLSearchParams({ market })
      if (filters.query) params.set('q', filters.query)
      if (filters.assets?.length) params.set('at', filters.assets.join(','))
      if (filters.valueMin != null) params.set('vmin', String(filters.valueMin))
      if (filters.valueMax != null) params.set('vmax', String(filters.valueMax))
      if (filters.acresMin != null) params.set('amin', String(filters.acresMin))
      if (filters.acresMax != null) params.set('amax', String(filters.acresMax))
      if (filters.owner) {
        params.set('owner', filters.owner.id)
        params.set('ownerKind', filters.owner.kind)
      }
      if (page.limit != null) params.set('limit', String(page.limit))
      if (page.offset) params.set('offset', String(page.offset))
      return request<ParcelSearch>(`/api/gis/parcels?${params.toString()}`)
    },

    /** One parcel, whole, for the card. */
    one: (market: string, id: string | number) =>
      request<{ parcel: ParcelRow }>(
        `/api/gis/parcel?market=${encodeURIComponent(market)}&id=${encodeURIComponent(String(id))}`,
      ),
  },

  listSurveys: () => request<{ surveys: Survey[] }>('/api/surveys'),
  createSurvey: (input: { name: string; clientName?: string; brokerName?: string; companyName?: string; centerLat?: number; centerLng?: number; zoom?: number }) =>
    request<{ survey: Survey }>('/api/surveys', json(input)),
  getSurvey: (id: string) =>
    request<{ survey: Survey; properties: Property[]; stages: DealStage[]; zones: Zone[] }>(`/api/surveys/${id}`),
  updateSurvey: (id: string, patch: Partial<Survey> & Record<string, unknown>) =>
    request<{ survey: Survey }>(`/api/surveys/${id}`, { ...json(patch), method: 'PATCH' }),
  deleteSurvey: (id: string) => request<void>(`/api/surveys/${id}`, { method: 'DELETE' }),

  addProperty: (surveyId: string, input: Partial<Property>) =>
    request<{ property: Property }>(`/api/surveys/${surveyId}/properties`, json(input)),
  updateProperty: (id: string, patch: Partial<Property>) =>
    request<{ property: Property }>(`/api/properties/${id}`, { ...json(patch), method: 'PATCH' }),
  deleteProperty: (id: string) => request<void>(`/api/properties/${id}`, { method: 'DELETE' }),

  listStages: (surveyId: string) => request<{ stages: DealStage[] }>(`/api/surveys/${surveyId}/stages`),
  addStage: (surveyId: string, input: { name: string; color?: string }) =>
    request<{ stage: DealStage }>(`/api/surveys/${surveyId}/stages`, json(input)),
  updateStage: (id: string, patch: { name?: string; color?: string; hidden?: boolean }) =>
    request<{ stage: DealStage }>(`/api/stages/${id}`, { ...json(patch), method: 'PATCH' }),
  deleteStage: (id: string) => request<void>(`/api/stages/${id}`, { method: 'DELETE' }),
  reorderStages: (surveyId: string, order: string[]) =>
    request<{ stages: DealStage[] }>(`/api/surveys/${surveyId}/stages`, { ...json({ order }), method: 'PUT' }),

  listImages: (propertyId: string) =>
    request<{ images: PropertyImage[] }>(`/api/properties/${propertyId}/images`),

  /**
   * Stores an image against a property.
   *
   * Sent as raw bytes with the type in the header rather than as multipart:
   * the body is already a Blob the canvas produced, and there is nothing else
   * to send alongside it.
   */
  addImage: (
    propertyId: string,
    blob: Blob,
    meta: { caption?: string; source?: 'flyer-crop' | 'upload' } = {},
  ) =>
    request<{ image: PropertyImage; property: Property }>(`/api/properties/${propertyId}/images`, {
      method: 'POST',
      headers: {
        'content-type': blob.type || 'image/png',
        ...(meta.caption ? { 'x-caption': encodeURIComponent(meta.caption) } : {}),
        ...(meta.source ? { 'x-source': meta.source } : {}),
      },
      body: blob,
    }),
  updateImage: (id: string, patch: { caption?: string | null }) =>
    request<{ image: PropertyImage }>(`/api/images/${id}`, { ...json(patch), method: 'PATCH' }),
  deleteImage: (id: string) => request<void>(`/api/images/${id}`, { method: 'DELETE' }),
  reorderImages: (propertyId: string, order: string[]) =>
    request<{ images: PropertyImage[] }>(`/api/properties/${propertyId}/images`, {
      ...json({ order }),
      method: 'PUT',
    }),
  /**
   * Reads the flyer already on a property and fills the site profile in.
   * Only empty fields are filled unless `overwrite` is asked for.
   */
  extractFlyer: (propertyId: string, options: { overwrite?: boolean } = {}) =>
    request<{ property: Property; extraction: FlyerExtraction }>(
      `/api/properties/${propertyId}/extract`,
      json(options),
    ),

  /** Attaches a flyer to a property that already exists, with no extraction. */
  attachFlyer: (propertyId: string, file: File) =>
    request<{ property: Property }>(`/api/properties/${propertyId}/flyer`, {
      method: 'POST',
      headers: {
        'content-type': file.type || 'application/pdf',
        'x-filename': encodeURIComponent(file.name),
      },
      body: file,
    }),

  bookStyle: (surveyId: string, input: { instruction?: string; style?: Partial<BookStyle> }) =>
    request<{ book: BookStyle }>(`/api/surveys/${surveyId}/book-style`, json(input)),
  planTour: (surveyId: string, options: TourRequest = {}) =>
    request<TourPlan>(`/api/surveys/${surveyId}/tour`, json(options)),
  saveTourOrder: (surveyId: string, order: string[]) =>
    request<{ properties: Property[] }>(`/api/surveys/${surveyId}/tour`, { ...json({ order }), method: 'PUT' }),

  updateShare: (surveyId: string, input: { enabled?: boolean; expiresAt?: string | null; regenerate?: boolean }) =>
    request<{ survey: Survey }>(`/api/surveys/${surveyId}/share`, json(input)),
  getShared: (token: string) => request<SharePayload>(`/api/share/${token}`),

  geocode: (query: string) => request<{ results: GeocodeResult[] }>(`/api/geocode?q=${encodeURIComponent(query)}`),
  placeCategories: () => request<{ categories: PlaceCategory[]; rings: number[] }>('/api/places/categories'),

  nearby: (params: { lat: number; lng: number; category?: string; keyword?: string; radius: number }) => {
    const query = new URLSearchParams({
      lat: String(params.lat),
      lng: String(params.lng),
      radius: String(params.radius),
    })
    if (params.category) query.set('category', params.category)
    if (params.keyword) query.set('keyword', params.keyword)
    return request<CompetitionResult>(`/api/places/nearby?${query.toString()}`)
  },

  /** Pasted listing text → a filled-in, placed property. */
  pasteProperty: (surveyId: string, text: string, mapCenter?: { lat: number; lng: number } | null) =>
    request<{ property: Property; extraction: { source: string; confidence: string; uncertainFields: string[] } }>(
      `/api/surveys/${surveyId}/paste`,
      json({ text, mapCenter: mapCenter ?? undefined }),
    ),

  demographics: (lat: number, lng: number) => request<Demographics>(`/api/demographics?lat=${lat}&lng=${lng}`),

  /** Uploads the raw file body; the filename travels in a header. */
  uploadFlyer: (surveyId: string, file: File, hint?: { lat: number; lng: number } | null) =>
    request<{ property: Property; extraction: { model: string; confidence: string; uncertainFields: string[] } }>(
      `/api/surveys/${surveyId}/flyer`,
      {
        method: 'POST',
        headers: {
          'content-type': file.type || 'application/octet-stream',
          'x-filename': encodeURIComponent(file.name),
          // Where the broker is looking. Used only when the flyer carries no
          // address to geocode, so the pin lands in view rather than nowhere.
          ...(hint ? { 'x-map-lat': String(hint.lat), 'x-map-lng': String(hint.lng) } : {}),
        },
        body: file,
      },
    ),

  uploadPhoto: (propertyId: string, file: File) =>
    request<{ property: Property }>(`/api/properties/${propertyId}/photo`, {
      method: 'POST',
      headers: { 'content-type': file.type, 'x-filename': encodeURIComponent(file.name) },
      body: file,
    }),
}
