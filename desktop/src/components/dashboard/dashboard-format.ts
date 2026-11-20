import type { useLanguage } from '../../contexts/LanguageContext'
import type {
  TokenUsageDailySummary,
  TokenUsagePeriod,
  TokenUsageTotals,
} from '../../types/ipc'

export type DashboardTranslateFn = ReturnType<typeof useLanguage>['t']

export interface DashboardModel {
  id: string
  [key: string]: unknown
}

const numberFormatter = new Intl.NumberFormat()

export const ALL_METRICS_VALUE = '__all__'
export const ALL_MODELS_VALUE = '__all__'
export const MAX_LIFETIME_TREND_POINTS = 180

export const TOKEN_USAGE_PERIODS: TokenUsagePeriod[] = [
  'today',
  'this_week',
  'last_7_days',
  'this_month',
  'last_30_days',
  'lifetime',
]

export const EMPTY_TOKEN_USAGE_TOTALS: TokenUsageTotals = {
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  costs: [],
  input_tokens: 0,
  output_tokens: 0,
  request_count: 0,
  total_tokens: 0,
}

export function maskSecret(value: string): string {
  if (value.length <= 8) return '*'.repeat(Math.max(value.length, 4))
  return `${value.slice(0, 4)}********${value.slice(-4)}`
}

export function formatTokenCount(value: number): string {
  return numberFormatter.format(Math.max(0, Math.floor(value)))
}

function padDatePart(value: number): string {
  return String(value).padStart(2, '0')
}

export function calcTokenTotal(tokens: TokenUsageTotals): number {
  return tokens.total_tokens
}

export function formatEventTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—'
  const date = new Date(value)
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}:${padDatePart(date.getSeconds())}`
}

export function formatRefreshTime(value: number | null): string {
  if (!value || !Number.isFinite(value)) return '—'
  const date = new Date(value)
  return `${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}:${padDatePart(date.getSeconds())}`
}

export function getTokenUsagePeriodLabel(
  t: DashboardTranslateFn,
  period: TokenUsagePeriod,
): string {
  return {
    today: t('dashboard.tokenUsagePeriodToday'),
    this_week: t('dashboard.tokenUsagePeriodThisWeek'),
    last_7_days: t('dashboard.tokenUsagePeriodLast7Days'),
    this_month: t('dashboard.tokenUsagePeriodThisMonth'),
    last_30_days: t('dashboard.tokenUsagePeriodLast30Days'),
    lifetime: t('dashboard.tokenUsagePeriodLifetime'),
  }[period]
}

export function formatCellText(value: string | null | undefined): string {
  const text = value?.trim()
  return text ? text : '—'
}

export function getTrendTotals(
  day: TokenUsageDailySummary['days'][number],
  selectedModel: string,
): TokenUsageTotals {
  if (selectedModel === ALL_MODELS_VALUE) return day.totals
  return (
    day.byModel.find((model) => model.model === selectedModel)
    ?? EMPTY_TOKEN_USAGE_TOTALS
  )
}

export function sampleTrendDays(
  days: TokenUsageDailySummary['days'],
  selectedModel: string,
  period: TokenUsagePeriod,
): TokenUsageDailySummary['days'] {
  if (period !== 'lifetime' || days.length <= MAX_LIFETIME_TREND_POINTS) {
    return days
  }

  const usageIndexes = days.reduce<Array<number>>((indexes, day, index) => {
    if (getTrendTotals(day, selectedModel).request_count > 0) {
      indexes.push(index)
    }
    return indexes
  }, [])
  if (usageIndexes.length >= MAX_LIFETIME_TREND_POINTS) {
    const step = (usageIndexes.length - 1) / (MAX_LIFETIME_TREND_POINTS - 1)
    return Array.from(
      { length: MAX_LIFETIME_TREND_POINTS },
      (_, index) => days[usageIndexes[Math.round(index * step)]],
    )
  }

  const indexes = new Set(usageIndexes)
  const sampleCount = Math.max(
    1,
    MAX_LIFETIME_TREND_POINTS - usageIndexes.length,
  )
  const step = (days.length - 1) / (sampleCount - 1 || 1)
  for (let index = 0; index < sampleCount; index += 1) {
    indexes.add(Math.round(index * step))
  }
  return [...indexes]
    .sort((left, right) => left - right)
    .slice(0, MAX_LIFETIME_TREND_POINTS)
    .map((index) => days[index])
}

export function formatChartDate(value: string): string {
  const [, month, day] = value.split('-')
  return month && day ? `${month}/${day}` : value
}
