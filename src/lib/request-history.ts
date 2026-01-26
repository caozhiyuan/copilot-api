import type { Database, SQLQueryBindings } from "bun:sqlite"
import type { Context } from "hono"

import consola from "consola"

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import type { EmbeddingResponse } from "~/services/copilot/create-embeddings"
import type {
  ResponseStreamEvent,
  ResponsesResult,
  ResponseUsage,
} from "~/services/copilot/create-responses"

import { getAdminDb, getAdminDbPath, getAdminDbUserVersion } from "./admin-db"

const DEFAULT_RETENTION_DAYS = 14
const DEFAULT_MAX_ROWS = 200_000

const INSERT_WARN_THROTTLE_MS = 30_000

let lastInsertWarnAtMs = 0
let suppressedInsertWarnCount = 0

function warnInsertFailure(error: unknown): void {
  const now = Date.now()

  if (now - lastInsertWarnAtMs < INSERT_WARN_THROTTLE_MS) {
    suppressedInsertWarnCount++
    return
  }

  const suppressed = suppressedInsertWarnCount
  suppressedInsertWarnCount = 0
  lastInsertWarnAtMs = now

  const suffix =
    suppressed > 0 ? ` (suppressed ${suppressed} similar errors)` : ""
  consola.warn(`Failed to insert request log${suffix}`, error)
}

function toDbNull<T>(value: T | null | undefined): T | null {
  return value === undefined ? null : value
}

function toDbBool(value: boolean | undefined): 0 | 1 | null {
  if (value === true) return 1
  if (value === false) return 0
  return null
}

export type ClientIpInfo = {
  ip?: string
  source?: string
}

export function getClientIpInfo(c: Context): ClientIpInfo {
  const cf = c.req.header("cf-connecting-ip")
  if (cf) return { ip: cf.trim(), source: "cf-connecting-ip" }

  const xff = c.req.header("x-forwarded-for")
  if (xff) {
    const first = xff.split(",")[0]?.trim()
    if (first) return { ip: first, source: "x-forwarded-for" }
  }

  const xri = c.req.header("x-real-ip")
  if (xri) return { ip: xri.trim(), source: "x-real-ip" }

  return {}
}

export type NormalizedUsage = {
  tokensInput?: number
  tokensOutput?: number
  tokensTotal?: number
  tokensCachedInput?: number
  usageJson?: string
}

export function normalizeChatCompletionsUsage(
  usage?: ChatCompletionResponse["usage"] | ChatCompletionChunk["usage"],
): NormalizedUsage {
  if (!usage) return {}

  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0
  const prompt = usage.prompt_tokens
  const completion = usage.completion_tokens
  const total = usage.total_tokens

  return {
    tokensCachedInput: cached,
    tokensInput: Math.max(0, prompt - cached),
    tokensOutput: completion,
    tokensTotal: total,
    usageJson: JSON.stringify(usage),
  }
}

export function normalizeResponsesUsage(
  usage?: ResponseUsage | null,
): NormalizedUsage {
  if (!usage) return {}

  const cached = usage.input_tokens_details?.cached_tokens ?? 0
  const input = usage.input_tokens
  const output = usage.output_tokens ?? 0
  const total = usage.total_tokens

  return {
    tokensCachedInput: cached,
    tokensInput: Math.max(0, input - cached),
    tokensOutput: output,
    tokensTotal: total,
    usageJson: JSON.stringify(usage),
  }
}

type AnthropicUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  service_tier?: "standard" | "priority" | "batch"
}

export function normalizeMessagesUsage(
  usage?: AnthropicUsage | null,
): NormalizedUsage {
  if (!usage) return {}

  const cached = usage.cache_read_input_tokens ?? 0
  const input = usage.input_tokens
  const output = usage.output_tokens
  const hasInput = typeof input === "number"
  const hasOutput = typeof output === "number"
  const tokensInput = hasInput ? Math.max(0, input - cached) : undefined
  const tokensOutput = hasOutput ? output : undefined
  const tokensTotal =
    hasInput || hasOutput ? (input ?? 0) + (output ?? 0) : undefined

  return {
    tokensCachedInput: cached,
    tokensInput,
    tokensOutput,
    tokensTotal,
    usageJson: JSON.stringify(usage),
  }
}

