import consola from "consola"
import path from "node:path"

import type { RequestTiming } from "~/lib/request-context"
import { PATHS } from "~/lib/paths"
import { registerProcessCleanup } from "~/lib/process-cleanup"
import {
  isSqliteRuntimeSupported,
  SqliteDbStore,
  type SqliteDatabase,
} from "~/lib/sqlite"

export type TokenUsageSource = "copilot" | "provider"

export type TokenUsageEndpoint =
  | "chat_completions"
  | "embeddings"
  | "messages"
  | "provider_messages"
  | "responses"

export type TokenUsagePeriod =
  | "today"
  | "this_week"
  | "last_7_days"
  | "this_month"
  | "last_30_days"
  | "lifetime"

export interface UsageTokens {
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
  cost?: number | null
  input_tokens?: number | null
  output_tokens?: number | null
  total_nano_aiu?: number | null
  total_tokens?: number | null
}

export interface TokenUsageCost {
  amount: number
  currency: string
  total_cost_nanos: number
}

export interface TokenUsageEventCost extends TokenUsageCost {
  source: string
}

export interface TokenUsageTiming {
  request_id: string | null
  first_token_ms: number | null
  duration_ms: number | null
  request_outcome: RequestTiming["outcome"]
}

export interface PersistedTokenUsageEvent extends TokenUsageTiming {
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  cost_currency: string | null
  cost_source: string | null
  created_at_ms: number
  created_at_utc: string
  endpoint: TokenUsageEndpoint
  input_tokens: number
  model: string
  output_tokens: number
  provider_name: string | null
  session_id: string
  source: TokenUsageSource
  total_cost_nanos: number | null
  total_nano_aiu: number | null
  total_tokens: number
  trace_id: string
  user_agent: string
  user_id: string
}

export interface TokenUsageTotals {
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  costs: Array<TokenUsageCost>
  input_tokens: number
  output_tokens: number
  request_count: number
  total_nano_aiu: number | null
  total_tokens: number
}

export interface TokenUsageModelSummary extends TokenUsageTotals {
  average_first_token_ms: number | null
  output_tokens_per_second: number | null
  model: string
}

export interface TokenUsageSessionSummary extends TokenUsageTotals {
  session_id: string
}

export interface TokenUsageEventRecord extends TokenUsageTiming {
  output_tokens_per_second: number | null
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  cost: TokenUsageEventCost | null
  created_at_ms: number
  created_at_utc: string
  endpoint: TokenUsageEndpoint
  id: number
  input_tokens: number
  model: string
  output_tokens: number
  provider_name: string | null
  session_id: string
  source: TokenUsageSource
  total_nano_aiu: number | null
  total_tokens: number
  trace_id: string
  user_agent: string
  user_id: string
}

export interface TokenUsageSummary {
  byModel: Array<TokenUsageModelSummary>
  period: TokenUsagePeriod
  range: {
    end_ms: number
    end_utc: string
    start_ms: number
    start_utc: string
  }
  totals: TokenUsageTotals
}

export interface TokenUsageDailyBucket {
  byModel: Array<TokenUsageModelSummary>
  date: string
  end_ms: number
  start_ms: number
  totals: TokenUsageTotals
}

export interface TokenUsageDailySummary {
  byModel: Array<TokenUsageModelSummary>
  days: Array<TokenUsageDailyBucket>
  period: TokenUsagePeriod
  range: {
    end_ms: number
    end_utc: string
    start_ms: number
    start_utc: string
  }
  totals: TokenUsageTotals
}

interface TokenUsagePage<T> {
  items: Array<T>
  page: number
  page_size: number
  period: TokenUsagePeriod
  range: {
    end_ms: number
    end_utc: string
    start_ms: number
    start_utc: string
  }
  total: number
  total_pages: number
}

export type TokenUsageEventsPage = TokenUsagePage<TokenUsageEventRecord>
export type TokenUsageSessionsPage = TokenUsagePage<TokenUsageSessionSummary>

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"
const DEFAULT_DB_FILENAME = "copilot-api.sqlite"
const COST_NANOS_PER_UNIT = 1_000_000_000

