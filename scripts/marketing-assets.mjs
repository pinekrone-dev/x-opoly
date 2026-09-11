// The pictures the public pages use, made from one real screenshot.
//
//   node scripts/marketing-assets.mjs [--gis path/to/screenshot.png]
//
// Two jobs. First, the crops: a 1440x900 screenshot of the parcel map becomes
// public/shots/gis.jpg plus three crops the pages show at different sizes,
// so nobody hand-edits a screenshot again. Second, the link-preview cards: one
// 1200x630 PNG per public page, drawn in the browser from the same navy,
// grid and rings the hero uses, with a product shot set into the right edge.
//
// Without --gis the crops are skipped and the cards are drawn from the shots
// already in public/shots, so the cards can be redrawn after a copy change
// without the original screenshot to hand. Needs Chromium; the smoke test's
// browser does, and PLAYWRIGHT_BROWSERS_PATH or CHROME_PATH says where.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'
import { chromium } from 'playwright-core'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = path.join(ROOT, 'public', 'shots')
const PUBLIC = path.join(ROOT, 'public')

const args = process.argv.slice(2)
const gisArg = args.includes('--gis') ? args[args.indexOf('--gis') + 1] : null

/* ---------- the crops ---------- */

async function crops(source) {
  const image = sharp(source)
  const { width, height } = await image.metadata()
  if (width !== 1440 || height !== 900) {
    throw new Error(`expected a 1440x900 screenshot, got ${width}x${height}`)
  }
  const out = (name) => path.join(SHOTS, name)
  await sharp(source).jpeg({ quality: 82, mozjpeg: true }).toFile(out('gis.jpg'))
  // The layer rail, the map itself and the legend, each as the page shows it.
  await sharp(source).extract({ left: 60, top: 58, width: 316, height: 840 }).jpeg({ quality: 82 }).toFile(out('gis-layers.jpg'))
  await sharp(source).extract({ left: 376, top: 58, width: 680, height: 840 }).jpeg({ quality: 82 }).toFile(out('gis-map.jpg'))
  await sharp(source).extract({ left: 1056, top: 58, width: 384, height: 240 }).jpeg({ quality: 82 }).toFile(out('gis-legend.jpg'))
  console.log('crops written to public/shots')
}

/* ---------- the cards ---------- */

const CARDS = [
  {
    file: 'og.png',
    eyebrow: 'For tenant rep brokers',
    title: 'Market surveys your clients actually open',
    sub: 'Map the sites, shade the demographics, plan the tour and send one live link. $29/month, teammates included.',
    shot: 'shots/map.jpg',
    shotWidth: 440,
  },
  {
    file: 'og-investors.png',
    eyebrow: 'For investors and acquisitions',
    title: 'Find the owner before the listing exists',
    sub: 'Owner of record, portfolios and mailing addresses from the county roll, filtered to your buy box and exported.',
    shot: 'shots/gis-map.jpg',
    shotWidth: 440,
  },
  {
    file: 'og-developers.png',
    eyebrow: 'For developers',
    title: 'Zoning, entitlements and the permit pipeline on one parcel map',
    sub: 'What can be built, what is being built, and who owns the dirt. Ten markets, 6.2 million parcels.',
    shot: 'shots/gis.jpg',
    shotWidth: 500,
  },
  {
    file: 'og-investment-sales.png',
    eyebrow: 'For investment sales brokers',
    title: 'Every owner in your product type, before the listing',
    sub: 'The owners in your asset class ranked by what they hold, with your comps mapped against them.',
    shot: 'shots/gis.jpg',
    shotWidth: 500,
  },
  {
    file: 'og-markets.png',
    eyebrow: 'Markets',
    title: 'Ten markets, 6.2 million parcels',
    sub: 'Austin, Broward County, Houston, Las Vegas, Nashville, New York, North Jersey, Orange County, Phoenix and Washington.',
    shot: 'shots/gis.jpg',
    shotWidth: 500,
  },
]

