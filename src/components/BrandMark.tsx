/**
 * The Land Quotient mark: the pin built out of the letterforms, navy above the
 * curve and teal below it, with the wordmark set in the same two colours.
 *
 * One component rather than an image pasted into every entry screen, so the
 * brand is changed in a single place.
 */

const NAVY = '#143366'
const TEAL = '#01A3A8'

/** The pin on its own — for favicons, avatars, and anywhere the name is already present. */
export function BrandPin({ size = 36, className = '' }: { size?: number; className?: string }) {
  // The real mark, not a redraw of it. It is taller than it is wide, so `size`
  // sets the height and the width follows; a square box would letterbox it.
  return (
    <img
      src="/brand/lq-mark.png"
      alt="Land Quotient"
      height={size}
      className={className}
      style={{ height: size, width: 'auto', display: 'block' }}
    />
  )
}

/**
 * Pin plus name, as the entry screens wear it.
 *
 * `tone` picks the wordmark treatment: the two-colour lockup on light
 * surfaces, plain white where it sits on the brand colour itself.
 */
export default function BrandMark({
  size = 36,
  tone = 'brand',
  tagline = false,
  className = '',
}: {
  size?: number
  tone?: 'brand' | 'inverse'
  /** Adds "Real Estate Intelligence" under the name, for entry screens. */
  tagline?: boolean
  className?: string
}) {
  return (
    <span className={`flex items-center gap-2.5 ${className}`}>
      <BrandPin size={size} />
      <span className="leading-tight">
        <span className="block text-[15px] font-bold tracking-tight">
          {tone === 'inverse' ? (
            <span className="text-white">Land Quotient</span>
          ) : (
            <>
              <span style={{ color: NAVY }}>Land</span>
              <span style={{ color: TEAL }}> Quotient</span>
            </>
          )}
        </span>
        {tagline ? (
          <span className={`block text-[11px] ${tone === 'inverse' ? 'text-white/70' : 'text-muted'}`}>
            Real Estate Intelligence
          </span>
        ) : null}
      </span>
    </span>
  )
}
