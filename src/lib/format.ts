export function formatBytes(bytes: number): string {
  if (!bytes) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function formatMs(ms: number): string {
  if (!ms) return '—'
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

export function formatNumber(value: number): string {
  return value.toLocaleString('en-US')
}

export function pathOf(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}` || '/'
  } catch {
    return url
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

export function truncate(value: string | null, length = 60): string {
  if (!value) return '—'
  return value.length > length ? `${value.slice(0, length - 1)}…` : value
}

/** Tailwind classes for an HTTP status pill. */
export function statusTone(status: number): string {
  if (status === 0) return 'bg-rose-500/15 text-rose-300 ring-rose-500/30'
  if (status >= 500) return 'bg-rose-500/15 text-rose-300 ring-rose-500/30'
  if (status >= 400) return 'bg-orange-500/15 text-orange-300 ring-orange-500/30'
  if (status >= 300) return 'bg-amber-500/15 text-amber-300 ring-amber-500/30'
  return 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30'
}

export function statusLabel(status: number): string {
  return status === 0 ? 'ERR' : String(status)
}

export function severityTone(severity: 'error' | 'warning' | 'info'): string {
  if (severity === 'error') return 'bg-rose-500/15 text-rose-300 ring-rose-500/30'
  if (severity === 'warning') return 'bg-amber-500/15 text-amber-300 ring-amber-500/30'
  return 'bg-sky-500/15 text-sky-300 ring-sky-500/30'
}

export function elapsed(startedAt: string | null, finishedAt: string | null): string {
  if (!startedAt) return '—'
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now()
  const seconds = Math.max(0, Math.round((end - new Date(startedAt).getTime()) / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
