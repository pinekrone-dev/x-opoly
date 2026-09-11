import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

/**
 * The public pages are separate HTML entries so a crawler reads each one's
 * own title and preview. These checks are the ones a broken card would fail.
 */

const PAGES = ['index.html', 'investors.html', 'developers.html', 'investment-sales.html', 'markets.html']

const meta = (html, attr, name) => {
  const m = html.match(new RegExp(`<meta\\s+${attr}="${name}"\\s+content="([^"]*)"`, 's'))
  return m ? m[1] : null
}

describe('public pages', () => {
  test('every page carries its own absolute preview card and a title', () => {
    const seen = new Set()
    for (const file of PAGES) {
      const html = fs.readFileSync(file, 'utf8')
      const title = html.match(/<title>([^<]+)<\/title>/)?.[1]
      assert.ok(title, `${file} has a title`)
      assert.ok(!seen.has(title), `${file} title is its own`)
      seen.add(title)
      const image = meta(html, 'property', 'og:image')
      assert.match(image ?? '', /^https:\/\/landquotient\.com\/og[\w-]*\.png$/, `${file} preview image`)
      assert.equal(meta(html, 'name', 'twitter:image'), image, `${file} twitter image matches`)
      assert.ok(fs.existsSync(`public/${image.split('/').pop()}`), `${file} preview image exists in public/`)
      assert.match(meta(html, 'property', 'og:url') ?? '', /^https:\/\/landquotient\.com\//, `${file} og:url`)
      assert.ok(html.includes('src="/src/main.tsx"'), `${file} loads the app`)
    }
  })

  test('the sitemap names every public page and nothing private', () => {
    const xml = fs.readFileSync('public/sitemap.xml', 'utf8')
    for (const p of ['/', '/investors', '/developers', '/investment-sales', '/markets', '/faq']) {
      assert.ok(xml.includes(`<loc>https://landquotient.com${p}</loc>`), `sitemap has ${p}`)
    }
    assert.ok(!/\/survey\/|\/s\/|\/api\//.test(xml))
    const robots = fs.readFileSync('public/robots.txt', 'utf8')
    assert.ok(robots.includes('Sitemap: https://landquotient.com/sitemap.xml'))
  })

  test('every preview card is a 1200x630 PNG', () => {
    for (const file of fs.readdirSync('public').filter((f) => /^og[\w-]*\.png$/.test(f))) {
      const bytes = fs.readFileSync(`public/${file}`)
      // PNG IHDR: width and height are the two big-endian ints at offsets 16 and 20.
      assert.equal(bytes.readUInt32BE(16), 1200, `${file} width`)
      assert.equal(bytes.readUInt32BE(20), 630, `${file} height`)
    }
  })
})
