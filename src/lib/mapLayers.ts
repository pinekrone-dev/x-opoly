/**
 * A market's published layers (zoning, flood zones, opportunity zones,
 * permits, power lines...) drawn onto a document map.
 *
 * Read from the layer's tile archive, the same .pmtiles the live map shows,
 * and only the tiles the picture covers: Austin's zoning file is twelve
 * megabytes as one download, and a cover aerial needs a few hundred
 * kilobytes of it.
 */
import { PMTiles } from 'pmtiles'
import { VectorTile } from '@mapbox/vector-tile'
import { PbfReader } from 'pbf'
import type { StaticMap } from './staticMap'

const HALF = Math.PI * 6378137

export interface DocLayer {
  id: string
  label: string
  kind: 'polygon' | 'line' | 'point'
  color: string
  /** The archive's URL, through this origin. */
  url: string
  sourceLayer: string
}

const archives = new Map<string, PMTiles>()
function archive(url: string) {
  let found = archives.get(url)
  if (!found) {
    found = new PMTiles(url)
    archives.set(url, found)
  }
  return found
}

function rgba(hex: string, alpha: number) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return hex
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`
}

/** Draws each layer over the map, under whatever is drawn after. */
export async function drawLayers(ctx: CanvasRenderingContext2D, map: StaticMap, layers: DocLayer[]) {
  if (!layers.length) return
  const [x0, y0, x1, y1] = map.bbox
  // Outlines thin out as the map widens: a city's zoning drawn at full
  // weight over three miles is a pink sheet, not a map.
  const metersAcross = (x1 - x0) * Math.cos(2 * Math.atan(Math.exp((y0 + y1) / 2 / 6378137)) - Math.PI / 2)
  const weight = metersAcross > 3000 ? 0.4 : metersAcross > 1200 ? 0.6 : 1
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, map.width, map.height)
  ctx.clip()
  for (const layer of layers) {
    try {
      const pm = archive(layer.url)
      const header = await pm.getHeader()
      // Fine enough for the picture, no deeper than the archive was cut.
      const want = Math.floor(Math.log2((2 * HALF) / 256 / map.metersPerUnit))
      let z = Math.max(header.minZoom, Math.min(header.maxZoom, want))
      const tileRange = (zoom: number) => {
        const n = 2 ** zoom
        const tx = (m: number) => Math.floor(((m + HALF) / (2 * HALF)) * n)
        const ty = (m: number) => Math.floor(((HALF - m) / (2 * HALF)) * n)
        return { n, xs: [tx(x0), tx(x1)], ys: [ty(y1), ty(y0)] }
      }
      let range = tileRange(z)
      while (z > header.minZoom && (range.xs[1] - range.xs[0] + 1) * (range.ys[1] - range.ys[0] + 1) > 36) {
        z -= 1
        range = tileRange(z)
      }
      const jobs = []
      for (let tx = range.xs[0]; tx <= range.xs[1]; tx += 1) {
        for (let ty = range.ys[0]; ty <= range.ys[1]; ty += 1) {
          jobs.push(pm.getZxy(z, tx, ty).then((r) => ({ tx, ty, data: r?.data })).catch(() => ({ tx, ty, data: undefined })))
        }
      }
      for (const { tx, ty, data } of await Promise.all(jobs)) {
        if (!data) continue
        const vt = new VectorTile(new PbfReader(new Uint8Array(data)))
        const source = vt.layers[layer.sourceLayer] ?? Object.values(vt.layers)[0]
        if (!source) continue
        const toMap = (gx: number, gy: number) =>
          map.projectMercator(
            ((tx + gx / source.extent) / range.n) * 2 * HALF - HALF,
            HALF - ((ty + gy / source.extent) / range.n) * 2 * HALF,
          )
        // Each tile repeats a margin of its neighbours' shapes; drawn whole,
        // those margins print twice and show as bands along the tile edges.
        // So each tile is drawn inside its own square only.
        const [cx0, cy0] = toMap(0, 0)
        const [cx1, cy1] = toMap(source.extent, source.extent)
        ctx.save()
        ctx.beginPath()
        ctx.rect(cx0, cy0, cx1 - cx0, cy1 - cy0)
        ctx.clip()
        for (let i = 0; i < source.length; i += 1) {
          const feature = source.feature(i)
          const geometry = feature.loadGeometry()
          if (feature.type === 1) {
            ctx.fillStyle = layer.color
            ctx.strokeStyle = '#ffffff'
            ctx.lineWidth = 1
            for (const part of geometry) {
              for (const p of part) {
                const [x, y] = toMap(p.x, p.y)
                ctx.beginPath()
                ctx.arc(x, y, 3.5, 0, Math.PI * 2)
                ctx.fill()
                ctx.stroke()
              }
            }
          } else {
            ctx.beginPath()
            for (const ring of geometry) {
              ring.forEach((p, j) => {
                const [x, y] = toMap(p.x, p.y)
                if (j === 0) ctx.moveTo(x, y)
                else ctx.lineTo(x, y)
              })
              if (feature.type === 3) ctx.closePath()
            }
            if (feature.type === 3) {
              ctx.fillStyle = rgba(layer.color, weight < 1 ? 0.1 : 0.16)
              ctx.fill('evenodd')
              ctx.strokeStyle = rgba(layer.color, weight < 1 ? 0.55 : 0.85)
              ctx.lineWidth = weight
            } else {
              ctx.strokeStyle = layer.color
              ctx.lineWidth = 2 * Math.max(weight, 0.75)
            }
            ctx.stroke()
          }
        }
        ctx.restore()
      }
    } catch {
      // A layer that cannot be read is left off this picture, not the others.
    }
  }
  ctx.restore()
}

/** A small key in the map's lower left: a swatch and a name per layer. */
export function drawLayerKey(ctx: CanvasRenderingContext2D, map: StaticMap, layers: DocLayer[]) {
  if (!layers.length) return
  ctx.save()
  ctx.font = `600 7.5px Inter, system-ui, sans-serif`
  const rowH = 12
  const w = Math.max(...layers.map((l) => ctx.measureText(l.label).width)) + 26
  const h = layers.length * rowH + 8
  const x = 8
  const y = map.height - h - 8
  ctx.fillStyle = 'rgba(255,255,255,0.92)'
  ctx.fillRect(x, y, w, h)
  layers.forEach((l, i) => {
    const ry = y + 6 + i * rowH
    ctx.fillStyle = l.kind === 'polygon' ? rgba(l.color, 0.35) : l.color
    ctx.strokeStyle = l.color
    ctx.lineWidth = 1
    if (l.kind === 'point') {
      ctx.beginPath()
      ctx.arc(x + 10, ry + 5, 3.5, 0, Math.PI * 2)
      ctx.fill()
    } else if (l.kind === 'line') {
      ctx.fillRect(x + 5, ry + 4, 11, 2)
    } else {
      ctx.fillRect(x + 5, ry + 1, 11, 8)
      ctx.strokeRect(x + 5, ry + 1, 11, 8)
    }
    ctx.fillStyle = '#0f172a'
    ctx.fillText(l.label, x + 21, ry + 8)
  })
  ctx.restore()
}
