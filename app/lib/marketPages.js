/*
 * The public page for each market, and the sitemap that lists them.
 *
 * These are what search engines and AI assistants read about a county: its
 * name, what the county publishes, how many parcels and how much value and
 * land there is, the mix of land uses, where the records come from, and how
 * to open the map. They are written on the server as plain HTML, so a
 * crawler that runs no script reads all of it.
 *
 * Only the market's published totals appear here (the same summary the
 * market list already shows). No parcel, owner or address is on these pages:
 * those stay inside the app, behind sign-in.
 */

const ORIGIN = 'https://landquotient.com'

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])

/** Tags out, entities decoded once: the catalogue's text is written for HTML. */
const plain = (value) =>
  String(value ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()

const count = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n)).toLocaleString('en-US') : null)

function money(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return null
  if (v >= 1e12) return `$${(v / 1e12).toFixed(1).replace(/\.0$/, '')} trillion`
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1).replace(/\.0$/, '')} billion`
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1).replace(/\.0$/, '')} million`
  return `$${count(v)}`
}

/** The markets a page may be written for: published, with a slug that is a slug. */
export function liveMarkets(catalogue) {
  const list = Array.isArray(catalogue) ? catalogue : catalogue?.markets ?? []
  return list.filter((m) => m?.status === 'live' && /^[a-z0-9-]{2,40}$/.test(String(m.slug ?? '')))
}

/** The pages the sitemap always lists, besides one per market. */
export const STATIC_PAGES = ['/', '/gis', '/markets', '/investment-sales', '/developers', '/investors', '/pricing', '/faq']

export function sitemapXml(markets, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const urls = [
    ...STATIC_PAGES.map((path) => ({ loc: `${ORIGIN}${path}`, priority: path === '/' ? '1.0' : '0.8' })),
    ...markets.map((m) => ({ loc: `${ORIGIN}/markets/${m.slug}`, priority: '0.7' })),
  ]
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((u) => `  <url><loc>${escapeHtml(u.loc)}</loc><lastmod>${today}</lastmod><priority>${u.priority}</priority></url>`),
    '</urlset>',
    '',
  ].join('\n')
}

/** One market's page. `others` are the rest of the live markets, for links between them. */
export function marketPage(market, others = []) {
  const name = plain(market.name)
  const region = plain(market.region)
  const stats = market.stats ?? {}
  const parcels = count(stats.parcels)
  const value = money(stats.value)
  const acres = count(stats.acres)
  const portfolios = Number(stats.portfolios) > 0 ? count(stats.portfolios) : null
  const inPortfolio = Number(stats.inPortfolio) > 0 ? count(stats.inPortfolio) : null
  const blurb = plain(market.blurb)
  const roll = plain(market.roll)
  const sources = (market.sources ?? []).map(plain).filter(Boolean)
  const groups = Object.entries(stats.groups ?? {})
    .filter(([, n]) => Number(n) > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
  const groupTotal = groups.reduce((sum, [, n]) => sum + Number(n), 0)
  const fields = (stats.fields ?? []).filter((f) => f?.l)

  const url = `${ORIGIN}/markets/${market.slug}`
  const title = `${name} parcel map: owners, values, zoning and flood zones (${region}) | Land Quotient`
  const description = (
    `${parcels ? `${parcels} parcels` : 'Every parcel'} across ${region}${value ? ` worth ${value}` : ''} on one map, ` +
    'with owners of record, assessed values, zoning, FEMA flood zones and building footprints, filtered county-wide.'
  ).slice(0, 300)

  const faq = [
    parcels && {
      q: `How many parcels are in ${region}?`,
      a: `The ${roll || 'county assessment roll'} lists ${parcels} parcels${acres ? ` covering ${acres} acres` : ''}${value ? `, with a total assessed value of ${value}` : ''}.`,
    },
    {
      q: `Where does the ${name} parcel data come from?`,
      a: `From ${roll || 'the county assessment roll'}${sources.length ? `, with ${sources.join(', ')}` : ''}. Zoning comes from city and county GIS, flood zones from FEMA's National Flood Hazard Layer, and building footprints from Overture Maps.`,
    },
    {
      q: `Can I search ${name} parcels by zoning, flood zone or owner?`,
      a: 'Yes. In Land Quotient every parcel carries its zoning district and FEMA flood status, so a question like "outside the flood zone, zoned anything but residential" filters the whole county at once, and the results open as a table you can export.',
    },
    portfolios && {
      q: `Can I see everything one owner holds in ${name}?`,
      a: `Yes. Land Quotient groups ${portfolios} owner portfolios across their different entity names and mailing addresses${inPortfolio ? `, covering ${inPortfolio} parcels` : ''}.`,
    },
  ].filter(Boolean)

  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'Dataset',
      name: `${name} parcel records`,
      description: `${blurb || description}`.slice(0, 500),
      url,
      spatialCoverage: { '@type': 'Place', name: region },
      creator: { '@type': 'Organization', name: 'Land Quotient', url: ORIGIN },
      isAccessibleForFree: false,
      ...(sources.length || roll ? { citation: [roll, ...sources].filter(Boolean).join('; ') } : {}),
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Markets', item: `${ORIGIN}/markets` },
        { '@type': 'ListItem', position: 2, name, item: url },
      ],
    },
  ]

  const stat = (label, val) => (val ? `<div class="stat"><div class="v">${escapeHtml(val)}</div><div class="l">${escapeHtml(label)}</div></div>` : '')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}" />
