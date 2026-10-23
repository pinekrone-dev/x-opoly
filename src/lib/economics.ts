/*
 * What a deal makes: the inputs a broker or investor fills in, and the
 * returns they produce.
 *
 * One model, read in two places. The deal page computes it here, live, as
 * the inputs are typed; the Excel export (dealWorkbook.ts) writes the same
 * arithmetic as formulas, so the file recalculates when a client changes a
 * number. The two are tested against each other, so the page and the
 * spreadsheet cannot drift apart.
 *
 * Percentages are kept as people type them (5 for 5%), and money as plain
 * dollars. Everything is annual. Any input left blank counts as zero, so a
 * deal with only a price and a commission rate still answers the
 * commission, and a hold period is what turns on the exit and the IRR.
 */

export interface EconomicsInputs {
  purchasePrice?: number | null
  closingCostsPct?: number | null
  capex?: number | null
  grossRent?: number | null
  otherIncome?: number | null
  vacancyPct?: number | null
  operatingExpenses?: number | null
  incomeGrowthPct?: number | null
  expenseGrowthPct?: number | null
  ltvPct?: number | null
  interestRatePct?: number | null
  amortYears?: number | null
  holdYears?: number | null
  exitCapPct?: number | null
  saleCostsPct?: number | null
  commissionPct?: number | null
  coBrokerPct?: number | null
  houseSplitPct?: number | null
}

export type EconomicsKey = keyof EconomicsInputs

export interface InputSpec {
  key: EconomicsKey
  label: string
  unit: 'usd' | 'pct' | 'years'
  hint?: string
}

export interface InputGroup {
  title: string
  inputs: InputSpec[]
}

/** The inputs, grouped as the page and the spreadsheet both lay them out. */
export const INPUT_GROUPS: InputGroup[] = [
  {
    title: 'Acquisition',
    inputs: [
      { key: 'purchasePrice', label: 'Purchase price', unit: 'usd' },
      { key: 'closingCostsPct', label: 'Closing costs', unit: 'pct', hint: '% of price' },
      { key: 'capex', label: 'Capital improvements', unit: 'usd', hint: 'Renovation, TI, site work' },
    ],
  },
  {
    title: 'Income and expenses',
    inputs: [
      { key: 'grossRent', label: 'Gross rent, year 1', unit: 'usd', hint: 'Per year' },
      { key: 'otherIncome', label: 'Other income, year 1', unit: 'usd', hint: 'Parking, signage, reimbursements' },
      { key: 'vacancyPct', label: 'Vacancy and credit loss', unit: 'pct' },
      { key: 'operatingExpenses', label: 'Operating expenses, year 1', unit: 'usd', hint: 'Per year' },
      { key: 'incomeGrowthPct', label: 'Income growth', unit: 'pct', hint: 'Per year' },
      { key: 'expenseGrowthPct', label: 'Expense growth', unit: 'pct', hint: 'Per year' },
    ],
  },
  {
    title: 'Financing',
    inputs: [
      { key: 'ltvPct', label: 'Loan to value', unit: 'pct' },
      { key: 'interestRatePct', label: 'Interest rate', unit: 'pct' },
      { key: 'amortYears', label: 'Amortization', unit: 'years', hint: '0 for interest only' },
    ],
  },
  {
    title: 'Exit',
    inputs: [
      { key: 'holdYears', label: 'Hold period', unit: 'years', hint: 'Up to 30' },
      { key: 'exitCapPct', label: 'Exit cap rate', unit: 'pct' },
      { key: 'saleCostsPct', label: 'Sale costs', unit: 'pct', hint: '% of sale price' },
    ],
  },
  {
    title: 'Brokerage',
    inputs: [
      { key: 'commissionPct', label: 'Commission', unit: 'pct', hint: '% of price' },
      { key: 'coBrokerPct', label: 'Co-broker share', unit: 'pct', hint: '% of commission' },
      { key: 'houseSplitPct', label: 'House split', unit: 'pct', hint: '% of your side' },
    ],
  },
]

export const INPUT_KEYS: EconomicsKey[] = INPUT_GROUPS.flatMap((group) => group.inputs.map((input) => input.key))

/** The longest hold the cash-flow table carries, on the page and in the file. */
export const MAX_HOLD_YEARS = 30

export interface YearRow {
  year: number
  income: number
  expenses: number
  noi: number
  debtService: number
  saleProceeds: number
  cashFlow: number
}

export interface EconomicsResult {
  totalCost: number
  noi: number
  goingInCap: number | null
  yieldOnCost: number | null
  loanAmount: number
  debtService: number
  equity: number
  cashFlowYear1: number
  cashOnCash: number | null
  dscr: number | null
  exitNoi: number
  salePrice: number
  loanBalanceAtSale: number
  netSaleProceeds: number
  totalCashFlow: number
  /** Null until there is a hold period: no exit, no investment profit to state. */
  totalProfit: number | null
  equityMultiple: number | null
  irr: number | null
  grossCommission: number
  coBrokerShare: number
  yourSide: number
  houseSplit: number
  netCommission: number
  years: YearRow[]
}

const n = (value: number | null | undefined) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const pct = (value: number | null | undefined) => n(value) / 100

