import type { GatewayApiKeyConfig } from "../api-key-config"
import { ApiKeyQuotaLedger, apiKeyQuotaWindow } from "../api-key-quota"
import type { ApiKeyQuotaUsage } from "../types/api-key"
import {
  initializeApiKeyQuotaTables,
  readApiKeyQuotaLedger,
  persistApiKeyQuotaLedger,
} from "../api-key-quota-store"
import consola from "consola"
import path from "node:path"
import { workerData } from "node:worker_threads"

import type { RequestTiming } from "~/lib/request-context"
import {
  getTokenUsageRetentionDays,
  resolveTokenUsageRetentionDays,
} from "~/lib/config-store"
import { PATHS } from "~/lib/paths"
import { registerProcessCleanup } from "~/lib/process-cleanup"
import {
  isSqliteRuntimeSupported,
  SqliteDbStore,
  type SqliteDatabase,
  type SqliteRow,
} from "~/lib/sqlite"

import { UsageWorker } from "./worker-client"
import { COST_NANOS_PER_UNIT, toCostNanos } from "./currency"

export type TokenUsageSource = "copilot" | "provider"

export type TokenUsageEndpoint =
  | "alpha_search"
  | "chat_completions"
  | "embeddings"
  | "images_generations"
  | "images_edits"
  | "messages"
  | "provider_messages"
  | "responses"
  | "videos_generations"

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
  input_tokens_details?: ImageTokenDetails
  output_tokens?: number | null
  output_tokens_details?: ImageTokenDetails
  total_nano_aiu?: number | null
  total_tokens?: number | null
}

