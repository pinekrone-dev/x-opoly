/**
 * Basemap selection.
 *
 * The tile provider is one environment variable. OpenStreetMap is the default
 * because it needs no key and no billing account; the keyed providers are here
 * so switching is a config change rather than a code change.
 *
 * `offline` serves placeholder tiles from this server — useful for development,
 * air-gapped deployments, and anywhere outbound traffic is filtered.
 */

/**
 * A standard street basemap by default — the ordinary road map people expect,
 * with streets, place names and POI labels, and no API key.
 *
 * Basemaps are never colour-filtered: an earlier version forced light tiles
 * dark with a CSS invert, which inverted the street labels along with them.
 * Dark basemaps remain available in the switcher for anyone who wants one.
 */
export const DEFAULT_PROVIDER = 'osm'

export const TILE_PRESETS = {
  osm: {
    label: 'Street map',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19,
    keyRequired: false,
  },
  'carto-voyager': {
    label: 'Street map (clean)',
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    attribution: '© OpenStreetMap contributors, © CARTO',
    maxZoom: 20,
    keyRequired: false,
  },
  'carto-light': {
    label: 'Muted',
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attribution: '© OpenStreetMap contributors, © CARTO',
    maxZoom: 20,
    keyRequired: false,
  },
  'carto-dark': {
    label: 'Dark',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '© OpenStreetMap contributors, © CARTO',
    maxZoom: 20,
    keyRequired: false,
    darkNative: true,
  },
  mapbox: {
    label: 'Mapbox',
    url: 'https://api.mapbox.com/styles/v1/mapbox/{style}/tiles/{z}/{x}/{y}?access_token={key}',
    attribution: '© Mapbox © OpenStreetMap',
    maxZoom: 22,
    keyRequired: true,
    defaultStyle: 'streets-v12',
  },
  here: {
    label: 'HERE',
    url: 'https://maps.hereapi.com/v3/base/mc/{z}/{x}/{y}/png8?apiKey={key}&style=explore.day',
    attribution: '© HERE',
    maxZoom: 20,
    keyRequired: true,
  },
  maptiler: {
    label: 'MapTiler',
    url: 'https://api.maptiler.com/maps/{style}/{z}/{x}/{y}.png?key={key}',
    attribution: '© MapTiler © OpenStreetMap contributors',
    maxZoom: 22,
    keyRequired: true,
    defaultStyle: 'streets-v2',
  },
  stadia: {
    label: 'Stadia Alidade',
    url: 'https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png?api_key={key}',
    attribution: '© Stadia Maps © OpenMapTiles © OpenStreetMap contributors',
    maxZoom: 20,
    keyRequired: true,
  },
  offline: {
    label: 'Offline placeholder',
    url: '/api/tiles/{z}/{x}/{y}.svg',
    attribution: 'Placeholder grid — no basemap configured',
    maxZoom: 19,
    keyRequired: false,
    placeholder: true,
  },
}

/**
 * Resolves the basemap from the environment.
 *
 * `TILE_URL` wins outright, for a self-hosted tile server. Otherwise
 * `TILE_PROVIDER` picks a preset, and a keyed preset with no `TILE_KEY` falls
 * back to OpenStreetMap rather than silently serving broken tiles.
 */
export function resolveTiles(env = {}) {
  if (env.TILE_URL) {
    return {
      provider: 'custom',
      url: env.TILE_URL,
      attribution: env.TILE_ATTRIBUTION || '',
      maxZoom: Number(env.TILE_MAX_ZOOM) || 19,
      darkNative: env.TILE_DARK === '1',
      placeholder: false,
    }
  }

  const requested = (env.TILE_PROVIDER || DEFAULT_PROVIDER).toLowerCase()
  const preset = TILE_PRESETS[requested] || TILE_PRESETS.osm
  const key = env.TILE_KEY || ''

  if (preset.keyRequired && !key) {
    return {
      ...toConfig(DEFAULT_PROVIDER, TILE_PRESETS[DEFAULT_PROVIDER], ''),
      notice: `${preset.label} needs an API key. Set TILE_KEY, or leave TILE_PROVIDER unset for the keyless default.`,
    }
  }

  return toConfig(requested in TILE_PRESETS ? requested : DEFAULT_PROVIDER, preset, key, env)
}

function toConfig(provider, preset, key, env = {}) {
  const style = env.TILE_STYLE || preset.defaultStyle || ''
  return {
    provider,
    label: preset.label,
    url: preset.url.replace('{key}', key).replace('{style}', style),
    attribution: preset.attribution,
    maxZoom: preset.maxZoom,
    darkNative: Boolean(preset.darkNative),
    placeholder: Boolean(preset.placeholder),
  }
}

/**
 * The basemaps a viewer can switch between right now — the keyless ones, plus
 * any keyed provider this deployment actually has a key for.
 */
export function availableBasemaps(env = {}) {
  const key = env.TILE_KEY || ''
  const options = []

  for (const [id, preset] of Object.entries(TILE_PRESETS)) {
    if (preset.keyRequired && !key) continue
    if (preset.placeholder && env.TILE_PROVIDER !== 'offline') continue
    options.push(toConfig(id, preset, key, env))
  }

  if (env.TILE_URL) {
    options.unshift({
      provider: 'custom',
      label: 'Configured basemap',
      url: env.TILE_URL,
      attribution: env.TILE_ATTRIBUTION || '',
      maxZoom: Number(env.TILE_MAX_ZOOM) || 19,
      darkNative: env.TILE_DARK === '1',
      placeholder: false,
    })
  }

  return options
}

/**
 * A placeholder tile.
 *
 * Deliberately a neutral grid with its own coordinates on it — never invented
 * coastlines or streets. Someone looking at this must be able to tell at a
 * glance that no basemap is loaded, while still seeing their pins in the right
 * relative positions.
 */
export function placeholderTile(z, x, y) {
  const size = 256
  const step = 32
  const lines = []

  for (let offset = step; offset < size; offset += step) {
    lines.push(`<line x1="${offset}" y1="0" x2="${offset}" y2="${size}"/>`)
    lines.push(`<line x1="0" y1="${offset}" x2="${size}" y2="${offset}"/>`)
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="#eceff3"/>
  <g stroke="#64748b" stroke-opacity="0.13" stroke-width="1">${lines.join('')}</g>
  <rect width="${size}" height="${size}" fill="none" stroke="#64748b" stroke-opacity="0.22" stroke-width="1"/>
  <text x="8" y="20" fill="#64748b" fill-opacity="0.75" font-family="monospace" font-size="10">${z}/${x}/${y}</text>
</svg>`
}
