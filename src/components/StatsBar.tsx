import type { CrawlStats } from '../types'
import { formatMs, formatNumber } from '../lib/format'

interface Props {
  stats: CrawlStats
  selected: number
}

export default function StatsBar({ stats, selected }: Props) {
  const cards = [
    { label: 'URLs found', value: formatNumber(stats.total), tone: 'text-slate-100' },
    { label: 'In sitemap', value: formatNumber(selected), tone: 'text-accent' },
    { label: 'Redirects', value: formatNumber(stats.redirects), tone: stats.redirects ? 'text-amber-300' : 'text-slate-400' },
    { label: 'Broken', value: formatNumber(stats.broken), tone: stats.broken ? 'text-rose-300' : 'text-slate-400' },
    { label: 'Noindex', value: formatNumber(stats.noindex), tone: 'text-slate-300' },
    { label: 'Deepest level', value: String(stats.maxDepth), tone: 'text-slate-300' },
    { label: 'Avg. words', value: formatNumber(stats.avgWords), tone: 'text-slate-300' },
    { label: 'Avg. response', value: formatMs(stats.avgResponseMs), tone: 'text-slate-300' },
  ]

  return (
    <section className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
      {cards.map((card) => (
        <div key={card.label} className="panel px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{card.label}</p>
          <p className={`mt-1 font-mono text-xl font-semibold ${card.tone}`}>{card.value}</p>
        </div>
      ))}
    </section>
  )
}
