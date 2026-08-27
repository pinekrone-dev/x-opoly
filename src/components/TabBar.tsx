import BrandMark from './BrandMark'
import { navigate } from '../lib/router'

/*
 * The three lenses.
 *
 * GIS, CRM and Survey are not three apps behind three tabs — they are three
 * readings of the same map. The tab changes what the panels say, not what the
 * map is, which is why a parcel found in GIS can be sent into a survey
 * without being found again.
 *
 * Full width rather than the constrained shell Home uses: the parcel map is
 * full bleed, and a centred max-width bar above it would leave the map
 * floating under a page header it does not belong to.
 */
const TABS = [
  { id: 'gis', label: 'GIS', path: '/gis' },
  { id: 'crm', label: 'CRM', path: '/deals' },
  { id: 'surveys', label: 'Surveys', path: '/surveys' },
] as const

export default function TabBar({ current }: { current: 'gis' | 'crm' | 'surveys' }) {
  return (
    <header className="flex shrink-0 items-center gap-5 border-b border-line bg-surface px-5">
      <button type="button" className="py-2.5" onClick={() => navigate('/deals')} aria-label="Land Quotient home">
        <BrandMark />
      </button>
      <nav className="flex gap-1" aria-label="Workspace">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`border-b-2 px-3 py-2.5 text-sm ${
              current === tab.id
                ? 'border-brand font-semibold text-ink'
                : 'border-transparent text-muted hover:text-body'
            }`}
            aria-current={current === tab.id ? 'page' : undefined}
            onClick={() => navigate(tab.path)}
          >
            {tab.label}
          </button>
        ))}
      </nav>
    </header>
  )
}
