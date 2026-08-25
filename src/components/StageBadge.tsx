import type { DealStage, Stage } from '../types'
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


/**
 * The survey's own pipeline as the one and only stage picker.
 *
 * The panel used to offer a built-in five-stage list while the sidebar showed
 * the survey's custom groups — so a site could read "Touring" in blue up top
 * and sit in a green "Qualified/Touring" bucket below. One pipeline, one
 * dropdown, one colour.
 */
export function PipelineSelect({
  stages,
  stageId,
  onChange,
  disabled,
}: {
  stages: DealStage[]
  stageId: string | null
  onChange: (stageId: string | null) => void
  disabled?: boolean
}) {
  const active = stages.find((stage) => stage.id === stageId) ?? null
  return (
    <div className="relative">
      <span
        className="pointer-events-none absolute left-2.5 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full"
        style={{ background: active?.color ?? '#94a3b8' }}
        aria-hidden
      />
      <select
        className="field appearance-none py-1.5 pl-6 pr-8 text-xs font-semibold"
        aria-label="Pipeline stage"
        value={stageId ?? ''}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">Unstaged</option>
        {stages.map((stage) => (
          <option key={stage.id} value={stage.id}>
            {stage.name}
          </option>
        ))}
      </select>
    </div>
  )
}
