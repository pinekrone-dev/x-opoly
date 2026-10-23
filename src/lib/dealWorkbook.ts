/*
 * Deals as an Excel workbook that still calculates.
 *
 * Every number a deal produces is written as a formula over its inputs, not
 * as a value: a client who opens the file and changes the price, the rent or
 * the exit cap sees the cap rate, the cash flows, the IRR and the commission
 * move with it, exactly as they do on the deal page. The arithmetic is
 * economics.ts's, cell for cell, and the tests hold the two together.
 *
 * One sheet per deal, plus a Summary that links to each deal's sheet rather
 * than copying its results, so the summary follows any change made on a
 * deal's own sheet. ExcelJS is passed in rather than imported, so the page
 * can load it only when someone actually exports, and the tests can run the
 * same builder in Node.
 */
import type ExcelJS from 'exceljs'
import { INPUT_GROUPS, MAX_HOLD_YEARS, type EconomicsInputs, type EconomicsKey } from './economics.ts'

export interface DealForExport {
  name: string
  stage?: string | null
  kind?: string | null
  closeDate?: string | null
  economics?: EconomicsInputs | null
}

type ExcelModule = typeof ExcelJS

const INPUT_FILL = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FFFFF7D6' } }
const INPUT_FONT = { color: { argb: 'FF1F4FBF' }, bold: true }
const HEAD_FONT = { bold: true, color: { argb: 'FF0F172A' } }
const SECTION_FILL = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FFE6F6F6' } }
const USD = '"$"#,##0;[Red]-"$"#,##0'
const PCT = '0.00%'
const MULT = '0.00"x"'

/** Sheet names: at most 31 characters, none of []:*?/\, and unique. */
export function sheetName(name: string, taken: Set<string>): string {
  const base = (name.replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim() || 'Deal').slice(0, 28)
  let candidate = base
  for (let i = 2; taken.has(candidate.toLowerCase()) || candidate.toLowerCase() === 'summary'; i += 1) {
    candidate = `${base.slice(0, 28 - String(i).length - 1)} ${i}`
  }
  taken.add(candidate.toLowerCase())
  return candidate
}

/** Where each input and each result sits on a deal sheet, for the formulas and the summary. */
export interface DealCells {
  input: Record<EconomicsKey, string>
  totalCost: string
  noi: string
  goingInCap: string
  yieldOnCost: string
  loanAmount: string
  debtService: string
  equity: string
  cashFlowYear1: string
  cashOnCash: string
  dscr: string
  exitNoi: string
  salePrice: string
  loanBalanceAtSale: string
  netSaleProceeds: string
  totalCashFlow: string
  totalProfit: string
  equityMultiple: string
  irr: string
  grossCommission: string
  coBrokerShare: string
  yourSide: string
  houseSplit: string
  netCommission: string
}

