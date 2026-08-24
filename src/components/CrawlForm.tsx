import { useState } from 'react'
import type { CrawlOptions } from '../types'
import OptionsPanel from './OptionsPanel'

interface Props {
  url: string
  onUrlChange: (value: string) => void
  options: CrawlOptions
  onOptionsChange: (options: CrawlOptions) => void
  onSubmit: () => void
  onStop: () => void
  running: boolean
  error: string | null
}

export default function CrawlForm({
  url,
  onUrlChange,
  options,
  onOptionsChange,
  onSubmit,
  onStop,
  running,
  error,
}: Props) {
  const [showOptions, setShowOptions] = useState(false)

  return (
    <section className="panel overflow-hidden">
      <form
        className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center"
        onSubmit={(event) => {
          event.preventDefault()
          if (!running) onSubmit()
        }}
      >
        <div className="relative flex-1">
          <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500" aria-hidden>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="12" cy="12" r="9" />
              <path d="M3 12h18M12 3c2.5 2.6 3.8 5.7 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3Z" />
            </svg>
          </span>
          <input
            className="field h-12 pl-11 text-base"
            type="text"
            inputMode="url"
            autoComplete="url"
            spellCheck={false}
            placeholder="example.com"
            aria-label="Website address to crawl"
            value={url}
            disabled={running}
            onChange={(event) => onUrlChange(event.target.value)}
          />
        </div>

        {running ? (
          <button type="button" className="btn-secondary h-12 px-6" onClick={onStop}>
            Stop crawl
          </button>
        ) : (
          <button type="submit" className="btn-primary h-12 px-6" disabled={!url.trim()}>
            Build sitemap
          </button>
        )}

        <button
          type="button"
          className="btn-ghost h-12"
          aria-expanded={showOptions}
          onClick={() => setShowOptions((open) => !open)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M4 6h16M4 12h16M4 18h16" />
            <circle cx="9" cy="6" r="2" fill="currentColor" stroke="none" />
            <circle cx="15" cy="12" r="2" fill="currentColor" stroke="none" />
            <circle cx="8" cy="18" r="2" fill="currentColor" stroke="none" />
          </svg>
          Settings
        </button>
      </form>

      {error && (
        <p className="mx-5 mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5 text-sm text-rose-200">
          {error}
        </p>
      )}

      {showOptions && <OptionsPanel options={options} onChange={onOptionsChange} disabled={running} />}
    </section>
  )
}
