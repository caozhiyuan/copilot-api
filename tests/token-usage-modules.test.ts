import { afterEach, describe, expect, test } from "bun:test"

import {
  flushApiKeyQuotas,
  persistApiKeyQuotas,
  readQuotaBuckets,
} from "~/lib/auth/api-key-quota-runtime"
import { readApiKeyQuotaLedger } from "~/lib/auth/api-key-quota-store"
import { openSqliteDatabase, type SqliteDatabase } from "~/lib/storage/sqlite"
import {
  apiKeyUsageTable,
  closeUsageDatabase,
  getUsageDb,
  initializeTokenUsageDb,
} from "~/lib/token-usage/db"
import {
  deleteExpiredUsageEvents,
  writeTokenUsageEvent,
  writeTokenUsageTiming,
} from "~/lib/token-usage/events-db"
import {
  addTotals,
  createCost,
  createDailyIntervals,
  createEmptyDailySummary,
  createEmptyEventsPage,
  createEmptySummary,
  createEmptyTotals,
  getPeriodRange,
  getPeriodRangeFromDb,
  rangePayload,
} from "~/lib/token-usage/period"
import {
  queryTokenUsageDailySummary,
  queryTokenUsageEventsPage,
  queryTokenUsageSessionsPage,
  queryTokenUsageSummary,
} from "~/lib/token-usage/queries"
import {
  pruneTokenUsageEvents,
  startTokenUsageRetention,
} from "~/lib/token-usage/retention"
import { closeUsageStore } from "~/lib/token-usage/runtime"
import type {
  PersistedTokenUsageEvent,
  TokenUsagePeriod,
} from "~/lib/types/token-usage"
import {
  clearVideoUsageJobPollRow,
  initializeVideoUsageJobs,
  queryDueVideoUsageJobRows,
  readVideoUsageJob,
  updateVideoUsageJobPollRow,
  writeVideoUsageJobRow,
} from "~/lib/video-settlement/db"

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"
const openDatabases: Array<SqliteDatabase> = []

afterEach(async () => {
  for (const db of openDatabases.splice(0)) {
    db.close?.()
  }
  await closeUsageStore()
  Reflect.deleteProperty(process.env, DB_PATH_ENV)
})

async function createMemoryUsageDb(): Promise<SqliteDatabase> {
  const db = await openSqliteDatabase(":memory:")
  openDatabases.push(db)
  initializeTokenUsageDb(db)
  return db
}

function makeEvent(
  overrides: Partial<PersistedTokenUsageEvent> = {},
): PersistedTokenUsageEvent {
  const createdAtMs =
    overrides.created_at_ms ?? Date.parse("2026-06-15T12:00:00.000Z")
  return {
    api_key_cost_nanos: null,
    api_key_id: null,
    api_key_name: null,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cost_currency: "USD",
    cost_source: "pricing",
    created_at_ms: createdAtMs,
    created_at_utc: new Date(createdAtMs).toISOString(),
    duration_ms: 1200,
    endpoint: "responses",
    first_token_ms: 200,
    input_tokens: 100,
    model: "gpt-5.6",
    output_tokens: 50,
    provider_name: "codex",
    request_id: "req-1",
    request_outcome: "completed",
    session_id: "sess-1",
    source: "provider",
    total_cost_nanos: 1_500_000,
    total_nano_aiu: null,
    total_tokens: 150,
    trace_id: "trace-1",
    upstream_request_id: null,
    user_agent: "test-agent/1.0",
    user_id: "user-1",
    ...overrides,
  }
}

