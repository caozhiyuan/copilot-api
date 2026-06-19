import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test"
import { Hono } from "hono"

import { requestContext } from "~/lib/request-context"
import { state } from "~/lib/state"
import {
  closeUsageStore,
  createCopilotTokenUsageRecorder,
  normalizeOpenAIUsage,
  recordTokenUsageEvent,
  type TokenUsageDailySummary,
  type TokenUsageEventsPage,
  type TokenUsageSummary,
} from "~/lib/token-usage"
import { traceIdMiddleware } from "~/lib/trace"
import { tokenUsageRoute } from "~/routes/token-usage/route"

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"

beforeEach(async () => {
  process.env[DB_PATH_ENV] = ":memory:"
  state.userName = "copilot-login"
  await closeUsageStore()
})

afterEach(async () => {
  await closeUsageStore()
  setSystemTime()
  state.userName = undefined
  Reflect.deleteProperty(process.env, DB_PATH_ENV)
})

function createTokenUsageApp(): Hono {
  const app = new Hono()
  app.use(traceIdMiddleware)
  app.route("/token-usage", tokenUsageRoute)
  return app
}

async function fetchEventsPage(pageSize = 20): Promise<TokenUsageEventsPage> {
  const response = await createTokenUsageApp().request(
    `/token-usage/events?period=day&page=1&page_size=${pageSize}`,
  )
  expect(response.status).toBe(200)
  return (await response.json()) as TokenUsageEventsPage
}

function localDate(year: number, month: number, day: number, hour = 12): Date {
  return new Date(year, month, day, hour, 0, 0, 0)
}

