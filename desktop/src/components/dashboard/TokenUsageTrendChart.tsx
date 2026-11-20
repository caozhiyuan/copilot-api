import { useState } from 'react'

import type {
  TokenUsageDailySummary,
  TokenUsageModelSummary,
  TokenUsagePeriod,
} from '../../types/ipc'

import {
  ALL_METRICS_VALUE,
  ALL_MODELS_VALUE,
  EMPTY_TOKEN_USAGE_TOTALS,
  formatChartDate,
  formatTokenCount,
  getTrendTotals,
  sampleTrendDays,
  type DashboardTranslateFn,
} from './dashboard-format'

type TokenUsageTrendMetricKey =
  | 'cache_creation_input_tokens'
  | 'cache_read_input_tokens'
  | 'input_tokens'
  | 'output_tokens'
  | 'total_tokens'

export function TokenUsageTrendChart({
  dailyUsage,
  loading,
  models,
  onModelChange,
  period,
  selectedModel,
  t,
}: {
  dailyUsage: TokenUsageDailySummary | null
  loading: boolean
  models: TokenUsageModelSummary[]
  onModelChange: (model: string) => void
  period: TokenUsagePeriod
  selectedModel: string
  t: DashboardTranslateFn
}) {
  const [activeDayIndex, setActiveDayIndex] = useState<number | null>(null)
  const [selectedMetric, setSelectedMetric] =
    useState<string>(ALL_METRICS_VALUE)
  const metrics: Array<{
    color: string
    key: TokenUsageTrendMetricKey
    label: string
  }> = [
    {
      color: 'var(--color-accent)',
      key: 'total_tokens',
      label: t('dashboard.tokenUsageTotal'),
    },
    {
      color: '#2563eb',
      key: 'input_tokens',
      label: t('dashboard.tokenUsageInput'),
    },
    {
      color: '#16a34a',
      key: 'output_tokens',
      label: t('dashboard.tokenUsageOutput'),
    },
    {
      color: '#0891b2',
      key: 'cache_read_input_tokens',
      label: t('dashboard.tokenUsageCacheRead'),
    },
    {
      color: '#d97706',
      key: 'cache_creation_input_tokens',
      label: t('dashboard.tokenUsageCacheWrite'),
    },
  ]
  const visibleMetrics =
    selectedMetric === ALL_METRICS_VALUE ? metrics : (
      metrics.filter((metric) => metric.key === selectedMetric)
    )
  const days = sampleTrendDays(dailyUsage?.days ?? [], selectedModel, period)
  const hasUsage = days.some(
    (day) => getTrendTotals(day, selectedModel).request_count > 0,
  )
  const latestUsageIndex = days.reduce((latest, day, index) => {
    return getTrendTotals(day, selectedModel).request_count > 0 ? index : latest
  }, -1)
  const selectedDayIndex =
    (
      activeDayIndex !== null
      && activeDayIndex >= 0
      && activeDayIndex < days.length
    ) ?
      activeDayIndex
    : latestUsageIndex >= 0 ? latestUsageIndex
    : Math.max(0, days.length - 1)
  const selectedDay = days[selectedDayIndex]
  const selectedDayTotals =
    selectedDay ?
      getTrendTotals(selectedDay, selectedModel)
    : EMPTY_TOKEN_USAGE_TOTALS
  const width = 720
  const height = 220
  const padding = { bottom: 34, left: 54, right: 16, top: 16 }
  const plotWidth = width - padding.left - padding.right
  const plotHeight = height - padding.top - padding.bottom
  const maxValue = Math.max(
    1,
    ...days.flatMap((day) => {
      const totals = getTrendTotals(day, selectedModel)
      return visibleMetrics.map((metric) => totals[metric.key])
    }),
  )
  const xForIndex = (index: number): number => {
    if (days.length <= 1) return padding.left + plotWidth / 2
    return padding.left + (plotWidth * index) / (days.length - 1)
  }
  const hitWidth = days.length <= 1 ? plotWidth : plotWidth / (days.length - 1)
  const yForValue = (value: number): number =>
    padding.top + plotHeight - (Math.max(0, value) / maxValue) * plotHeight
  const labelEvery = Math.max(1, Math.ceil(days.length / 6))
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) =>
    Math.round(maxValue * ratio),
  )

  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-line-soft">
      <div className="flex flex-col gap-1.5 bg-sunken px-2.5 py-1.5 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-[13px] font-semibold text-ink-soft">
          {t('dashboard.tokenUsageTrend')}
        </span>
        <select
          value={selectedModel}
          onChange={(event) => onModelChange(event.target.value)}
          className="h-7 rounded-md border border-line bg-surface px-2 text-[13px] text-ink-soft focus:outline-none focus:ring-2 focus:ring-accent/30"
        >
          <option value={ALL_MODELS_VALUE}>
            {t('dashboard.tokenUsageAllModels')}
          </option>
          {models.map((model) => (
            <option key={model.model} value={model.model}>
              {model.model}
            </option>
          ))}
        </select>
      </div>
      <div className="min-h-64 px-2.5 py-2">
        {loading && !dailyUsage ?
          <div className="flex h-56 items-start text-[13px] text-ink-faint animate-pulse">
            {t('dashboard.loading')}
          </div>
        : !dailyUsage || days.length === 0 || !hasUsage ?
          <div className="text-[13px] text-ink-faint">
            {t('dashboard.noTokenUsage')}
          </div>
        : <div className={`${loading ? 'opacity-60' : ''}`}>
            <svg
              className="h-56 w-full"
              viewBox={`0 0 ${width} ${height}`}
              role="img"
            >
              {yTicks.map((tick, index) => {
                const y = yForValue(tick)
                return (
                  <g key={`${tick}-${index}`}>
                    <line
                      x1={padding.left}
                      x2={width - padding.right}
                      y1={y}
                      y2={y}
                      stroke="var(--color-line)"
                      strokeWidth="1"
                    />
                    <text
                      x={padding.left - 8}
                      y={y + 4}
                      textAnchor="end"
                      fontSize="11"
                      fill="var(--color-ink-faint)"
                    >
                      {formatTokenCount(tick)}
                    </text>
                  </g>
                )
              })}
              {days.map((day, index) => {
                if (index % labelEvery !== 0 && index !== days.length - 1)
                  return null
                const x = xForIndex(index)
                return (
                  <text
                    key={day.date}
                    x={x}
                    y={height - 10}
                    textAnchor="middle"
                    fontSize="11"
                    fill="var(--color-ink-faint)"
                  >
                    {formatChartDate(day.date)}
                  </text>
                )
              })}
              {selectedDay && (
                <line
                  x1={xForIndex(selectedDayIndex)}
                  x2={xForIndex(selectedDayIndex)}
                  y1={padding.top}
                  y2={padding.top + plotHeight}
                  stroke="var(--color-line)"
                  strokeDasharray="4 4"
                  strokeWidth="1"
                />
              )}
              {days.map((day, index) => {
                const x = xForIndex(index)
                const hitStart = Math.max(padding.left, x - hitWidth / 2)
                const hitEnd = Math.min(width - padding.right, x + hitWidth / 2)
                return (
                  <rect
                    key={`${day.date}-hit`}
                    className="cursor-pointer"
                    fill="transparent"
                    height={plotHeight}
                    onClick={() => setActiveDayIndex(index)}
                    onFocus={() => setActiveDayIndex(index)}
                    onMouseEnter={() => setActiveDayIndex(index)}
                    tabIndex={0}
                    width={hitEnd - hitStart}
                    x={hitStart}
                    y={padding.top}
                  />
                )
              })}
              {visibleMetrics.map((metric) => {
                const points = days
                  .map((day, index) => {
                    const totals = getTrendTotals(day, selectedModel)
                    return `${xForIndex(index)},${yForValue(totals[metric.key])}`
                  })
                  .join(' ')
                return (
                  <g key={metric.key}>
                    <polyline
                      fill="none"
                      points={points}
                      stroke={metric.color}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2.25"
                    >
                      <title>{metric.label}</title>
                    </polyline>
                    {days.map((day, index) => {
                      const totals = getTrendTotals(day, selectedModel)
                      return (
                        <circle
                          key={`${day.date}-${metric.key}`}
                          cx={xForIndex(index)}
                          cy={yForValue(totals[metric.key])}
                          fill={metric.color}
                          onClick={() => setActiveDayIndex(index)}
                          onFocus={() => setActiveDayIndex(index)}
                          onMouseEnter={() => setActiveDayIndex(index)}
                          r="2.5"
                          tabIndex={0}
                        />
                      )
                    })}
                  </g>
                )
              })}
            </svg>
            <div className="mt-1 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setSelectedMetric(ALL_METRICS_VALUE)}
                className={`inline-flex items-center rounded-md border px-2 py-1 text-[13px] ${
                  selectedMetric === ALL_METRICS_VALUE ?
                    'border-line bg-sunken font-semibold text-ink'
                  : 'border-line bg-surface text-ink-soft'
                }`}
              >
                All
              </button>
              {metrics.map((metric) => (
                <button
                  key={metric.key}
                  type="button"
                  onClick={() => setSelectedMetric(metric.key)}
                  className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[13px] ${
                    selectedMetric === metric.key ?
                      'border-line bg-sunken font-semibold text-ink'
                    : 'border-line bg-surface text-ink-soft'
                  }`}
                >
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: metric.color }}
                  />
                  {metric.label}
                </button>
              ))}
            </div>
            {selectedDay && (
              <div className="mt-2 flex flex-wrap gap-2 rounded-md bg-sunken px-2.5 py-2 text-[13px] text-ink-soft">
                <span className="font-semibold text-ink">
                  {formatChartDate(selectedDay.date)}
                </span>
                {visibleMetrics.map((metric) => (
                  <span key={metric.key}>
                    {metric.label}:{' '}
                    {formatTokenCount(selectedDayTotals[metric.key])}
                  </span>
                ))}
              </div>
            )}
          </div>
        }
      </div>
    </div>
  )
}