/** Writes one deal's sheet and answers where its cells are. */
export function addDealSheet(workbook: ExcelJS.Workbook, deal: DealForExport, name: string): DealCells {
  const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 2 }] })
  sheet.getColumn(1).width = 34
  sheet.getColumn(2).width = 18
  sheet.getColumn(3).width = 30
  sheet.getColumn(4).width = 3
  for (const col of [5, 6, 7, 8, 9, 10, 11, 12]) sheet.getColumn(col).width = col === 5 ? 7 : 15

  sheet.getCell('A1').value = deal.name
  sheet.getCell('A1').font = { bold: true, size: 14 }
  sheet.getCell('A2').value = 'Blue cells are inputs: change any of them and every result recalculates.'
  sheet.getCell('A2').font = { italic: true, color: { argb: 'FF64748B' } }

  const economics = deal.economics ?? {}
  const input = {} as Record<EconomicsKey, string>
  let row = 4
  for (const group of INPUT_GROUPS) {
    const head = sheet.getCell(`A${row}`)
    head.value = group.title
    head.font = HEAD_FONT
    sheet.getRow(row).fill = SECTION_FILL
    row += 1
    for (const spec of group.inputs) {
      const raw = economics[spec.key]
      const value = typeof raw === 'number' && Number.isFinite(raw) ? (spec.unit === 'pct' ? raw / 100 : raw) : 0
      sheet.getCell(`A${row}`).value = spec.label
      const cell = sheet.getCell(`B${row}`)
      cell.value = value
      cell.numFmt = spec.unit === 'usd' ? USD : spec.unit === 'pct' ? PCT : '0'
      cell.fill = INPUT_FILL
      cell.font = INPUT_FONT
      if (spec.hint) sheet.getCell(`C${row}`).value = spec.hint
      sheet.getCell(`C${row}`).font = { color: { argb: 'FF94A3B8' } }
      input[spec.key] = `$B$${row}`
      row += 1
    }
    row += 1
  }
  const i = input
  sheet.getCell(i.holdYears).dataValidation = {
    type: 'whole',
    operator: 'between',
    allowBlank: true,
    formulae: [0, MAX_HOLD_YEARS],
    showErrorMessage: true,
    errorTitle: 'Hold period',
    error: `Enter a whole number of years from 0 to ${MAX_HOLD_YEARS}.`,
  }

  // The cash-flow table, beside the inputs: year 0 is the equity in, then
  // one row per year up to the longest hold, zero past the one chosen.
  const top = 4
  const headers = ['Year', 'Income', 'Expenses', 'NOI', 'Debt service', 'Operating CF', 'Sale proceeds', 'Total CF']
  headers.forEach((label, at) => {
    const cell = sheet.getCell(top, 5 + at)
    cell.value = label
    cell.font = HEAD_FONT
    cell.fill = SECTION_FILL
  })
  const first = top + 1
  const last = first + MAX_HOLD_YEARS
  const results = {} as Omit<DealCells, 'input'>
  // Results start under the inputs; their addresses are needed by the table.
  const resultTop = row + 1
  const at = (offset: number) => `$B$${resultTop + offset}`
  const keys: (keyof Omit<DealCells, 'input'>)[] = [
    'totalCost', 'noi', 'goingInCap', 'yieldOnCost', 'loanAmount', 'debtService', 'equity', 'cashFlowYear1',
    'cashOnCash', 'dscr', 'exitNoi', 'salePrice', 'loanBalanceAtSale', 'netSaleProceeds', 'totalCashFlow',
    'totalProfit', 'equityMultiple', 'irr',
  ]
  keys.forEach((key, offset) => {
    results[key] = at(offset)
  })
  const commissionTop = resultTop + keys.length + 2
  ;(['grossCommission', 'coBrokerShare', 'yourSide', 'houseSplit', 'netCommission'] as const).forEach((key, offset) => {
    results[key] = `$B$${commissionTop + offset}`
  })
  const r = results

  for (let line = first; line <= last; line += 1) {
    const year = `E${line}`
    if (line === first) {
      sheet.getCell(year).value = 0
      for (const col of ['F', 'G', 'H', 'I', 'J', 'K']) sheet.getCell(`${col}${line}`).value = 0
      sheet.getCell(`L${line}`).value = { formula: `-${r.equity}` }
    } else {
      const inHold = `E${line}>${i.holdYears}`
      sheet.getCell(year).value = { formula: `E${line - 1}+1` }
      sheet.getCell(`F${line}`).value = {
        formula: `IF(${inHold},0,(${i.grossRent}+${i.otherIncome})*(1+${i.incomeGrowthPct})^(E${line}-1)*(1-${i.vacancyPct}))`,
      }
      sheet.getCell(`G${line}`).value = {
        formula: `IF(${inHold},0,${i.operatingExpenses}*(1+${i.expenseGrowthPct})^(E${line}-1))`,
      }
      sheet.getCell(`H${line}`).value = { formula: `F${line}-G${line}` }
      sheet.getCell(`I${line}`).value = { formula: `IF(${inHold},0,${r.debtService})` }
      sheet.getCell(`J${line}`).value = { formula: `H${line}-I${line}` }
      sheet.getCell(`K${line}`).value = { formula: `IF(E${line}=${i.holdYears},${r.netSaleProceeds},0)` }
      sheet.getCell(`L${line}`).value = { formula: `J${line}+K${line}` }
    }
    for (const col of ['F', 'G', 'H', 'I', 'J', 'K', 'L']) sheet.getCell(`${col}${line}`).numFmt = USD
  }
  const flows = `$L$${first}:$L$${last}`
  const operating = `$J$${first + 1}:$J$${last}`

  const formulas: Record<keyof Omit<DealCells, 'input'>, { label: string; formula: string; format: string }> = {
    totalCost: { label: 'Total project cost', formula: `${i.purchasePrice}*(1+${i.closingCostsPct})+${i.capex}`, format: USD },
    noi: { label: 'Net operating income, year 1', formula: `(${i.grossRent}+${i.otherIncome})*(1-${i.vacancyPct})-${i.operatingExpenses}`, format: USD },
    goingInCap: { label: 'Going-in cap rate', formula: `IF(${i.purchasePrice}>0,${r.noi}/${i.purchasePrice},0)`, format: PCT },
    yieldOnCost: { label: 'Yield on cost', formula: `IF(${r.totalCost}>0,${r.noi}/${r.totalCost},0)`, format: PCT },
    loanAmount: { label: 'Loan amount', formula: `${i.purchasePrice}*${i.ltvPct}`, format: USD },
    debtService: {
      label: 'Annual debt service',
      formula: `IF(${r.loanAmount}=0,0,IF(${i.amortYears}>0,IF(${i.interestRatePct}=0,${r.loanAmount}/${i.amortYears},PMT(${i.interestRatePct}/12,${i.amortYears}*12,-${r.loanAmount})*12),${r.loanAmount}*${i.interestRatePct}))`,
      format: USD,
    },
    equity: { label: 'Equity required', formula: `${r.totalCost}-${r.loanAmount}`, format: USD },
    cashFlowYear1: { label: 'Cash flow after debt, year 1', formula: `${r.noi}-${r.debtService}`, format: USD },
    cashOnCash: { label: 'Cash-on-cash, year 1', formula: `IF(${r.equity}>0,${r.cashFlowYear1}/${r.equity},0)`, format: PCT },
    dscr: { label: 'Debt service coverage', formula: `IF(${r.debtService}>0,${r.noi}/${r.debtService},0)`, format: MULT },
    exitNoi: {
      label: 'NOI in the year after sale',
      formula: `(${i.grossRent}+${i.otherIncome})*(1+${i.incomeGrowthPct})^${i.holdYears}*(1-${i.vacancyPct})-${i.operatingExpenses}*(1+${i.expenseGrowthPct})^${i.holdYears}`,
      format: USD,
    },
    salePrice: { label: 'Sale price', formula: `IF(${i.exitCapPct}>0,${r.exitNoi}/${i.exitCapPct},0)`, format: USD },
    loanBalanceAtSale: {
      label: 'Loan balance at sale',
      formula: `IF(${r.loanAmount}=0,0,IF(${i.amortYears}>0,IF(${i.interestRatePct}=0,MAX(0,${r.loanAmount}-${r.loanAmount}/${i.amortYears}*${i.holdYears}),MAX(0,-FV(${i.interestRatePct}/12,${i.holdYears}*12,-PMT(${i.interestRatePct}/12,${i.amortYears}*12,-${r.loanAmount}),${r.loanAmount}))),${r.loanAmount}))`,
      format: USD,
    },
    netSaleProceeds: { label: 'Net sale proceeds after loan', formula: `${r.salePrice}*(1-${i.saleCostsPct})-${r.loanBalanceAtSale}`, format: USD },
    totalCashFlow: { label: 'Operating cash flow over the hold', formula: `SUM(${operating})`, format: USD },
    totalProfit: {
      label: 'Total profit',
      // Blank, not a loss, until there is a hold period: a deal entered for its
      // commission alone has no investment to make a profit on.
      formula: `IF(${i.holdYears}>0,${r.totalCashFlow}+${r.netSaleProceeds}-${r.equity},"")`,
      format: USD,
    },
    equityMultiple: {
      label: 'Equity multiple',
      formula: `IF(AND(${i.holdYears}>0,${r.equity}>0),(${r.totalCashFlow}+${r.netSaleProceeds})/${r.equity},"")`,
      format: MULT,
    },
    irr: { label: 'IRR, levered', formula: `IF(${i.holdYears}>0,IFERROR(IRR(${flows}),""),"")`, format: PCT },
    grossCommission: { label: 'Gross commission', formula: `${i.purchasePrice}*${i.commissionPct}`, format: USD },
    coBrokerShare: { label: 'To the co-broker', formula: `${r.grossCommission}*${i.coBrokerPct}`, format: USD },
    yourSide: { label: 'Your side', formula: `${r.grossCommission}-${r.coBrokerShare}`, format: USD },
    houseSplit: { label: 'To your brokerage', formula: `${r.yourSide}*${i.houseSplitPct}`, format: USD },
    netCommission: { label: 'Net commission to you', formula: `${r.yourSide}-${r.houseSplit}`, format: USD },
  }

  const section = (rowAt: number, title: string) => {
    const cell = sheet.getCell(`A${rowAt}`)
    cell.value = title
    cell.font = HEAD_FONT
    sheet.getRow(rowAt).fill = SECTION_FILL
  }
  section(resultTop - 1, 'Returns')
  section(commissionTop - 1, 'Commission')
  for (const [key, spec] of Object.entries(formulas) as [keyof typeof formulas, (typeof formulas)[keyof typeof formulas]][]) {
    const address = r[key].replace(/\$/g, '')
    const rowAt = Number(address.slice(1))
    sheet.getCell(`A${rowAt}`).value = spec.label
    const cell = sheet.getCell(address)
    cell.value = { formula: spec.formula }
    cell.numFmt = spec.format
    if (key === 'totalProfit' || key === 'irr' || key === 'netCommission') cell.font = { bold: true }
  }

  return { input, ...results }
}

