import type { Page } from '../types'

export interface TreeNode {
  id: string
  label: string
  url: string | null
  page: Page | null
  children: TreeNode[]
  /** Number of pages at or below this node, used for the branch badges. */
  size: number
}

function labelFor(segment: string): string {
  return decodeURIComponent(segment).replace(/\.(html?|php|aspx?)$/i, '')
}

/**
 * Folds a flat list of crawled URLs into the hierarchy their paths imply.
 * Directories that were never crawled as pages of their own still appear, so
 * `/blog/2024/post` shows a `blog` and a `2024` branch even when neither URL
 * returned a page.
 */
export function buildTree(pages: Page[], rootUrl: string): TreeNode {
  let origin = rootUrl
  try {
    origin = new URL(rootUrl).origin
  } catch {
    /* fall back to the raw value */
  }

  const root: TreeNode = { id: origin, label: origin.replace(/^https?:\/\//, ''), url: null, page: null, children: [], size: 0 }
  const index = new Map<string, TreeNode>([['', root]])

  const sorted = [...pages].sort((a, b) => a.url.localeCompare(b.url))

  for (const page of sorted) {
    let parsed: URL
    try {
      parsed = new URL(page.url)
    } catch {
      continue
    }

    const segments = parsed.pathname.split('/').filter(Boolean)
    if (segments.length === 0) {
      root.url = page.url
      root.page = page
      continue
    }

    let key = ''
    let parent = root
    segments.forEach((segment, position) => {
      key += `/${segment}`
      let node = index.get(key)
      if (!node) {
        node = { id: `${origin}${key}`, label: labelFor(segment), url: null, page: null, children: [], size: 0 }
        index.set(key, node)
        parent.children.push(node)
      }
      if (position === segments.length - 1) {
        // A query string makes this a distinct page under the same path.
        if (node.page && parsed.search) {
          const variant: TreeNode = {
            id: page.url,
            label: `${labelFor(segment)}${parsed.search}`,
            url: page.url,
            page,
            children: [],
            size: 0,
          }
          node.children.push(variant)
        } else {
          node.url = page.url
          node.page = page
        }
      }
      parent = node
    })
  }

  const measure = (node: TreeNode): number => {
    node.children.sort((a, b) => a.label.localeCompare(b.label))
    node.size = (node.page ? 1 : 0) + node.children.reduce((total, child) => total + measure(child), 0)
    return node.size
  }
  measure(root)

  return root
}

/** Collects the ids of every branch node, for expand-all / collapse-all. */
export function branchIds(node: TreeNode, into: string[] = []): string[] {
  if (node.children.length > 0) {
    into.push(node.id)
    for (const child of node.children) branchIds(child, into)
  }
  return into
}