<link rel="canonical" href="${url}" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="Land Quotient" />
<meta property="og:title" content="${escapeHtml(`${name} parcel map`)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:url" content="${url}" />
<meta property="og:image" content="${ORIGIN}/og-markets.png" />
<meta name="twitter:card" content="summary_large_image" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
${jsonLd.map((doc) => `<script type="application/ld+json">${JSON.stringify(doc).replace(/</g, '\\u003c')}</script>`).join('\n')}
<style>
:root{--ink:#0f172a;--body:#334155;--muted:#64748b;--line:#e2e8f0;--paper:#f6f8fa;--brand:#01A3A8;--deep:#143366;--night:#0c1f42;--tint:#e9f5f6}
*{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,sans-serif;color:var(--body);background:var(--paper);line-height:1.55}
a{color:var(--deep)}header,footer{background:var(--night);color:#fff}header .in,footer .in,main{max-width:960px;margin:0 auto;padding:16px}
header .in{display:flex;align-items:center;justify-content:space-between;gap:12px}header a{color:#fff;text-decoration:none;font-weight:600}
header nav a{margin-left:16px;font-weight:500;opacity:.85}
.hero{background:var(--night);color:#fff;padding:24px 0 40px}.hero .in{max-width:960px;margin:0 auto;padding:0 16px}
.crumb{font-size:13px;opacity:.7}.crumb a{color:#fff}h1{font-size:34px;line-height:1.2;margin:8px 0 12px;color:#fff}
.lede{font-size:17px;max-width:720px;opacity:.9}.cta{display:flex;gap:12px;flex-wrap:wrap;margin-top:20px}
.btn{display:inline-block;padding:11px 18px;border-radius:8px;font-weight:600;text-decoration:none}
.btn.primary{background:var(--brand);color:#fff}.btn.ghost{border:1px solid #22406f;color:#fff}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:-24px 0 24px}
.stat{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px}.stat .v{font-size:22px;font-weight:700;color:var(--ink)}.stat .l{font-size:13px;color:var(--muted)}
section{background:#fff;border:1px solid var(--line);border-radius:10px;padding:20px;margin-bottom:16px}h2{font-size:20px;color:var(--ink);margin:0 0 10px}
table{width:100%;border-collapse:collapse;font-size:14px}td{padding:6px 0;border-bottom:1px solid var(--line)}td.n{text-align:right;font-variant-numeric:tabular-nums}
.bar{height:6px;background:var(--tint);border-radius:3px}.bar i{display:block;height:6px;background:var(--brand);border-radius:3px}
ul{padding-left:20px}dt{font-weight:600;color:var(--ink);margin-top:12px}dd{margin:4px 0 0}
.others a{display:inline-block;margin:4px 10px 4px 0}footer{margin-top:24px;font-size:13px}footer a{color:#fff}
@media(max-width:600px){h1{font-size:26px}header nav a{margin-left:10px}}
</style>
</head>
<body>
<header><div class="in"><a href="/">Land Quotient</a><nav><a href="/markets">Markets</a><a href="/pricing">Pricing</a><a href="/gis">Sign in</a></nav></div></header>
<div class="hero"><div class="in">
<div class="crumb"><a href="/markets">Markets</a> / ${escapeHtml(name)}</div>
<h1>${escapeHtml(name)} parcel map</h1>
<p class="lede">${escapeHtml(blurb || `Every parcel in ${region} on one map, with the county's own record on each lot.`)}</p>
<div class="cta"><a class="btn primary" href="/gis/${escapeHtml(market.slug)}">Open the ${escapeHtml(name)} map</a><a class="btn ghost" href="/pricing">Start a 14-day free trial</a></div>
</div></div>
<main>
<div class="stats">
${stat('Parcels', parcels)}${stat('Total assessed value', value)}${stat('Acres', acres)}${stat('Owner portfolios', portfolios)}
</div>
${
  groups.length
    ? `<section><h2>Land use across ${escapeHtml(region)}</h2><table>${groups
        .map(([label, n]) => {
          const share = groupTotal ? Number(n) / groupTotal : 0
          return `<tr><td>${escapeHtml(label)}</td><td class="n">${count(n)}</td><td class="n" style="width:28%"><div class="bar"><i style="width:${Math.max(1, Math.round(share * 100))}%"></i></div></td></tr>`
        })
        .join('')}</table></section>`
    : ''
}
<section><h2>What you can do with ${escapeHtml(name)} parcels in Land Quotient</h2>
<ul>
<li>See every parcel's owner of record, assessed value, land use and lot size from ${escapeHtml(roll || 'the county roll')}.</li>
<li>Filter the whole county by zoning district and FEMA flood zone, including "anything but" a zoning category.</li>
<li>Find vacant and under-built lots from mapped building footprints.</li>
<li>Group an owner's holdings across entity names and mailing addresses.</li>
<li>Ask in plain English, highlight the matches on the map and export the list.</li>
</ul>
${fields.length ? `<p>Fields this county publishes: ${fields.map((f) => `${escapeHtml(f.l)}${f.pct != null ? ` (${Number(f.pct)}% of parcels)` : ''}`).join(', ')}.</p>` : ''}
</section>
<section><h2>Questions about ${escapeHtml(name)} parcel data</h2><dl>
${faq.map((f) => `<dt>${escapeHtml(f.q)}</dt><dd>${escapeHtml(f.a)}</dd>`).join('\n')}
</dl></section>
${
  others.length
    ? `<section class="others"><h2>Other markets</h2>${others
        .map((m) => `<a href="/markets/${escapeHtml(m.slug)}">${escapeHtml(plain(m.name))}</a>`)
        .join('')}</section>`
    : ''
}
</main>
<footer><div class="in">Land Quotient: parcel maps and site selection for commercial real estate. <a href="/markets">All markets</a> · <a href="/faq">FAQ</a> · <a href="/pricing">Pricing</a></div></footer>
</body>
</html>`
}