describe("token usage db module", () => {
  test("initializes and migrates legacy token_usage_events schema", async () => {
    const db = await openSqliteDatabase(":memory:")
    openDatabases.push(db)
    db.exec(`
      CREATE TABLE token_usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at_ms INTEGER NOT NULL,
        created_at_utc TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        session_id TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        provider_name TEXT,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0
      )
    `)

    initializeTokenUsageDb(db)
    const columns = db
      .prepare("PRAGMA table_info(token_usage_events)")
      .all()
      .map((row) => String(row.name))

    expect(columns).toContain("api_key_id")
    expect(columns).toContain("api_key_cost_nanos")
    expect(columns).toContain("request_id")
    expect(columns).toContain("upstream_request_id")
    expect(columns).toContain("first_token_ms")
    expect(columns).toContain("duration_ms")
    expect(columns).toContain("request_outcome")
    expect(columns).toContain("user_agent")
  })

  test("builds scoped apiKeyUsageTable SQL and guards worker-only getUsageDb", async () => {
    expect(apiKeyUsageTable(undefined)).toBe("token_usage_events")
    expect(apiKeyUsageTable(null)).toBe(
      "(SELECT * FROM token_usage_events WHERE api_key_id IS NULL)",
    )
    expect(apiKeyUsageTable("key'1")).toBe(
      "(SELECT * FROM token_usage_events WHERE api_key_id = 'key''1')",
    )

    await closeUsageDatabase()
    let workerError: unknown
    try {
      await getUsageDb()
    } catch (error) {
      workerError = error
    }
    expect(workerError).toBeInstanceOf(Error)
    expect((workerError as Error).message).toBe(
      "SQLite usage database requires a worker",
    )
    // Clear the cached rejected promise on tokenUsageDbStore.
    try {
      await closeUsageDatabase()
    } catch {
      // Expected because getDb cached the non-worker rejection.
    }
  })
})

describe("token usage period helpers", () => {
  test("computes ranges, daily intervals, empty payloads and merged totals", async () => {
    const now = new Date(2026, 5, 17, 14, 30, 0, 0)
    const nowMs = now.getTime()

    expect(getPeriodRange("lifetime", now)).toEqual({
      endMs: nowMs + 1,
      startMs: nowMs + 1,
    })
    expect(getPeriodRange("today", now).startMs).toBe(
      new Date(2026, 5, 17, 0, 0, 0, 0).getTime(),
    )
    expect(getPeriodRange("this_week", now).startMs).toBe(
      new Date(2026, 5, 15, 0, 0, 0, 0).getTime(),
    )
    expect(getPeriodRange("last_7_days", now).startMs).toBe(
      new Date(2026, 5, 11, 0, 0, 0, 0).getTime(),
    )
    expect(getPeriodRange("this_month", now).startMs).toBe(
      new Date(2026, 5, 1, 0, 0, 0, 0).getTime(),
    )
    expect(getPeriodRange("last_30_days", now).startMs).toBe(
      new Date(2026, 4, 19, 0, 0, 0, 0).getTime(),
    )
    expect(getPeriodRange("unexpected" as TokenUsagePeriod, now).startMs).toBe(
      new Date(2026, 5, 17, 0, 0, 0, 0).getTime(),
    )

    const db = await createMemoryUsageDb()
    expect(getPeriodRangeFromDb(db, "lifetime", now)).toEqual({
      apiKeyId: undefined,
      endMs: nowMs + 1,
      startMs: nowMs + 1,
    })
    expect(getPeriodRangeFromDb(db, "today", now, "k1").apiKeyId).toBe("k1")

    const earliestMs = new Date(2026, 5, 15, 8, 0, 0, 0).getTime()
    await writeTokenUsageEvent(
      makeEvent({ api_key_id: "k1", created_at_ms: earliestMs }),
      db,
    )
    expect(getPeriodRangeFromDb(db, "lifetime", now, "k1")).toEqual({
      apiKeyId: "k1",
      endMs: nowMs + 1,
      startMs: earliestMs,
    })

    const intervals = createDailyIntervals({
      endMs: nowMs + 1,
      startMs: earliestMs,
    })
    expect(intervals.map((i) => i.date)).toEqual([
      "2026-06-15",
      "2026-06-16",
      "2026-06-17",
    ])
    expect(createDailyIntervals({ endMs: nowMs, startMs: nowMs })).toEqual([])

    const target = createEmptyTotals()
    addTotals(target, {
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 2,
      costs: [createCost("USD", 1_000_000_000)],
      input_tokens: 10,
      output_tokens: 5,
      request_count: 1,
      total_nano_aiu: null,
      total_tokens: 15,
    })
    addTotals(target, {
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 4,
      costs: [createCost("CNY", 2_000_000_000), createCost("USD", 500_000_000)],
      input_tokens: 20,
      output_tokens: 10,
      request_count: 2,
      total_nano_aiu: 500,
      total_tokens: 30,
    })
    addTotals(target, {
      ...createEmptyTotals(),
      total_nano_aiu: 250,
    })
    addTotals(target, {
      ...createEmptyTotals(),
      total_nano_aiu: null,
    })
    expect(target.total_nano_aiu).toBe(750)
    expect(target.costs.map((c) => [c.currency, c.amount])).toEqual([
      ["CNY", 2],
      ["USD", 1.5],
    ])

    const payload = rangePayload({ endMs: nowMs + 1, startMs: earliestMs })
    expect(payload.start_ms).toBe(earliestMs)
    expect(createEmptySummary("today").byModel).toEqual([])
    expect(createEmptyDailySummary("last_7_days").days.length).toBe(7)
    expect(
      createEmptyEventsPage({ page: 0, pageSize: 500, period: "today" }),
    ).toMatchObject({
      items: [],
      page: 1,
      page_size: 100,
      total: 0,
      total_pages: 1,
    })
  })
})

