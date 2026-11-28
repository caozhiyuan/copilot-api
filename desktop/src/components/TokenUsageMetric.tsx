export type TokenUsageMetricValue = string | readonly string[]

function getTokenUsageValueLines(
  value: TokenUsageMetricValue,
): readonly string[] {
  return typeof value === 'string' ? [value] : value
}

export function TokenUsageValueLines({
  value,
}: {
  value: TokenUsageMetricValue
}) {
  const lines = getTokenUsageValueLines(value)

  return (
    <>
      {lines.map((line, index) => (
        <span key={`${line}-${index}`} className="block whitespace-nowrap">
          {line}
        </span>
      ))}
    </>
  )
}

export function TokenUsageMetric({
  label,
  loading,
  tone,
  value,
}: {
  label: string
  loading: boolean
  tone: 'amber' | 'blue' | 'cyan' | 'green' | 'slate' | 'violet'
  value: TokenUsageMetricValue
}) {
  const toneClasses = {
    amber:
      'bg-amber-50/75 border-amber-200/80 text-amber-700 dark:bg-amber-500/10 dark:border-amber-500/25 dark:text-amber-300',
    blue: 'bg-blue-50/75 border-blue-200/80 text-blue-700 dark:bg-blue-500/10 dark:border-blue-500/25 dark:text-blue-300',
    cyan: 'bg-cyan-50/75 border-cyan-200/80 text-cyan-700 dark:bg-cyan-500/10 dark:border-cyan-500/25 dark:text-cyan-300',
    green:
      'bg-green-50/75 border-green-200/80 text-green-700 dark:bg-green-500/10 dark:border-green-500/25 dark:text-green-300',
    slate: 'bg-sunken border-line text-ink',
    violet:
      'bg-violet-50/75 border-violet-200/80 text-violet-700 dark:bg-violet-500/10 dark:border-violet-500/25 dark:text-violet-300',
  }[tone]
  const title = getTokenUsageValueLines(value).join('\n')

  return (
    <div className={`min-w-0 rounded-lg border px-2.5 py-2 ${toneClasses}`}>
      <div
        className={`text-[15px] font-bold leading-4 tracking-tight tabular-nums ${
          loading ? 'animate-pulse opacity-40' : ''
        }`}
        title={title}
      >
        {loading ? '…' : <TokenUsageValueLines value={value} />}
      </div>
      <div className="mt-1 whitespace-nowrap text-[11px] font-medium leading-4 opacity-75">
        {label}
      </div>
    </div>
  )
}

export function TokenUsageCostMetric({
  label,
  loading,
  value,
}: {
  label: string
  loading: boolean
  value: TokenUsageMetricValue
}) {
  return (
    <TokenUsageMetric
      label={label}
      loading={loading}
      tone="amber"
      value={value}
    />
  )
}
