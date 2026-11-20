import type { SqliteDatabase, SqliteRow } from "~/lib/storage/sqlite"
import type {
  RequestTiming,
  TokenUsageCost,
  TokenUsageDailyBucket,
  TokenUsageDailySummary,
  TokenUsageEndpoint,
  TokenUsageEventCost,
  TokenUsageEventRecord,
  TokenUsageEventsPage,
  TokenUsageModelSummary,
  TokenUsagePageInput,
  TokenUsagePeriod,
  TokenUsageSessionSummary,
  TokenUsageSessionsPage,
  TokenUsageSource,
  TokenUsageSummary,
  TokenUsageTotals,
} from "~/lib/types/token-usage"

import { apiKeyUsageTable, getUsageDb } from "./db"
import {
  addTotals,
  createCost,
  createDailyIntervals,
  createEmptyTotals,
  getPeriodRangeFromDb,
  rangePayload,
  type UsageDailyInterval,
  type UsageTimeRange,
} from "./period"

function numberFromRow(row: SqliteRow | null | undefined, key: string): number {
  const value = row?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function nullableNumberFromRow(
  row: SqliteRow | null | undefined,
  key: string,
): number | null {
  const value = row?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function stringFromRow(row: SqliteRow, key: string): string {
  const value = row[key]
  return typeof value === "string" ? value : ""
}

function nullableStringFromRow(row: SqliteRow, key: string): string | null {
  const value = row[key]
  return typeof value === "string" ? value : null
}

function costFromRow(row: SqliteRow): TokenUsageCost | null {
  const currency = row.cost_currency
  const totalCostNanos = row.total_cost_nanos
  if (
    typeof currency !== "string"
    || !currency
    || typeof totalCostNanos !== "number"
    || !Number.isFinite(totalCostNanos)
  ) {
    return null
  }

  return createCost(currency, totalCostNanos)
}

function eventCostFromRow(row: SqliteRow): TokenUsageEventCost | null {
  const cost = costFromRow(row)
  const source = row.cost_source
  if (!cost || typeof source !== "string" || !source) {
    return null
  }

  return {
    ...cost,
    source,
  }
}

function totalsFromRow(
  row: SqliteRow | null | undefined,
  costs: Array<TokenUsageCost> = [],
): TokenUsageTotals {
  return {
    cache_creation_input_tokens: numberFromRow(
      row,
      "cache_creation_input_tokens",
    ),
    cache_read_input_tokens: numberFromRow(row, "cache_read_input_tokens"),
    costs,
    input_tokens: numberFromRow(row, "input_tokens"),
    output_tokens: numberFromRow(row, "output_tokens"),
    request_count: numberFromRow(row, "request_count"),
    total_nano_aiu: nullableNumberFromRow(row, "total_nano_aiu"),
    total_tokens: numberFromRow(row, "total_tokens"),
  }
}

function modelSummaryFromRow(
  row: SqliteRow,
  costs: Array<TokenUsageCost> = [],
): TokenUsageModelSummary {
  return {
    ...totalsFromRow(row, costs),
    average_first_token_ms: nullableNumberFromRow(
      row,
      "average_first_token_ms",
    ),
    output_tokens_per_second: nullableNumberFromRow(
      row,
      "output_tokens_per_second",
    ),
    model: typeof row.model === "string" ? row.model : "unknown",
  }
}

function outputTokensPerSecond(row: SqliteRow): number | null {
  const first = nullableNumberFromRow(row, "first_token_ms")
  const duration = nullableNumberFromRow(row, "duration_ms")
  const output = numberFromRow(row, "output_tokens")
  // A row cannot attribute shared request time to just one of multiple calls.
  if (
    row.request_outcome !== "completed"
    || row.usage_event_count !== 1
    || first === null
    || first < 0
    || duration === null
    || duration <= first
    || output <= 0
  )
    return null
  const rate = (output * 1000) / (duration - first)
  return Number.isFinite(rate) ? rate : null
}

function usageEventFromRow(row: SqliteRow): TokenUsageEventRecord {
  return {
    request_id: nullableStringFromRow(row, "request_id"),
    first_token_ms: nullableNumberFromRow(row, "first_token_ms"),
    duration_ms: nullableNumberFromRow(row, "duration_ms"),
    request_outcome: nullableStringFromRow(
      row,
      "request_outcome",
    ) as RequestTiming["outcome"],
    output_tokens_per_second: outputTokensPerSecond(row),
    cache_creation_input_tokens: numberFromRow(
      row,
      "cache_creation_input_tokens",
    ),
    cache_read_input_tokens: numberFromRow(row, "cache_read_input_tokens"),
    cost: eventCostFromRow(row),
    created_at_ms: numberFromRow(row, "created_at_ms"),
    created_at_utc: stringFromRow(row, "created_at_utc"),
    endpoint: stringFromRow(row, "endpoint") as TokenUsageEndpoint,
    id: numberFromRow(row, "id"),
    input_tokens: numberFromRow(row, "input_tokens"),
    model: stringFromRow(row, "model") || "unknown",
    output_tokens: numberFromRow(row, "output_tokens"),
    provider_name: nullableStringFromRow(row, "provider_name"),
    session_id: stringFromRow(row, "session_id"),
    source: stringFromRow(row, "source") as TokenUsageSource,
    total_nano_aiu: nullableNumberFromRow(row, "total_nano_aiu"),
    total_tokens: numberFromRow(row, "total_tokens"),
    trace_id: stringFromRow(row, "trace_id"),
    user_id: stringFromRow(row, "user_id"),
    api_key_id: stringFromRow(row, "api_key_id") || null,
    api_key_name: stringFromRow(row, "api_key_name") || null,
    user_agent: stringFromRow(row, "user_agent"),
  }
}

function getTotalsRow(
  db: SqliteDatabase,
  range: UsageTimeRange,
): SqliteRow | null | undefined {
  return db
    .prepare(
      `
    SELECT
      COUNT(*) AS request_count,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
      COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
      SUM(total_nano_aiu) AS total_nano_aiu,
      COALESCE(SUM(total_tokens), 0) AS total_tokens
    FROM ${apiKeyUsageTable(range.apiKeyId)}
    WHERE created_at_ms >= ? AND created_at_ms < ?
  `,
    )
    .get(range.startMs, range.endMs)
}

function getModelRows(
  db: SqliteDatabase,
  range: UsageTimeRange,
): Array<SqliteRow> {
  return db
    .prepare(
      `
    SELECT
      model,
      COUNT(*) AS request_count,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
      COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
      SUM(total_nano_aiu) AS total_nano_aiu,
      COALESCE(SUM(total_tokens), 0) AS total_tokens
    FROM ${apiKeyUsageTable(range.apiKeyId)}
    WHERE created_at_ms >= ? AND created_at_ms < ?
    GROUP BY model
    ORDER BY
      total_tokens DESC,
      model ASC
  `,
    )
    .all(range.startMs, range.endMs)
}

function getCostRows(
  db: SqliteDatabase,
  range: UsageTimeRange,
): Array<TokenUsageCost> {
  const rows = db
    .prepare(
      `
    SELECT
      cost_currency,
      COALESCE(SUM(total_cost_nanos), 0) AS total_cost_nanos
    FROM ${apiKeyUsageTable(range.apiKeyId)}
    WHERE
      created_at_ms >= ?
      AND created_at_ms < ?
      AND cost_currency IS NOT NULL
      AND total_cost_nanos IS NOT NULL
    GROUP BY cost_currency
    ORDER BY cost_currency ASC
  `,
    )
    .all(range.startMs, range.endMs)

  return rows.flatMap((row) => {
    const cost = costFromRow(row)
    return cost ? [cost] : []
  })
}

function getModelCostMap(
  db: SqliteDatabase,
  range: UsageTimeRange,
): Map<string, Array<TokenUsageCost>> {
  const rows = db
    .prepare(
      `
    SELECT
      model,
      cost_currency,
      COALESCE(SUM(total_cost_nanos), 0) AS total_cost_nanos
    FROM ${apiKeyUsageTable(range.apiKeyId)}
    WHERE
      created_at_ms >= ?
      AND created_at_ms < ?
      AND cost_currency IS NOT NULL
      AND total_cost_nanos IS NOT NULL
    GROUP BY model, cost_currency
    ORDER BY model ASC, cost_currency ASC
  `,
    )
    .all(range.startMs, range.endMs)

  const costMap = new Map<string, Array<TokenUsageCost>>()
  for (const row of rows) {
    const model = stringFromRow(row, "model") || "unknown"
    const cost = costFromRow(row)
    if (!cost) {
      continue
    }
    costMap.set(model, [...(costMap.get(model) ?? []), cost])
  }

  return costMap
}

function getSessionSummaries(
  db: SqliteDatabase,
  range: UsageTimeRange,
  limit: number,
  offset: number,
): Array<TokenUsageSessionSummary> {
  const rows = db
    .prepare(
      `
    SELECT
      session_id,
      COUNT(*) AS request_count,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
      COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
      SUM(total_nano_aiu) AS total_nano_aiu,
      COALESCE(SUM(total_tokens), 0) AS total_tokens
    FROM ${apiKeyUsageTable(range.apiKeyId)}
    WHERE created_at_ms >= ? AND created_at_ms < ?
    GROUP BY session_id
    ORDER BY total_tokens DESC, session_id ASC
    LIMIT ? OFFSET ?
  `,
    )
    .all(range.startMs, range.endMs, limit, offset)
  const sessionIds = rows.map((row) => stringFromRow(row, "session_id"))
  const costRows = db
    .prepare(
      `
    SELECT
      session_id,
      cost_currency,
      COALESCE(SUM(total_cost_nanos), 0) AS total_cost_nanos
    FROM ${apiKeyUsageTable(range.apiKeyId)}
    WHERE
      created_at_ms >= ?
      AND created_at_ms < ?
      AND session_id IN (${sessionIds.map(() => "?").join(", ")})
      AND cost_currency IS NOT NULL
      AND total_cost_nanos IS NOT NULL
    GROUP BY session_id, cost_currency
    ORDER BY session_id ASC, cost_currency ASC
  `,
    )
    .all(range.startMs, range.endMs, ...sessionIds)
  const costMap = new Map<string, Array<TokenUsageCost>>()
  for (const row of costRows) {
    const cost = costFromRow(row)
    if (cost) {
      const id = stringFromRow(row, "session_id")
      costMap.set(id, [...(costMap.get(id) ?? []), cost])
    }
  }

  return rows.map((row) => {
    const session_id = stringFromRow(row, "session_id")
    return {
      ...totalsFromRow(row, costMap.get(session_id) ?? []),
      session_id,
    }
  })
}

// Expand candidate IDs through the request index before grouping. A request
// contributes once even when usage arrives in several rows. Mixed-model calls
// and requests crossing a bucket boundary have no unambiguous per-model timing.
function getModelTimingRows(
  db: SqliteDatabase,
  intervals: Array<UsageDailyInterval>,
): Array<SqliteRow> {
  if (intervals.length === 0) return []
  return db
    .prepare(
      `
    WITH selected_requests AS (
      SELECT DISTINCT request_id FROM ${apiKeyUsageTable(intervals[0]?.apiKeyId)}
      WHERE created_at_ms >= ? AND created_at_ms < ? AND request_id IS NOT NULL
    -- The bucket join would otherwise re-run request grouping for every day.
    ), requests AS MATERIALIZED (
      SELECT e.request_id, MIN(e.model) AS model,
        MIN(e.created_at_ms) AS first_usage_at_ms,
        MAX(e.created_at_ms) AS last_usage_at_ms,
        SUM(e.output_tokens) AS output_tokens,
        MAX(e.first_token_ms) AS first_token_ms,
        MAX(e.duration_ms) AS duration_ms
      FROM selected_requests r JOIN ${apiKeyUsageTable(intervals[0]?.apiKeyId)} e USING (request_id)
      GROUP BY e.request_id
      HAVING COUNT(DISTINCT e.model) = 1
        AND COUNT(e.first_token_ms) = COUNT(*)
        AND COUNT(e.duration_ms) = COUNT(*)
        AND COUNT(e.request_outcome) = COUNT(*)
        AND MIN(e.request_outcome) = 'completed'
        AND MAX(e.request_outcome) = 'completed'
        AND MIN(e.first_token_ms) >= 0
        AND MIN(e.duration_ms) >= MAX(e.first_token_ms)
    ), buckets(usage_date, start_ms, end_ms) AS (VALUES ${intervals.map(() => "(?, ?, ?)").join(", ")})
    SELECT buckets.usage_date, model,
      AVG(first_token_ms) AS average_first_token_ms,
      1000.0 * SUM(CASE WHEN duration_ms > first_token_ms AND output_tokens > 0 THEN output_tokens END)
        / SUM(CASE WHEN duration_ms > first_token_ms AND output_tokens > 0 THEN duration_ms - first_token_ms END)
        AS output_tokens_per_second
    FROM requests JOIN buckets
      ON first_usage_at_ms >= start_ms AND last_usage_at_ms < end_ms
    GROUP BY buckets.usage_date, model
  `,
    )
    .all(
      intervals[0].startMs,
      intervals[intervals.length - 1].endMs,
      ...intervals.flatMap(({ date, startMs, endMs }) => [
        date,
        startMs,
        endMs,
      ]),
    )
}

function getModelSummaries(
  db: SqliteDatabase,
  range: UsageTimeRange,
): Array<TokenUsageModelSummary> {
  const costMap = getModelCostMap(db, range)
  const timings = new Map(
    getModelTimingRows(db, [{ date: "", ...range }]).map((row) => [
      stringFromRow(row, "model"),
      row,
    ]),
  )
  return getModelRows(db, range).map((row) => {
    const model = stringFromRow(row, "model") || "unknown"
    return modelSummaryFromRow(
      { ...row, ...timings.get(model) },
      costMap.get(model) ?? [],
    )
  })
}

function getDailyModelSummaries(
  db: SqliteDatabase,
  intervals: Array<UsageDailyInterval>,
): Map<string, Array<TokenUsageModelSummary>> {
  if (intervals.length === 0) {
    return new Map()
  }

  // Bucket events by the same local-day intervals the response reports.
  // SQLite's 'localtime' follows the C library timezone, which can disagree
  // with the JavaScript runtime (bun test forces UTC; images without tzdata
  // ignore TZ), putting events in the wrong day.
  const usageDays = `usage_days(usage_date, day_start_ms, day_end_ms) AS (VALUES ${intervals
    .map(() => "(?, ?, ?)")
    .join(", ")})`
  const dayParams = intervals.flatMap((interval) => [
    interval.date,
    interval.startMs,
    interval.endMs,
  ])
  const rows = db
    .prepare(
      `
    WITH ${usageDays}
    SELECT
      usage_days.usage_date AS usage_date,
      model,
      COUNT(*) AS request_count,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
      COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
      SUM(total_nano_aiu) AS total_nano_aiu,
      COALESCE(SUM(total_tokens), 0) AS total_tokens
    FROM usage_days
    JOIN ${apiKeyUsageTable(intervals[0]?.apiKeyId)}
      ON created_at_ms >= usage_days.day_start_ms
      AND created_at_ms < usage_days.day_end_ms
    GROUP BY usage_days.usage_date, model
    ORDER BY usage_days.usage_date ASC, total_tokens DESC, model ASC
  `,
    )
    .all(...dayParams)
  const costRows = db
    .prepare(
      `
    WITH ${usageDays}
    SELECT
      usage_days.usage_date AS usage_date,
      model,
      cost_currency,
      COALESCE(SUM(total_cost_nanos), 0) AS total_cost_nanos
    FROM usage_days
    JOIN ${apiKeyUsageTable(intervals[0]?.apiKeyId)}
      ON created_at_ms >= usage_days.day_start_ms
      AND created_at_ms < usage_days.day_end_ms
    WHERE cost_currency IS NOT NULL
      AND total_cost_nanos IS NOT NULL
    GROUP BY usage_days.usage_date, model, cost_currency
    ORDER BY usage_days.usage_date ASC, model ASC, cost_currency ASC
  `,
    )
    .all(...dayParams)
  const costsByDateAndModel = new Map<string, Array<TokenUsageCost>>()
  for (const row of costRows) {
    const date = stringFromRow(row, "usage_date")
    const model = stringFromRow(row, "model") || "unknown"
    const cost = costFromRow(row)
    if (!date || !cost) {
      continue
    }

    const key = `${date}\u0000${model}`
    costsByDateAndModel.set(key, [
      ...(costsByDateAndModel.get(key) ?? []),
      cost,
    ])
  }

  const timings = new Map(
    getModelTimingRows(db, intervals).map((row) => [
      `${stringFromRow(row, "usage_date")}\u0000${stringFromRow(row, "model")}`,
      row,
    ]),
  )
  const summariesByDate = new Map<string, Array<TokenUsageModelSummary>>()
  for (const row of rows) {
    const date = stringFromRow(row, "usage_date")
    if (!date) {
      continue
    }

    const model = stringFromRow(row, "model") || "unknown"
    const summaries = summariesByDate.get(date) ?? []
    summaries.push(
      modelSummaryFromRow(
        { ...row, ...timings.get(`${date}\u0000${model}`) },
        costsByDateAndModel.get(`${date}\u0000${model}`) ?? [],
      ),
    )
    summariesByDate.set(date, summaries)
  }

  return summariesByDate
}

function createDailyBucket(
  interval: { date: string; endMs: number; startMs: number },
  byModel: Array<TokenUsageModelSummary>,
): TokenUsageDailyBucket {
  const totals = createEmptyTotals()
  for (const model of byModel) {
    addTotals(totals, model)
  }

  return {
    byModel,
    date: interval.date,
    end_ms: interval.endMs,
    start_ms: interval.startMs,
    totals,
  }
}

export async function queryTokenUsageSummary(
  period: TokenUsagePeriod,
  nowMs: number,
  apiKeyId?: string | null,
  db?: SqliteDatabase,
): Promise<TokenUsageSummary> {
  const resolvedDb = db ?? (await getUsageDb())
  const range = getPeriodRangeFromDb(
    resolvedDb,
    period,
    new Date(nowMs),
    apiKeyId,
  )
  const totalsRow = getTotalsRow(resolvedDb, range)

  return {
    byModel: getModelSummaries(resolvedDb, range),
    period,
    range: rangePayload(range),
    totals: totalsFromRow(totalsRow, getCostRows(resolvedDb, range)),
  }
}

export async function queryTokenUsageDailySummary(
  period: TokenUsagePeriod,
  nowMs: number,
  apiKeyId?: string | null,
  db?: SqliteDatabase,
): Promise<TokenUsageDailySummary> {
  const resolvedDb = db ?? (await getUsageDb())
  const range = getPeriodRangeFromDb(
    resolvedDb,
    period,
    new Date(nowMs),
    apiKeyId,
  )
  const intervals = createDailyIntervals(range)
  const dailySummaries = getDailyModelSummaries(resolvedDb, intervals)

  return {
    byModel: getModelSummaries(resolvedDb, range),
    days: intervals.map((interval) =>
      createDailyBucket(interval, dailySummaries.get(interval.date) ?? []),
    ),
    period,
    range: rangePayload(range),
    totals: totalsFromRow(
      getTotalsRow(resolvedDb, range),
      getCostRows(resolvedDb, range),
    ),
  }
}

export async function queryTokenUsageEventsPage(
  input: TokenUsagePageInput,
  nowMs: number,
  db?: SqliteDatabase,
): Promise<TokenUsageEventsPage> {
  const page = Math.max(1, Math.floor(input.page))
  const pageSize = Math.min(100, Math.max(1, Math.floor(input.pageSize)))
  const offset = (page - 1) * pageSize
  const resolvedDb = db ?? (await getUsageDb())
  const range = getPeriodRangeFromDb(
    resolvedDb,
    input.period,
    new Date(nowMs),
    input.apiKeyId,
  )

  const totalRow = resolvedDb
    .prepare(
      `
    SELECT COUNT(*) AS total
    FROM ${apiKeyUsageTable(range.apiKeyId)} AS token_usage_events
    WHERE created_at_ms >= ? AND created_at_ms < ?
  `,
    )
    .get(range.startMs, range.endMs)

  const rows = resolvedDb
    .prepare(
      `
    SELECT
      id,
      created_at_ms,
      created_at_utc,
      trace_id,
      session_id,
      user_id,
      api_key_id,
      api_key_name,
      source,
      endpoint,
      provider_name,
      model,
      input_tokens,
      output_tokens,
      cache_read_input_tokens,
      cache_creation_input_tokens,
      total_nano_aiu,
      total_tokens,
      cost_currency,
      total_cost_nanos,
      cost_source,
      request_id,
      first_token_ms,
      duration_ms,
      request_outcome,
      user_agent,
      (SELECT COUNT(*) FROM ${apiKeyUsageTable(range.apiKeyId)} sibling
        WHERE sibling.request_id = token_usage_events.request_id) AS usage_event_count
    FROM ${apiKeyUsageTable(range.apiKeyId)} AS token_usage_events
    WHERE created_at_ms >= ? AND created_at_ms < ?
    ORDER BY created_at_ms DESC, id DESC
    LIMIT ? OFFSET ?
  `,
    )
    .all(range.startMs, range.endMs, pageSize, offset)

  const total = numberFromRow(totalRow, "total")

  return {
    items: rows.map((row) => usageEventFromRow(row)),
    page,
    page_size: pageSize,
    period: input.period,
    range: rangePayload(range),
    total,
    total_pages: Math.max(1, Math.ceil(total / pageSize)),
  }
}

export async function queryTokenUsageSessionsPage(
  input: TokenUsagePageInput,
  nowMs: number,
  db?: SqliteDatabase,
): Promise<TokenUsageSessionsPage> {
  const page = Math.max(1, Math.floor(input.page))
  const pageSize = Math.min(100, Math.max(1, Math.floor(input.pageSize)))
  const resolvedDb = db ?? (await getUsageDb())
  const range = getPeriodRangeFromDb(
    resolvedDb,
    input.period,
    new Date(nowMs),
    input.apiKeyId,
  )
  const totalRow = resolvedDb
    .prepare(
      `
    SELECT COUNT(DISTINCT session_id) AS total
    FROM ${apiKeyUsageTable(range.apiKeyId)}
    WHERE created_at_ms >= ? AND created_at_ms < ?
  `,
    )
    .get(range.startMs, range.endMs)
  const total = numberFromRow(totalRow, "total")

  return {
    items: getSessionSummaries(
      resolvedDb,
      range,
      pageSize,
      (page - 1) * pageSize,
    ),
    page,
    page_size: pageSize,
    period: input.period,
    range: rangePayload(range),
    total,
    total_pages: Math.max(1, Math.ceil(total / pageSize)),
  }
}
