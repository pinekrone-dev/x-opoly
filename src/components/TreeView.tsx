import { useMemo, useState } from 'react'
import type { Page } from '../types'
import { branchIds, buildTree, type TreeNode } from '../lib/tree'
import { formatNumber, statusLabel, statusTone } from '../lib/format'

interface Props {
  pages: Page[]
  rootUrl: string
  selected: Set<string>
  onToggle: (url: string) => void
}

/** Expands the first two levels so the shape of the site is visible at a glance. */
function initialExpansion(root: TreeNode): Set<string> {
  const open = new Set<string>([root.id])
  for (const child of root.children) open.add(child.id)
  return open
}

function NodeRow({
  node,
  depth,
  expanded,
  onExpand,
  selected,
  onToggle,
}: {
  node: TreeNode
  depth: number
  expanded: Set<string>
  onExpand: (id: string) => void
  selected: Set<string>
  onToggle: (url: string) => void
}) {
  const hasChildren = node.children.length > 0
  const isOpen = expanded.has(node.id)
  const page = node.page

  return (
    <li>
      <div
        className="group flex items-center gap-2 rounded-md py-1 pr-2 hover:bg-white/5"
        style={{ paddingLeft: `${depth * 1.1}rem` }}
      >
        {hasChildren ? (
          <button
            type="button"
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-white/10 hover:text-slate-200"
            aria-expanded={isOpen}
            aria-label={isOpen ? `Collapse ${node.label}` : `Expand ${node.label}`}
            onClick={() => onExpand(node.id)}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              className={`transition-transform ${isOpen ? 'rotate-90' : ''}`}
              aria-hidden
            >
              <path d="m9 6 6 6-6 6" />
            </svg>
          </button>
        ) : (
          <span className="h-5 w-5 shrink-0" />
        )}

        {page ? (
          <input
            className="checkbox"
            type="checkbox"
            checked={selected.has(page.url)}
            aria-label={`Include ${page.url} in the sitemap`}
            onChange={() => onToggle(page.url)}
          />
        ) : (
          <span className="h-4 w-4 shrink-0" />
        )}

        <span
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded ${
            page ? 'text-accent/80' : 'text-slate-600'
          }`}
          aria-hidden
        >
          {hasChildren ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
              <path d="M14 3v5h5" />
            </svg>
          )}
        </span>

        <span className="min-w-0 flex-1 truncate text-sm">
          <span className={page ? 'text-slate-200' : 'text-slate-500'}>{node.label || '/'}</span>
          {page?.title && <span className="ml-2 text-xs text-slate-500">{page.title}</span>}
        </span>

        {node.size > 1 && (
          <span className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
            {formatNumber(node.size)}
          </span>
        )}

        {page && (
          <>
            {page.noindex && <span className="pill bg-white/5 text-slate-400 ring-white/10">noindex</span>}
            {page.redirectTo && <span className="pill bg-amber-500/10 text-amber-300 ring-amber-500/25">→</span>}
            <span className={`pill ${statusTone(page.status)}`}>{statusLabel(page.status)}</span>
            <a
              className="opacity-0 transition group-hover:opacity-100"
              href={page.url}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={`Open ${page.url} in a new tab`}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-slate-400 hover:text-accent">
                <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
              </svg>
            </a>
          </>
        )}
      </div>

      {hasChildren && isOpen && (
        <ul className="border-l border-white/5" style={{ marginLeft: `${depth * 1.1 + 0.6}rem` }}>
          {node.children.map((child) => (
            <NodeRow
              key={child.id}
              node={child}
              depth={0}
              expanded={expanded}
              onExpand={onExpand}
              selected={selected}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

export default function TreeView({ pages, rootUrl, selected, onToggle }: Props) {
  const tree = useMemo(() => buildTree(pages, rootUrl), [pages, rootUrl])
  const [expanded, setExpanded] = useState<Set<string>>(() => initialExpansion(tree))

  const toggleExpand = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <section className="panel">
      <header className="panel-header">
        <h2 className="panel-title">Site structure</h2>
        <div className="flex gap-1">
          <button type="button" className="btn-ghost px-2.5 py-1 text-xs" onClick={() => setExpanded(new Set(branchIds(tree)))}>
            Expand all
          </button>
          <button type="button" className="btn-ghost px-2.5 py-1 text-xs" onClick={() => setExpanded(new Set([tree.id]))}>
            Collapse
          </button>
        </div>
      </header>

      <div className="scrollbar-thin max-h-[36rem] overflow-auto p-3">
        <ul>
          <NodeRow
            node={tree}
            depth={0}
            expanded={expanded}
            onExpand={toggleExpand}
            selected={selected}
            onToggle={onToggle}
          />
        </ul>
      </div>
    </section>
  )
}
