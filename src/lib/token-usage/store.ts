import consola from "consola"

import { getDatabaseConfig } from "~/lib/config"
import { registerProcessCleanup } from "~/lib/process-cleanup"
import {
  AsyncDbStore,
  type AsyncDatabase,
  isSqliteRuntimeSupported,
  openSqliteDatabase,
} from "~/lib/sqlite"
import { openTursoDatabase } from "~/lib/turso"

export type TokenUsageSource = "copilot" | "provider"

export type TokenUsageEndpoint =
  | "chat_completions"
  | "embeddings"
  | "messages"
  | "provider_messages"
  | "responses"

export type TokenUsagePeriod = "day" | "week" | "month"

export interface UsageTokens {
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
  input_tokens?: number | null
  output_tokens?: number | null
  total_tokens?: number | null
}

export interface PersistedTokenUsageEvent {
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  created_at_ms: number
  created_at_utc: string
  endpoint: TokenUsageEndpoint
  input_tokens: number
  model: string
  output_tokens: number
  provider_name: string | null
  session_id: string
  source: TokenUsageSource
  total_tokens: number
  trace_id: string
  user_id: string
}

export interface TokenUsageTotals {
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  input_tokens: number
  output_tokens: number
  request_count: number
  total_tokens: number
}

export interface TokenUsageModelSummary extends TokenUsageTotals {
  model: string
}

export interface TokenUsageEventRecord {
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
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
  total_tokens: number
  trace_id: string
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

export interface TokenUsageEventsPage {
  items: Array<TokenUsageEventRecord>
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

let writeQueue: Promise<void> = Promise.resolve()

const tokenUsageDbStore = new AsyncDbStore({
  open: () => {
    const dbConfig = getDatabaseConfig()
    return dbConfig.type === "turso" ?
        openTursoDatabase(dbConfig)
      : openSqliteDatabase(dbConfig.path)
  },
  initialize: initializeTokenUsageDb,
})

function getDb(): Promise<AsyncDatabase> {
  return tokenUsageDbStore.getDb()
}

export function isTokenUsageStorageEnabled(): boolean {
  return getDatabaseConfig().type === "turso" || isSqliteRuntimeSupported()
}

// Human-readable description of where token usage is stored, for startup logs.
// Reads config only — does not open the database.
export function describeTokenUsageStorage(): string {
  if (!isTokenUsageStorageEnabled()) {
    return "disabled (requires Bun or Node.js >= 22.13.0)"
  }
  const dbConfig = getDatabaseConfig()
  return dbConfig.type === "turso" ?
      `Turso/libsql remote (${dbConfig.url})`
    : `local SQLite (${dbConfig.path})`
}

async function initializeTokenUsageDb(db: AsyncDatabase): Promise<void> {
  if (db.kind === "sqlite") {
    await db.exec("PRAGMA journal_mode = WAL")
    await db.exec("PRAGMA busy_timeout = 5000")
  }
  await db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      created_at_utc TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      user_id TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      provider_name TEXT,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0
    )
  `)
  await ensureColumn(db, "user_id", "TEXT NOT NULL DEFAULT ''")
  await ensureColumn(db, "total_tokens", "INTEGER NOT NULL DEFAULT 0")
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_usage_events_created_at_ms
    ON token_usage_events(created_at_ms)
  `)
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_usage_events_model
    ON token_usage_events(model)
  `)
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_usage_events_trace_id
    ON token_usage_events(trace_id)
  `)
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_usage_events_session_id
    ON token_usage_events(session_id)
  `)
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_usage_events_user_id
    ON token_usage_events(user_id)
  `)
}

