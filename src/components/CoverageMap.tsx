import { useEffect, useMemo, useState } from 'react'

import type { Market } from '../lib/catalogue'
import { MAP_H, MAP_W, place, stateOf } from '../lib/coverage'

/**
 * The country, with the states that have a live market filled and a dot on
 * each market.
 *
 * It is drawn from the same two things the map itself opens on: the state
 * outlines in /geo/us-states.json and the live market list. So the picture
 * cannot claim a market that is not published, and it grows by itself when
 * one is. Nothing here is a map library: the outlines are projected once into
 * SVG paths, which is all a still picture of fifty states needs.
 */

interface StateShape {
  properties: { abbr: string; name: string }
  geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: number[][][] | number[][][][] }
}

function pathOf(shape: StateShape): string {
  const abbr = shape.properties.abbr
  const polygons = (shape.geometry.type === 'Polygon' ? [shape.geometry.coordinates] : shape.geometry.coordinates) as number[][][][]
  let d = ''
  for (const polygon of polygons) {
    for (const ring of polygon) {
      ring.forEach(([lon, lat], i) => {
        const [x, y] = place(abbr, lon, lat)
        d += `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`
      })
      d += 'Z'
    }
  }
  return d
}

export default function CoverageMap({ markets }: { markets: Market[] | null }) {
  const [shapes, setShapes] = useState<StateShape[] | null>(null)

  useEffect(() => {
    let live = true
    fetch('/geo/us-states.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((doc) => {
        if (live && doc?.features) setShapes(doc.features as StateShape[])
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  const paths = useMemo(() => (shapes ?? []).map((s) => ({ abbr: s.properties.abbr, name: s.properties.name, d: pathOf(s) })), [shapes])
  const covered = useMemo(() => new Set((markets ?? []).map((m) => stateOf(m.slug)).filter(Boolean)), [markets])
  const dots = useMemo(
    () =>
      (markets ?? [])
        .filter((m) => Array.isArray(m.stats?.center) && stateOf(m.slug))
        .map((m) => {
          const [lon, lat] = m.stats.center as [number, number]
          const [x, y] = place(stateOf(m.slug), lon, lat)
          return { slug: m.slug, name: m.name, x, y }
        }),
    [markets],
  )

  const label = markets
    ? `Map of the United States. ${covered.size} states have at least one live market, ${markets.length} markets in all.`
    : 'Map of the United States.'

  return (
    <svg viewBox={`0 0 ${MAP_W} ${MAP_H}`} role="img" aria-label={label} className="block h-auto w-full">
      <g>
        {paths.map((p) => {
          const has = covered.has(p.abbr)
          return (
            <path
              key={p.abbr}
              d={p.d}
              fill={has ? 'rgba(1,163,168,.20)' : 'rgba(255,255,255,.025)'}
              stroke={has ? 'rgba(127,217,219,.65)' : 'rgba(148,163,184,.28)'}
              strokeWidth={has ? 1 : 0.7}
              strokeLinejoin="round"
            >
              <title>{has ? `${p.name}: live` : p.name}</title>
            </path>
          )
        })}
      </g>
      {/* One reveal, once the list has arrived: the dots are the news here. */}
      <g className="transition-opacity duration-700 motion-reduce:transition-none" style={{ opacity: dots.length ? 1 : 0 }}>
        {dots.map((dot) => (
          <a key={dot.slug} href={`/markets/${dot.slug}`} aria-label={dot.name}>
            <circle cx={dot.x} cy={dot.y} r={7} fill="rgba(1,163,168,.22)" />
            <circle cx={dot.x} cy={dot.y} r={3.2} fill="#7fd9db" stroke="#0c1f42" strokeWidth={0.8}>
              <title>{dot.name}</title>
            </circle>
          </a>
        ))}
      </g>
    </svg>
  )
}
