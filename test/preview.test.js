import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { PLACEHOLDER_ORIGIN, isHtml, withPreviewOrigin } from '../app/lib/preview.js'

describe('link previews', () => {
  test('index.html ships absolute preview URLs a crawler can follow', () => {
    const html = fs.readFileSync('index.html', 'utf8')
    assert.match(html, /property="og:image" content="https:\/\/[^"]+\/og\.png"/)
    assert.match(html, /name="twitter:card" content="summary_large_image"/)
    // Relative URLs are the classic mistake here: a crawler has no page
    // context to resolve them against, so the card renders without an image.
    assert.ok(!/content="\/og\.png"/.test(html), 'no relative preview image')
  })

  test('the preview image is actually in the build', () => {
    const bytes = fs.statSync('public/og.png').size
    assert.ok(bytes > 10_000, `og.png looks empty (${bytes} bytes)`)
  })

  test('the served origin replaces the one baked in at build time', () => {
    const html = `<meta property="og:image" content="${PLACEHOLDER_ORIGIN}/og.png" />`
    const rewritten = withPreviewOrigin(html, 'https://landquotient.com')
    assert.match(rewritten, /content="https:\/\/landquotient\.com\/og\.png"/)
    assert.ok(!rewritten.includes(PLACEHOLDER_ORIGIN))
  })

  test('every occurrence moves, not just the first', () => {
    const html = `${PLACEHOLDER_ORIGIN}/ and ${PLACEHOLDER_ORIGIN}/og.png`
    const rewritten = withPreviewOrigin(html, 'https://www.example.com')
    assert.equal(rewritten, 'https://www.example.com/ and https://www.example.com/og.png')
  })

  test('serving from the baked-in origin changes nothing', () => {
    const html = `<meta content="${PLACEHOLDER_ORIGIN}/og.png" />`
    assert.equal(withPreviewOrigin(html, PLACEHOLDER_ORIGIN), html)
    assert.equal(withPreviewOrigin(html, ''), html)
    assert.equal(withPreviewOrigin(html, null), html)
  })

  test('only HTML responses are rewritten', () => {
    const html = new Response('<html></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } })
    const js = new Response('export {}', { headers: { 'content-type': 'text/javascript' } })
    assert.equal(isHtml(html), true)
    assert.equal(isHtml(js), false)
    assert.equal(isHtml(new Response('x')), false)
  })
})