describe("token usage events-db and video-settlement db", () => {
  test("writes events, updates timing, settles video jobs, rolls back failures and prunes expired events", async () => {
    const db = await createMemoryUsageDb()
    const baseMs = Date.parse("2026-06-15T10:00:00.000Z")

    writeVideoUsageJobRow(db, {
      api_key_id: "key-1",
      api_key_name: "Key 1",
      model: "grok-imagine-video-1.5",
      provider_name: "xai",
      request_id: "vid-1",
      session_id: "sess-v",
      trace_id: "trace-v",
    })
    // Duplicate job insert is ignored.
    writeVideoUsageJobRow(db, {
      api_key_id: "key-1",
      api_key_name: "Key 1",
      model: "grok-imagine-video-1.5",
      provider_name: "xai",
      request_id: "vid-1",
      session_id: "sess-v",
      trace_id: "trace-v",
    })

    const job = readVideoUsageJob(db, "xai", "vid-1")
    expect(job).toBeDefined()
    expect(readVideoUsageJob(db, "xai", "missing")).toBeUndefined()

    const due = queryDueVideoUsageJobRows(db, "xai", Date.now() + 60_000, 10)
    expect(due).toHaveLength(1)
    expect(
      updateVideoUsageJobPollRow(db, due[0], due[0].next_poll_at_ms! + 5000),
    ).toBe(true)
    expect(
      updateVideoUsageJobPollRow(db, due[0], due[0].next_poll_at_ms! + 10_000),
    ).toBe(false)

    // Settle video job via writeTokenUsageEvent.
    const videoEvent = makeEvent({
      api_key_cost_nanos: 5_000_000,
      api_key_id: "key-1",
      api_key_name: "Key 1",
      created_at_ms: baseMs,
      endpoint: "videos_generations",
      input_tokens: 0,
      model: "grok-imagine-video-1.5",
      output_tokens: 0,
      provider_name: "xai",
      request_id: "req-vid-1",
      total_cost_nanos: 5_000_000,
      total_tokens: 0,
      upstream_request_id: "vid-1",
    })
    expect(await writeTokenUsageEvent(videoEvent, db)).toBe(true)
    expect(readVideoUsageJob(db, "xai", "vid-1")?.settled).toBe(1)
    // Duplicate settlement is skipped.
    expect(await writeTokenUsageEvent(videoEvent, db)).toBe(false)

    clearVideoUsageJobPollRow(db, due[0])
    expect(readVideoUsageJob(db, "xai", "vid-1")?.next_poll_at_ms).toBeNull()

    // Rollback path when video job settlement fails mid-transaction.
    const failingDb: SqliteDatabase = {
      exec: (sql) => db.exec(sql),
      prepare: <Row>(sql: string) => {
        const statement = db.prepare<Row>(sql)
        if (sql.includes("UPDATE api_key_video_jobs SET settled = 1")) {
          return {
            all: (...values) => statement.all(...values),
            get: (...values) => statement.get(...values),
            run: () => {
              throw new Error("simulated sqlite failure")
            },
          }
        }
        return statement
      },
    }
    writeVideoUsageJobRow(db, {
      api_key_id: "key-1",
      api_key_name: "Key 1",
      model: "grok-imagine-video-1.5",
      provider_name: "xai",
      request_id: "vid-fail",
      session_id: "sess-v",
      trace_id: "trace-v",
    })
    let rollbackError: unknown
    try {
      await writeTokenUsageEvent(
        makeEvent({
          endpoint: "videos_generations",
          provider_name: "xai",
          upstream_request_id: "vid-fail",
        }),
        failingDb,
      )
    } catch (error) {
      rollbackError = error
    }
    expect(rollbackError).toBeInstanceOf(Error)
    expect((rollbackError as Error).message).toBe("simulated sqlite failure")
    expect(readVideoUsageJob(db, "xai", "vid-fail")?.settled).toBe(0)

    // Timing update and retention pruning preserve quota ledger.
    await writeTokenUsageEvent(
      makeEvent({
        api_key_cost_nanos: 2_000_000,
        api_key_id: "key-1",
        created_at_ms: baseMs - 10_000,
        first_token_ms: null,
        duration_ms: null,
        request_id: "req-timing",
        request_outcome: null,
      }),
      db,
    )
    await writeTokenUsageTiming(
      {
        durationMs: 900,
        firstTokenMs: 150,
        id: "req-timing",
        outcome: "completed",
      },
      db,
    )
    const deleted = await deleteExpiredUsageEvents(baseMs - 5_000, db)
    expect(deleted).toBe(1)
    expect(readApiKeyQuotaLedger(db).used("key-1", "lifetime")).toBe(7_000_000)

    // Backfill legacy pending:* video rows.
    await writeTokenUsageEvent(
      makeEvent({
        api_key_id: "key-1",
        endpoint: "videos_generations",
        provider_name: "xai",
        total_cost_nanos: 0,
        upstream_request_id: "pending:legacy-1",
      }),
      db,
    )
    initializeVideoUsageJobs(db)
    expect(readVideoUsageJob(db, "xai", "legacy-1")?.settled).toBe(0)
  })
})