export interface ImageTokenDetails {
  image_tokens?: number
  text_tokens?: number
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
  api_key_cost_nanos?: number | null
  api_key_id?: string | null
  api_key_name?: string | null
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
  upstream_request_id?: string | null
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
  api_key_id?: string | null
  api_key_name?: string | null
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

interface TokenUsagePageInput {
  page: number
  pageSize: number
  period: TokenUsagePeriod
  apiKeyId?: string | null
}

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"
const DEFAULT_DB_FILENAME = "copilot-api.sqlite"
const TOKEN_USAGE_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000
const VIDEO_USAGE_POLL_INTERVAL_MS = 5000
const DAY_MS = 24 * 60 * 60 * 1000

let worker: UsageWorker | undefined
let closing: Promise<void> | undefined
let closingWorker = false
let retentionTimer: ReturnType<typeof setInterval> | undefined
let retentionStarted = false
let stopVideoUsageSettlement: (() => Promise<void>) | undefined

function getDbPath(): string {
  return (
    process.env[DB_PATH_ENV] ?? path.join(PATHS.APP_DIR, DEFAULT_DB_FILENAME)
  )
}

function getWorker(): UsageWorker {
  if (closingWorker) throw new Error("SQLite usage store is closing")
  if (!worker) {
    worker = new UsageWorker(getDbPath())
    registerProcessCleanup(closeUsageStore)
  }
  return worker
}

const tokenUsageDbStore = new SqliteDbStore({
  getPath: () => {
    if (typeof workerData !== "string")
      throw new Error("SQLite usage database requires a worker")
    return workerData
  },
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
  ensureColumn(db, "api_key_id", "TEXT")
  ensureColumn(db, "api_key_name", "TEXT")
  ensureColumn(db, "api_key_cost_nanos", "INTEGER")
  initializeApiKeyQuotaTables(db)
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_token_usage_events_api_key ON token_usage_events(api_key_id, created_at_ms)",
  )
  ensureColumn(db, "user_id", "TEXT NOT NULL DEFAULT ''")
  ensureColumn(db, "user_agent", "TEXT NOT NULL DEFAULT ''")
  ensureColumn(db, "total_tokens", "INTEGER NOT NULL DEFAULT 0")
  ensureColumn(db, "total_nano_aiu", "INTEGER")
  ensureColumn(db, "cost_currency", "TEXT")
  ensureColumn(db, "total_cost_nanos", "INTEGER")
  ensureColumn(db, "cost_source", "TEXT")
  ensureColumn(db, "request_id", "TEXT")
  ensureColumn(db, "upstream_request_id", "TEXT")
  ensureColumn(db, "first_token_ms", "REAL")
  ensureColumn(db, "duration_ms", "REAL")
  ensureColumn(db, "request_outcome", "TEXT")
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_token_usage_events_upstream_request
    ON token_usage_events(source, provider_name, endpoint, upstream_request_id)
  `)
  initializeVideoUsageJobs(db)
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
  const rows = db.prepare("PRAGMA table_info(token_usage_events)").all()
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

function insertTokenUsageEvent(
  db: SqliteDatabase,
  event: PersistedTokenUsageEvent,
): boolean {
  const result = db
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
        total_tokens,
        total_nano_aiu,
        cost_currency,
        total_cost_nanos,
        cost_source,
        request_id,
        upstream_request_id,
        first_token_ms,
        duration_ms,
        request_outcome,
        user_agent,
        api_key_id,
        api_key_name,
        api_key_cost_nanos
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, provider_name, endpoint, upstream_request_id) DO NOTHING
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
      event.total_nano_aiu,
      event.cost_currency,
      event.total_cost_nanos,
      event.cost_source,
      event.request_id,
      event.upstream_request_id ?? null,
      event.first_token_ms,
      event.duration_ms,
      event.request_outcome,
      event.user_agent,
      event.api_key_id ?? null,
      event.api_key_name ?? null,
      event.api_key_cost_nanos ?? null,
    )
  return Boolean(result.changes)
}

function insertVideoUsageEvent(
  db: SqliteDatabase,
  event: PersistedTokenUsageEvent,
  provider: string,
  requestId: string,
): boolean {
  db.exec("BEGIN IMMEDIATE")
  try {
    const job = readVideoUsageJob(db, provider, requestId)
    const inserted = !job?.settled && insertTokenUsageEvent(db, event)
    if (job && !job.settled) {
      db.prepare(
        `UPDATE api_key_video_jobs SET settled = 1, next_poll_at_ms = NULL
         WHERE provider_name = ? AND request_id = ?`,
      ).run(provider, requestId)
    }
    db.exec("COMMIT")
    return inserted
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
}

async function writeTokenUsageEvent(
  event: PersistedTokenUsageEvent,
): Promise<boolean> {
  const db = await getDb()
  return (
      event.source === "provider"
        && event.endpoint === "videos_generations"
        && event.provider_name
        && event.upstream_request_id
    ) ?
      insertVideoUsageEvent(
        db,
        event,
        event.provider_name,
        event.upstream_request_id,
      )
    : insertTokenUsageEvent(db, event)
}

async function writeTokenUsageTiming(
  timing: Pick<RequestTiming, "id" | "firstTokenMs" | "durationMs" | "outcome">,
): Promise<void> {
  const db = await getDb()
  db.prepare(
    `
    UPDATE token_usage_events
    SET first_token_ms = ?, duration_ms = ?, request_outcome = ?
    WHERE request_id = ?
    `,
  ).run(timing.firstTokenMs, timing.durationMs, timing.outcome, timing.id)
}

export function enqueueTokenUsageWrite(event: PersistedTokenUsageEvent): void {
  if (!isTokenUsageStorageEnabled()) return

  const state = quotaState
  const id = event.api_key_id
  const costNanos = event.api_key_cost_nanos
  const at = event.created_at_ms

  const completion = (async () => {
    try {
      const inserted = await getWorker().execute("writeTokenUsageEvent", event)
      if (inserted && id && costNanos != null) {
        state?.ledger.add(id, costNanos, at)
      }
    } catch (error) {
      if (id) quotaWriteFailed = true
      consola.warn("Failed to record token usage", error)
    }
  })()

  // Writes already submitted when the ledger loads are included in its replay.
  // Track subsequent charges until SQLite confirms whether the row was new.
  if (!state || !id || costNanos == null || costNanos <= 0) return
  const pending = state.pending.get(id) ?? new Set<PendingCharge>()
  const charge = { at, costNanos, completion }
  pending.add(charge)
  state.pending.set(id, pending)
  void completion.then(() => {
    pending.delete(charge)
    if (pending.size === 0) state.pending.delete(id)
  })
}

export function enqueueTokenUsageTiming(timing: RequestTiming): void {
  if (!isTokenUsageStorageEnabled()) return
  const { id, firstTokenMs, durationMs, outcome } = timing
  void (async () => {
    try {
      await getWorker().execute("writeTokenUsageTiming", {
        id,
        firstTokenMs,
        durationMs,
        outcome,
      })
    } catch (error) {
      consola.warn("Failed to record token usage timing", error)
    }
  })()
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
  apiKeyId?: string | null,
) {
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

function createDailyIntervals(range: {
  endMs: number
  startMs: number
  apiKeyId?: string | null
}) {
  const intervals: Array<{
    date: string
    endMs: number
    startMs: number
    apiKeyId?: string | null
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

function rangePayload(range: {
  endMs: number
  startMs: number
  apiKeyId?: string | null
}) {
  return {
    end_ms: range.endMs,
    end_utc: new Date(range.endMs).toISOString(),
    start_ms: range.startMs,
    start_utc: new Date(range.startMs).toISOString(),
  }
}

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

function createCost(currency: string, totalCostNanos: number): TokenUsageCost {
  return {
    amount: totalCostNanos / COST_NANOS_PER_UNIT,
    currency,
    total_cost_nanos: totalCostNanos,
  }
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

function stringFromRow(row: SqliteRow, key: string): string {
  const value = row[key]
  return typeof value === "string" ? value : ""
}

function nullableStringFromRow(row: SqliteRow, key: string): string | null {
  const value = row[key]
  return typeof value === "string" ? value : null
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
  range: { endMs: number; startMs: number; apiKeyId?: string | null },
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
  range: { endMs: number; startMs: number; apiKeyId?: string | null },
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
  range: { endMs: number; startMs: number; apiKeyId?: string | null },
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
  range: { endMs: number; startMs: number; apiKeyId?: string | null },
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
  range: { endMs: number; startMs: number; apiKeyId?: string | null },
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
  intervals: Array<{
    date: string
    endMs: number
    startMs: number
    apiKeyId?: string | null
  }>,
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
  range: { endMs: number; startMs: number; apiKeyId?: string | null },
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
  intervals: Array<{
    date: string
    endMs: number
    startMs: number
    apiKeyId?: string | null
  }>,
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

async function queryTokenUsageSummary(
  period: TokenUsagePeriod,
  nowMs: number,
  apiKeyId?: string | null,
): Promise<TokenUsageSummary> {
  const db = await getDb()
  const range = getPeriodRangeFromDb(db, period, new Date(nowMs), apiKeyId)
  const totalsRow = getTotalsRow(db, range)

  return {
    byModel: getModelSummaries(db, range),
    period,
    range: rangePayload(range),
    totals: totalsFromRow(totalsRow, getCostRows(db, range)),
  }
}

async function queryTokenUsageDailySummary(
  period: TokenUsagePeriod,
  nowMs: number,
  apiKeyId?: string | null,
): Promise<TokenUsageDailySummary> {
  const db = await getDb()
  const range = getPeriodRangeFromDb(db, period, new Date(nowMs), apiKeyId)
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

async function queryTokenUsageEventsPage(
  input: TokenUsagePageInput,
  nowMs: number,
): Promise<TokenUsageEventsPage> {
  const page = Math.max(1, Math.floor(input.page))
  const pageSize = Math.min(100, Math.max(1, Math.floor(input.pageSize)))
  const offset = (page - 1) * pageSize
  const db = await getDb()
  const range = getPeriodRangeFromDb(
    db,
    input.period,
    new Date(nowMs),
    input.apiKeyId,
  )

  const totalRow = db
    .prepare(
      `
    SELECT COUNT(*) AS total
    FROM ${apiKeyUsageTable(range.apiKeyId)} AS token_usage_events
    WHERE created_at_ms >= ? AND created_at_ms < ?
  `,
    )
    .get(range.startMs, range.endMs)

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

async function queryTokenUsageSessionsPage(
  input: TokenUsagePageInput,
  nowMs: number,
): Promise<TokenUsageSessionsPage> {
  const page = Math.max(1, Math.floor(input.page))
  const pageSize = Math.min(100, Math.max(1, Math.floor(input.pageSize)))
  const db = await getDb()
  const range = getPeriodRangeFromDb(
    db,
    input.period,
    new Date(nowMs),
    input.apiKeyId,
  )
  const totalRow = db
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
    items: getSessionSummaries(db, range, pageSize, (page - 1) * pageSize),
    page,
    page_size: pageSize,
    period: input.period,
    range: rangePayload(range),
    total,
    total_pages: Math.max(1, Math.ceil(total / pageSize)),
  }
}

export async function getTokenUsageSummary(
  period: TokenUsagePeriod,
  apiKeyId?: string | null,
) {
  if (!isTokenUsageStorageEnabled()) return createEmptySummary(period)
  return getWorker().execute(
    "getTokenUsageSummary",
    period,
    Date.now(),
    apiKeyId,
  )
}

export async function getTokenUsageDailySummary(
  period: TokenUsagePeriod,
  apiKeyId?: string | null,
) {
  if (!isTokenUsageStorageEnabled()) return createEmptyDailySummary(period)
  return getWorker().execute(
    "getTokenUsageDailySummary",
    period,
    Date.now(),
    apiKeyId,
  )
}

export async function getTokenUsageEventsPage(input: TokenUsagePageInput) {
  if (!isTokenUsageStorageEnabled()) return createEmptyEventsPage(input)
  return getWorker().execute("getTokenUsageEventsPage", input, Date.now())
}

export async function getTokenUsageSessionsPage(input: TokenUsagePageInput) {
  if (!isTokenUsageStorageEnabled()) {
    return { ...createEmptyEventsPage(input), items: [] }
  }
  return getWorker().execute("getTokenUsageSessionsPage", input, Date.now())
}

export async function pruneTokenUsageEvents(options?: {
  nowMs?: number
  retentionDays?: number | null
}): Promise<number> {
  const retentionDays = resolveTokenUsageRetentionDays(
    options && "retentionDays" in options ?
      options.retentionDays
    : getTokenUsageRetentionDays(),
  )
  if (retentionDays === null || !isTokenUsageStorageEnabled()) return 0

  const cutoffMs = (options?.nowMs ?? Date.now()) - retentionDays * DAY_MS
  return getWorker().execute("pruneTokenUsageEvents", cutoffMs)
}

export async function startTokenUsageRetention(): Promise<void> {
  if (retentionStarted) return
  retentionStarted = true
  try {
    await pruneTokenUsageEvents()
  } catch (error) {
    consola.warn("Failed to prune token usage", error)
  }
  retentionTimer = setInterval(() => {
    void pruneTokenUsageEvents().catch((error: unknown) => {
      consola.warn("Failed to prune token usage", error)
    })
  }, TOKEN_USAGE_RETENTION_INTERVAL_MS)
  retentionTimer.unref?.()
}

function stopTokenUsageRetention(): void {
  if (retentionTimer) {
    clearInterval(retentionTimer)
    retentionTimer = undefined
  }
  retentionStarted = false
}

export function closeUsageStore(): Promise<void> {
  closing ??= (async () => {
    stopTokenUsageRetention()
    if (quotaTimer) clearInterval(quotaTimer)
    quotaTimer = undefined
    await stopVideoUsageSettlement?.()
    stopVideoUsageSettlement = undefined

    const current = worker
    // Settlements can still enqueue writes while the poll and worker drain.
    if (current) await current.waitForIdle()
    closingWorker = true
    try {
      await current?.execute("closeUsageDatabase")
    } finally {
      worker = undefined
      quotaState = undefined
      quotaWriteFailed = false
      await current?.terminate()
    }
  })().finally(() => {
    closingWorker = false
    closing = undefined
  })
  return closing
}

async function deleteExpiredUsageEvents(cutoffMs: number): Promise<number> {
  const db = await getDb()
  persistApiKeyQuotaLedger(db)
  const result = db
    .prepare("DELETE FROM token_usage_events WHERE created_at_ms < ?")
    .run(cutoffMs)
  return Number(result.changes)
}

async function closeUsageDatabase(): Promise<void> {
  await tokenUsageDbStore.close({
    beforeClose: (db) => {
      persistApiKeyQuotaLedger(db)
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      } catch {
        // Ignore WAL cleanup errors during shutdown.
      }
    },
  })
}

async function persistApiKeyQuotas(): Promise<void> {
  persistApiKeyQuotaLedger(await getDb())
}

async function readQuotaBuckets(dayStartMs: number, monthStartMs: number) {
  const ledger = readApiKeyQuotaLedger(await getDb())
  return ledger
    .snapshot()
    .filter(
      (bucket) =>
        bucket.period === "lifetime"
        || bucket.period_start_ms
          >= (bucket.period === "day" ? dayStartMs : monthStartMs),
    )
}

function apiKeyUsageTable(apiKeyId?: string | null): string {
  if (apiKeyId === undefined) return "token_usage_events"
  const filter =
    apiKeyId === null ? "IS NULL" : "= '" + apiKeyId.replaceAll("'", "''") + "'"
  return "(SELECT * FROM token_usage_events WHERE api_key_id " + filter + ")"
}

let quotaTimer: ReturnType<typeof setInterval> | undefined
let quotaWriteFailed = false

interface PendingCharge {
  at: number
  costNanos: number
  completion: Promise<void>
}

interface QuotaState {
  dayStartMs: number
  ledger: ApiKeyQuotaLedger
  pending: Map<string, Set<PendingCharge>>
  ready: Promise<void>
}

let quotaState: QuotaState | undefined

function loadQuotaState(): QuotaState {
  if (!isTokenUsageStorageEnabled())
    throw new Error("API key quotas require SQLite support")
  if (closing) throw new Error("SQLite usage store is closing")

  const now = Date.now()
  if (!quotaState || now < quotaState.dayStartMs) {
    // Older periods stay on disk and are restored if the clock moves back.
    const dayStartMs = apiKeyQuotaWindow("day", now).startMs
    const monthStartMs = apiKeyQuotaWindow("month", now).startMs
    const ledger = new ApiKeyQuotaLedger()
    const ready = getWorker()
      .execute("readQuotaBuckets", dayStartMs, monthStartMs)
      .then((buckets) => {
        ledger.restore(buckets)
        if (closing || quotaTimer) return
        quotaTimer = setInterval(() => {
          void flushApiKeyQuotas().catch((error: unknown) =>
            consola.warn("Failed to persist API key quotas", error),
          )
        }, 5000)
        quotaTimer.unref?.()
      })
      .catch((error: unknown) => {
        if (quotaState?.ready === ready) quotaState = undefined
        throw error
      })
    quotaState = { dayStartMs, ledger, pending: new Map(), ready }
  }
  return quotaState
}

export async function initializeApiKeyQuotas(): Promise<void> {
  await loadQuotaState().ready
}

export async function flushApiKeyQuotas(): Promise<void> {
  if (!isTokenUsageStorageEnabled()) return
  await getWorker().execute("flushApiKeyQuotas")
}

function readQuotaBalance(
  state: QuotaState,
  key: GatewayApiKeyConfig,
  now: number,
) {
  if (closing || quotaWriteFailed || worker?.failed)
    throw new Error("API key usage could not be persisted")
  const quota = key.quota
  const period = quota?.period ?? "lifetime"
  const window = apiKeyQuotaWindow(period, now)
  const usedCostNanos = state.ledger.used(key.id, period, window)
  return {
    ...window,
    usedCostNanos,
    remainingCostNanos:
      quota ? Math.max(0, toCostNanos(quota.amount) - usedCostNanos) : null,
  }
}

async function readSettledQuotaBalance(
  key: GatewayApiKeyConfig,
): Promise<ReturnType<typeof readQuotaBalance>> {
  const state = loadQuotaState()
  await state.ready
  let pending = state.pending.get(key.id)
  while (pending?.size) {
    await Promise.all(Array.from(pending, (charge) => charge.completion))
    pending = state.pending.get(key.id)
  }
  const now = Date.now()
  if (state !== quotaState || now < state.dayStartMs)
    return readSettledQuotaBalance(key)
  return readQuotaBalance(state, key, now)
}

export async function getApiKeyQuotaUsage(
  key: GatewayApiKeyConfig,
): Promise<Omit<ApiKeyQuotaUsage, "id">> {
  const { usedCostNanos, remainingCostNanos, endMs } =
    await readSettledQuotaBalance(key)
  return {
    usedAmount: usedCostNanos / COST_NANOS_PER_UNIT,
    remainingAmount:
      remainingCostNanos === null ? null : (
        remainingCostNanos / COST_NANOS_PER_UNIT
      ),
    resetsAt: endMs,
  }
}

export async function getApiKeyQuotaAdmission(
  key: GatewayApiKeyConfig,
): Promise<ReturnType<typeof readQuotaBalance>> {
  const state = loadQuotaState()
  await state.ready
  const now = Date.now()
  if (state !== quotaState || now < state.dayStartMs)
    return getApiKeyQuotaAdmission(key)
  const balance = readQuotaBalance(state, key, now)
  const { startMs, endMs, remainingCostNanos } = balance
  const pending = state.pending.get(key.id)
  if (!pending || !remainingCostNanos) return balance

  let pendingCost = 0
  for (const charge of pending) {
    if (charge.at >= startMs && (endMs === null || charge.at < endMs))
      pendingCost += charge.costNanos
  }
  // Only a charge that could exhaust this key must be confirmed before
  // admitting it. A duplicate may settle without consuming any balance.
  return pendingCost >= remainingCostNanos ?
      readSettledQuotaBalance(key)
    : balance
}

export interface VideoUsageJob {
  provider_name: string
  request_id: string
  api_key_id: string
  api_key_name: string | null
  model: string
  trace_id: string
  session_id: string
  settled: number
  next_poll_at_ms: number | null
}

function initializeVideoUsageJobs(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_key_video_jobs (
      provider_name TEXT NOT NULL,
      request_id TEXT NOT NULL,
      api_key_id TEXT NOT NULL,
      api_key_name TEXT,
      model TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      settled INTEGER NOT NULL DEFAULT 0,
      next_poll_at_ms INTEGER,
      PRIMARY KEY (provider_name, request_id)
    )
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_api_key_video_jobs_due
    ON api_key_video_jobs(provider_name, next_poll_at_ms)
    WHERE next_poll_at_ms IS NOT NULL
  `)
  // Keep ownership and settlement for jobs accepted before the queue existed.
  db.exec(`
    INSERT INTO api_key_video_jobs (
      provider_name, request_id, api_key_id, api_key_name, model, trace_id,
      session_id, settled, next_poll_at_ms
    )
    SELECT pending.provider_name, substr(pending.upstream_request_id, 9),
      pending.api_key_id, pending.api_key_name, pending.model, pending.trace_id,
      pending.session_id, completed.id IS NOT NULL,
      CASE WHEN completed.id IS NULL THEN pending.created_at_ms ELSE NULL END
    FROM token_usage_events AS pending
    LEFT JOIN token_usage_events AS completed
      ON completed.source = pending.source
      AND completed.provider_name = pending.provider_name
      AND completed.endpoint = pending.endpoint
      AND completed.upstream_request_id = substr(pending.upstream_request_id, 9)
    WHERE pending.source = 'provider'
      AND pending.endpoint = 'videos_generations'
      AND pending.provider_name IS NOT NULL
      AND pending.api_key_id IS NOT NULL
      AND pending.total_cost_nanos = 0
      AND pending.upstream_request_id GLOB 'pending:*'
    ON CONFLICT (provider_name, request_id) DO NOTHING
  `)
}