async function ensureColumn(
  db: AsyncDatabase,
  name: string,
  definition: string,
): Promise<void> {
  const rows = await db.prepare("PRAGMA table_info(token_usage_events)").all()
  const hasColumn = rows.some((row) => row.name === name)
  if (!hasColumn) {
    await db.exec(
      `ALTER TABLE token_usage_events ADD COLUMN ${name} ${definition}`,
    )
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
  await db
    .prepare(
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
        total_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
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
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)

  switch (period) {
    case "day": {
      break
    }
    case "week": {
      start.setDate(start.getDate() - 6)
      break
    }
    case "month": {
      start.setDate(start.getDate() - 29)
      break
    }
    default: {
      break
    }
  }

  const end = new Date(start)
  switch (period) {
    case "day": {
      end.setDate(end.getDate() + 1)
      break
    }
    case "week": {
      end.setDate(end.getDate() + 7)
      break
    }
    case "month": {
      end.setDate(end.getDate() + 30)
      break
    }
    default: {
      break
    }
  }

  return {
    endMs: end.getTime(),
    startMs: start.getTime(),
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

  while (cursor.getTime() < range.endMs) {
    const startMs = cursor.getTime()
    const next = new Date(cursor)
    next.setDate(next.getDate() + 1)
    const endMs = Math.min(next.getTime(), range.endMs)
    intervals.push({
      date: formatLocalDate(cursor),
      endMs,
      startMs,
    })
    cursor.setTime(endMs)
  }

  return intervals
}

function createEmptyTotals(): TokenUsageTotals {
  return {
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    request_count: 0,
    total_tokens: 0,
  }
}

function addTotals(target: TokenUsageTotals, next: TokenUsageTotals): void {
  target.cache_creation_input_tokens += next.cache_creation_input_tokens
  target.cache_read_input_tokens += next.cache_read_input_tokens
  target.input_tokens += next.input_tokens
  target.output_tokens += next.output_tokens
  target.request_count += next.request_count
  target.total_tokens += next.total_tokens
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

function totalsFromRow(
  row: Record<string, unknown> | undefined,
): TokenUsageTotals {
  return {
    cache_creation_input_tokens: numberFromRow(
      row,
      "cache_creation_input_tokens",
    ),
    cache_read_input_tokens: numberFromRow(row, "cache_read_input_tokens"),
    input_tokens: numberFromRow(row, "input_tokens"),
    output_tokens: numberFromRow(row, "output_tokens"),
    request_count: numberFromRow(row, "request_count"),
    total_tokens: numberFromRow(row, "total_tokens"),
  }
}

function modelSummaryFromRow(
  row: Record<string, unknown>,
): TokenUsageModelSummary {
  return {
    ...totalsFromRow(row),
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

function usageEventFromRow(
  row: Record<string, unknown>,
): TokenUsageEventRecord {
  return {
    cache_creation_input_tokens: numberFromRow(
      row,
      "cache_creation_input_tokens",
    ),
    cache_read_input_tokens: numberFromRow(row, "cache_read_input_tokens"),
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
    total_tokens: numberFromRow(row, "total_tokens"),
    trace_id: stringFromRow(row, "trace_id"),
    user_id: stringFromRow(row, "user_id"),
  }
}

async function getTotalsRow(
  db: AsyncDatabase,
  range: { endMs: number; startMs: number },
): Promise<Record<string, unknown> | undefined> {
  return db
    .prepare(
      `
    SELECT
      COUNT(*) AS request_count,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input_tokens,
      COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens
    FROM token_usage_events
    WHERE created_at_ms >= ? AND created_at_ms < ?
  `,
    )
    .get(range.startMs, range.endMs)
}

async function getModelRows(
  db: AsyncDatabase,
  range: { endMs: number; startMs: number },
): Promise<Array<Record<string, unknown>>> {
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
      COALESCE(SUM(total_tokens), 0) AS total_tokens
    FROM token_usage_events
    WHERE created_at_ms >= ? AND created_at_ms < ?
    GROUP BY model
    ORDER BY
      total_tokens DESC,
      model ASC
  `,
    )
    .all(range.startMs, range.endMs)
}

function createDailyBucket(
  interval: { date: string; endMs: number; startMs: number },
  rows: Array<Record<string, unknown>>,
): TokenUsageDailyBucket {
  const byModel = rows.map((row) => modelSummaryFromRow(row))
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
  const range = getPeriodRange(period)
  const db = await getDb()
  const [totalsRow, byModelRows] = await Promise.all([
    getTotalsRow(db, range),
    getModelRows(db, range),
  ])

  return {
    byModel: byModelRows.map((row) => modelSummaryFromRow(row)),
    period,
    range: rangePayload(range),
    totals: totalsFromRow(totalsRow),
  }
}

export async function getTokenUsageDailySummary(
  period: TokenUsagePeriod,
): Promise<TokenUsageDailySummary> {
  if (!isTokenUsageStorageEnabled()) {
    return createEmptyDailySummary(period)
  }

  await flushTokenUsageEvents()
  const range = getPeriodRange(period)
  const db = await getDb()
  const intervals = createDailyIntervals(range)

  const [byModelRows, totalsRow, days] = await Promise.all([
    getModelRows(db, range),
    getTotalsRow(db, range),
    Promise.all(
      intervals.map(async (interval) =>
        createDailyBucket(interval, await getModelRows(db, interval)),
      ),
    ),
  ])

  return {
    byModel: byModelRows.map((row) => modelSummaryFromRow(row)),
    days,
    period,
    range: rangePayload(range),
    totals: totalsFromRow(totalsRow),
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
  const range = getPeriodRange(input.period)
  const page = Math.max(1, Math.floor(input.page))
  const pageSize = Math.min(100, Math.max(1, Math.floor(input.pageSize)))
  const offset = (page - 1) * pageSize
  const db = await getDb()

  const totalRow = await db
    .prepare(
      `
    SELECT COUNT(*) AS total
    FROM token_usage_events
    WHERE created_at_ms >= ? AND created_at_ms < ?
  `,
    )
    .get(range.startMs, range.endMs)

  const rows = await db
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
      total_tokens
    FROM token_usage_events
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

export async function closeUsageStore(): Promise<void> {
  await flushTokenUsageEvents()
  await tokenUsageDbStore.close({
    beforeClose: async (db) => {
      if (db.kind !== "sqlite") {
        return
      }
      try {
        await db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      } catch {
        // Ignore cleanup errors in tests.
      }
    },
  })
  writeQueue = Promise.resolve()
}

registerProcessCleanup(closeUsageStore)