/** Excel's PMT, payment as a positive number: rate per period, periods, principal. */
export function pmt(rate: number, periods: number, principal: number): number {
  if (periods <= 0) return 0
  if (rate === 0) return principal / periods
  return (principal * rate) / (1 - (1 + rate) ** -periods)
}

/** What is still owed after `paid` payments of `payment` on a loan of `principal`. */
export function balanceAfter(rate: number, paid: number, payment: number, principal: number): number {
  if (rate === 0) return principal - payment * paid
  const growth = (1 + rate) ** paid
  return principal * growth - (payment * (growth - 1)) / rate
}

/** IRR by bisection: robust where Newton's method wanders, and exact enough for a return. */
export function irr(flows: number[]): number | null {
  if (!flows.some((f) => f < 0) || !flows.some((f) => f > 0)) return null
  const npv = (rate: number) => flows.reduce((sum, flow, t) => sum + flow / (1 + rate) ** t, 0)
  let lo = -0.99
  let hi = 10
  let fLo = npv(lo)
  if (fLo * npv(hi) > 0) return null
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2
    const fMid = npv(mid)
    if (Math.abs(fMid) < 1e-9) return mid
    if (fLo * fMid < 0) hi = mid
    else {
      lo = mid
      fLo = fMid
    }
  }
  return (lo + hi) / 2
}

/** The returns, from whatever inputs are filled in. */
export function computeEconomics(inputs: EconomicsInputs): EconomicsResult {
  const price = n(inputs.purchasePrice)
  const totalCost = price * (1 + pct(inputs.closingCostsPct)) + n(inputs.capex)
  const grossIncome = n(inputs.grossRent) + n(inputs.otherIncome)
  const vacancy = pct(inputs.vacancyPct)
  const opex = n(inputs.operatingExpenses)
  const incomeGrowth = pct(inputs.incomeGrowthPct)
  const expenseGrowth = pct(inputs.expenseGrowthPct)
  const noi = grossIncome * (1 - vacancy) - opex

  const loanAmount = price * pct(inputs.ltvPct)
  const rate = pct(inputs.interestRatePct)
  const amort = n(inputs.amortYears)
  const monthly = amort > 0 ? pmt(rate / 12, amort * 12, loanAmount) : 0
  const debtService = loanAmount === 0 ? 0 : amort > 0 ? monthly * 12 : loanAmount * rate
  const equity = totalCost - loanAmount
  const cashFlowYear1 = noi - debtService

  const hold = Math.max(0, Math.min(MAX_HOLD_YEARS, Math.round(n(inputs.holdYears))))
  const exitNoi = grossIncome * (1 + incomeGrowth) ** hold * (1 - vacancy) - opex * (1 + expenseGrowth) ** hold
  const exitCap = pct(inputs.exitCapPct)
  const salePrice = exitCap > 0 ? exitNoi / exitCap : 0
  const loanBalanceAtSale =
    loanAmount === 0
      ? 0
      : amort > 0
        ? Math.max(0, balanceAfter(rate / 12, hold * 12, monthly, loanAmount))
        : loanAmount
  const netSaleProceeds = salePrice * (1 - pct(inputs.saleCostsPct)) - loanBalanceAtSale

  const years: YearRow[] = []
  for (let year = 1; year <= hold; year += 1) {
    const income = grossIncome * (1 + incomeGrowth) ** (year - 1) * (1 - vacancy)
    const expenses = opex * (1 + expenseGrowth) ** (year - 1)
    const saleProceeds = year === hold ? netSaleProceeds : 0
    years.push({
      year,
      income,
      expenses,
      noi: income - expenses,
      debtService,
      saleProceeds,
      cashFlow: income - expenses - debtService + saleProceeds,
    })
  }
  const totalCashFlow = years.reduce((sum, row) => sum + row.cashFlow - row.saleProceeds, 0)
  const proceeds = hold > 0 ? netSaleProceeds : 0
  const totalProfit = hold > 0 ? totalCashFlow + proceeds - equity : null

  const grossCommission = price * pct(inputs.commissionPct)
  const coBrokerShare = grossCommission * pct(inputs.coBrokerPct)
  const yourSide = grossCommission - coBrokerShare
  const houseSplit = yourSide * pct(inputs.houseSplitPct)

  return {
    totalCost,
    noi,
    goingInCap: price > 0 ? noi / price : null,
    yieldOnCost: totalCost > 0 ? noi / totalCost : null,
    loanAmount,
    debtService,
    equity,
    cashFlowYear1,
    cashOnCash: equity > 0 ? cashFlowYear1 / equity : null,
    dscr: debtService > 0 ? noi / debtService : null,
    exitNoi,
    salePrice,
    loanBalanceAtSale,
    netSaleProceeds,
    totalCashFlow,
    totalProfit,
    equityMultiple: hold > 0 && equity > 0 ? (totalCashFlow + proceeds) / equity : null,
    irr: hold > 0 ? irr([-equity, ...years.map((row) => row.cashFlow)]) : null,
    grossCommission,
    coBrokerShare,
    yourSide,
    houseSplit,
    netCommission: yourSide - houseSplit,
    years,
  }
}

/** Whether anything at all has been entered. */
export function hasEconomics(inputs: EconomicsInputs | null | undefined): boolean {
  return Boolean(inputs) && INPUT_KEYS.some((key) => typeof inputs?.[key] === 'number')
}