let writeQueue: Promise<void> = Promise.resolve()

function getDbPath(): string {
  return (
    process.env[DB_PATH_ENV] ?? path.join(PATHS.APP_DIR, DEFAULT_DB_FILENAME)
  )
}

const tokenUsageDbStore = new SqliteDbStore({
  getPath: getDbPath,
  initialize: initializeTokenUsageDb,
})

function getDb(): Promise<SqliteDatabase> {
  return tokenUsageDbStore.getDb()
}

export function isTokenUsageStorageEnabled(): boolean {
  return isSqliteRuntimeSupported()
}

function initializeTokenUsageDb(db: SqliteDatabase): void {
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      created_at_utc TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      user_id TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      provider_name TEXT,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      total_nano_aiu INTEGER,
      cost_currency TEXT,
      total_cost_nanos INTEGER,
      cost_source TEXT
    )
  `)
  ensureColumn(db, "user_id", "TEXT NOT NULL DEFAULT ''")
  ensureColumn(db, "user_agent", "TEXT NOT NULL DEFAULT ''")
  ensureColumn(db, "total_tokens", "INTEGER NOT NULL DEFAULT 0")
  ensureColumn(db, "total_nano_aiu", "INTEGER")
  ensureColumn(db, "cost_currency", "TEXT")
  ensureColumn(db, "total_cost_nanos", "INTEGER")
  ensureColumn(db, "cost_source", "TEXT")
  ensureColumn(db, "request_id", "TEXT")
  ensureColumn(db, "first_token_ms", "REAL")
  ensureColumn(db, "duration_ms", "REAL")
  ensureColumn(db, "request_outcome", "TEXT")
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_usage_events_request_id
    ON token_usage_events(request_id)
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_usage_events_created_at_ms
    ON token_usage_events(created_at_ms)
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_usage_events_model
    ON token_usage_events(model)
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_usage_events_trace_id
    ON token_usage_events(trace_id)
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_usage_events_session_id
    ON token_usage_events(session_id)
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_usage_events_user_id
    ON token_usage_events(user_id)
  `)
}

function ensureColumn(
  db: SqliteDatabase,
  name: string,
  definition: string,
): void {
  const rows = db
    .prepare("PRAGMA table_info(token_usage_events)")
    .all() as Array<Record<string, unknown>>
  const hasColumn = rows.some((row) => row.name === name)
  if (!hasColumn) {
    db.exec(`ALTER TABLE token_usage_events ADD COLUMN ${name} ${definition}`)
  }
}

export function normalizeToken(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0
  }
  return Math.max(0, Math.floor(value))
}

export function normalizeOptionalToken(
  value: number | null | undefined,
): number | undefined {
  return value === null || value === undefined ?
      undefined
    : normalizeToken(value)
}

export function hasAnyToken(tokens: UsageTokens): boolean {
  return (
    normalizeToken(tokens.input_tokens) > 0
    || normalizeToken(tokens.output_tokens) > 0
    || normalizeToken(tokens.cache_read_input_tokens) > 0
    || normalizeToken(tokens.cache_creation_input_tokens) > 0
    || normalizeToken(tokens.total_tokens) > 0
    || normalizeToken(tokens.total_nano_aiu) > 0
  )
}

export function resolveTotalTokens(input: UsageTokens): number {
  const explicitTotal = normalizeOptionalToken(input.total_tokens)
  if (explicitTotal !== undefined) {
    return explicitTotal
  }
  return (
    normalizeToken(input.input_tokens)
    + normalizeToken(input.output_tokens)
    + normalizeToken(input.cache_read_input_tokens)
    + normalizeToken(input.cache_creation_input_tokens)
  )
}

