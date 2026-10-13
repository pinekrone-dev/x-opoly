/*
 * The ground's own shape, for the tilted 3D view.
 *
 * Elevation comes from the Terrain Tiles on AWS Open Data: a global
 * elevation model (USGS 3DEP across the United States, SRTM and others
 * beyond), published as PNG tiles whose colour channels encode metres in
 * the "terrarium" scheme. Public, keyless and served with CORS open, so the
 * browser reads it straight from Amazon: nothing of ours stores, serves or
 * is billed for it.
 */

export const TERRAIN_SOURCE = 'terrain-dem'

export const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'

export const TERRAIN_ATTRIBUTION = 'Elevation: Terrain Tiles on AWS (USGS 3DEP, SRTM and others)'

/** The archive's deepest zoom; the map overzooms past it, which is what it should do. */
export const TERRAIN_MAX_ZOOM = 15

/*
 * Drawn at true scale. Most markets are near-flat at street zoom, and a
 * site survey that exaggerates a slope misdescribes the site; where there
 * is real relief (Phoenix's mountains, San Diego's canyons) it shows as it is.
 */
export const TERRAIN_EXAGGERATION = 1

/** Where the viewer's on/off choice is kept between visits. */
export const TERRAIN_STORAGE_KEY = 'lq:terrain'

/**
 * Whether the ground should be drawn in relief right now.
 *
 * Only while tilted, since a flat view gains nothing from it and still pays
 * for the elevation tiles; only while the viewer has not switched it off; and
 * only at the map's full quality, because a browser already stepped down for
 * want of GPU memory is the one terrain would push over the edge.
 */
export function terrainWanted({ tilted, enabled, gpuLevel }: { tilted: boolean; enabled: boolean; gpuLevel: number }): boolean {
  return tilted && enabled && gpuLevel === 0
}

/** Reads the stored choice. On unless the viewer turned it off; storage that cannot be read is no choice at all. */
export function readTerrainChoice(raw: string | null | undefined): boolean {
  return raw !== 'off'
}
