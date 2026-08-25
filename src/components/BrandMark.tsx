/**
 * The Land Quotient mark: a map pin split the way the logo is, navy above the
 * curve and teal below it, with the wordmark set in the same two colours.
 *
 * One component rather than an SVG pasted into every entry screen, so the
 * brand is changed in a single place.
 */

const NAVY = '#1B3668'
const TEAL = '#12AEB6'

/** The pin on its own — for favicons, avatars, and anywhere the name is already present. */
export function BrandPin({ size = 36, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      role="img"
      aria-label="Land Quotient"
    >
      <defs>
        <clipPath id="lq-pin-clip">
          <path d="M16 31 3.6 16.4A12.6 12.6 0 1 1 28.4 16.4Z" />
        </clipPath>
      </defs>
      <g clipPath="url(#lq-pin-clip)">
        <rect width="32" height="32" fill={NAVY} />
        <path d="M2 15.2Q16 21.6 30 15.2L30 32 2 32Z" fill={TEAL} />
      </g>
    </svg>
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
  className = '',
}: {
  size?: number
  tone?: 'brand' | 'inverse'
  className?: string
}) {
  return (
    <span className={`flex items-center gap-2.5 ${className}`}>
      <BrandPin size={size} />
      <span className="text-[15px] font-bold tracking-tight">
        {tone === 'inverse' ? (
          <span className="text-white">Land Quotient</span>
        ) : (
          <>
            <span style={{ color: NAVY }}>Land</span>
            <span style={{ color: TEAL }}> Quotient</span>
          </>
        )}
      </span>
    </span>
  )
}