async function writeTokenUsageEvent(
  event: PersistedTokenUsageEvent,
): Promise<void> {
  const db = await getDb()
  db.prepare(
    `
      INSERT INTO token_usage_events (
        created_at_ms,
        created_at_utc,
        trace_id,
        session_id,
        user_id,
        source,
        endpoint,
        provider_name,
        model,
        input_tokens,
        output_tokens,
        cache_read_input_tokens,
        cache_creation_input_tokens,
        total_tokens,
        total_nano_aiu,
        cost_currency,
        total_cost_nanos,
        cost_source,
        request_id,
        first_token_ms,
        duration_ms,
        request_outcome,
        user_agent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    event.created_at_ms,
    event.created_at_utc,
    event.trace_id,
    event.session_id,
    event.user_id,
    event.source,
    event.endpoint,
    event.provider_name,
    event.model,
    event.input_tokens,
    event.output_tokens,
    event.cache_read_input_tokens,
    event.cache_creation_input_tokens,
    event.total_tokens,
    event.total_nano_aiu,
    event.cost_currency,
    event.total_cost_nanos,
    event.cost_source,
    event.request_id,
    event.first_token_ms,
    event.duration_ms,
    event.request_outcome,
    event.user_agent,
  )
}

export function enqueueTokenUsageWrite(event: PersistedTokenUsageEvent): void {
  if (!isTokenUsageStorageEnabled()) {
    return
  }

  writeQueue = writeQueue
    .then(() => writeTokenUsageEvent(event))
    .catch((error: unknown) => {
      consola.warn("Failed to record token usage", error)
    })
}

// Share the insert queue: early usage is preserved, then completed with timing.
// Late usage carries the final snapshot directly, without a pending-request map.
export function enqueueTokenUsageTiming(timing: RequestTiming): void {
  if (!isTokenUsageStorageEnabled()) return
  const { id, firstTokenMs, durationMs, outcome } = timing
  writeQueue = writeQueue
    .then(async () => {
      const db = await getDb()
      db.prepare(
        `
      UPDATE token_usage_events
      SET first_token_ms = ?, duration_ms = ?, request_outcome = ?
      WHERE request_id = ?
    `,
      ).run(firstTokenMs, durationMs, outcome, id)
    })
    .catch((error: unknown) => {
      consola.warn("Failed to record token usage timing", error)
    })
}

async function flushTokenUsageEvents(): Promise<void> {
  let currentQueue = writeQueue
  while (true) {
    await currentQueue
    if (currentQueue === writeQueue) {
      return
    }
    currentQueue = writeQueue
  }
}

function getPeriodRange(period: TokenUsagePeriod, now = new Date()) {
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

function getPeriodRangeFromDb(
  db: SqliteDatabase,
  period: TokenUsagePeriod,
  now = new Date(),
) {
  if (period !== "lifetime") {
    return getPeriodRange(period, now)
  }

  const nowMs = now.getTime()
  const row = db
    .prepare(
      `
    SELECT MIN(created_at_ms) AS start_ms
    FROM token_usage_events
    WHERE created_at_ms <= ?
  `,
    )
    .get(nowMs) as Record<string, unknown> | undefined
  const earliestEventMs = row?.start_ms
  const hasEarliestEvent =
    typeof earliestEventMs === "number" && Number.isFinite(earliestEventMs)
  const startMs = hasEarliestEvent ? earliestEventMs : nowMs + 1

  return {
    endMs: nowMs + 1,
    startMs,
  }
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function createDailyIntervals(range: { endMs: number; startMs: number }) {
  const intervals: Array<{
    date: string
    endMs: number
    startMs: number
  }> = []
  const cursor = new Date(range.startMs)
  cursor.setHours(0, 0, 0, 0)

  while (cursor.getTime() < range.endMs) {
    const startMs = Math.max(cursor.getTime(), range.startMs)
    const next = new Date(cursor)
    next.setDate(next.getDate() + 1)
    const endMs = Math.min(next.getTime(), range.endMs)
    if (startMs < endMs) {
      intervals.push({
        date: formatLocalDate(cursor),
        endMs,
        startMs,
      })
    }
    cursor.setTime(next.getTime())
  }

  return intervals
}

function createEmptyTotals(): TokenUsageTotals {
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

function addTotals(target: TokenUsageTotals, next: TokenUsageTotals): void {
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

function createEmptySummary(period: TokenUsagePeriod): TokenUsageSummary {
  const range = getPeriodRange(period)

  return {
    byModel: [],
    period,
    range: {
      end_ms: range.endMs,
      end_utc: new Date(range.endMs).toISOString(),
      start_ms: range.startMs,
      start_utc: new Date(range.startMs).toISOString(),
    },
    totals: createEmptyTotals(),
  }
}

function createEmptyDailySummary(
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
    range: {
      end_ms: range.endMs,
      end_utc: new Date(range.endMs).toISOString(),
      start_ms: range.startMs,
      start_utc: new Date(range.startMs).toISOString(),
    },
    totals: createEmptyTotals(),
  }
}

function createEmptyEventsPage(input: {
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
    range: {
      end_ms: range.endMs,
      end_utc: new Date(range.endMs).toISOString(),
      start_ms: range.startMs,
      start_utc: new Date(range.startMs).toISOString(),
    },
    total: 0,
    total_pages: 1,
  }
}

function rangePayload(range: { endMs: number; startMs: number }) {
  return {
    end_ms: range.endMs,
    end_utc: new Date(range.endMs).toISOString(),
    start_ms: range.startMs,
    start_utc: new Date(range.startMs).toISOString(),
  }
}

function numberFromRow(
  row: Record<string, unknown> | undefined,
  key: string,
): number {
  const value = row?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function nullableNumberFromRow(
  row: Record<string, unknown> | undefined,
  key: string,
): number | null {
  const value = row?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function createCost(currency: string, totalCostNanos: number): TokenUsageCost {
  return {
    amount: totalCostNanos / COST_NANOS_PER_UNIT,
    currency,
    total_cost_nanos: totalCostNanos,
  }
}

function costFromRow(row: Record<string, unknown>): TokenUsageCost | null {
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

function eventCostFromRow(
  row: Record<string, unknown>,
): TokenUsageEventCost | null {
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
  row: Record<string, unknown> | undefined,
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
  row: Record<string, unknown>,
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

function stringFromRow(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  return typeof value === "string" ? value : ""
}

function nullableStringFromRow(
  row: Record<string, unknown>,
  key: string,
): string | null {
  const value = row[key]
  return typeof value === "string" ? value : null
}

function outputTokensPerSecond(row: Record<string, unknown>): number | null {
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

function usageEventFromRow(
  row: Record<string, unknown>,
): TokenUsageEventRecord {
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
    user_agent: stringFromRow(row, "user_agent"),
  }
}

function getTotalsRow(
  db: SqliteDatabase,
  range: { endMs: number; startMs: number },
): Record<string, unknown> | undefined {
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
    FROM token_usage_events
    WHERE created_at_ms >= ? AND created_at_ms < ?
  `,
    )
    .get(range.startMs, range.endMs) as Record<string, unknown> | undefined
}

