import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"

import { recordResponsesFirstToken } from "~/lib/first-token"
import { GatewayPlugins } from "~/lib/gateway-plugins"
import { requestContext, type RequestTiming } from "~/lib/request-context"
import { requestEventsMiddleware } from "~/lib/request-events"
import { openSqliteDatabase } from "~/lib/sqlite"
import {
  closeUsageStore,
  getTokenUsageDailySummary,
  getTokenUsageEventsPage,
  getTokenUsageSummary,
  recordTokenUsageEvent,
} from "~/lib/token-usage"
import { traceIdMiddleware } from "~/lib/trace"

const previousDb = process.env.COPILOT_API_SQLITE_DB_PATH
let now = 100
let clock: ReturnType<typeof spyOn<typeof performance, "now">>
let directory: string | undefined
const plugins: GatewayPlugins[] = []

async function removeTestDirectory(path: string): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await rm(path, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 20,
      })
      return
    } catch (error) {
      lastError = error
      if (
        typeof error !== "object"
        || error === null
        || !("code" in error)
        || error.code !== "EBUSY"
      ) {
        throw error
      }
      Bun.gc(true)
      await Bun.sleep(10)
    }
  }
  throw lastError
}

const events = () =>
  getTokenUsageEventsPage({ period: "today", page: 1, pageSize: 100 })
const summary = () => getTokenUsageSummary("today")
const usage = (output = 50, model = "test-model") =>
  recordTokenUsageEvent({
    source: "copilot",
    endpoint: "responses",
    model,
    input_tokens: 10,
    output_tokens: output,
  })
const first = () =>
  recordResponsesFirstToken({
    type: "response.reasoning_summary_part.added",
    item_id: "r",
    output_index: 0,
    summary_index: 0,
    sequence_number: 1,
    part: { type: "summary_text", text: "" },
  })

beforeEach(async () => {
  await closeUsageStore()
  process.env.COPILOT_API_SQLITE_DB_PATH = ":memory:"
  now = 100
  clock = spyOn(performance, "now").mockImplementation(() => now)
})
afterEach(async () => {
  const directoryToRemove = directory
  directory = undefined
  clock.mockRestore()
  setSystemTime()
  await Promise.all(plugins.splice(0).map((plugin) => plugin.close()))
  await closeUsageStore()
  if (previousDb === undefined) delete process.env.COPILOT_API_SQLITE_DB_PATH
  else process.env.COPILOT_API_SQLITE_DB_PATH = previousDb
  if (directoryToRemove) await removeTestDirectory(directoryToRemove)
})

function app(plugin?: GatewayPlugins) {
  const server = new Hono()
  server.use(traceIdMiddleware)
  server.use(requestEventsMiddleware(plugin, 5000))
  return server
}

function completed(
  id: string,
  firstTokenMs: number | null,
  durationMs: number,
  output: number,
  model = "test-model",
  outcome: RequestTiming["outcome"] = "completed",
) {
  requestContext.run(
    {
      traceId: "reused-trace",
      startTime: Date.now(),
      userAgent: "test",
      sessionAffinity: "session",
      parentSessionId: undefined,
      requestTiming: {
        id,
        firstTokenMs,
        durationMs,
        outcome,
        hasUsage: false,
        recordFirstToken() {},
      },
    },
    () => usage(output, model),
  )
}

describe("stored User-Agent", () => {
  test.each([
    { name: "missing", value: undefined },
    { name: "empty", value: "" },
    { name: "short", value: "copilot-client/1.0" },
    { name: "63 chars", value: "a".repeat(63) },
    { name: "64 chars", value: "b".repeat(64) },
    { name: "65 chars", value: "c".repeat(65) },
    { name: "very long", value: "long-client/".repeat(1000) },
  ])(
    "stores at most 64 User-Agent characters: $name",
    async ({ value: userAgent }) => {
      const server = app()
      server.post("/v1/messages", (c) => {
        usage()
        return c.text("ok")
      })
      await (
        await server.request("/v1/messages", {
          method: "POST",
          headers: userAgent === undefined ? {} : { "user-agent": userAgent },
        })
      ).text()
      expect((await events()).items[0].user_agent).toBe(
        (userAgent ?? "").slice(0, 64),
      )
    },
  )

  test("captures User-Agent without request timing or plugins, and defaults to empty outside a request", async () => {
    const server = new Hono()
    server.use(traceIdMiddleware)
    server.post("/v1/embeddings", (c) => {
      usage(1, "no-timing")
      return c.text("ok")
    })
    const userAgent = "embedding-client/" + "z".repeat(100)
    await (
      await server.request("/v1/embeddings", {
        method: "POST",
        headers: { "user-agent": userAgent },
      })
    ).text()
    usage(1, "outside-request")
    const rows = (await events()).items
    expect(rows.find((row) => row.model === "no-timing")).toMatchObject({
      user_agent: userAgent.slice(0, 64),
      request_id: null,
    })
    expect(
      rows.find((row) => row.model === "outside-request")?.user_agent,
    ).toBe("")
  })
})