function readVideoUsageJob(
  db: SqliteDatabase,
  provider: string,
  requestId: string,
): VideoUsageJob | undefined {
  return (
    db
      .prepare<VideoUsageJob>(
        "SELECT * FROM api_key_video_jobs WHERE provider_name = ? AND request_id = ?",
      )
      .get(provider, requestId) ?? undefined
  )
}

async function lookupVideoUsageJob(
  provider: string,
  requestId: string,
): Promise<VideoUsageJob | undefined> {
  return readVideoUsageJob(await getDb(), provider, requestId)
}

async function writeVideoUsageJob(
  job: Omit<VideoUsageJob, "settled" | "next_poll_at_ms">,
): Promise<void> {
  const db = await getDb()
  db.prepare(
    `
    INSERT INTO api_key_video_jobs (
      provider_name, request_id, api_key_id, api_key_name, model, trace_id,
      session_id, next_poll_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (provider_name, request_id) DO NOTHING
  `,
  ).run(
    job.provider_name,
    job.request_id,
    job.api_key_id,
    job.api_key_name,
    job.model,
    job.trace_id,
    job.session_id,
    Date.now() + VIDEO_USAGE_POLL_INTERVAL_MS,
  )
}

async function queryDueVideoUsageJobs(
  provider: string,
  now: number,
  limit: number,
): Promise<Array<VideoUsageJob>> {
  const db = await getDb()
  return db
    .prepare<VideoUsageJob>(
      `
    SELECT * FROM api_key_video_jobs
    WHERE provider_name = ? AND next_poll_at_ms <= ?
    ORDER BY next_poll_at_ms, request_id
    LIMIT ?
  `,
    )
    .all(provider, now, limit)
}