function getModelRows(
  db: SqliteDatabase,
  range: { endMs: number; startMs: number },
): Array<Record<string, unknown>> {
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
    FROM token_usage_events
    WHERE created_at_ms >= ? AND created_at_ms < ?
    GROUP BY model
    ORDER BY
      total_tokens DESC,
      model ASC
  `,
    )
    .all(range.startMs, range.endMs) as Array<Record<string, unknown>>
}

function getCostRows(
  db: SqliteDatabase,
  range: { endMs: number; startMs: number },
): Array<TokenUsageCost> {
  const rows = db
    .prepare(
      `
    SELECT
      cost_currency,
      COALESCE(SUM(total_cost_nanos), 0) AS total_cost_nanos
    FROM token_usage_events
    WHERE
      created_at_ms >= ?
      AND created_at_ms < ?
      AND cost_currency IS NOT NULL
      AND total_cost_nanos IS NOT NULL
    GROUP BY cost_currency
    ORDER BY cost_currency ASC
  `,
    )
    .all(range.startMs, range.endMs) as Array<Record<string, unknown>>

  return rows.flatMap((row) => {
    const cost = costFromRow(row)
    return cost ? [cost] : []
  })
}

function getModelCostMap(
  db: SqliteDatabase,
  range: { endMs: number; startMs: number },
): Map<string, Array<TokenUsageCost>> {
  const rows = db
    .prepare(
      `
    SELECT
      model,
      cost_currency,
      COALESCE(SUM(total_cost_nanos), 0) AS total_cost_nanos
    FROM token_usage_events
    WHERE
      created_at_ms >= ?
      AND created_at_ms < ?
      AND cost_currency IS NOT NULL
      AND total_cost_nanos IS NOT NULL
    GROUP BY model, cost_currency
    ORDER BY model ASC, cost_currency ASC
  `,
    )
    .all(range.startMs, range.endMs) as Array<Record<string, unknown>>

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
  range: { endMs: number; startMs: number },
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
    FROM token_usage_events
    WHERE created_at_ms >= ? AND created_at_ms < ?
    GROUP BY session_id
    ORDER BY total_tokens DESC, session_id ASC
    LIMIT ? OFFSET ?
  `,
    )
    .all(range.startMs, range.endMs, limit, offset) as Array<
    Record<string, unknown>
  >
  const sessionIds = rows.map((row) => stringFromRow(row, "session_id"))
  const costRows = db
    .prepare(
      `
    SELECT
      session_id,
      cost_currency,
      COALESCE(SUM(total_cost_nanos), 0) AS total_cost_nanos
    FROM token_usage_events
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
    .all(range.startMs, range.endMs, ...sessionIds) as Array<
    Record<string, unknown>
  >
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
  intervals: Array<{ date: string; endMs: number; startMs: number }>,
): Array<Record<string, unknown>> {
  if (intervals.length === 0) return []
  return db
    .prepare(
      `
    WITH selected_requests AS (
      SELECT DISTINCT request_id FROM token_usage_events
      WHERE created_at_ms >= ? AND created_at_ms < ? AND request_id IS NOT NULL
    ), requests AS (
      SELECT e.request_id, MIN(e.model) AS model,
        MIN(e.created_at_ms) AS first_usage_at_ms,
        MAX(e.created_at_ms) AS last_usage_at_ms,
        SUM(e.output_tokens) AS output_tokens,
        MAX(e.first_token_ms) AS first_token_ms,
        MAX(e.duration_ms) AS duration_ms
      FROM selected_requests r JOIN token_usage_events e USING (request_id)
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
    ) as Array<Record<string, unknown>>
}