const SUMMARY_COLUMNS: { header: string; key: keyof Omit<DealCells, 'input'> | 'price'; format: string; total?: boolean }[] = [
  { header: 'Purchase price', key: 'price', format: USD, total: true },
  { header: 'Total cost', key: 'totalCost', format: USD, total: true },
  { header: 'NOI, year 1', key: 'noi', format: USD, total: true },
  { header: 'Cap rate', key: 'goingInCap', format: PCT },
  { header: 'Yield on cost', key: 'yieldOnCost', format: PCT },
  { header: 'Equity', key: 'equity', format: USD, total: true },
  { header: 'Cash-on-cash', key: 'cashOnCash', format: PCT },
  { header: 'IRR', key: 'irr', format: PCT },
  { header: 'Equity multiple', key: 'equityMultiple', format: MULT },
  { header: 'Total profit', key: 'totalProfit', format: USD, total: true },
  { header: 'Net commission', key: 'netCommission', format: USD, total: true },
]

/** The whole workbook: a Summary linked to one sheet per deal. */
export function buildDealWorkbook(Excel: ExcelModule, deals: DealForExport[]): ExcelJS.Workbook {
  const workbook = new Excel.Workbook()
  workbook.creator = 'Land Quotient'
  workbook.created = new Date()
  // Excel recalculates every formula when the file opens, so the cached
  // values a generator cannot know are never what a reader sees.
  workbook.calcProperties = { fullCalcOnLoad: true }

  const summary = workbook.addWorksheet('Summary', { views: [{ state: 'frozen', ySplit: 3 }] })
  const taken = new Set<string>()
  const sheets = deals.map((deal) => {
    const name = sheetName(deal.name, taken)
    return { deal, name, cells: addDealSheet(workbook, deal, name) }
  })

  summary.getCell('A1').value = deals.length === 1 ? `${deals[0].name}: deal summary` : 'Deal summary'
  summary.getCell('A1').font = { bold: true, size: 14 }
  summary.getCell('A2').value = "Each row reads its deal's own sheet. Change an input there and this updates."
  summary.getCell('A2').font = { italic: true, color: { argb: 'FF64748B' } }
  const headers = ['Deal', 'Stage', ...SUMMARY_COLUMNS.map((column) => column.header)]
  headers.forEach((label, at) => {
    const cell = summary.getCell(3, at + 1)
    cell.value = label
    cell.font = HEAD_FONT
    cell.fill = SECTION_FILL
  })
  summary.getColumn(1).width = 32
  summary.getColumn(2).width = 14
  SUMMARY_COLUMNS.forEach((_, at) => {
    summary.getColumn(at + 3).width = 16
  })

  sheets.forEach(({ deal, name, cells }, at) => {
    const rowAt = 4 + at
    const ref = (address: string) => `'${name.replace(/'/g, "''")}'!${address}`
    const link = summary.getCell(rowAt, 1)
    link.value = { text: deal.name, hyperlink: `#${ref('A1')}` }
    link.font = { color: { argb: 'FF0E7490' }, underline: true }
    summary.getCell(rowAt, 2).value = deal.stage ?? ''
    SUMMARY_COLUMNS.forEach((column, offset) => {
      const cell = summary.getCell(rowAt, offset + 3)
      const address = column.key === 'price' ? cells.input.purchasePrice : cells[column.key]
      cell.value = { formula: ref(address) }
      cell.numFmt = column.format
    })
  })

  if (sheets.length > 1) {
    const totalRow = 4 + sheets.length
    summary.getCell(totalRow, 1).value = 'Total'
    summary.getCell(totalRow, 1).font = HEAD_FONT
    SUMMARY_COLUMNS.forEach((column, offset) => {
      if (!column.total) return
      const col = summary.getColumn(offset + 3).letter
      const cell = summary.getCell(totalRow, offset + 3)
      cell.value = { formula: `SUM(${col}4:${col}${totalRow - 1})` }
      cell.numFmt = column.format
      cell.font = HEAD_FONT
    })
  }
  return workbook
}

/** The download: built in the browser, named for what is in it. */
export async function downloadDealWorkbook(deals: DealForExport[], filename: string) {
  const Excel = (await import('exceljs')).default
  const workbook = buildDealWorkbook(Excel, deals)
  const buffer = await workbook.xlsx.writeBuffer()
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'deals.xlsx'
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
