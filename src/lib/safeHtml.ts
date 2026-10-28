/*
 * The little HTML a county's catalogue carries — an attribution with a link,
 * a caveat with some emphasis — made safe to put on the page.
 *
 * These strings come from our own pipeline, so this is defence in depth, not
 * the only line: if the catalogue were ever written by someone else, a
 * script tag or an onclick in a note would otherwise run as the signed-in
 * user. Text, emphasis, line breaks and http(s) links survive; every other
 * element is reduced to its text and every attribute but a link's href is
 * dropped.
 */
const KEEP = new Set(['A', 'B', 'STRONG', 'I', 'EM', 'BR', 'SPAN'])

export function safeHtml(html: string): string {
  if (!html) return ''
  if (typeof DOMParser === 'undefined') return escapeText(html)
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
  const root = doc.body.firstElementChild
  if (!root) return ''
  return clean(root)
}

function escapeText(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string)
}

function clean(node: Node): string {
  let out = ''
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      out += escapeText(child.textContent ?? '')
      return
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return
    const element = child as Element
    const tag = element.tagName
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'IFRAME' || tag === 'OBJECT') return
    if (!KEEP.has(tag)) {
      out += clean(element)
      return
    }
    if (tag === 'BR') {
      out += '<br>'
      return
    }
    if (tag === 'A') {
      const href = element.getAttribute('href') ?? ''
      if (/^https?:\/\//i.test(href)) {
        out += `<a href="${escapeText(href)}" target="_blank" rel="noopener noreferrer">${clean(element)}</a>`
      } else {
        out += clean(element)
      }
      return
    }
    const name = tag.toLowerCase()
    out += `<${name}>${clean(element)}</${name}>`
  })
  return out
}
