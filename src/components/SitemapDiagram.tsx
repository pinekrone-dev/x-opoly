import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { hierarchy, tree, type HierarchyPointNode } from 'd3-hierarchy'
import type { Page } from '../types'
import { buildTree, type TreeNode } from '../lib/tree'
import { formatNumber } from '../lib/format'

interface Props {
  pages: Page[]
  rootUrl: string
  selected: Set<string>
  onToggle: (url: string) => void
}

const NODE_WIDTH = 178
const NODE_HEIGHT = 40
const ROW_GAP = 12
const COLUMN_GAP = 74

/** Colours are attributes rather than classes so exported SVG/PNG match the screen. */
const PALETTE = {
  surface: '#131a30',
  surfaceMuted: '#0e1428',
  border: '#293353',
  borderStrong: '#3a4569',
  text: '#e2e8f0',
  textMuted: '#7c8db5',
  accent: '#4cc2ff',
  ok: '#34d399',
  redirect: '#fbbf24',
  broken: '#fb7185',
  none: '#64748b',
}

function toneFor(node: TreeNode): string {
  const page = node.page
  if (!page) return PALETTE.none
  if (page.status === 0 || page.status >= 400) return PALETTE.broken
  if (page.redirectTo || (page.status >= 300 && page.status < 400)) return PALETTE.redirect
  return PALETTE.ok
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/** An S-curve between the right edge of a parent and the left edge of a child. */
function linkPath(source: HierarchyPointNode<TreeNode>, target: HierarchyPointNode<TreeNode>): string {
  const x0 = source.y + NODE_WIDTH
  const y0 = source.x
  const x1 = target.y
  const y1 = target.x
  const mid = x0 + (x1 - x0) / 2
  return `M${x0},${y0} C${mid},${y0} ${mid},${y1} ${x1},${y1}`
}

export default function SitemapDiagram({ pages, rootUrl, selected, onToggle }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [transform, setTransform] = useState({ x: 40, y: 0, k: 1 })
  const [drag, setDrag] = useState<{ x: number; y: number; tx: number; ty: number } | null>(null)

  const root = useMemo(() => buildTree(pages, rootUrl), [pages, rootUrl])

  const layout = useMemo(() => {
    const nodes = hierarchy<TreeNode>(root, (node) => (collapsed.has(node.id) ? [] : node.children))
    const layoutTree = tree<TreeNode>().nodeSize([NODE_HEIGHT + ROW_GAP, NODE_WIDTH + COLUMN_GAP])
    const positioned = layoutTree(nodes)

    const all = positioned.descendants()
    const minX = Math.min(...all.map((node) => node.x))
    const maxX = Math.max(...all.map((node) => node.x))
    const maxY = Math.max(...all.map((node) => node.y))

    return {
      nodes: all,
      links: positioned.links(),
      width: maxY + NODE_WIDTH + 40,
      height: maxX - minX + NODE_HEIGHT + 40,
      offsetY: -minX + NODE_HEIGHT / 2 + 20,
    }
  }, [root, collapsed])

  const fit = useCallback(() => {
    const box = container.current?.getBoundingClientRect()
    if (!box) return
    const scale = Math.min(1, (box.width - 40) / layout.width, (box.height - 40) / layout.height)
    setTransform({ x: 24, y: (box.height - layout.height * scale) / 2, k: Math.max(0.2, scale) })
  }, [layout.width, layout.height])

  useEffect(() => {
    fit()
    // Re-fit when the crawl changes, not on every collapse.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root])

  const toggleCollapse = (node: TreeNode) => {
    if (node.children.length === 0) return
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(node.id)) next.delete(node.id)
      else next.add(node.id)
      return next
    })
  }

  const onWheel = (event: React.WheelEvent) => {
    event.preventDefault()
    const box = container.current?.getBoundingClientRect()
    if (!box) return
    const pointerX = event.clientX - box.left
    const pointerY = event.clientY - box.top
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12

    setTransform((current) => {
      const k = Math.min(2.5, Math.max(0.15, current.k * factor))
      const ratio = k / current.k
      return { k, x: pointerX - (pointerX - current.x) * ratio, y: pointerY - (pointerY - current.y) * ratio }
    })
  }

  /** Serializes the current diagram, standalone, for download. */
  const serialize = (): string => {
    const svg = svgRef.current
    if (!svg) return ''
    const clone = svg.cloneNode(true) as SVGSVGElement
    clone.setAttribute('width', String(layout.width))
    clone.setAttribute('height', String(layout.height))
    clone.setAttribute('viewBox', `0 ${-layout.offsetY + 20} ${layout.width} ${layout.height}`)
    const group = clone.querySelector('g')
    group?.setAttribute('transform', `translate(20, ${layout.offsetY})`)
    const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    background.setAttribute('x', '0')
    background.setAttribute('y', String(-layout.offsetY + 20))
    background.setAttribute('width', String(layout.width))
    background.setAttribute('height', String(layout.height))
    background.setAttribute('fill', '#0b1020')
    clone.insertBefore(background, clone.firstChild)
    return new XMLSerializer().serializeToString(clone)
  }

  const downloadSvg = () => {
    const blob = new Blob([serialize()], { type: 'image/svg+xml' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'sitemap-diagram.svg'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const downloadPng = () => {
    const source = serialize()
    const image = new Image()
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = layout.width * 2
      canvas.height = layout.height * 2
      const context = canvas.getContext('2d')
      if (!context) return
      context.fillStyle = '#0b1020'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      canvas.toBlob((blob) => {
        if (!blob) return
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = 'sitemap-diagram.png'
        anchor.click()
        URL.revokeObjectURL(url)
      })
    }
    image.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(source)))}`
  }

  return (
    <section className="panel flex flex-col">
      <header className="panel-header">
        <h2 className="panel-title">
          Sitemap diagram
          <span className="ml-2 font-mono text-xs font-normal text-slate-500">{formatNumber(layout.nodes.length)} nodes</span>
        </h2>
        <div className="flex items-center gap-1">
          <button type="button" className="btn-ghost px-2.5 py-1 text-xs" onClick={() => setCollapsed(new Set())}>
            Expand all
          </button>
          <button
            type="button"
            className="btn-ghost px-2.5 py-1 text-xs"
            onClick={() => setTransform((current) => ({ ...current, k: Math.max(0.15, current.k / 1.25) }))}
            aria-label="Zoom out"
          >
            −
          </button>
          <button
            type="button"
            className="btn-ghost px-2.5 py-1 text-xs"
            onClick={() => setTransform((current) => ({ ...current, k: Math.min(2.5, current.k * 1.25) }))}
            aria-label="Zoom in"
          >
            +
          </button>
          <button type="button" className="btn-ghost px-2.5 py-1 text-xs" onClick={fit}>
            Fit
          </button>
          <span className="mx-1 h-4 w-px bg-white/10" />
          <button type="button" className="btn-ghost px-2.5 py-1 text-xs" onClick={downloadSvg}>
            SVG
          </button>
          <button type="button" className="btn-ghost px-2.5 py-1 text-xs" onClick={downloadPng}>
            PNG
          </button>
        </div>
      </header>

      <div
        ref={container}
        className={`relative h-[36rem] overflow-hidden ${drag ? 'cursor-grabbing' : 'cursor-grab'}`}
        onWheel={onWheel}
        onPointerDown={(event) => {
          if ((event.target as Element).closest('[data-node]')) return
          event.currentTarget.setPointerCapture(event.pointerId)
          setDrag({ x: event.clientX, y: event.clientY, tx: transform.x, ty: transform.y })
        }}
        onPointerMove={(event) => {
          if (!drag) return
          setTransform((current) => ({ ...current, x: drag.tx + (event.clientX - drag.x), y: drag.ty + (event.clientY - drag.y) }))
        }}
        onPointerUp={() => setDrag(null)}
        onPointerLeave={() => setDrag(null)}
      >
        <svg ref={svgRef} className="h-full w-full" role="img" aria-label="Diagram of the crawled site structure">
          <g transform={`translate(${transform.x}, ${transform.y + layout.offsetY * transform.k}) scale(${transform.k})`}>
            {layout.links.map((link) => (
              <path
                key={`${link.source.data.id}->${link.target.data.id}`}
                d={linkPath(link.source, link.target)}
                fill="none"
                stroke={PALETTE.border}
                strokeWidth={1.4}
              />
            ))}

            {layout.nodes.map((node) => {
              const data = node.data
              const tone = toneFor(data)
              const included = data.page ? selected.has(data.page.url) : false
              const isCollapsed = collapsed.has(data.id)
              const hidden = isCollapsed ? data.size : 0

              return (
                <g key={data.id} transform={`translate(${node.y}, ${node.x - NODE_HEIGHT / 2})`} data-node>
                  <rect
                    width={NODE_WIDTH}
                    height={NODE_HEIGHT}
                    rx={7}
                    fill={data.page ? PALETTE.surface : PALETTE.surfaceMuted}
                    stroke={included ? PALETTE.accent : PALETTE.border}
                    strokeWidth={included ? 1.5 : 1}
                  />
                  <rect width={3.5} height={NODE_HEIGHT} rx={2} fill={tone} />

                  <text x={14} y={17} fill={PALETTE.text} fontSize={12} fontFamily="Inter, sans-serif" fontWeight={600}>
                    {truncate(data.label || '/', 21)}
                  </text>
                  <text x={14} y={30} fill={PALETTE.textMuted} fontSize={10} fontFamily="Inter, sans-serif">
                    {data.page
                      ? truncate(data.page.title || `${data.page.status}`, 26)
                      : `${formatNumber(data.size)} pages below`}
                  </text>

                  {data.page && (
                    <circle
                      cx={NODE_WIDTH - 13}
                      cy={13}
                      r={5}
                      fill={included ? PALETTE.accent : 'transparent'}
                      stroke={included ? PALETTE.accent : PALETTE.borderStrong}
                      strokeWidth={1.4}
                      style={{ cursor: 'pointer' }}
                      onClick={() => onToggle(data.page!.url)}
                    >
                      <title>{included ? 'In the sitemap — click to leave it out' : 'Left out — click to include'}</title>
                    </circle>
                  )}

                  {data.children.length > 0 && (
                    <g style={{ cursor: 'pointer' }} onClick={() => toggleCollapse(data)}>
                      <circle
                        cx={NODE_WIDTH}
                        cy={NODE_HEIGHT / 2}
                        r={9}
                        fill={PALETTE.surfaceMuted}
                        stroke={PALETTE.borderStrong}
                        strokeWidth={1.2}
                      />
                      <text
                        x={NODE_WIDTH}
                        y={NODE_HEIGHT / 2 + 3.5}
                        fill={PALETTE.textMuted}
                        fontSize={10}
                        fontFamily="Inter, sans-serif"
                        textAnchor="middle"
                      >
                        {isCollapsed ? hidden : '−'}
                      </text>
                      <title>{isCollapsed ? 'Expand this branch' : 'Collapse this branch'}</title>
                    </g>
                  )}
                </g>
              )
            })}
          </g>
        </svg>

        <div className="pointer-events-none absolute bottom-3 left-3 flex flex-wrap gap-3 rounded-lg bg-ink-950/80 px-3 py-2 text-[11px] text-slate-400 ring-1 ring-white/10">
          {[
            { tone: PALETTE.ok, label: 'OK' },
            { tone: PALETTE.redirect, label: 'Redirect' },
            { tone: PALETTE.broken, label: 'Broken' },
            { tone: PALETTE.none, label: 'Not crawled' },
          ].map((entry) => (
            <span key={entry.label} className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm" style={{ background: entry.tone }} />
              {entry.label}
            </span>
          ))}
          <span className="text-slate-600">drag to pan · scroll to zoom</span>
        </div>
      </div>
    </section>
  )
}
