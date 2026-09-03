import { useEffect, useMemo, useState } from 'react'
import AccountMenu from './AccountMenu'
import { api } from '../api'
import BrandMark from './BrandMark'
import { OBJECTS } from '../lib/crm'
import { navigate } from '../lib/router'
import type { Account, BillingStatus } from '../types'

/*
 * One header for the whole workspace.
 *
 * GIS and the lists used to render their own, laid out differently — one
 * centred inside a max-width shell, one full bleed above the map. Moving
 * between them slid the logo and the tabs sideways, which reads as the page
 * jumping rather than as navigation. Same bar, same position, every route.
 *
 * Three tabs, because deals, people, companies and places are not peers of
 * the map: they are what the CRM is made of, so they hang under CRM.
 */
export default function WorkspaceNav({
  current,
  counts,
  surveyCount,
  account,
  smsConfigured,
  billing,
  onAccountChange,
  onSignedOut,
}: {
  /** Which tab is lit; `settings` lights none, the page being off the tab row. */
  current: 'gis' | 'crm' | 'surveys' | 'settings'
  /** Live counts per CRM segment, when the caller has them. */
  counts?: Record<string, number>
  surveyCount?: number
  account?: Account | null
  smsConfigured?: boolean
  billing?: BillingStatus | null
  onAccountChange?: (account: Account) => void
  onSignedOut?: () => void
}) {
  const segments = useMemo(() => OBJECTS.map((object) => object.segment), [])

  /*
   * The counts are part of the answer, not decoration: "how many places do I
   * have" is often the whole question. The lists already fetch them and pass
   * them in; every other route would otherwise show an empty menu, so the nav
   * fetches its own when nobody hands it any.
   */
  const [own, setOwn] = useState<Record<string, number> | null>(null)
  const [ownSurveys, setOwnSurveys] = useState<number | null>(null)
  const needsOwn = counts === undefined
  useEffect(() => {
    if (!needsOwn || !account) return undefined
    let cancelled = false
    // One request for all the numbers. This used to download every record of
    // every type just to measure the lists' lengths.
    api.crm
      .counts()
      .then(({ counts: found, surveys }) => {
        if (cancelled) return
        setOwn(Object.fromEntries(segments.map((segment) => [segment, found[segment] ?? 0])))
        setOwnSurveys(surveys)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [needsOwn, account, segments])

  const shownCounts = counts ?? own ?? undefined
  const shownSurveys = surveyCount ?? ownSurveys ?? undefined

  return (
    <header className="shrink-0 border-b border-line bg-surface">
      <div className="flex items-center gap-6 px-5">
        <button type="button" className="py-2.5" onClick={() => navigate('/gis')} aria-label="Land Quotient home">
          <BrandMark />
        </button>

        <nav className="flex gap-1" aria-label="Workspace">
          <Tab label="GIS" active={current === 'gis'} onClick={() => navigate('/gis')} />

          {/*
           * Opens on hover, and stays open while the pointer is anywhere in
           * the group so crossing the gap between the tab and the list does
           * not close it. The counts are the answer as often as the links
           * are, so reaching them should not cost a click to open and another
           * to close. group-focus-within keeps it reachable from a keyboard.
           */}
          <div className="group relative">
            <Tab label="CRM" active={current === 'crm'} caret onClick={() => navigate('/deals')} />
            <ul className="invisible absolute left-0 top-full z-[700] w-52 overflow-hidden rounded-lg border border-line bg-surface opacity-0 shadow-xl transition group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100">
              {OBJECTS.map((object) => (
                <li key={object.segment}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-body hover:bg-sunken"
                    onClick={() => navigate(`/${object.segment}`)}
                  >
                    {object.label}
                    <span className="text-xs text-faint">{shownCounts?.[object.segment] ?? ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <Tab
            label="Surveys"
            active={current === 'surveys'}
            count={shownSurveys}
            onClick={() => navigate('/surveys')}
          />
        </nav>

        {account ? (
          <div className="ml-auto py-2">
            <AccountMenu
              account={account}
              smsConfigured={Boolean(smsConfigured)}
              billing={billing ?? undefined}
              onChange={(next) => onAccountChange?.(next)}
              onSignedOut={() => onSignedOut?.()}
            />
          </div>
        ) : null}
      </div>
    </header>
  )
}

/** Which CRM segment, if any, a path is showing — for the active underline. */
export function navSection(tab: string): 'gis' | 'crm' | 'surveys' {
  if (tab === 'gis') return 'gis'
  if (tab === 'surveys') return 'surveys'
  return 'crm'
}

function Tab({
  label,
  active,
  count,
  caret,
  onClick,
}: {
  label: string
  active: boolean
  count?: number
  caret?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={`shrink-0 border-b-2 px-3 py-2.5 text-sm ${
        active ? 'border-brand font-semibold text-ink' : 'border-transparent text-muted hover:text-body'
      }`}
      aria-current={active ? 'page' : undefined}
      aria-haspopup={caret ? 'true' : undefined}
      onClick={onClick}
    >
      {label}
      {count != null && <span className="ml-1.5 text-xs text-faint">{count}</span>}
      {caret && (
        <span className="ml-1.5 text-xs text-faint" aria-hidden>
          ▾
        </span>
      )}
    </button>
  )
}
