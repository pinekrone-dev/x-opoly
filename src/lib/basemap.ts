import type { TileConfig } from '../types'

/**
 * Which basemap the map should actually draw.
 *
 * Two rules, both learned from a map that went blank and stayed blank:
 *
 * A stored preference is a choice, not a pin. It is kept against the
 * deployment default it was chosen over, so when the server changes its
 * default the older preference is stale by definition and is dropped. Without
 * that, an operator could switch away from a basemap that had started failing
 * and every returning browser would keep the broken one, with no remote way to
 * correct it.
 *
 * A basemap that cannot serve tiles is not a destination. Once it has failed
 * here it is skipped, so one dead tile host degrades the map instead of
 * emptying it.
 */

/** How the choice is persisted: the id, plus the default it was chosen over. */
export interface StoredBasemap {
  id: string
  base: string
}

/**
 * Reads a stored choice, or nothing if it no longer applies.
 *
 * `currentDefault` is the provider the deployment serves today. A bare string
 * is the older format, written before the default was recorded alongside it;
 * it cannot be distinguished from a stale choice, so it is discarded rather
 * than trusted.
 */
export function readStoredBasemap(raw: string | null | undefined, currentDefault: string): string | null {
  if (!raw || !raw.startsWith('{')) return null
  try {
    const parsed = JSON.parse(raw) as Partial<StoredBasemap>
    if (typeof parsed?.id !== 'string' || !parsed.id) return null
    if (parsed.base !== currentDefault) return null
    return parsed.id
  } catch {
    return null
  }
}

/** Serialises a choice against the default it was made over. */
export function writeStoredBasemap(id: string, currentDefault: string): string {
  return JSON.stringify({ id, base: currentDefault } satisfies StoredBasemap)
}

/**
 * Resolves the basemap to draw.
 *
 * Prefers what the viewer picked; falls back to the deployment default, then
 * to anything else that still works. Returns the chosen one unchanged when
 * every option has failed — a blank map with the right label beats crashing,
 * and the failure is reported separately.
 */
export function pickBasemap({
  activeId,
  options,
  fallback,
  broken = [],
}: {
  activeId: string
  options?: TileConfig[] | null
  fallback: TileConfig
  broken?: string[]
}): TileConfig {
  const list = options && options.length > 1 ? options : null
  const chosen = list?.find((entry) => entry.provider === activeId) ?? fallback
  if (!broken.includes(chosen.provider)) return chosen

  const working = (entry: TileConfig) => !broken.includes(entry.provider)
  return (
    list?.find((entry) => entry.provider === fallback.provider && working(entry)) ??
    (working(fallback) ? fallback : undefined) ??
    list?.find(working) ??
    chosen
  )
}
