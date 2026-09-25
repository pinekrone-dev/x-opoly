import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { PLACEHOLDER_ORIGIN, isHtml, withPreviewOrigin } from '../app/lib/preview.js'

describe('link previews', () => {
  test('index.html ships absolute preview URLs a crawler can follow', () => {
    const html = fs.readFileSync('index.html', 'utf8')
    assert.match(html, /property="og:image" content="https:\/\/[^"]+\/og\.png(\?v=\w+)?"/)
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
    // The placeholder is the real origin now, so the rewrite is exercised
    // against a different host; on the live domain it is a no-op.
    const html = `<meta property="og:image" content="${PLACEHOLDER_ORIGIN}/og.png" />`
    const rewritten = withPreviewOrigin(html, 'https://preview.example.com')
    assert.match(rewritten, /content="https:\/\/preview\.example\.com\/og\.png"/)
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

import { DatabaseSync } from 'node:sqlite'
import { nodeAdapter } from '../app/lib/sql.js'
import { placeFromSlug, previewForPath, rewritePreview, sharePreview } from '../app/lib/preview.js'

describe('a preview for every link', () => {
  const index = fs.readFileSync('index.html', 'utf8')
  const origin = 'https://landquotient.com'
  const tag = (html, attr, name) =>
    html.match(new RegExp(`<meta\\s+${attr}="${name}"\\s+content="([^"]*)"`, 's'))?.[1] ?? null

  test('a rewrite reaches every tag a crawler reads, multi-line ones included', () => {
    const out = rewritePreview(index, {
      title: 'Harbor Blvd relocation | Market survey',
      description: 'Prepared by Pat Doe, Example Realty.',
      url: `${origin}/s/abc`,
      image: `${origin}/og-share.png?v=1`,
    })
    assert.match(out, /<title>Harbor Blvd relocation \| Market survey<\/title>/)
    for (const [attr, name] of [['property', 'og:title'], ['name', 'twitter:title'], ['property', 'og:image:alt']]) {
      assert.equal(tag(out, attr, name), 'Harbor Blvd relocation | Market survey', name)
    }
    for (const [attr, name] of [['name', 'description'], ['property', 'og:description'], ['name', 'twitter:description']]) {
      assert.equal(tag(out, attr, name), 'Prepared by Pat Doe, Example Realty.', name)
    }
    assert.equal(tag(out, 'property', 'og:url'), `${origin}/s/abc`)
    assert.equal(tag(out, 'property', 'og:image'), `${origin}/og-share.png?v=1`)
    assert.equal(tag(out, 'name', 'twitter:image'), `${origin}/og-share.png?v=1`)
  })

  test('text from a survey cannot break out of the tag', () => {
    const out = rewritePreview(index, { title: 'A "quoted" <b>name</b> & co' })
    assert.equal(tag(out, 'property', 'og:title'), 'A &quot;quoted&quot; &lt;b&gt;name&lt;/b&gt; &amp; co')
    assert.ok(!out.includes('<b>name</b>'))
  })

  test('market slugs read as places', () => {
    assert.equal(placeFromSlug('north-jersey-nj'), 'North Jersey, NJ')
    assert.equal(placeFromSlug('orange-county-ca'), 'Orange County, CA')
    assert.equal(placeFromSlug('washington-dc'), 'Washington, DC')
  })

  test('a market map link previews as that market', async () => {
    const p = await previewForPath('/gis/phoenix-az', origin)
    assert.equal(p.title, 'Phoenix, AZ parcel map | Land Quotient')
    assert.equal(p.url, `${origin}/gis/phoenix-az`)
    assert.match(p.image, /\/og-gis\.png/)
  })

  test('an app page at least points at itself rather than the home page', async () => {
    assert.deepEqual(await previewForPath('/survey/xyz/', origin), { url: `${origin}/survey/xyz` })
  })

  test('a share link names its survey and broker, never the client', async () => {
    const db = nodeAdapter(new DatabaseSync(':memory:'))
    await db.migrate()
    const at = new Date().toISOString()
    const add = (id, token, enabled, expires = null) =>
      db.run(
        `INSERT INTO surveys (id, name, client_name, broker_name, company_name, share_token, share_enabled, share_expires_at, created_at, updated_at)
         VALUES (?, 'Harbor Blvd relocation', 'Secret Client Inc', 'Pat Doe', 'Example Realty', ?, ?, ?, ?, ?)`,
        [id, token, enabled, expires, at, at],
      )
    await add('s1', 'live-token', 1)
    await add('s2', 'off-token', 0)
    await add('s3', 'old-token', 1, '2020-01-01T00:00:00Z')

    const live = await previewForPath('/s/live-token', origin, { lookupShare: (t) => sharePreview(db, t) })
    assert.equal(live.title, 'Harbor Blvd relocation | Market survey')
    assert.match(live.description, /^Prepared by Pat Doe, Example Realty\./)
    assert.ok(!JSON.stringify(live).includes('Secret Client'), 'the client is not in the preview')
    assert.match(live.image, /\/og-share\.png/)
    assert.equal(live.url, `${origin}/s/live-token`)

    for (const token of ['off-token', 'old-token', 'no-such-token']) {
      const dead = await previewForPath(`/s/${token}`, origin, { lookupShare: (t) => sharePreview(db, t) })
      assert.match(dead.description, /no longer active/, token)
      assert.ok(!dead.title.includes('Harbor'), `${token} does not advertise the survey`)
    }

    const offline = await previewForPath('/s/live-token', origin)
    assert.match(offline.title, /Market survey/)
  })
})
