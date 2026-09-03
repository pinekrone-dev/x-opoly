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
    // 2026-08-27: CARTO throttles anonymous use with "API required" tiles
    // served as 200s. Kept resolvable for a deployment that explicitly asks,
    // never offered in the switcher.
    unreliable: true,
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    attribution: '© OpenStreetMap contributors, © CARTO',
    maxZoom: 20,
    keyRequired: false,
  },
  satellite: {
    label: 'Satellite',
    // Esri publishes World Imagery without a key. Note the {z}/{y}/{x} order:
    // ArcGIS puts row before column, the reverse of the usual slippy-map
    // template, and getting it backwards silently serves the wrong tiles.
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: '© Esri — Source: Esri, Maxar, Earthstar Geographics',
    maxZoom: 19,
    keyRequired: false,
    darkNative: true,
  },
  /*
   * The rest of Esri's keyless basemaps, same host and same tile order.
   * Free to use with the attribution shown, which the map keeps visible.
   */
  'esri-streets': {
    label: 'Streets (Esri)',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    attribution: '© Esri — Source: Esri, HERE, Garmin, USGS, NGA, OpenStreetMap contributors',
    maxZoom: 19,
    keyRequired: false,
  },
  'esri-topo': {
    label: 'Topographic',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
    attribution: '© Esri — Source: Esri, HERE, Garmin, USGS, NGA, OpenStreetMap contributors',
    maxZoom: 19,
    keyRequired: false,
  },
  'esri-gray': {
    // A near-blank canvas: the basemap parcels and layers read best on,
    // since nothing underneath competes with their colour.
    label: 'Light canvas',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    attribution: '© Esri — Source: Esri, HERE, Garmin, OpenStreetMap contributors',
    maxZoom: 16,
    keyRequired: false,
  },
  'esri-dark': {
    label: 'Dark canvas',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    attribution: '© Esri — Source: Esri, HERE, Garmin, OpenStreetMap contributors',
    maxZoom: 16,
    keyRequired: false,
    darkNative: true,
  },
  'esri-natgeo': {
    label: 'National Geographic',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/NatGeo_World_Map/MapServer/tile/{z}/{y}/{x}',
    attribution: '© Esri — Source: National Geographic, Esri, Garmin, HERE, UNEP-WCMC, USGS, NASA, ESA, METI, NRCAN, GEBCO, NOAA',
    maxZoom: 16,
    keyRequired: false,
  },
  /*
   * The US Geological Survey's own tiles, public domain and keyless. US
   * only, which is where every market is, and the imagery is often newer
   * over a county than the world layers above.
   */
  'usgs-imagery': {
    label: 'Satellite (USGS)',
    url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
    attribution: 'USGS The National Map: Orthoimagery',
    maxZoom: 16,
    keyRequired: false,
    darkNative: true,
  },
  'usgs-topo': {
    label: 'Topographic (USGS)',
    url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
    attribution: 'USGS The National Map: National Boundaries, Transportation, Hydrography, Names',
    maxZoom: 16,
    keyRequired: false,
  },
  'usgs-hybrid': {
    label: 'Satellite with roads (USGS)',
    url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryTopo/MapServer/tile/{z}/{y}/{x}',
    attribution: 'USGS The National Map: Orthoimagery and Topo',
    maxZoom: 16,
    keyRequired: false,
    darkNative: true,
  },
  /*
   * Two more OpenStreetMap renderings from projects that ask for
   * attribution and nothing else.
   */
  'osm-hot': {
    label: 'Street map (humanitarian)',
    url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors, tiles style by Humanitarian OpenStreetMap Team, hosted by OpenStreetMap France',
    maxZoom: 19,
    keyRequired: false,
  },
  opentopomap: {
    label: 'Terrain (OpenTopoMap)',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors, SRTM · map style © OpenTopoMap (CC-BY-SA)',
    maxZoom: 17,
    keyRequired: false,
  },
  'carto-light': {
    label: 'Muted',
    unreliable: true,
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attribution: '© OpenStreetMap contributors, © CARTO',
    maxZoom: 20,
    keyRequired: false,
  },
  'carto-dark': {
    label: 'Dark',
    unreliable: true,
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

  const chosen = (env.TILE_PROVIDER || '').toLowerCase()
  for (const [id, preset] of Object.entries(TILE_PRESETS)) {
    // A key belongs to exactly one service, so a keyed preset is only
    // offered when TILE_PROVIDER names it. Offering every keyed provider
    // whenever any TILE_KEY exists put three broken options in the picker —
    // and Stadia answers a wrong key with tiles that read "API key
    // required", which both maps then faithfully drew.
    if (preset.keyRequired && !(key && chosen === id)) continue
    // A host known to refuse anonymous traffic is only offered when the
    // deployment explicitly configured it — a picker must never list a
    // basemap that draws "API required" instead of a map.
    if (preset.unreliable && chosen !== id) continue
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
