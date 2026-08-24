export interface Page {
  url: string
  depth: number
  parent: string | null
  discoveredVia: 'seed' | 'link' | 'sitemap' | 'redirect'
  status: number
  ok: boolean
  error: string | null
  redirectTo: string | null
  title: string | null
  description: string | null
  canonical: string | null
  noindex: boolean
  nofollow: boolean
  contentType: string | null
  lastModified: string | null
  bytes: number
  responseMs: number
  wordCount: number
  h1: string | null
  lang: string | null
  alternates: { hreflang: string; href: string }[]
  internalLinks: number
  externalLinks: number
  images: { loc: string; caption: string | null }[]
  isDocument: boolean
  rendered?: boolean
}

export interface CrawlOptions {
  maxPages: number
  maxDepth: number
  concurrency: number
  delayMs: number
  timeoutMs: number
  respectRobots: boolean
  includeSubdomains: boolean
  includeDocuments: boolean
  stripQuery: boolean
  seedFromSitemap: boolean
  checkExternalLinks: boolean
  renderJs: boolean
  includePatterns: string
  excludePatterns: string
}

export type CrawlStatus = 'queued' | 'running' | 'stopping' | 'stopped' | 'complete' | 'error'

export interface CrawlSummary {
  id: string
  rootUrl: string
  status: CrawlStatus
  error: string | null
  startedAt: string | null
  finishedAt: string | null
  crawled: number
  queued: number
  active: number
  maxPages: number
  current: string[]
  robots: { available: boolean; blocked: number; crawlDelay: number | null; sitemaps: string[] }
  warnings: string[]
  rendering: boolean
}

export interface IssueUrl {
  url: string
  detail?: string
  from?: string | null
}

export interface Issue {
  id: string
  severity: 'error' | 'warning' | 'info'
  label: string
  description: string
  count: number
  urls: IssueUrl[]
}

export interface CrawlStats {
  total: number
  indexable: number
  ok: number
  redirects: number
  broken: number
  noindex: number
  documents: number
  externalLinks: number
  maxDepth: number
  avgWords: number
  avgResponseMs: number
}

export interface ExternalLink {
  url: string
  count: number
  status: number | null
  from: string[]
}

export interface CrawlResult extends CrawlSummary {
  options: CrawlOptions
  pages: Page[]
  externalLinks: ExternalLink[]
  redirects: { from: string; to: string | null; status: number }[]
  audit: { issues: Issue[]; stats: CrawlStats }
}

export interface ExportSettings {
  priorityMode: 'depth' | 'fixed' | 'none'
  fixedPriority: number
  changefreqMode: 'depth' | 'fixed' | 'none'
  fixedChangefreq: string
  includeLastmod: boolean
  includeAlternates: boolean
  includeImages: boolean
  gzip: boolean
}

export type ExportFormat = 'xml' | 'txt' | 'csv' | 'html'

export interface ExportResponse {
  format: ExportFormat
  count: number
  robotsLine: string
  files: { name: string; content: string; encoding?: 'base64' }[]
}