export function normalizeEmbeddingsUsage(
  usage?: EmbeddingResponse["usage"],
): NormalizedUsage {
  if (!usage) return {}

  return {
    tokensCachedInput: 0,
    tokensInput: usage.prompt_tokens,
    tokensOutput: 0,
    tokensTotal: usage.total_tokens,
    usageJson: JSON.stringify(usage),
  }
}

export type RequestLogInsert = {
  requestId: string
  startedAtMs: number
  finishedAtMs?: number
  durationMs?: number
  ttfbMs?: number

  method: string
  path: string
  upstreamEndpoint?: string
  stream: boolean

  accountId?: string
  accountType?: string
  costUnits?: number
  clientModel?: string
  upstreamModel?: string

  clientIp?: string
  clientIpSource?: string
  userAgent?: string

  userId?: string
  safetyIdentifier?: string
  promptCacheKey?: string
  initiator?: "agent" | "user"
  upstreamRequestId?: string

  tokensInput?: number
  tokensOutput?: number
  tokensTotal?: number
  tokensCachedInput?: number
  usageJson?: string

  premiumRemainingBefore?: number
  premiumRemainingAfter?: number
  premiumRemainingDiff?: number
  premiumUnlimitedBefore?: boolean
  premiumUnlimitedAfter?: boolean

  httpStatus?: number
  errorName?: string
  errorStatus?: number
  errorMessage?: string
  selectionFailureReason?: string
}

export type RequestLogRow = {
  id: number
  request_id: string
  started_at_ms: number
  finished_at_ms: number | null
  duration_ms: number | null
  ttfb_ms: number | null

  method: string
  path: string
  upstream_endpoint: string | null
  stream: number

  account_id: string | null
  account_type: string | null
  cost_units: number | null
  client_model: string | null
  upstream_model: string | null

  client_ip: string | null
  client_ip_source: string | null
  user_agent: string | null

  user_id: string | null
  safety_identifier: string | null
  prompt_cache_key: string | null
  initiator: string | null
  upstream_request_id: string | null

  tokens_input: number | null
  tokens_output: number | null
  tokens_total: number | null
  tokens_cached_input: number | null
  usage_json: string | null

  premium_remaining_before: number | null
  premium_remaining_after: number | null
  premium_remaining_diff: number | null
  premium_unlimited_before: number | null
  premium_unlimited_after: number | null

  http_status: number | null
  error_name: string | null
  error_status: number | null
  error_message: string | null
  selection_failure_reason: string | null
}

export type RequestLogQuery = {
  limit: number
  cursorId?: number

  accountId?: string
  upstreamModel?: string
  clientModel?: string
  upstreamEndpoint?: string
  path?: string
  status?: number
  hasError?: boolean
  fromMs?: number
  toMs?: number
}

export type SessionUsageKey = {
  promptCacheKey: string
  safetyIdentifier: string
  clientModel: string
}

export type RequestLogQueryResult = {
  items: Array<RequestLogRow>
  nextCursorId?: number
  hasMore: boolean
}

export type AccountStatsRow = {
  account_id: string
  request_count: number
  error_count: number
  tokens_total: number
  avg_duration_ms: number
  last_request_at_ms: number
}

export class RequestHistoryStore {
  private readonly db: Database
  private readonly insertStmt: ReturnType<Database["query"]>

  private readonly getByRequestIdStmt: ReturnType<Database["query"]>
  private readonly getLastCompletedUsageBySessionStmt: ReturnType<
    Database["query"]
  >