async function updateVideoUsageJobPoll(
  job: VideoUsageJob,
  nextPollAt: number,
): Promise<boolean> {
  const db = await getDb()
  const result = db
    .prepare(
      `
    UPDATE api_key_video_jobs SET next_poll_at_ms = ?
    WHERE provider_name = ? AND request_id = ? AND next_poll_at_ms = ?
  `,
    )
    .run(nextPollAt, job.provider_name, job.request_id, job.next_poll_at_ms)
  return Boolean(result.changes)
}

async function clearVideoUsageJobPoll(job: VideoUsageJob): Promise<void> {
  const db = await getDb()
  db.prepare(
    `
    UPDATE api_key_video_jobs SET next_poll_at_ms = NULL
    WHERE provider_name = ? AND request_id = ?
  `,
  ).run(job.provider_name, job.request_id)
}

export async function getVideoUsageJob(provider: string, requestId: string) {
  if (!isTokenUsageStorageEnabled()) return undefined
  return getWorker().execute("getVideoUsageJob", provider, requestId)
}

export async function saveVideoUsageJob(
  job: Omit<VideoUsageJob, "settled" | "next_poll_at_ms">,
): Promise<void> {
  if (!isTokenUsageStorageEnabled()) return
  await getWorker().execute("saveVideoUsageJob", job)
}