describe("persisted request timing", () => {
  test("createServer persists timing from the actual Responses parser with no plugins configured", async () => {
    const { createServer } = await import("~/server")
    const { responsesHandlerDependencies } = await import(
      "~/routes/responses/handler"
    )
    const original = { ...responsesHandlerDependencies }
    responsesHandlerDependencies.resolveMappedModel = (model) => model
    responsesHandlerDependencies.findEndpointModel = (id) => ({
      id,
      name: id,
      object: "model",
      model_picker_enabled: true,
      preview: false,
      vendor: "test",
      version: "1",
      supported_endpoints: ["/responses"],
      capabilities: {
        family: "test",
        limits: {},
        object: "model_capabilities",
        supports: {},
        tokenizer: "test",
        type: "chat",
      },
    })
    let reads = 0
    responsesHandlerDependencies.createResponses = () =>
      Promise.resolve(
        (async function* () {
          await Promise.resolve()
          now = 300
          reads++
          yield {
            event: "response.output_item.added",
            data: JSON.stringify({
              type: "response.output_item.added",
              sequence_number: 1,
              output_index: 0,
              item: { type: "reasoning", id: "r", summary: [] },
            }),
          }
          now = 1300
          reads++
          yield {
            event: "response.completed",
            data: JSON.stringify({
              type: "response.completed",
              sequence_number: 2,
              response: {
                id: "resp",
                object: "response",
                status: "completed",
                model: "test-model",
                output: [],
                usage: {
                  input_tokens: 10,
                  output_tokens: 50,
                  total_tokens: 60,
                },
              },
            }),
          }
        })(),
      )
    try {
      const response = await createServer({
        port: 5000,
        getApiKeys: () => [],
      }).request("/v1/responses", {
        method: "POST",
        body: JSON.stringify({
          model: "test-model",
          input: "hello",
          stream: true,
        }),
      })
      const text = await response.text()
      expect(text).toContain('"type":"reasoning"')
      expect(text).toContain('"type":"response.completed"')
      expect(reads).toBe(2)
      expect((await events()).items[0]).toMatchObject({
        first_token_ms: 200,
        duration_ms: 1200,
        output_tokens_per_second: 50,
        output_tokens: 50,
      })
    } finally {
      Object.assign(responsesHandlerDependencies, original)
    }
  })

  test.each([false, true])(
    "records thinking TTFT and completes early usage with plugins=%s",
    async (enabled) => {
      const plugin = enabled ? new GatewayPlugins(5000) : undefined
      const ends: Array<{
        id: string
        durationMs: number
        firstTokenMs: number | null
      }> = []
      if (plugin) {
        plugins.push(plugin)
        await plugin.register("test", ({ on }) => {
          on("request.end", (event) => {
            ends.push(event)
          })
        })
      }
      const server = app(plugin)
      server.post("/v1/responses", (c) => {
        expect(requestContext.getStore()?.pluginRequest !== undefined).toBe(
          enabled,
        )
        now = 300
        first()
        now = 400
        first()
        usage()
        return c.text("data: thinking\n\n", 200, {
          "content-type": "text/event-stream",
        })
      })
      const response = await server.request("/v1/responses", { method: "POST" })
      expect((await events()).items[0]).toMatchObject({
        first_token_ms: 200,
        duration_ms: null,
        output_tokens_per_second: null,
      })
      now = 1300
      expect(await response.text()).toBe("data: thinking\n\n")
      const row = (await events()).items[0]
      expect(row).toMatchObject({
        first_token_ms: 200,
        duration_ms: 1200,
        request_outcome: "completed",
        output_tokens_per_second: 50,
        output_tokens: 50,
        session_id: "",
      })
      expect(row.request_id).toBeString()
      if (plugin) {
        await plugin.flush()
        expect(ends).toHaveLength(1)
        expect(ends[0]).toMatchObject({
          id: row.request_id,
          firstTokenMs: 200,
          durationMs: 1200,
        })
      }
    },
  )

  test("late usage carries finished timing and repeated trace IDs do not join unrelated requests", async () => {
    const server = app()
    let late = () => {}
    server.post("/v1/responses", (c) => {
      now += 200
      first()
      const context = requestContext.getStore()!
      late = () => requestContext.run(context, () => usage())
      return c.text("ok")
    })
    const ids: Array<string | null> = []
    for (let i = 0; i < 2; i++) {
      now = 100
      const response = await server.request("/v1/responses", {
        method: "POST",
        headers: { "x-client-request-id": "reused-trace" },
      })
      now = 1300
      await response.text()
      late()
      ids.push((await events()).items[0].request_id)
    }
    expect(new Set(ids).size).toBe(2)
    expect((await summary()).byModel[0]).toMatchObject({
      average_first_token_ms: 200,
      output_tokens_per_second: 50,
      request_count: 2,
    })
  })

  test.each(["cancel", "abort", "error"] as const)(
    "preserves partial usage but omits speed on %s",
    async (mode) => {
      const server = app()
      const aborter = new AbortController()
      server.post("/v1/responses", () => {
        now = 300
        first()
        usage()
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1]))
            },
            pull() {
              if (mode === "error") throw new Error("upstream failed")
            },
          }),
        )
      })
      const response = await server.request("/v1/responses", {
        method: "POST",
        signal: aborter.signal,
      })
      now = 1300
      if (mode === "error") {
        const error: unknown = await response.text().then(
          () => null,
          (error: unknown) => error,
        )
        expect(String(error)).toContain("upstream failed")
      } else {
        if (mode === "abort") aborter.abort()
        await response.body!.cancel()
      }
      expect((await events()).items[0]).toMatchObject({
        request_outcome: mode === "error" ? "error" : "cancelled",
        first_token_ms: 200,
        output_tokens_per_second: null,
        output_tokens: 50,
      })
      expect((await summary()).byModel[0]).toMatchObject({
        average_first_token_ms: null,
        output_tokens_per_second: null,
      })
    },
  )

  test("non-streaming and legacy usage keep missing TTFT null, without losing tokens", async () => {
    usage()
    const server = app()
    server.post("/v1/messages", (c) => {
      usage()
      return c.json({ content: "ok" })
    })
    now = 100
    const response = await server.request("/v1/messages", { method: "POST" })
    now = 900
    await response.text()
    const rows = (await events()).items
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      first_token_ms: null,
      duration_ms: 800,
      output_tokens_per_second: null,
    })
    expect(rows[1]).toMatchObject({
      request_id: null,
      first_token_ms: null,
      duration_ms: null,
      output_tokens_per_second: null,
    })
    expect((await summary()).totals.output_tokens).toBe(100)
  })

  test("does not create a database for requests without usage", async () => {
    directory = await mkdtemp(join(tmpdir(), "usage-timing-"))
    const path = join(directory, "unused.sqlite")
    process.env.COPILOT_API_SQLITE_DB_PATH = path
    const server = app()
    server.post("/v1/messages", (c) => {
      first()
      recordTokenUsageEvent({
        source: "copilot",
        endpoint: "messages",
        model: "empty",
        input_tokens: 0,
        output_tokens: 0,
      })
      return c.text("ok")
    })
    await (await server.request("/v1/messages", { method: "POST" })).text()
    expect(await Bun.file(path).exists()).toBe(false)
  })

  test("untracked routes and methods do not acquire timing state", async () => {
    const server = app()
    server.all("*", (c) =>
      c.json({ timed: !!requestContext.getStore()?.requestTiming }),
    )
    for (const [path, method] of [
      ["/models", "GET"],
      ["/v1/responses", "GET"],
      ["/v1/messages/count_tokens", "POST"],
    ]) {
      expect(await (await server.request(path, { method })).json()).toEqual({
        timed: false,
      })
    }
  })

  test("migrates the previous SQLite schema without rewriting historical token/session accounting", async () => {
    directory = await mkdtemp(join(tmpdir(), "usage-migration-"))
    const path = join(directory, "old.sqlite")
    const db = await openSqliteDatabase(path)
    db.exec(`CREATE TABLE token_usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_at_ms INTEGER NOT NULL, created_at_utc TEXT NOT NULL,
      trace_id TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, endpoint TEXT NOT NULL,
      provider_name TEXT, model TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0
    )`)
    db.prepare(
      "INSERT INTO token_usage_events (created_at_ms,created_at_utc,trace_id,session_id,source,endpoint,model,output_tokens) VALUES (?,?,?,?,?,?,?,?)",
    ).run(
      Date.now(),
      new Date().toISOString(),
      "old-trace",
      "old-session",
      "copilot",
      "responses",
      "old-model",
      99,
    )
    db.close?.()
    process.env.COPILOT_API_SQLITE_DB_PATH = path
    const row = (await events()).items[0]
    expect(row).toMatchObject({
      trace_id: "old-trace",
      session_id: "old-session",
      user_agent: "",
      output_tokens: 99,
      request_id: null,
      first_token_ms: null,
      duration_ms: null,
      output_tokens_per_second: null,
    })
    completed("new", 100, 1100, 50)
    expect((await events()).total).toBe(2)
    const migrated = await openSqliteDatabase(path)
    expect(
      migrated
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'idx_token_usage_events_request_id'",
        )
        .get(),
    ).toBeDefined()
    migrated.close?.()
  })
})