describe("token usage queries module", () => {
  test("aggregates summary, daily buckets, events page and sessions page across edge cases", async () => {
    const db = await createMemoryUsageDb()
    const day1 = new Date(2026, 5, 15, 10, 0, 0, 0).getTime()
    const day2 = new Date(2026, 5, 16, 11, 0, 0, 0).getTime()
    const nowMs = new Date(2026, 5, 16, 18, 0, 0, 0).getTime()

    // Empty lifetime daily summary exercises zero-interval fast paths.
    const emptyDaily = await queryTokenUsageDailySummary(
      "lifetime",
      nowMs,
      undefined,
      db,
    )
    expect(emptyDaily.days).toEqual([])
    expect(emptyDaily.byModel).toEqual([])

    // Single-row completed request with valid timing + cost.
    await writeTokenUsageEvent(
      makeEvent({
        api_key_id: "key-a",
        api_key_name: "Key A",
        cost_currency: "USD",
        cost_source: "pricing",
        created_at_ms: day1,
        duration_ms: 1200,
        first_token_ms: 200,
        input_tokens: 100,
        model: "gpt-5.6",
        output_tokens: 50,
        request_id: "req-single",
        request_outcome: "completed",
        session_id: "sess-a",
        total_cost_nanos: 1_000_000,
        total_nano_aiu: 100,
        total_tokens: 150,
      }),
      db,
    )

    // Multi-row same-model request + alternate currency.
    await writeTokenUsageEvent(
      makeEvent({
        api_key_id: "key-a",
        api_key_name: "Key A",
        cost_currency: "CNY",
        cost_source: "reported",
        created_at_ms: day2,
        duration_ms: 2200,
        first_token_ms: 200,
        input_tokens: 60,
        model: "gpt-5.6",
        output_tokens: 40,
        request_id: "req-multi",
        request_outcome: "completed",
        session_id: "sess-a",
        total_cost_nanos: 2_000_000,
        total_tokens: 100,
      }),
      db,
    )
    await writeTokenUsageEvent(
      makeEvent({
        api_key_id: "key-a",
        api_key_name: "Key A",
        cost_currency: null,
        cost_source: null,
        created_at_ms: day2 + 1000,
        duration_ms: 2200,
        first_token_ms: 200,
        input_tokens: 20,
        model: "gpt-5.6",
        output_tokens: 20,
        request_id: "req-multi",
        request_outcome: "completed",
        session_id: "sess-a",
        total_cost_nanos: null,
        total_tokens: 40,
      }),
      db,
    )

    // Anonymous / other model with cancelled outcome (excluded from timing).
    await writeTokenUsageEvent(
      makeEvent({
        api_key_id: null,
        api_key_name: null,
        cost_currency: "USD",
        cost_source: "pricing",
        created_at_ms: day2 + 2000,
        duration_ms: 500,
        first_token_ms: 100,
        input_tokens: 30,
        model: "claude-sonnet",
        output_tokens: 10,
        request_id: "req-cancel",
        request_outcome: "cancelled",
        session_id: "sess-b",
        total_cost_nanos: 500_000,
        total_tokens: 40,
      }),
      db,
    )

    const summary = await queryTokenUsageSummary(
      "lifetime",
      nowMs,
      undefined,
      db,
    )
    expect(summary.totals.request_count).toBe(4)
    expect(summary.totals.total_tokens).toBe(330)
    expect(summary.byModel.map((m) => m.model)).toEqual([
      "gpt-5.6",
      "claude-sonnet",
    ])
    expect(summary.byModel[0].average_first_token_ms).toBe(200)
    expect(summary.byModel[0].output_tokens_per_second).toBeGreaterThan(0)
    expect(summary.byModel[1].output_tokens_per_second).toBeNull()

    const scopedSummary = await queryTokenUsageSummary(
      "lifetime",
      nowMs,
      "key-a",
      db,
    )
    expect(scopedSummary.totals.request_count).toBe(3)

    const daily = await queryTokenUsageDailySummary(
      "lifetime",
      nowMs,
      undefined,
      db,
    )
    expect(daily.days).toHaveLength(2)
    expect(daily.days[0].totals.total_tokens).toBe(150)
    expect(daily.days[1].totals.total_tokens).toBe(180)

    const eventsPage = await queryTokenUsageEventsPage(
      { page: 1, pageSize: 10, period: "lifetime" },
      nowMs,
      db,
    )
    expect(eventsPage.total).toBe(4)
    const singleEvent = eventsPage.items.find(
      (item) => item.request_id === "req-single",
    )
    const multiEvent = eventsPage.items.find(
      (item) => item.request_id === "req-multi",
    )
    const cancelledEvent = eventsPage.items.find(
      (item) => item.request_id === "req-cancel",
    )
    expect(singleEvent?.output_tokens_per_second).toBe(50)
    expect(multiEvent?.output_tokens_per_second).toBeNull()
    expect(cancelledEvent?.output_tokens_per_second).toBeNull()

    const sessionsPage = await queryTokenUsageSessionsPage(
      { page: 1, pageSize: 10, period: "lifetime" },
      nowMs,
      db,
    )
    expect(sessionsPage.total).toBe(2)
    expect(sessionsPage.items.map((item) => item.session_id)).toEqual([
      "sess-a",
      "sess-b",
    ])
  })
})