  constructor(db: Database) {
    this.db = db

    this.insertStmt = db.query(`
      INSERT INTO request_log (
        request_id,
        started_at_ms,
        finished_at_ms,
        duration_ms,
        ttfb_ms,
        method,
        path,
        upstream_endpoint,
        stream,
        account_id,
        account_type,
        cost_units,
        client_model,
        upstream_model,
        client_ip,
        client_ip_source,
        user_agent,
        user_id,
        safety_identifier,
        prompt_cache_key,
        initiator,
        upstream_request_id,
        tokens_input,
        tokens_output,
        tokens_total,
        tokens_cached_input,
        usage_json,
        premium_remaining_before,
        premium_remaining_after,
        premium_remaining_diff,
        premium_unlimited_before,
        premium_unlimited_after,
        http_status,
        error_name,
        error_status,
        error_message,
        selection_failure_reason
      ) VALUES (
        ?,?,?,?,?,?,?,?,
        ?,?,?,?,?,?,?,?,
        ?,?,?,?,?,?,?,?,
        ?,?,?,?,?,?,?,?,
        ?,?,?,?,?
      );
    `)

    this.getByRequestIdStmt = db.query(
      "SELECT * FROM request_log WHERE request_id = ? LIMIT 1;",
    )

    this.getLastCompletedUsageBySessionStmt = db.query(`
      SELECT
        tokens_input,
        tokens_output,
        tokens_total,
        tokens_cached_input
      FROM request_log
      WHERE prompt_cache_key = ?
        AND safety_identifier = ?
        AND client_model = ?
        AND finished_at_ms IS NOT NULL
        AND tokens_input IS NOT NULL
      ORDER BY finished_at_ms DESC
      LIMIT 1;
    `)
  }

  insert(record: RequestLogInsert): void {
    try {
      const args = [
        record.requestId,
        record.startedAtMs,
        toDbNull(record.finishedAtMs),
        toDbNull(record.durationMs),
        toDbNull(record.ttfbMs),

        record.method,
        record.path,
        toDbNull(record.upstreamEndpoint),
        record.stream ? 1 : 0,

        toDbNull(record.accountId),
        toDbNull(record.accountType),
        toDbNull(record.costUnits),
        toDbNull(record.clientModel),
        toDbNull(record.upstreamModel),

        toDbNull(record.clientIp),
        toDbNull(record.clientIpSource),
        toDbNull(record.userAgent),
        toDbNull(record.userId),
        toDbNull(record.safetyIdentifier),
        toDbNull(record.promptCacheKey),
        toDbNull(record.initiator),
        toDbNull(record.upstreamRequestId),

        toDbNull(record.tokensInput),
        toDbNull(record.tokensOutput),
        toDbNull(record.tokensTotal),
        toDbNull(record.tokensCachedInput),
        toDbNull(record.usageJson),

        toDbNull(record.premiumRemainingBefore),
        toDbNull(record.premiumRemainingAfter),
        toDbNull(record.premiumRemainingDiff),
        toDbBool(record.premiumUnlimitedBefore),
        toDbBool(record.premiumUnlimitedAfter),

        toDbNull(record.httpStatus),
        toDbNull(record.errorName),
        toDbNull(record.errorStatus),
        toDbNull(record.errorMessage),
        toDbNull(record.selectionFailureReason),
      ] as const

      this.insertStmt.run(...args)
    } catch (error) {
      warnInsertFailure(error)
    }
  }

  getByRequestId(requestId: string): RequestLogRow | null {
    try {
      const row = this.getByRequestIdStmt.get(requestId) as
        | RequestLogRow
        | null
        | undefined
      return row ?? null
    } catch (error) {
      consola.debug("Failed to fetch request log by request_id", error)
      return null
    }
  }

  getLastCompletedUsageBySession(
    session: SessionUsageKey,
  ): NormalizedUsage | null {
    if (
      !session.promptCacheKey
      || !session.safetyIdentifier
      || !session.clientModel
    ) {
      return null
    }

    try {
      const row = this.getLastCompletedUsageBySessionStmt.get(
        session.promptCacheKey,
        session.safetyIdentifier,
        session.clientModel,
      ) as
        | {
            tokens_input: number | null
            tokens_output: number | null
            tokens_total: number | null
            tokens_cached_input: number | null
          }
        | null
        | undefined

      if (!row || row.tokens_input === null) {
        return null
      }

      const tokensOutput =
        row.tokens_output === null ? undefined : row.tokens_output
      const tokensTotal =
        row.tokens_total === null ? undefined : row.tokens_total
      const tokensCachedInput =
        row.tokens_cached_input === null ? undefined : row.tokens_cached_input

      return {
        tokensInput: row.tokens_input,
        tokensOutput,
        tokensTotal,
        tokensCachedInput,
      }
    } catch (error) {
      consola.debug("Failed to fetch last completed usage by session", error)
      return null
    }
  }