function localDateLabel(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

describe("token usage storage", () => {
  test("normalizes OpenAI cache creation usage details", () => {
    expect(
      normalizeOpenAIUsage({
        completion_tokens: 10,
        prompt_tokens: 100,
        prompt_tokens_details: {
          cache_creation_input_tokens: 20,
          cached_tokens: 12,
        },
        total_tokens: 110,
      }),
    ).toEqual({
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 12,
      input_tokens: 68,
      output_tokens: 10,
      total_tokens: 110,
    })
  })

  test("records trace id and prefers x-session-affinity for session id", async () => {
    requestContext.run(
      {
        parentSessionId: undefined,
        sessionAffinity: "opencode-session",
        startTime: Date.now(),
        traceId: "trace-123",
        userAgent: "test",
      },
      () => {
        recordTokenUsageEvent({
          endpoint: "messages",
          input_tokens: 10,
          model: "gpt-test",
          output_tokens: 5,
          sessionId: "claude-session",
          source: "copilot",
        })
      },
    )

    const page = await fetchEventsPage()
    const row = page.items[0]
    expect(row.trace_id).toBe("trace-123")
    expect(row.session_id).toBe("opencode-session")
    expect(row.user_id).toBe("copilot-login")
    expect(row.total_tokens).toBe(15)
  })

  test("uses explicit metadata session id when no session affinity exists", async () => {
    recordTokenUsageEvent({
      endpoint: "provider_messages",
      input_tokens: 12,
      model: "claude-test",
      output_tokens: 4,
      providerName: "anthropic",
      sessionId: "claude-session",
      source: "provider",
    })

    const page = await fetchEventsPage()
    const row = page.items[0]
    expect(typeof row.trace_id).toBe("string")
    expect(row.trace_id.length).toBeGreaterThan(0)
    expect(row.session_id).toBe("claude-session")
    expect(row.user_id).toBe("anthropic")
    expect(row.total_tokens).toBe(16)
  })

  test("does not write zero-token usage events", async () => {
    recordTokenUsageEvent({
      endpoint: "chat_completions",
      input_tokens: 0,
      model: "gpt-test",
      output_tokens: 0,
      source: "copilot",
    })

    const response = await createTokenUsageApp().request(
      "/token-usage?period=day",
    )
    expect(response.status).toBe(200)
    const summary = (await response.json()) as TokenUsageSummary
    expect(summary.totals.request_count).toBe(0)
  })

  test("summarizes by model with total token and user fields", async () => {
    recordTokenUsageEvent({
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 2,
      endpoint: "chat_completions",
      input_tokens: 10,
      model: "gpt-a",
      output_tokens: 3,
      source: "copilot",
      total_nano_aiu: 1000,
    })
    recordTokenUsageEvent({
      cache_read_input_tokens: 4,
      endpoint: "responses",
      input_tokens: 20,
      model: "gpt-b",
      output_tokens: 6,
      source: "copilot",
      total_nano_aiu: 2500,
    })

    const response = await createTokenUsageApp().request(
      "/token-usage?period=day",
    )
    expect(response.status).toBe(200)

    const summary = (await response.json()) as TokenUsageSummary
    expect(summary.totals).toEqual({
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 6,
      input_tokens: 30,
      output_tokens: 9,
      request_count: 2,
      total_nano_aiu: 3500,
      total_tokens: 46,
    })
    expect(summary.totals.total_tokens).toBe(46)
    expect(summary.totals.total_nano_aiu).toBe(3500)
    expect(summary.byModel).toHaveLength(2)
    expect(summary.byModel.every((row) => row.total_tokens > 0)).toBe(true)
    expect(summary.byModel.map((row) => row.total_nano_aiu)).toEqual([
      2500, 1000,
    ])
  })

  test("returns paginated usage events with user id", async () => {
    recordTokenUsageEvent({
      endpoint: "chat_completions",
      input_tokens: 10,
      model: "gpt-a",
      output_tokens: 2,
      source: "copilot",
      total_nano_aiu: 1200,
    })
    recordTokenUsageEvent({
      endpoint: "provider_messages",
      input_tokens: 20,
      model: "claude-a",
      output_tokens: 5,
      providerName: "anthropic",
      sessionId: "claude-session",
      source: "provider",
      traceId: "trace-provider",
    })

    const response = await createTokenUsageApp().request(
      "/token-usage/events?period=day&page=1&page_size=1",
    )
    expect(response.status).toBe(200)

    const page = (await response.json()) as TokenUsageEventsPage
    expect(page.total).toBe(2)
    expect(page.page).toBe(1)
    expect(page.page_size).toBe(1)
    expect(page.total_pages).toBe(2)
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.total_nano_aiu).toBe(null)
    expect(page.items[0]?.user_id).toBe("anthropic")
    expect(page.items[0]?.trace_id).toBe("trace-provider")
    expect(page.items[0]?.session_id).toBe("claude-session")
    expect(page.items[0]?.total_tokens).toBe(25)
  })

  test("only falls back to interaction id when no real session id exists", async () => {
    const recordWithFallback = createCopilotTokenUsageRecorder({
      endpoint: "responses",
      fallbackSessionId: "interaction-session",
      model: "gpt-test",
    })
    const recordWithRealSession = createCopilotTokenUsageRecorder({
      endpoint: "responses",
      fallbackSessionId: "ignored-interaction-session",
      model: "gpt-test",
      sessionId: "real-session",
    })

    recordWithFallback({
      input_tokens: 5,
    })
    recordWithRealSession({
      input_tokens: 7,
    })

    const page = await fetchEventsPage(10)
    expect(page.items).toHaveLength(2)
    expect(page.items[0]?.session_id).toBe("real-session")
    expect(page.items[1]?.session_id).toBe("interaction-session")
  })

  test("returns daily token usage buckets by model with total tokens", async () => {
    setSystemTime(localDate(2026, 4, 8))
    recordTokenUsageEvent({
      endpoint: "chat_completions",
      input_tokens: 999,
      model: "outside-week",
      output_tokens: 1,
      source: "copilot",
    })

    setSystemTime(localDate(2026, 4, 12, 10))
    recordTokenUsageEvent({
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 2,
      endpoint: "chat_completions",
      input_tokens: 10,
      model: "gpt-a",
      output_tokens: 3,
      source: "copilot",
      total_nano_aiu: 100,
    })
    recordTokenUsageEvent({
      cache_read_input_tokens: 4,
      endpoint: "responses",
      input_tokens: 20,
      model: "gpt-b",
      output_tokens: 5,
      source: "copilot",
      total_nano_aiu: 200,
    })

    setSystemTime(localDate(2026, 4, 14, 9))
    recordTokenUsageEvent({
      endpoint: "messages",
      input_tokens: 6,
      model: "gpt-a",
      output_tokens: 4,
      source: "copilot",
      total_nano_aiu: 300,
      total_tokens: 100,
    })

    setSystemTime(localDate(2026, 4, 15))
    const response = await createTokenUsageApp().request(
      "/token-usage/daily?period=week",
    )
    expect(response.status).toBe(200)

    const daily = (await response.json()) as TokenUsageDailySummary
    expect(daily.period).toBe("week")
    expect(daily.days).toHaveLength(7)
    expect(daily.totals).toEqual({
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 6,
      input_tokens: 36,
      output_tokens: 12,
      request_count: 3,
      total_nano_aiu: 600,
      total_tokens: 145,
    })
    expect(daily.byModel.map((model) => model.model)).toEqual([
      "gpt-a",
      "gpt-b",
    ])
    expect(daily.byModel[0]?.total_tokens).toBe(116)
    expect(daily.byModel[0]?.total_nano_aiu).toBe(400)

    const firstDay = daily.days[0]
    expect(firstDay?.date).toBe(localDateLabel(localDate(2026, 4, 9)))
    expect(firstDay?.totals.total_tokens).toBe(0)

    const may12 = daily.days.find(
      (day) => day.date === localDateLabel(localDate(2026, 4, 12)),
    )
    expect(may12?.totals).toEqual({
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 6,
      input_tokens: 30,
      output_tokens: 8,
      request_count: 2,
      total_nano_aiu: 300,
      total_tokens: 45,
    })
    expect(may12?.byModel.map((model) => model.model)).toEqual([
      "gpt-b",
      "gpt-a",
    ])

    const may14 = daily.days.find(
      (day) => day.date === localDateLabel(localDate(2026, 4, 14)),
    )
    expect(may14?.totals.total_tokens).toBe(100)
    expect(may14?.byModel[0]?.model).toBe("gpt-a")
    expect(may14?.byModel[0]?.total_tokens).toBe(100)
  })

  test("returns empty daily buckets and falls back invalid period to day", async () => {
    setSystemTime(localDate(2026, 4, 15))
    const response = await createTokenUsageApp().request(
      "/token-usage/daily?period=invalid",
    )
    expect(response.status).toBe(200)

    const daily = (await response.json()) as TokenUsageDailySummary
    expect(daily.period).toBe("day")
    expect(daily.days).toHaveLength(1)
    expect(daily.days[0]?.date).toBe(localDateLabel(localDate(2026, 4, 15)))
    expect(daily.days[0]?.totals.total_tokens).toBe(0)
    expect(daily.byModel).toEqual([])
    expect(daily.totals.request_count).toBe(0)
  })
})
