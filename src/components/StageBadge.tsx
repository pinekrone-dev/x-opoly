import type { Stage } from '../types'
import { STAGE_META, STAGE_ORDER } from '../lib/format'

export function StageBadge({ stage }: { stage: Stage }) {
  const meta = STAGE_META[stage] ?? STAGE_META.prospect
  return (
    <span className={`pill ${meta.ring}`}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: meta.color }} aria-hidden />
      {meta.label}
    </span>
  )
}

export function StageSelect({
  stage,
  onChange,
  disabled,
}: {
  stage: Stage
  onChange: (stage: Stage) => void
  disabled?: boolean
}) {
  return (
    <div className="relative">
      <span
        className="pointer-events-none absolute left-2.5 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full"
        style={{ background: STAGE_META[stage]?.color }}
        aria-hidden
      />
      <select
        className="field appearance-none py-1.5 pl-6 pr-8 text-xs font-semibold"
        aria-label="Deal stage"
        value={stage}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as Stage)}
      >
        {STAGE_ORDER.map((value) => (
          <option key={value} value={value}>
            {STAGE_META[value].label}
          </option>
        ))}
      </select>
    </div>
  )
}
