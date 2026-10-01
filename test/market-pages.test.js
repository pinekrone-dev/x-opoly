/**
 * The public market pages and the sitemap: what a crawler reads about each
 * county. Pinned: the page is plain HTML with the county's published totals,
 * structured data and a way into the map, and it carries no parcel, owner or
 * address, because those stay behind sign-in.
 */

import assert from 'node:assert/strict'
import test, { describe } from 'node:test'

import { liveMarkets, marketPage, sitemapXml } from '../app/lib/marketPages.js'

const CATALOGUE = {
  markets: [
    {
      slug: 'houston-tx',
      name: 'Houston',
      region: 'Harris County, TX',
      status: 'live',
      blurb: 'Harris County commercial parcels with <b>owners</b> &amp; values.',
      roll: "Harris County's appraisal roll",
      sources: ['Harris Central Appraisal District'],
      stats: { parcels: 373541, value: 389439870248, acres: 577493, portfolios: 15669, inPortfolio: 61357, groups: { Commercial: 13969, 'Vacant land': 30208 } },
    },
    { slug: 'austin-tx', name: 'Austin', region: 'Travis County, TX', status: 'live', stats: {} },
    { slug: 'next-one', name: 'Soon', status: 'next' },
  ],
}

describe('market pages', () => {
  test('only live markets get a page', () => {
    assert.deepEqual(liveMarkets(CATALOGUE).map((m) => m.slug), ['houston-tx', 'austin-tx'])
  })

  test("a page reads the county's totals, links into the map and to the other markets", () => {
    const [houston, ...others] = liveMarkets(CATALOGUE)
    const html = marketPage(houston, others)
    assert.match(html, /<title>Houston parcel map: owners, values, zoning and flood zones \(Harris County, TX\) \| Land Quotient<\/title>/)
    assert.match(html, /<link rel="canonical" href="https:\/\/landquotient.com\/markets\/houston-tx" \/>/)
    assert.match(html, /373,541/)
    assert.match(html, /\$389\.4 billion/)
    assert.match(html, /href="\/gis\/houston-tx"/)
    assert.match(html, /href="\/markets\/austin-tx"/)
    assert.match(html, /"@type":"Dataset"/)
    assert.match(html, /"@type":"FAQPage"/)
    assert.doesNotMatch(html, /<b>owners<\/b>/, "the catalogue's markup is flattened, never injected")
  })

  test('a market with no totals still makes a sensible page', () => {
    const html = marketPage(liveMarkets(CATALOGUE)[1])
    assert.match(html, /Austin parcel map/)
    assert.doesNotMatch(html, /undefined|NaN|null parcels/)
  })

  test('the sitemap lists the fixed pages and one per live market', () => {
    const xml = sitemapXml(liveMarkets(CATALOGUE), { today: '2026-10-01' })
    assert.match(xml, /<loc>https:\/\/landquotient.com\/pricing<\/loc>/)
    assert.match(xml, /<loc>https:\/\/landquotient.com\/markets\/houston-tx<\/loc>/)
    assert.doesNotMatch(xml, /next-one/)
  })
})

describe('through the Worker', () => {
  test('a county page and the sitemap are answered by the app, not the single-page shell', async () => {
    const { default: worker } = await import('../worker/index.js')
    const { R2Shim, workerEnv } = await import('./cloudflare-shims.js')
    const bucket = new R2Shim()
    await bucket.put('markets.json', JSON.stringify(CATALOGUE))
    const env = await workerEnv({ PROSPECTOR_DATA: bucket })
    const ctx = { waitUntil: (p) => p, passThroughOnException() {} }
    const page = await worker.fetch(new Request('http://localhost/markets/houston-tx'), env, ctx)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /Houston parcel map/)
    const missing = await worker.fetch(new Request('http://localhost/markets/nowhere-xx'), env, ctx)
    assert.equal(missing.status, 404)
    const map = await worker.fetch(new Request('http://localhost/sitemap.xml'), env, ctx)
    assert.match(map.headers.get('content-type'), /xml/)
    assert.match(await map.text(), /markets\/austin-tx/)
  })
})