function getModelSummaries(
  db: SqliteDatabase,
  range: { endMs: number; startMs: number },
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
  intervals: Array<{ date: string; endMs: number; startMs: number }>,
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
    JOIN token_usage_events
      ON created_at_ms >= usage_days.day_start_ms
      AND created_at_ms < usage_days.day_end_ms
    GROUP BY usage_days.usage_date, model
    ORDER BY usage_days.usage_date ASC, total_tokens DESC, model ASC
  `,
    )
    .all(...dayParams) as Array<Record<string, unknown>>
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
    JOIN token_usage_events
      ON created_at_ms >= usage_days.day_start_ms
      AND created_at_ms < usage_days.day_end_ms
    WHERE cost_currency IS NOT NULL
      AND total_cost_nanos IS NOT NULL
    GROUP BY usage_days.usage_date, model, cost_currency
    ORDER BY usage_days.usage_date ASC, model ASC, cost_currency ASC
  `,
    )
    .all(...dayParams) as Array<Record<string, unknown>>
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

export async function getTokenUsageSummary(
  period: TokenUsagePeriod,
): Promise<TokenUsageSummary> {
  if (!isTokenUsageStorageEnabled()) {
    return createEmptySummary(period)
  }

  await flushTokenUsageEvents()
  const db = await getDb()
  const range = getPeriodRangeFromDb(db, period)
  const totalsRow = getTotalsRow(db, range)

  return {
    byModel: getModelSummaries(db, range),
    period,
    range: rangePayload(range),
    totals: totalsFromRow(totalsRow, getCostRows(db, range)),
  }
}

