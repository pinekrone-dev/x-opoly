import type {
  Account,
  BillingConfig,
  BillingStatus,
  Invite,
  Zone,
  AppFeatures,
  DealStage,
  CompetitionResult,
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
  /** Operator only: a single-use 100%-off signup code, no card required. */
  mintFreeCode: () => request<{ code: string }>('/api/billing/free-code', { method: 'POST' }),
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
  createZone: (surveyId: string, zone: { label: string; lat: number; lng: number; radiusMiles: number; color?: string }) =>
    request<{ zone: Zone }>(`/api/surveys/${surveyId}/zones`, json(zone)),
  deleteZone: (id: string) => request<void>(`/api/zones/${id}`, { method: 'DELETE' }),
  createInvite: (email: string) =>
    request<{ invite: Invite; url: string }>('/api/invites', json({ email })),
  revokeInvite: (id: string) => request<void>(`/api/invites/${id}`, { method: 'DELETE' }),
  setTwoFactor: (input: { enabled: boolean; password: string; phone?: string }) =>
    request<{ user: Account }>('/api/auth/2fa', json(input)),
  changePassword: (input: { currentPassword: string; newPassword: string }) =>
    request<{ ok: true }>('/api/auth/password', json(input)),

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