const dataUri = (file) => {
  const ext = path.extname(file).slice(1)
  const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`
}

/*
 * The site's typefaces, embedded rather than linked: the drawing browser has
 * no network, so the woff2 files are read from FONT_DIR (default
 * scripts/fonts) and inlined. Without them the cards fall back to the
 * system sans and still draw, just not in Inter.
 */
const FONT_DIR = process.env.FONT_DIR || path.join(ROOT, 'scripts', 'fonts')
function fontFaces() {
  // Both are variable fonts, so one file each covers every weight the card uses.
  const faces = [
    ['Inter', '100 900', 'Inter.woff2'],
    ['JetBrains Mono', '100 800', 'JetBrainsMono.woff2'],
  ]
  return faces
    .filter(([, , file]) => fs.existsSync(path.join(FONT_DIR, file)))
    .map(
      ([family, weight, file]) =>
        `@font-face{font-family:'${family}';font-weight:${weight};font-style:normal;src:url(data:font/woff2;base64,${fs
          .readFileSync(path.join(FONT_DIR, file))
          .toString('base64')}) format('woff2')}`,
    )
    .join('\n')
}

function cardHtml(card) {
  const mark = dataUri(path.join(PUBLIC, 'brand', 'lq-mark-inverse.png'))
  const shot = dataUri(path.join(PUBLIC, card.shot))
  const titleSize = card.title.length > 44 ? 54 : 64
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
${fontFaces()}
  html,body{margin:0;width:1200px;height:630px;overflow:hidden;background:#0c1f42;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
  .grid{position:absolute;inset:0;background-image:
    repeating-linear-gradient(0deg,rgba(122,170,225,.07) 0 1px,transparent 1px 46px),
    repeating-linear-gradient(90deg,rgba(122,170,225,.07) 0 1px,transparent 1px 46px)}
  .rings{position:absolute;inset:0;background-image:
    radial-gradient(circle at 86% 22%,transparent 0 150px,rgba(1,163,168,.28) 150px 151px,transparent 151px 300px,rgba(1,163,168,.20) 300px 301px,transparent 301px 470px,rgba(1,163,168,.13) 470px 471px,transparent 471px)}
  .brand{position:absolute;left:64px;top:56px;display:flex;align-items:center;gap:18px}
  .brand img{height:66px}
  .brand span{color:#fff;font-weight:800;font-size:30px;letter-spacing:-.02em}
  .site{position:absolute;right:64px;top:62px;font-family:"JetBrains Mono",ui-monospace,monospace;font-size:20px;color:#8ea0bd}
  .eyebrow{position:absolute;left:64px;top:170px;padding:9px 16px;border:1px solid #22406f;border-radius:999px;font-family:"JetBrains Mono",ui-monospace,monospace;font-size:17px;letter-spacing:.16em;text-transform:uppercase;color:#7fd9db}
  h1{position:absolute;left:64px;top:222px;width:620px;margin:0;color:#fff;font-weight:800;font-size:${titleSize}px;line-height:1.05;letter-spacing:-.025em}
  p{position:absolute;left:64px;bottom:60px;width:600px;margin:0;color:#c8d3e6;font-size:24px;line-height:1.35;font-weight:500}
  .shot{position:absolute;left:${1200 - card.shotWidth}px;top:250px;width:${card.shotWidth + 80}px;border-radius:14px 0 0 0;overflow:hidden;background:#fff;box-shadow:0 30px 60px rgba(0,0,0,.45);border:1px solid #22406f;border-right:0}
  .shot img{display:block;width:100%}
</style></head><body>
<div class="grid"></div><div class="rings"></div>
<div class="brand"><img src="${mark}" alt=""><span>Land Quotient</span></div>
<div class="site">landquotient.com</div>
<div class="eyebrow">${card.eyebrow}</div>
<h1>${card.title}</h1>
<p>${card.sub}</p>
<div class="shot"><img src="${shot}" alt=""></div>
</body></html>`
}

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH
  if (!base) return undefined
  const dirs = fs
    .readdirSync(base)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort()
  for (const d of dirs.reverse()) {
    const candidate = path.join(base, d, 'chrome-linux64', 'chrome')
    if (fs.existsSync(candidate)) return candidate
    const older = path.join(base, d, 'chrome-linux', 'chrome')
    if (fs.existsSync(older)) return older
  }
  return undefined
}

async function cards() {
  const browser = await chromium.launch({ executablePath: chromePath() })
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })
    for (const card of CARDS) {
      await page.setContent(cardHtml(card), { waitUntil: 'networkidle' })
      await page.evaluate(() => document.fonts.ready)
      await page.screenshot({ path: path.join(PUBLIC, card.file), type: 'png' })
      console.log(`drew ${card.file}`)
    }
  } finally {
    await browser.close()
  }
}

if (gisArg) await crops(path.resolve(gisArg))
await cards()
