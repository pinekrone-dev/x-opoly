/**
 * A map as a picture, for documents: an offering memorandum's aerial, its
 * location map, its amenity map.
 *
 * Built from the same Esri tiles the live map's basemap switcher loads,
 * stitched onto a canvas for an exact extent and handed back with the
 * projection, so pins, rings, labels and the market's layers can be drawn
 * on top in the right places. Tiles are cached and always there; Esri's
 * export service, used before, refused high-resolution requests over small
 * areas ("Error: bytes") and left covers blank. Esri answers cross-origin,
 * so the canvas stays readable and can go into a PDF or a deck.
 */

const R = 6378137
const HALF = Math.PI * R
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services'

/** Web Mercator metres for a point. */
export function mercator(lat: number, lng: number): [number, number] {
  return [(R * lng * Math.PI) / 180, R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))]
}

export type Basemap = 'imagery' | 'light'

/*
 * Each basemap's tile layers and how deep they go. The grey canvas has
 * nothing past zoom 16 (deeper tiles are a "no data" placeholder), so the
 * light map is the street map, washed to grey here: as quiet, and sharp
 * on a downtown block.
 */
const LAYERS: Record<Basemap, { base: string; baseMax: number; labels: string | null; labelsMax: number; wash: boolean }> = {
  imagery: { base: 'World_Imagery', baseMax: 19, labels: 'Reference/World_Transportation', labelsMax: 19, wash: false },
  light: { base: 'World_Street_Map', baseMax: 19, labels: null, labelsMax: 0, wash: true },
}

export interface StaticMap {
  /** Width and height in drawing units (the caller's points). */
  width: number
  height: number
  /** Where a point falls, in the same units, from the map's top left. */
  project: (lat: number, lng: number) => [number, number]
  /** The same, from Web Mercator metres. */
  projectMercator: (mx: number, my: number) => [number, number]
  /** How many drawing units a distance on the ground spans here. */
  unitsForMeters: (meters: number) => number
  /** The extent in Web Mercator metres: west, south, east, north. */
  bbox: [number, number, number, number]
  /** Mercator metres per drawing unit, for picking a tile zoom. */
  metersPerUnit: number
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

/** Tiles of one Esri layer, stitched over the extent; true when any arrived. */
async function stitch(
  ctx: CanvasRenderingContext2D,
  service: string,
  maxZoom: number,
  bbox: [number, number, number, number],
  px: number,
  py: number,
): Promise<boolean> {
  const [x0, y0, x1, y1] = bbox
  // The zoom whose pixels are at least as fine as the canvas's, within reach.
  const metersPerPixel = (x1 - x0) / px
  let z = Math.min(maxZoom, Math.max(0, Math.ceil(Math.log2((2 * HALF) / 256 / metersPerPixel))))
  const span = (zoom: number) => {
    const world = 256 * 2 ** zoom
    const left = ((x0 + HALF) / (2 * HALF)) * world
    const right = ((x1 + HALF) / (2 * HALF)) * world
    const top = ((HALF - y1) / (2 * HALF)) * world
    const bottom = ((HALF - y0) / (2 * HALF)) * world
    return { left, right, top, bottom }
  }
  // Never more than a hundred tiles for one picture.
  while (z > 0) {
    const s = span(z)
    const count = (Math.floor(s.right / 256) - Math.floor(s.left / 256) + 1) * (Math.floor(s.bottom / 256) - Math.floor(s.top / 256) + 1)
    if (count <= 100) break
    z -= 1
  }
  const s = span(z)
  const k = px / (s.right - s.left)
  const jobs: Promise<boolean>[] = []
  for (let tx = Math.floor(s.left / 256); tx <= Math.floor((s.right - 1e-9) / 256); tx += 1) {
    for (let ty = Math.floor(s.top / 256); ty <= Math.floor((s.bottom - 1e-9) / 256); ty += 1) {
      const url = `${ESRI}/${service}/MapServer/tile/${z}/${ty}/${tx}`
      jobs.push(
        load(url).then(
          (img) => {
            // A hair of overlap, so seams between tiles do not show.
            ctx.drawImage(img, (tx * 256 - s.left) * k, (ty * 256 - s.top) * k, 256 * k + 0.6, 256 * k + 0.6)
            return true
          },
          () => false,
        ),
      )
    }
  }
  return (await Promise.all(jobs)).some(Boolean)
}

/** Greys and lightens a street map in place, so pins read over it. */
function wash(ctx: CanvasRenderingContext2D, px: number, py: number) {
  const pixels = ctx.getImageData(0, 0, px, py)
  const d = pixels.data
  for (let i = 0; i < d.length; i += 4) {
    const grey = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]
    const v = 255 - (255 - grey) * 0.62
    d[i] = v
    d[i + 1] = v
    d[i + 2] = v + 3
  }
  ctx.putImageData(pixels, 0, 0)
}

// The same picture asked twice (a re-render after editing a headline) is
// fetched once.
const made = new Map<string, Promise<StaticMap>>()

/**
 * A basemap of `metersAcross` ground metres across, centred on a point, at
 * `width` × `height` drawing units, drawn at `scale` pixels per unit.
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
  const bbox: [number, number, number, number] = [cx - spanX / 2, cy - spanY / 2, cx + spanX / 2, cy + spanY / 2]
  const px = Math.round(width * scale)
  const py = Math.round(height * scale)
  const unitsPerMeter = width / spanX

  const projectMercator = (mx: number, my: number): [number, number] => [(mx - bbox[0]) * unitsPerMeter, (bbox[3] - my) * unitsPerMeter]
  const project = (pLat: number, pLng: number): [number, number] => projectMercator(...mercator(pLat, pLng))
  const unitsForMeters = (meters: number) => meters * stretch * unitsPerMeter

  const layer = LAYERS[basemap]
  let image: HTMLCanvasElement | null = document.createElement('canvas')
  image.width = px
  image.height = py
  const ctx = image.getContext('2d', { willReadFrequently: layer.wash }) as CanvasRenderingContext2D
  ctx.fillStyle = '#e5e7eb'
  ctx.fillRect(0, 0, px, py)
  const got = await stitch(ctx, layer.base, layer.baseMax, bbox, px, py)
  if (!got) image = null
  else {
    if (layer.wash) {
      try {
        wash(ctx, px, py)
      } catch {
        // A canvas the browser will not let us read stays in colour.
      }
    }
    if (labels && layer.labels) await stitch(ctx, layer.labels, layer.labelsMax, bbox, px, py)
  }
  return { width, height, project, projectMercator, unitsForMeters, bbox, metersPerUnit: spanX / width, image }
}
