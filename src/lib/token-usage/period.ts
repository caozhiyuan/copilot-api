import type { SqliteDatabase } from "~/lib/storage/sqlite"
import type {
  TokenUsageCost,
  TokenUsageDailySummary,
  TokenUsageEventsPage,
  TokenUsagePeriod,
  TokenUsageSummary,
  TokenUsageTotals,
} from "~/lib/types/token-usage"

import { COST_NANOS_PER_UNIT } from "./currency"
import { apiKeyUsageTable } from "./db"

export interface UsageTimeRange {
  endMs: number
  startMs: number
  apiKeyId?: string | null
}

export interface UsageDailyInterval extends UsageTimeRange {
  date: string
}

export function getPeriodRange(period: TokenUsagePeriod, now = new Date()) {
  const nowMs = now.getTime()
  if (period === "lifetime") {
    return {
      endMs: nowMs + 1,
      startMs: nowMs + 1,
    }
  }

  const start = new Date(now)
  start.setHours(0, 0, 0, 0)

  switch (period) {
    case "today": {
      break
    }
    case "this_week": {
      const daysSinceMonday = (start.getDay() + 6) % 7
      start.setDate(start.getDate() - daysSinceMonday)
      break
    }
    case "last_7_days": {
      start.setDate(start.getDate() - 6)
      break
    }
    case "this_month": {
      start.setDate(1)
      break
    }
    case "last_30_days": {
      start.setDate(start.getDate() - 29)
      break
    }
    default: {
      break
    }
  }

  return {
    endMs: nowMs + 1,
    startMs: start.getTime(),
  }
}

export function getPeriodRangeFromDb(
  db: SqliteDatabase,
  period: TokenUsagePeriod,
  now = new Date(),
  apiKeyId?: string | null,
): UsageTimeRange {
  if (period !== "lifetime") {
    return { ...getPeriodRange(period, now), apiKeyId }
  }

  const nowMs = now.getTime()
  const row = db
    .prepare(
      `
    SELECT MIN(created_at_ms) AS start_ms
    FROM ${apiKeyUsageTable(apiKeyId)}
    WHERE created_at_ms <= ?
  `,
    )
    .get(nowMs)
  const earliestEventMs = row?.start_ms
  const hasEarliestEvent =
    typeof earliestEventMs === "number" && Number.isFinite(earliestEventMs)
  const startMs = hasEarliestEvent ? earliestEventMs : nowMs + 1

  return {
    endMs: nowMs + 1,
    startMs,
    apiKeyId,
  }
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

export function createDailyIntervals(
  range: UsageTimeRange,
): Array<UsageDailyInterval> {
  const intervals: Array<UsageDailyInterval> = []
  const cursor = new Date(range.startMs)
  cursor.setHours(0, 0, 0, 0)

  while (cursor.getTime() < range.endMs) {
    const startMs = Math.max(cursor.getTime(), range.startMs)
    const next = new Date(cursor)
    next.setDate(next.getDate() + 1)
    const endMs = Math.min(next.getTime(), range.endMs)
    if (startMs < endMs) {
      intervals.push({
        apiKeyId: range.apiKeyId,
        date: formatLocalDate(cursor),
        endMs,
        startMs,
      })
    }
    cursor.setTime(next.getTime())
  }

  return intervals
}

export function createCost(
  currency: string,
  totalCostNanos: number,
): TokenUsageCost {
  return {
    amount: totalCostNanos / COST_NANOS_PER_UNIT,
    currency,
    total_cost_nanos: totalCostNanos,
  }
}

export function createEmptyTotals(): TokenUsageTotals {
  return {
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    costs: [],
    input_tokens: 0,
    output_tokens: 0,
    request_count: 0,
    total_nano_aiu: null,
    total_tokens: 0,
  }
}

function addNullableNumbers(
  current: number | null,
  next: number | null,
): number | null {
  if (current === null) return next
  if (next === null) return current
  return current + next
}

function mergeCosts(
  current: Array<TokenUsageCost>,
  next: Array<TokenUsageCost>,
): Array<TokenUsageCost> {
  const byCurrency = new Map<string, number>()
  for (const cost of [...current, ...next]) {
    byCurrency.set(
      cost.currency,
      (byCurrency.get(cost.currency) ?? 0) + cost.total_cost_nanos,
    )
  }

  return [...byCurrency.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, totalCostNanos]) => createCost(currency, totalCostNanos))
}

export function addTotals(
  target: TokenUsageTotals,
  next: TokenUsageTotals,
): void {
  target.cache_creation_input_tokens += next.cache_creation_input_tokens
  target.cache_read_input_tokens += next.cache_read_input_tokens
  target.costs = mergeCosts(target.costs, next.costs)
  target.input_tokens += next.input_tokens
  target.output_tokens += next.output_tokens
  target.request_count += next.request_count
  target.total_nano_aiu = addNullableNumbers(
    target.total_nano_aiu,
    next.total_nano_aiu,
  )
  target.total_tokens += next.total_tokens
}

export function rangePayload(range: UsageTimeRange) {
  return {
    end_ms: range.endMs,
    end_utc: new Date(range.endMs).toISOString(),
    start_ms: range.startMs,
    start_utc: new Date(range.startMs).toISOString(),
  }
}

export function createEmptySummary(
  period: TokenUsagePeriod,
): TokenUsageSummary {
  const range = getPeriodRange(period)

  return {
    byModel: [],
    period,
    range: rangePayload(range),
    totals: createEmptyTotals(),
  }
}

export function createEmptyDailySummary(
  period: TokenUsagePeriod,
): TokenUsageDailySummary {
  const range = getPeriodRange(period)

  return {
    byModel: [],
    days: createDailyIntervals(range).map((interval) => ({
      byModel: [],
      date: interval.date,
      end_ms: interval.endMs,
      start_ms: interval.startMs,
      totals: createEmptyTotals(),
    })),
    period,
    range: rangePayload(range),
    totals: createEmptyTotals(),
  }
}

export function createEmptyEventsPage(input: {
  page: number
  pageSize: number
  period: TokenUsagePeriod
}): TokenUsageEventsPage {
  const range = getPeriodRange(input.period)
  const page = Math.max(1, Math.floor(input.page))
  const pageSize = Math.min(100, Math.max(1, Math.floor(input.pageSize)))

  return {
    items: [],
    page,
    page_size: pageSize,
    period: input.period,
    range: rangePayload(range),
    total: 0,
    total_pages: 1,
  }
}