export async function getDueVideoUsageJobs(
  provider: string,
  now: number,
  limit: number,
) {
  return getWorker().execute("getDueVideoUsageJobs", provider, now, limit)
}

export async function deferVideoUsageJob(
  job: VideoUsageJob,
  nextPollAtMs: number,
) {
  return getWorker().execute("deferVideoUsageJob", job, nextPollAtMs)
}

export async function stopPollingVideoUsageJob(
  job: VideoUsageJob,
): Promise<void> {
  await getWorker().execute("stopPollingVideoUsageJob", job)
}

export function startVideoUsageSettlement(
  poll: (signal: AbortSignal) => Promise<void>,
): void {
  if (stopVideoUsageSettlement || !isTokenUsageStorageEnabled()) return
  const controller = new AbortController()
  let activePoll: Promise<void> | undefined
  const pollIfIdle = () => {
    if (activePoll) return
    activePoll = poll(controller.signal)
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          consola.warn("Failed to check pending video usage", error)
      })
      .finally(() => {
        activePoll = undefined
      })
  }
  const timer = setInterval(pollIfIdle, VIDEO_USAGE_POLL_INTERVAL_MS)
  timer.unref?.()
  stopVideoUsageSettlement = async () => {
    clearInterval(timer)
    controller.abort()
    await activePoll
  }
  pollIfIdle()
}

// The worker serializes these database operations. Callers use the exports above.
export const usageDatabaseOperations = {
  writeTokenUsageEvent,
  writeTokenUsageTiming,
  getTokenUsageSummary: queryTokenUsageSummary,
  getTokenUsageDailySummary: queryTokenUsageDailySummary,
  getTokenUsageEventsPage: queryTokenUsageEventsPage,
  getTokenUsageSessionsPage: queryTokenUsageSessionsPage,
  pruneTokenUsageEvents: deleteExpiredUsageEvents,
  closeUsageDatabase,
  flushApiKeyQuotas: persistApiKeyQuotas,
  readQuotaBuckets,
  getVideoUsageJob: lookupVideoUsageJob,
  saveVideoUsageJob: writeVideoUsageJob,
  getDueVideoUsageJobs: queryDueVideoUsageJobs,
  deferVideoUsageJob: updateVideoUsageJobPoll,
  stopPollingVideoUsageJob: clearVideoUsageJobPoll,
}
