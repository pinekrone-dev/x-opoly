import type { CrawlOptions, CrawlResult, CrawlSummary, ExportFormat, ExportResponse, ExportSettings } from './types'

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json()
    return body?.error || `Request failed with status ${response.status}.`
  } catch {
    return `Request failed with status ${response.status}.`
  }
}

export async function startCrawl(url: string, options: Partial<CrawlOptions>): Promise<{ id: string; rootUrl: string }> {
  const response = await fetch('/api/crawl', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, options }),
  })
  if (!response.ok) throw new Error(await readError(response))
  return response.json()
}

export async function fetchResult(id: string): Promise<CrawlResult> {
  const response = await fetch(`/api/crawl/${id}/result`)
  if (!response.ok) throw new Error(await readError(response))
  return response.json()
}

export async function stopCrawl(id: string): Promise<CrawlSummary> {
  const response = await fetch(`/api/crawl/${id}/stop`, { method: 'POST' })
  if (!response.ok) throw new Error(await readError(response))
  return response.json()
}

export async function requestExport(
  id: string,
  format: ExportFormat,
  urls: string[],
  settings: ExportSettings,
): Promise<ExportResponse> {
  const response = await fetch(`/api/crawl/${id}/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ format, urls, settings }),
  })
  if (!response.ok) throw new Error(await readError(response))
  return response.json()
}

/**
 * Subscribes to crawl progress. Returns an unsubscribe function.
 * Falls back to nothing if the browser cannot open the stream — the caller
 * still polls the result endpoint when the stream closes.
 */
export function subscribeToCrawl(
  id: string,
  handlers: { onProgress: (summary: CrawlSummary) => void; onDone: (summary: CrawlSummary) => void; onError: () => void },
): () => void {
  const source = new EventSource(`/api/crawl/${id}/stream`)

  source.addEventListener('progress', (event) => {
    handlers.onProgress(JSON.parse((event as MessageEvent).data))
  })
  source.addEventListener('done', (event) => {
    handlers.onDone(JSON.parse((event as MessageEvent).data))
    source.close()
  })
  source.onerror = () => {
    source.close()
    handlers.onError()
  }

  return () => source.close()
}

export function downloadFile(name: string, content: string, mime: string, encoding?: 'base64'): void {
  let blob: Blob
  if (encoding === 'base64') {
    const binary = atob(content)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    blob = new Blob([bytes], { type: 'application/gzip' })
  } else {
    blob = new Blob([content], { type: mime })
  }
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