describe("api-key-quota-runtime and retention lifecycle", () => {
  test("persists and filters quota buckets by day/month/lifetime windows", async () => {
    const db = await createMemoryUsageDb()
    const oldMs = new Date(2026, 3, 10, 12, 0, 0, 0).getTime()
    const recentMs = new Date(2026, 5, 15, 12, 0, 0, 0).getTime()

    await writeTokenUsageEvent(
      makeEvent({
        api_key_cost_nanos: 1_000_000,
        api_key_id: "key-q",
        created_at_ms: oldMs,
      }),
      db,
    )
    await writeTokenUsageEvent(
      makeEvent({
        api_key_cost_nanos: 2_500_000,
        api_key_id: "key-q",
        created_at_ms: recentMs,
      }),
      db,
    )

    await persistApiKeyQuotas(db)
    const dayStartMs = new Date(2026, 5, 15, 0, 0, 0, 0).getTime()
    const monthStartMs = new Date(2026, 5, 1, 0, 0, 0, 0).getTime()
    const buckets = await readQuotaBuckets(dayStartMs, monthStartMs, db)

    expect(
      buckets.some(
        (b) => b.period === "lifetime" && b.used_cost_nanos === 3_500_000,
      ),
    ).toBe(true)
    expect(
      buckets.some(
        (b) => b.period === "month" && b.period_start_ms === monthStartMs,
      ),
    ).toBe(true)
    expect(
      buckets.some(
        (b) => b.period === "day" && b.period_start_ms === dayStartMs,
      ),
    ).toBe(true)
    expect(
      buckets.some((b) => b.period === "day" && b.period_start_ms < dayStartMs),
    ).toBe(false)
  })

  test("starts retention idempotently, flushes quotas via worker, and stops cleanly on close", async () => {
    process.env[DB_PATH_ENV] = ":memory:"
    await closeUsageStore()

    await startTokenUsageRetention()
    // Second call is an idempotent no-op.
    await startTokenUsageRetention()
    await flushApiKeyQuotas()
    expect(await pruneTokenUsageEvents()).toBe(0)

    await closeUsageStore()
  })
})