describe("model timing aggregation", () => {
  test("period and daily buckets exclude partial cross-boundary usage without changing token totals", async () => {
    setSystemTime(new Date(2026, 9, 24, 23, 59, 59))
    completed("cross-day", 100, 1100, 20)
    setSystemTime(new Date(2026, 9, 25, 0, 1))
    completed("cross-day", 100, 1100, 30)
    completed("today", 200, 1200, 50)
    expect((await summary()).byModel[0]).toMatchObject({
      output_tokens: 80,
      average_first_token_ms: 200,
      output_tokens_per_second: 50,
    })
    const daily = await getTokenUsageDailySummary("last_7_days")
    expect(daily.byModel[0]).toMatchObject({
      output_tokens: 100,
      average_first_token_ms: 150,
      output_tokens_per_second: 50,
    })
    const nonempty = daily.days.filter((day) => day.byModel.length > 0)
    expect(nonempty).toHaveLength(2)
    expect(nonempty[0].byModel[0].average_first_token_ms).toBeNull()
    expect(nonempty[1].byModel[0]).toMatchObject({
      average_first_token_ms: 200,
      output_tokens_per_second: 50,
    })
  })

  test("weights speed by generation duration, excludes missing timing and deduplicates same-model usage", async () => {
    completed("fast", 100, 1100, 100)
    completed("slow", 300, 3300, 30)
    completed("split", 200, 1200, 20)
    completed("split", 200, 1200, 30)
    completed("legacy", null, 5000, 9000)
    completed("cancelled", 100, 1100, 1000, "test-model", "cancelled")
    const model = (await summary()).byModel[0]
    expect(model.average_first_token_ms).toBe(200)
    expect(model.output_tokens_per_second).toBe(36) // (100 + 30 + 50) / (1 + 3 + 1)
    expect(model.output_tokens).toBe(10180)
    const split = (await events()).items.filter(
      (row) => row.request_id === "split",
    )
    expect(split).toHaveLength(2)
    expect(split.every((row) => row.output_tokens_per_second === null)).toBe(
      true,
    )
    const daily = await getTokenUsageDailySummary("today")
    expect(daily.byModel[0].output_tokens_per_second).toBe(36)
    expect(daily.days[0].byModel[0].average_first_token_ms).toBe(200)
    expect(daily.days[0].byModel[0].output_tokens_per_second).toBe(36)
  })

  test("mixed-model calls keep token totals but do not attribute shared timing to individual models", async () => {
    completed("multi", 100, 1100, 50, "model-a")
    completed("multi", 100, 1100, 50, "model-b")
    const models = (await summary()).byModel
    expect(models).toHaveLength(2)
    for (const model of models)
      expect(model).toMatchObject({
        output_tokens: 50,
        average_first_token_ms: null,
        output_tokens_per_second: null,
      })
  })

  test.each<[number | null, number, number, number | null, number | null]>([
    [null, 1000, 50, null, null],
    [-1, 1000, 50, null, null],
    [100, 50, 50, null, null],
    [100, 100, 50, 100, null],
    [100, 1100, 0, 100, null],
    [0, 1000, 50, 0, 50],
  ])(
    "handles TTFT=%s duration=%s output=%s",
    async (ttft, duration, output, average, speed) => {
      completed("edge", ttft, duration, output)
      expect((await summary()).byModel[0]).toMatchObject({
        average_first_token_ms: average,
        output_tokens_per_second: speed,
      })
      expect((await events()).items[0].output_tokens_per_second).toBe(speed)
    },
  )
})