export async function getTokenUsageDailySummary(
  period: TokenUsagePeriod,
): Promise<TokenUsageDailySummary> {
  if (!isTokenUsageStorageEnabled()) {
    return createEmptyDailySummary(period)
  }

  await flushTokenUsageEvents()
  const db = await getDb()
  const range = getPeriodRangeFromDb(db, period)
  const intervals = createDailyIntervals(range)
  const dailySummaries = getDailyModelSummaries(db, intervals)

  return {
    byModel: getModelSummaries(db, range),
    days: intervals.map((interval) =>
      createDailyBucket(interval, dailySummaries.get(interval.date) ?? []),
    ),
    period,
    range: rangePayload(range),
    totals: totalsFromRow(getTotalsRow(db, range), getCostRows(db, range)),
  }
}

export async function getTokenUsageEventsPage(input: {
  page: number
  pageSize: number
  period: TokenUsagePeriod
}): Promise<TokenUsageEventsPage> {
  if (!isTokenUsageStorageEnabled()) {
    return createEmptyEventsPage(input)
  }

  await flushTokenUsageEvents()
  const page = Math.max(1, Math.floor(input.page))
  const pageSize = Math.min(100, Math.max(1, Math.floor(input.pageSize)))
  const offset = (page - 1) * pageSize
  const db = await getDb()
  const range = getPeriodRangeFromDb(db, input.period)

  const totalRow = db
    .prepare(
      `
    SELECT COUNT(*) AS total
    FROM token_usage_events
    WHERE created_at_ms >= ? AND created_at_ms < ?
  `,
    )
    .get(range.startMs, range.endMs) as Record<string, unknown> | undefined

  const rows = db
    .prepare(
      `
    SELECT
      id,
      created_at_ms,
      created_at_utc,
      trace_id,
      session_id,
      user_id,
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
      (SELECT COUNT(*) FROM token_usage_events sibling
        WHERE sibling.request_id = token_usage_events.request_id) AS usage_event_count
    FROM token_usage_events
    WHERE created_at_ms >= ? AND created_at_ms < ?
    ORDER BY created_at_ms DESC, id DESC
    LIMIT ? OFFSET ?
  `,
    )
    .all(range.startMs, range.endMs, pageSize, offset) as Array<
    Record<string, unknown>
  >

  const total = numberFromRow(totalRow, "total")

  return {
    items: rows.map((row) => usageEventFromRow(row)),
    page,
    page_size: pageSize,
    period: input.period,
    range: {
      end_ms: range.endMs,
      end_utc: new Date(range.endMs).toISOString(),
      start_ms: range.startMs,
      start_utc: new Date(range.startMs).toISOString(),
    },
    total,
    total_pages: Math.max(1, Math.ceil(total / pageSize)),
  }
}

export async function getTokenUsageSessionsPage(input: {
  page: number
  pageSize: number
  period: TokenUsagePeriod
}): Promise<TokenUsageSessionsPage> {
  const page = Math.max(1, Math.floor(input.page))
  const pageSize = Math.min(100, Math.max(1, Math.floor(input.pageSize)))
  if (!isTokenUsageStorageEnabled()) {
    return { ...createEmptyEventsPage(input), items: [] }
  }

  await flushTokenUsageEvents()
  const db = await getDb()
  const range = getPeriodRangeFromDb(db, input.period)
  const totalRow = db
    .prepare(
      `
    SELECT COUNT(DISTINCT session_id) AS total
    FROM token_usage_events
    WHERE created_at_ms >= ? AND created_at_ms < ?
  `,
    )
    .get(range.startMs, range.endMs) as Record<string, unknown> | undefined
  const total = numberFromRow(totalRow, "total")

  return {
    items: getSessionSummaries(db, range, pageSize, (page - 1) * pageSize),
    page,
    page_size: pageSize,
    period: input.period,
    range: rangePayload(range),
    total,
    total_pages: Math.max(1, Math.ceil(total / pageSize)),
  }
}

export async function closeUsageStore(): Promise<void> {
  await flushTokenUsageEvents()
  await tokenUsageDbStore.close({
    beforeClose: (db) => {
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      } catch {
        // Ignore cleanup errors in tests.
      }
    },
  })
  writeQueue = Promise.resolve()
}

registerProcessCleanup(closeUsageStore)