  query(params: RequestLogQuery): RequestLogQueryResult {
    const limit = Math.max(1, Math.min(params.limit, 200))

    const where: Array<string> = []
    const values: Array<SQLQueryBindings> = []

    if (params.cursorId !== undefined) {
      where.push("id < ?")
      values.push(params.cursorId)
    }

    if (params.accountId) {
      where.push("account_id = ?")
      values.push(params.accountId)
    }

    if (params.upstreamModel) {
      where.push("upstream_model = ?")
      values.push(params.upstreamModel)
    }

    if (params.clientModel) {
      where.push("client_model = ?")
      values.push(params.clientModel)
    }

    if (params.upstreamEndpoint) {
      where.push("upstream_endpoint = ?")
      values.push(params.upstreamEndpoint)
    }

    if (params.path) {
      where.push("path = ?")
      values.push(params.path)
    }

    if (params.status !== undefined) {
      where.push("http_status = ?")
      values.push(params.status)
    }

    if (params.hasError === true) {
      where.push("http_status >= 400")
    }
    if (params.hasError === false) {
      where.push("http_status < 400")
    }

    if (params.fromMs !== undefined) {
      where.push("started_at_ms >= ?")
      values.push(params.fromMs)
    }

    if (params.toMs !== undefined) {
      where.push("started_at_ms <= ?")
      values.push(params.toMs)
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""

    const sql = `
      SELECT *
      FROM request_log
      ${whereSql}
      ORDER BY id DESC
      LIMIT ?;
    `

    const rows = this.db
      .query(sql)
      .all(...values, limit + 1) as Array<RequestLogRow>

    const items = rows.slice(0, limit)
    const hasMore = rows.length > limit
    const nextCursorId = hasMore ? items.at(-1)?.id : undefined

    return {
      items,
      nextCursorId,
      hasMore,
    }
  }

  getAccountStatsSince(
    sinceMs: number,
  ): Record<string, AccountStatsRow | undefined> {
    try {
      const sql = `
        SELECT
          account_id,
          COUNT(*) AS request_count,
          SUM(CASE WHEN http_status >= 400 THEN 1 ELSE 0 END) AS error_count,
          COALESCE(SUM(tokens_total), 0) AS tokens_total,
          COALESCE(AVG(duration_ms), 0) AS avg_duration_ms,
          COALESCE(MAX(started_at_ms), 0) AS last_request_at_ms
        FROM request_log
        WHERE started_at_ms >= ? AND account_id IS NOT NULL
        GROUP BY account_id;
      `

      const rows = this.db.query(sql).all(sinceMs) as Array<AccountStatsRow>
      const map: Record<string, AccountStatsRow | undefined> = {}
      for (const row of rows) {
        map[row.account_id] = row
      }
      return map
    } catch (error) {
      consola.debug("Failed to fetch account stats", error)
      return {}
    }
  }

  cleanupRetention(
    retentionDays: number = DEFAULT_RETENTION_DAYS,
    maxRows: number = DEFAULT_MAX_ROWS,
  ): void {
    try {
      const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000
      this.db
        .query("DELETE FROM request_log WHERE started_at_ms < ?;")
        .run(cutoffMs)

      const countRow = this.db
        .query("SELECT COUNT(*) AS c FROM request_log;")
        .get() as { c: number }

      const count = countRow.c
      if (count <= maxRows) {
        return
      }

      const offset = maxRows - 1
      const threshold = this.db
        .query("SELECT id FROM request_log ORDER BY id DESC LIMIT 1 OFFSET ?;")
        .get(offset) as { id?: number } | null

      const thresholdId = threshold?.id
      if (!thresholdId) {
        return
      }

      this.db.query("DELETE FROM request_log WHERE id < ?;").run(thresholdId)
    } catch (error) {
      consola.debug("Failed to cleanup request_log retention", error)
    }
  }

  meta(): {
    dbPath: string
    userVersion: number
    retentionDays: number
    maxRows: number
  } {
    return {
      dbPath: getAdminDbPath(),
      userVersion: getAdminDbUserVersion(this.db),
      retentionDays: DEFAULT_RETENTION_DAYS,
      maxRows: DEFAULT_MAX_ROWS,
    }
  }
}

export type RequestHistoryStoreApi = {
  insert(record: RequestLogInsert): void
  getByRequestId(requestId: string): RequestLogRow | null
  getLastCompletedUsageBySession(
    session: SessionUsageKey,
  ): NormalizedUsage | null
  query(params: RequestLogQuery): RequestLogQueryResult
  getAccountStatsSince(
    sinceMs: number,
  ): Record<string, AccountStatsRow | undefined>
  cleanupRetention(retentionDays?: number, maxRows?: number): void
  meta(): {
    dbPath: string
    userVersion: number
    retentionDays: number
    maxRows: number
  }
}

const STORE_INIT_WARN_THROTTLE_MS = 30_000
const STORE_INIT_RETRY_DELAY_MS = 30_000

let lastStoreInitWarnAtMs = 0
let suppressedStoreInitWarnCount = 0
let nextStoreRetryAtMs = 0

function warnStoreInitFailure(error: unknown): void {
  const now = Date.now()

  if (now - lastStoreInitWarnAtMs < STORE_INIT_WARN_THROTTLE_MS) {
    suppressedStoreInitWarnCount++
    return
  }

  const suppressed = suppressedStoreInitWarnCount
  suppressedStoreInitWarnCount = 0
  lastStoreInitWarnAtMs = now

  const suffix =
    suppressed > 0 ? ` (suppressed ${suppressed} similar errors)` : ""
  consola.warn(`Request history store is disabled${suffix}`, error)
}

const disabledStore: RequestHistoryStoreApi = {
  insert: () => {},
  getByRequestId: () => null,
  getLastCompletedUsageBySession: () => null,
  query: () => ({ items: [], hasMore: false }),
  getAccountStatsSince: () => ({}),
  cleanupRetention: () => {},
  meta: () => ({
    dbPath: getAdminDbPath(),
    userVersion: 0,
    retentionDays: DEFAULT_RETENTION_DAYS,
    maxRows: DEFAULT_MAX_ROWS,
  }),
}

let sharedStore: RequestHistoryStoreApi | null = null
let maintenanceStarted = false

export function getRequestHistoryStore(): RequestHistoryStoreApi {
  if (sharedStore) {
    return sharedStore
  }

  const now = Date.now()
  if (now < nextStoreRetryAtMs) {
    return disabledStore
  }

  try {
    sharedStore = new RequestHistoryStore(getAdminDb())

    if (!maintenanceStarted) {
      maintenanceStarted = true

      // Run once at startup.
      sharedStore.cleanupRetention()

      // Then daily.
      setInterval(
        () => {
          sharedStore?.cleanupRetention()
        },
        24 * 60 * 60 * 1000,
      )
    }

    return sharedStore
  } catch (error) {
    nextStoreRetryAtMs = now + STORE_INIT_RETRY_DELAY_MS
    warnStoreInitFailure(error)
    return disabledStore
  }
}

export function extractResponsesUsageFromStreamEvent(
  event: ResponseStreamEvent,
): NormalizedUsage {
  if (
    event.type === "response.completed"
    || event.type === "response.incomplete"
  ) {
    return normalizeResponsesUsage(event.response.usage)
  }

  if (event.type === "response.failed") {
    return normalizeResponsesUsage(event.response.usage)
  }

  return {}
}

export function extractResponsesUsageFromResult(
  result: ResponsesResult,
): NormalizedUsage {
  return normalizeResponsesUsage(result.usage)
}
