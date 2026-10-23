/**
 * Deal economics: the arithmetic on the deal page, the Excel workbook that
 * repeats it as formulas, and the column the inputs are kept in.
 *
 * The workbook's formulas were also checked by recalculating an export in
 * LibreOffice and comparing every result with computeEconomics; that needs
 * an office suite, so here the formulas are held to their shape and to the
 * cells they read, and the numbers to hand-worked answers.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test, { after, before, describe } from 'node:test'

import { balanceAfter, computeEconomics, irr, pmt } from '../src/lib/economics.ts'
import { buildDealWorkbook, sheetName } from '../src/lib/dealWorkbook.ts'
import { createServer } from '../server/index.js'
import { useTempData } from './helpers.js'

const Excel = createRequire(import.meta.url)('exceljs')

const near = (actual, expected, tolerance = 0.01) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`)

const PARMER = {
  purchasePrice: 4200000, closingCostsPct: 2, capex: 250000, grossRent: 410000, otherIncome: 12000,
  vacancyPct: 5, operatingExpenses: 95000, incomeGrowthPct: 3, expenseGrowthPct: 2.5, ltvPct: 65,
  interestRatePct: 6.75, amortYears: 25, holdYears: 7, exitCapPct: 7.25, saleCostsPct: 2,
  commissionPct: 3, coBrokerPct: 50, houseSplitPct: 30,
}

describe('the arithmetic', () => {
  test('PMT and the balance left agree with the textbook loan', () => {
    // $100,000 at 6% for 30 years: $599.55 a month, the standard example.
    near(pmt(0.06 / 12, 360, 100000), 599.55)
    near(balanceAfter(0.06 / 12, 360, pmt(0.06 / 12, 360, 100000), 100000), 0, 0.001)
    near(pmt(0, 120, 12000), 100)
  })

  test('IRR finds the rate that zeroes the cash flows', () => {
    near(irr([-1000, 1100]), 0.1, 1e-6)
    near(irr([-1000, 0, 1210]), 0.1, 1e-6)
    assert.equal(irr([1000, 1000]), null, 'no money in, no rate')
  })

  test('a financed hold: NOI, cap rate, debt, exit and returns', () => {
    const r = computeEconomics(PARMER)
    near(r.totalCost, 4534000)
    near(r.noi, (410000 + 12000) * 0.95 - 95000) // 305,900
    near(r.goingInCap, 305900 / 4200000, 1e-9)
    near(r.loanAmount, 2730000)
    near(r.debtService, pmt(0.0675 / 12, 300, 2730000) * 12)
    near(r.equity, 4534000 - 2730000)
    assert.equal(r.years.length, 7)
    near(r.years[6].saleProceeds, r.netSaleProceeds)
    near(r.totalProfit, 1749907.41)
    near(r.irr, 0.113463, 1e-6)
  })

  test('the commission splits three ways', () => {
    const r = computeEconomics(PARMER)
    near(r.grossCommission, 126000)
    near(r.coBrokerShare, 63000)
    near(r.houseSplit, 18900)
    near(r.netCommission, 44100)
  })

  test('a commission-only deal states no investment profit', () => {
    const r = computeEconomics({ purchasePrice: 1500000, commissionPct: 6 })
    assert.equal(r.totalProfit, null, 'not a $1.5M loss')
    assert.equal(r.irr, null)
    assert.equal(r.equityMultiple, null)
    near(r.netCommission, 90000)
  })

  test('interest only: the loan is still owed in full at sale', () => {
    const r = computeEconomics({ purchasePrice: 1000000, ltvPct: 50, interestRatePct: 7, amortYears: 0, holdYears: 5 })
    near(r.debtService, 35000)
    near(r.loanBalanceAtSale, 500000)
  })
})

describe('the workbook', () => {
  const book = buildDealWorkbook(Excel, [
    { name: 'Parmer Lane retail', stage: 'loi', economics: PARMER },
    { name: 'Parmer Lane retail', stage: 'prospect', economics: { purchasePrice: 900000, commissionPct: 4 } },
  ])

  test('a Summary, then one sheet per deal, uniquely named', () => {
    assert.deepEqual(book.worksheets.map((s) => s.name), ['Summary', 'Parmer Lane retail', 'Parmer Lane retail 2'])
    const taken = new Set()
    assert.equal(sheetName('a/b:c*d?', taken), 'a b c d')
    assert.equal(sheetName('Summary', taken), 'Summary 2', 'never the summary sheet itself')
  })

  test('inputs are values, results are formulas over them', () => {
    const sheet = book.getWorksheet('Parmer Lane retail')
    const labelled = {}
    sheet.eachRow((row) => {
      const label = row.getCell(1).value
      if (typeof label === 'string' && !(label in labelled)) labelled[label] = row.getCell(2).value
    })
    assert.equal(labelled['Purchase price'], 4200000)
    assert.equal(labelled['Closing costs'], 0.02, 'a percentage as Excel keeps it')
    assert.match(labelled['Total project cost'].formula, /^\$B\$5\*\(1\+\$B\$6\)\+\$B\$7$/)
    assert.match(labelled['Annual debt service'].formula, /PMT\(/)
    assert.match(labelled['IRR, levered'].formula, /IRR\(\$L\$5:\$L\$35\)/)
    assert.match(labelled['Net commission to you'].formula, /^\$B\$\d+-\$B\$\d+$/)
  })

  test('the summary links to each deal sheet instead of copying its numbers', () => {
    const summary = book.getWorksheet('Summary')
    assert.equal(summary.getCell('A4').value.text, 'Parmer Lane retail')
    assert.match(summary.getCell('C4').value.formula, /^'Parmer Lane retail'!\$B\$5$/)
    assert.match(summary.getCell('C5').value.formula, /^'Parmer Lane retail 2'!\$B\$5$/)
    assert.match(summary.getCell('C6').value.formula, /^SUM\(C4:C5\)$/, 'and totals them')
  })

  test('the file is a real xlsx that recalculates on open', async () => {
    const buffer = await book.xlsx.writeBuffer()
    assert.equal(Buffer.from(buffer).subarray(0, 2).toString(), 'PK')
    const reread = new Excel.Workbook()
    await reread.xlsx.load(buffer)
    assert.equal(reread.worksheets.length, 3)
    // ExcelJS writes the flag but does not read it back; the workbook XML is the truth.
    const { inflateRawSync } = await import('node:zlib')
    const zip = Buffer.from(buffer)
    const at = zip.indexOf('xl/workbook.xml')
    const header = at - 30
    const method = zip.readUInt16LE(header + 8)
    const size = zip.readUInt32LE(header + 18)
    const start = at + zip.readUInt16LE(header + 26) + zip.readUInt16LE(header + 28)
    const xml = (method === 8 ? inflateRawSync(zip.subarray(start, start + size)) : zip.subarray(start, start + size)).toString()
    assert.match(xml, /<calcPr[^>]*fullCalcOnLoad="1"/)
  })
})

describe('the stored inputs', () => {
  const temp = useTempData()
  let app
  let cookie = null
  const call = async (path, init = {}) => {
    const response = await app.fetch(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      }),
    )
    const set = response.headers.get('set-cookie')
    if (set) cookie = set.split(';')[0]
    return { status: response.status, body: await response.json().catch(() => null) }
  }
  before(async () => {
    app = await createServer({ DATA_DIR: temp.directory, DB_FILE: `${temp.directory}/test.db` })
    await call('/api/auth/register', { method: 'POST', body: JSON.stringify({ email: 'e@example.com', password: 'a long enough password' }) })
  })
  after(() => temp.cleanup())

  test('a deal keeps its economics, numbers only, and lists them', async () => {
    const made = await call('/api/crm/deals', { method: 'POST', body: JSON.stringify({ name: 'Economics' }) })
    const id = made.body.record.id
    const saved = await call(`/api/crm/deals/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ economics: { purchasePrice: '2500000', capRate: 7, vacancyPct: 'lots', holdYears: 5, ltvPct: null } }),
    })
    assert.equal(saved.status, 200)
    assert.deepEqual(saved.body.record.economics, { purchasePrice: 2500000, holdYears: 5 }, 'unknown keys and non-numbers dropped')
    const listed = await call('/api/crm/deals')
    assert.deepEqual(listed.body.records.find((r) => r.id === id).economics, { purchasePrice: 2500000, holdYears: 5 })
    const cleared = await call(`/api/crm/deals/${id}`, { method: 'PATCH', body: JSON.stringify({ economics: {} }) })
    assert.equal(cleared.body.record.economics, null)
  })
})
