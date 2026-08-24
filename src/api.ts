import type { AppFeatures, Demographics, GeocodeResult, Property, SharePayload, Survey, TourPlan } from './types'

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

  listSurveys: () => request<{ surveys: Survey[] }>('/api/surveys'),
  createSurvey: (input: { name: string; clientName?: string; brokerName?: string; companyName?: string }) =>
    request<{ survey: Survey }>('/api/surveys', json(input)),
  getSurvey: (id: string) => request<{ survey: Survey; properties: Property[] }>(`/api/surveys/${id}`),
  updateSurvey: (id: string, patch: Partial<Survey> & Record<string, unknown>) =>
    request<{ survey: Survey }>(`/api/surveys/${id}`, { ...json(patch), method: 'PATCH' }),
  deleteSurvey: (id: string) => request<void>(`/api/surveys/${id}`, { method: 'DELETE' }),

  addProperty: (surveyId: string, input: Partial<Property>) =>
    request<{ property: Property }>(`/api/surveys/${surveyId}/properties`, json(input)),
  updateProperty: (id: string, patch: Partial<Property>) =>
    request<{ property: Property }>(`/api/properties/${id}`, { ...json(patch), method: 'PATCH' }),
  deleteProperty: (id: string) => request<void>(`/api/properties/${id}`, { method: 'DELETE' }),

  planTour: (surveyId: string, startId?: string | null) =>
    request<TourPlan>(`/api/surveys/${surveyId}/tour`, json({ startId: startId ?? null })),
  saveTourOrder: (surveyId: string, order: string[]) =>
    request<{ properties: Property[] }>(`/api/surveys/${surveyId}/tour`, { ...json({ order }), method: 'PUT' }),

  updateShare: (surveyId: string, input: { enabled?: boolean; expiresAt?: string | null; regenerate?: boolean }) =>
    request<{ survey: Survey }>(`/api/surveys/${surveyId}/share`, json(input)),
  getShared: (token: string) => request<SharePayload>(`/api/share/${token}`),

  geocode: (query: string) => request<{ results: GeocodeResult[] }>(`/api/geocode?q=${encodeURIComponent(query)}`),
  demographics: (lat: number, lng: number) => request<Demographics>(`/api/demographics?lat=${lat}&lng=${lng}`),

  /** Uploads the raw file body; the filename travels in a header. */
  uploadFlyer: (surveyId: string, file: File) =>
    request<{ property: Property; extraction: { model: string; confidence: string; uncertainFields: string[] } }>(
      `/api/surveys/${surveyId}/flyer`,
      {
        method: 'POST',
        headers: { 'content-type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) },
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
