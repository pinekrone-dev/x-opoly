/**
 * A map as a picture, for documents: an offering memorandum's aerial, its
 * location map, its amenity map.
 *
 * The live map is WebGL and lives in one place on the page; a document needs
 * several fixed pictures it can put in a PDF. So the basemap is asked of
 * Esri's export service for an exact extent (the same imagery and grey
 * canvas the map's basemap switcher offers), drawn into a canvas, and handed
 * back with the projection, so pins, rings and labels can be drawn on top in
 * the right places. Esri answers cross-origin, so the canvas stays readable
 * and can go into a PDF.
 */

const R = 6378137
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services'

/** Web Mercator metres for a point. */
export function mercator(lat: number, lng: number): [number, number] {
  return [(R * lng * Math.PI) / 180, R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))]
}

export type Basemap = 'imagery' | 'light'

const LAYERS: Record<Basemap, { base: string; labels: string; format: 'jpg' | 'png' }> = {
  // Aerial photography, with the roads and place names over it.
  imagery: { base: 'World_Imagery', labels: 'Reference/World_Transportation', format: 'jpg' },
  // A quiet grey canvas that pins read well on, with its own street names.
  light: { base: 'Canvas/World_Light_Gray_Base', labels: 'Canvas/World_Light_Gray_Reference', format: 'jpg' },
}

export interface StaticMap {
  /** Width and height in drawing units (the caller's points). */
  width: number
  height: number
  /** Where a point falls, in the same units, from the map's top left. */
  project: (lat: number, lng: number) => [number, number]
  /** How many drawing units a distance on the ground spans here. */
  unitsForMeters: (meters: number) => number
  /** The basemap at the requested scale, or null when it could not be fetched. */
  image: HTMLCanvasElement | null
}

function load(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`Could not load ${url}`))
    img.src = url
  })
}

// The same picture asked twice (a re-render after editing a headline) is
// fetched once.
const made = new Map<string, Promise<StaticMap>>()

/**
 * A basemap of `metersAcross` ground metres across, centred on a point, at
 * `width` × `height` drawing units, fetched at `scale` pixels per unit.
 */
export function staticMap(options: Parameters<typeof drawStaticMap>[0]): Promise<StaticMap> {
  const key = JSON.stringify(options)
  const held = made.get(key)
  if (held) return held
  const fresh = drawStaticMap(options).then((map) => {
    // A basemap that failed is asked for again next time, not remembered.
    if (!map.image) made.delete(key)
    return map
  })
  made.set(key, fresh)
  return fresh
}

async function drawStaticMap({
  lat,
  lng,
  metersAcross,
  width,
  height,
  scale = 3,
  basemap = 'imagery',
  labels = true,
}: {
  lat: number
  lng: number
  metersAcross: number
  width: number
  height: number
  scale?: number
  basemap?: Basemap
  labels?: boolean
}): Promise<StaticMap> {
  // Mercator stretches with latitude: a ground metre is 1/cos(lat) map metres.
  const stretch = 1 / Math.cos((lat * Math.PI) / 180)
  const spanX = metersAcross * stretch
  const spanY = (spanX * height) / width
  const [cx, cy] = mercator(lat, lng)
  const [x0, y0, x1, y1] = [cx - spanX / 2, cy - spanY / 2, cx + spanX / 2, cy + spanY / 2]
  const px = Math.round(width * scale)
  const py = Math.round(height * scale)
  const unitsPerMeter = width / spanX

  const project = (pLat: number, pLng: number): [number, number] => {
    const [mx, my] = mercator(pLat, pLng)
    return [(mx - x0) * unitsPerMeter, (y1 - my) * unitsPerMeter]
  }
  const unitsForMeters = (meters: number) => meters * stretch * unitsPerMeter

  const layer = LAYERS[basemap]
  const exportUrl = (service: string, format: string, transparent: boolean) =>
    `${ESRI}/${service}/MapServer/export?bbox=${x0},${y0},${x1},${y1}&bboxSR=3857&imageSR=3857&size=${px},${py}&format=${format}${transparent ? '&transparent=true' : ''}&f=image`

  let image: HTMLCanvasElement | null = null
  try {
    const [base, overlay] = await Promise.all([
      load(exportUrl(layer.base, layer.format, false)),
      labels ? load(exportUrl(layer.labels, 'png32', true)).catch(() => null) : Promise.resolve(null),
    ])
    image = document.createElement('canvas')
    image.width = px
    image.height = py
    const ctx = image.getContext('2d')
    if (ctx) {
      ctx.drawImage(base, 0, 0, px, py)
      if (overlay) ctx.drawImage(overlay, 0, 0, px, py)
    }
  } catch {
    image = null
  }
  return { width, height, project, unitsForMeters, image }
}
