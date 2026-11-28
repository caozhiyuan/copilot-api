import type { HTMLAttributes } from 'react'

export function LoadingSpinner({
  className = '',
  size = 14,
}: {
  className?: string
  size?: number
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={`shrink-0 animate-spin ${className}`}
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        strokeWidth="2.2"
        className="opacity-20"
      />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function InlineLoading({
  className = '',
  label,
}: {
  className?: string
  label: string
}) {
  return (
    <span
      role="status"
      aria-live="polite"
      className={`inline-flex items-center gap-1.5 text-[13px] text-ink-faint ${className}`}
    >
      <LoadingSpinner size={13} />
      <span>{label}</span>
    </span>
  )
}

const TABLE_ROW_WIDTHS = [
  ['w-28', 'w-16', 'w-20', 'w-14'],
  ['w-36', 'w-14', 'w-16', 'w-12'],
  ['w-24', 'w-20', 'w-14', 'w-16'],
  ['w-32', 'w-16', 'w-24', 'w-12'],
  ['w-28', 'w-12', 'w-20', 'w-16'],
] as const

export function TableSkeleton({
  heightClass = 'h-[194px]',
  label,
  rows = 4,
}: {
  heightClass?: string
  label: string
  rows?: number
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label}
      className={`${heightClass} overflow-hidden px-2.5 py-2`}
    >
      <span className="sr-only">{label}</span>
      <div className="flex items-center justify-between gap-4 border-b border-line-soft pb-2.5">
        <div className="skeleton-shimmer h-3 w-24 rounded-full" />
        <div className="flex items-center gap-4">
          <div className="skeleton-shimmer h-3 w-14 rounded-full" />
          <div className="skeleton-shimmer h-3 w-16 rounded-full" />
          <div className="skeleton-shimmer h-3 w-12 rounded-full" />
        </div>
      </div>
      <div className="divide-y divide-line-soft">
        {Array.from({ length: rows }, (_, index) => {
          const widths = TABLE_ROW_WIDTHS[index % TABLE_ROW_WIDTHS.length]
          return (
            <div
              key={index}
              className="flex items-center justify-between gap-4 py-3"
            >
              <div
                className={`skeleton-shimmer h-3.5 rounded-full ${widths[0]}`}
              />
              <div className="flex items-center gap-4">
                <div
                  className={`skeleton-shimmer h-3 rounded-full ${widths[1]}`}
                />
                <div
                  className={`skeleton-shimmer h-3 rounded-full ${widths[2]}`}
                />
                <div
                  className={`skeleton-shimmer h-3 rounded-full ${widths[3]}`}
                />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const CHART_BAR_HEIGHTS = [
  'h-12',
  'h-24',
  'h-16',
  'h-32',
  'h-20',
  'h-36',
  'h-28',
  'h-16',
  'h-24',
  'h-32',
  'h-14',
  'h-20',
] as const

export function ChartSkeleton({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label}
      className="flex h-56 flex-col justify-end gap-3 pt-4"
    >
      <span className="sr-only">{label}</span>
      <div className="flex flex-1 items-end gap-2 border-b border-line-soft px-2 pb-2">
        {CHART_BAR_HEIGHTS.map((heightClass, index) => (
          <div
            key={index}
            className={`skeleton-shimmer flex-1 rounded-t-md ${heightClass}`}
          />
        ))}
      </div>
      <div className="flex justify-between px-2">
        <div className="skeleton-shimmer h-2.5 w-10 rounded-full" />
        <div className="skeleton-shimmer h-2.5 w-10 rounded-full" />
        <div className="skeleton-shimmer h-2.5 w-10 rounded-full" />
        <div className="skeleton-shimmer h-2.5 w-10 rounded-full" />
      </div>
    </div>
  )
}

export function PageLoadingSkeleton({
  cards = 3,
  className = '',
  compact = false,
  delayed = false,
  label,
  ...rest
}: {
  cards?: number
  className?: string
  compact?: boolean
  delayed?: boolean
  label: string
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      role="status"
      aria-live="polite"
      aria-label={label}
      className={`${compact ? 'py-2' : 'p-6'} ${delayed ? 'loading-delayed-fade' : ''} ${className}`}
    >
      <span className="sr-only">{label}</span>
      {!compact && (
        <div className="mb-5 space-y-2">
          <div className="skeleton-shimmer h-5 w-40 rounded-lg" />
          <div className="skeleton-shimmer h-3.5 w-64 rounded-full" />
        </div>
      )}
      <div
        className={`grid gap-4 ${
          cards >= 4 ? 'sm:grid-cols-2 lg:grid-cols-4'
          : cards === 2 ? 'md:grid-cols-[220px_minmax(0,1fr)]'
          : 'md:grid-cols-3'
        }`}
      >
        {Array.from({ length: cards }, (_, index) => (
          <div
            key={index}
            className="rounded-2xl border border-line bg-surface p-5"
          >
            <div className="skeleton-shimmer h-4 w-28 rounded-full" />
            <div className="skeleton-shimmer mt-4 h-7 w-24 rounded-lg" />
            <div className="mt-5 space-y-2.5">
              <div className="skeleton-shimmer h-3 w-full rounded-full" />
              <div className="skeleton-shimmer h-3 w-4/5 rounded-full" />
              <div className="skeleton-shimmer h-3 w-3/5 rounded-full" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
