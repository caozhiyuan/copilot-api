import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test"
import { Hono } from "hono"

import { installModelsDevCatalog } from "~/lib/models-dev-cache"
import { requestContext } from "~/lib/request-context"
import { state } from "~/lib/state"
import {
  closeUsageStore,
  createCopilotTokenUsageRecorder,
  normalizeOpenAIUsage,
  recordTokenUsageEvent,
  type TokenUsageDailySummary,
  type TokenUsageEventsPage,
  type TokenUsagePeriod,
  type TokenUsageSummary,
} from "~/lib/token-usage"
import {
  dashscopePeakWindows,
  deepseekPeakWindows,
  isPeakPricingTime,
  resolveTokenUsageCost,
  type TokenUsageCostInput,
} from "~/lib/token-usage/pricing"
import { traceIdMiddleware } from "~/lib/trace"
import { tokenUsageRoute } from "~/routes/token-usage/route"

import { modelsDevCatalogFixture } from "./fixtures/models-dev-catalog"

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
    `/token-usage/events?period=today&page=1&page_size=${pageSize}`,
  )
  expect(response.status).toBe(200)
  return (await response.json()) as TokenUsageEventsPage
}

function localDate(
  year: number,
  month: number,
  day: number,
  hour = 12,
  minute = 0,
): Date {
  return new Date(year, month, day, hour, minute, 0, 0)
}

function localDateLabel(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

// 2026-09-14 is a Monday; 2026-09-19 is a Saturday. DeepSeek bills peak prices
// on Beijing time 09:00-12:00 and 14:00-18:00 of weekdays (UTC 01:00-04:00 and
// 06:00-10:00), while DashScope bills peak prices on UTC 00:00-14:00 daily.
const deepseekPeakTime = new Date("2026-09-14T02:00:00.000Z")
const deepseekOffPeakTime = new Date("2026-09-19T02:00:00.000Z")
const dashscopePeakTime = new Date("2026-09-14T00:30:00.000Z")
const dashscopeOffPeakTime = new Date("2026-09-14T15:00:00.000Z")

function buildPricedUsage(
  model: string,
  providerName: string,
): TokenUsageCostInput {
  return {
    cache_read_input_tokens: 2_000,
    input_tokens: 1_000,
    model,
    output_tokens: 3_000,
    providerName,
    source: "provider",
  }
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
      "/token-usage?period=today",
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
      "/token-usage?period=today",
    )
    expect(response.status).toBe(200)

    const summary = (await response.json()) as TokenUsageSummary
    expect(summary.totals).toEqual({
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 6,
      costs: [
        {
          amount: 0.000000035,
          currency: "USD",
          total_cost_nanos: 35,
        },
      ],
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
      "/token-usage/events?period=today&page=1&page_size=1",
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

  test("calculates built-in Codex GPT-5.6 prices with cached input discount", async () => {
    const expectedCosts = [
      { model: "gpt-5.6-sol", totalCostNanos: 64_800_000 },
      { model: "gpt-5.6-terra", totalCostNanos: 38_400_000 },
      { model: "gpt-5.6-luna", totalCostNanos: 3_840_000 },
    ]

    for (const { model } of expectedCosts) {
      recordTokenUsageEvent({
        cache_read_input_tokens: 2_000,
        endpoint: "responses",
        input_tokens: 1_000,
        model,
        output_tokens: 3_000,
        providerName: "codex",
        source: "provider",
      })
    }

    const page = await fetchEventsPage(10)
    const costsByModel = new Map(
      page.items.map((item) => [item.model, item.cost]),
    )

    for (const { model, totalCostNanos } of expectedCosts) {
      const cost = costsByModel.get(model)
      expect(cost?.currency).toBe("USD")
      expect(cost?.source).toBe("builtin")
      expect(cost?.total_cost_nanos).toBe(totalCostNanos)
    }

    const response = await createTokenUsageApp().request(
      "/token-usage?period=today",
    )
    expect(response.status).toBe(200)
    const summary = (await response.json()) as TokenUsageSummary
    expect(summary.totals.costs).toEqual([
      {
        amount: 0.10704,
        currency: "USD",
        total_cost_nanos: 107_040_000,
      },
    ])
  })

  test("records provider-reported cost before configured pricing", async () => {
    recordTokenUsageEvent({
      cost: 0.0002928408,
      endpoint: "provider_messages",
      input_tokens: 853,
      model: "claude-sonnet-4",
      output_tokens: 284,
      pricing: {
        input: 100,
        output: 100,
      },
      pricingCurrency: "USD",
      providerName: "openrouter",
      source: "provider",
    })

    const page = await fetchEventsPage()
    expect(page.items[0]?.cost).toEqual({
      amount: 0.000292841,
      currency: "USD",
      source: "upstream",
      total_cost_nanos: 292_841,
    })
  })

  test("does not use provider-reported cost for non-OpenRouter providers", () => {
    expect(
      resolveTokenUsageCost({
        cost: 0.0002928408,
        input_tokens: 10,
        model: "custom-model",
        output_tokens: 5,
        pricing: {
          input: 1,
          output: 2,
        },
        pricingCurrency: "USD",
        providerName: "anthropic",
        source: "provider",
      }),
    ).toEqual({
      currency: "USD",
      source: "config",
      total_cost_nanos: 20_000,
    })
  })

  test("uses GPT-5.6 Terra and Luna long-context and cache-write prices", () => {
    const expectedCosts = [
      { model: "gpt-5.6-terra", totalCostNanos: 1_140_800_000 },
      { model: "gpt-5.6-luna", totalCostNanos: 114_080_000 },
    ]

    for (const { model, totalCostNanos } of expectedCosts) {
      expect(
        resolveTokenUsageCost({
          cache_creation_input_tokens: 2_000,
          cache_read_input_tokens: 2_000,
          input_tokens: 269_000,
          model,
          output_tokens: 3_000,
          providerName: "codex",
          source: "provider",
        }),
      ).toEqual({
        currency: "USD",
        source: "builtin",
        total_cost_nanos: totalCostNanos,
      })
    }
  })

  test("prices GPT-6.1 Sol cache usage at the 272K input tier boundary", () => {
    const expectedCosts = [
      {
        cache_creation_input_tokens: 1_000,
        cache_read_input_tokens: 2_000,
        input_tokens: 269_000,
        totalCostNanos: 570_700_000,
      },
      {
        cache_creation_input_tokens: 1_000,
        cache_read_input_tokens: 2_000,
        input_tokens: 269_001,
        totalCostNanos: 1_126_404_000,
      },
    ]

    for (const { totalCostNanos, ...usage } of expectedCosts) {
      expect(
        resolveTokenUsageCost({
          ...usage,
          model: "gpt-6.1-sol",
          output_tokens: 3_000,
          providerName: "codex",
          source: "provider",
        }),
      ).toEqual({
        currency: "USD",
        source: "builtin",
        total_cost_nanos: totalCostNanos,
      })
    }
  })

  test("prices DashScope Qwen3.8 Max with explicit cache prices", () => {
    expect(
      resolveTokenUsageCost({
        cache_creation_input_tokens: 1_000,
        cache_read_input_tokens: 2_000,
        input_tokens: 1_000,
        model: "qwen3.8-max",
        output_tokens: 3_000,
        providerName: "dashscope",
        source: "provider",
      }),
    ).toEqual({
      currency: "CNY",
      source: "builtin",
      total_cost_nanos: 137_000_000,
    })
  })

  test("prices DashScope DeepSeek V4.1 Flash with peak and off-peak prices", () => {
    const usage = buildPricedUsage("deepseek-v4.1-flash", "dashscope")

    expect(resolveTokenUsageCost({ ...usage, at: dashscopePeakTime })).toEqual({
      currency: "CNY",
      source: "builtin",
      total_cost_nanos: 26_400_000,
    })
    expect(
      resolveTokenUsageCost({ ...usage, at: dashscopeOffPeakTime }),
    ).toEqual({
      currency: "CNY",
      source: "builtin",
      total_cost_nanos: 13_200_000,
    })
  })

  test("prices DeepSeek models with peak and off-peak prices in CNY", () => {
    const expectedCosts = [
      {
        model: "deepseek-flash",
        offPeakCostNanos: 13_040_000,
        peakCostNanos: 26_080_000,
      },
      {
        model: "deepseek-v4-pro",
        offPeakCostNanos: 45_300_000,
        peakCostNanos: 90_600_000,
      },
    ]

    for (const expected of expectedCosts) {
      const usage = buildPricedUsage(expected.model, "deepseek")

      expect(resolveTokenUsageCost({ ...usage, at: deepseekPeakTime })).toEqual(
        {
          currency: "CNY",
          source: "builtin",
          total_cost_nanos: expected.peakCostNanos,
        },
      )
      expect(
        resolveTokenUsageCost({ ...usage, at: deepseekOffPeakTime }),
      ).toEqual({
        currency: "CNY",
        source: "builtin",
        total_cost_nanos: expected.offPeakCostNanos,
      })
    }
  })

  test("prices OpenCode Go models from the models.dev catalog in USD", () => {
    installModelsDevCatalog(modelsDevCatalogFixture)
    const expectedCosts = [
      {
        model: "deepseek-v4.1-flash",
        offPeakCostNanos: 1_956_000,
        peakCostNanos: 1_956_000,
      },
      {
        model: "deepseek-v4-pro",
        offPeakCostNanos: 6_644_000,
        peakCostNanos: 6_644_000,
      },
    ]

    for (const expected of expectedCosts) {
      const usage = buildPricedUsage(expected.model, "opencode-go")

      expect(resolveTokenUsageCost({ ...usage, at: deepseekPeakTime })).toEqual(
        {
          currency: "USD",
          source: "builtin",
          total_cost_nanos: expected.peakCostNanos,
        },
      )
      expect(
        resolveTokenUsageCost({ ...usage, at: deepseekOffPeakTime }),
      ).toEqual({
        currency: "USD",
        source: "builtin",
        total_cost_nanos: expected.offPeakCostNanos,
      })
    }
  })

  test("treats DeepSeek peak windows as UTC weekday windows", () => {
    expect(
      isPeakPricingTime(deepseekPeakWindows, new Date("2026-09-18T00:59:00Z")),
    ).toBe(false)
    expect(
      isPeakPricingTime(deepseekPeakWindows, new Date("2026-09-18T01:00:00Z")),
    ).toBe(true)
    expect(
      isPeakPricingTime(deepseekPeakWindows, new Date("2026-09-18T03:59:00Z")),
    ).toBe(true)
    expect(
      isPeakPricingTime(deepseekPeakWindows, new Date("2026-09-18T04:00:00Z")),
    ).toBe(false)
    expect(
      isPeakPricingTime(deepseekPeakWindows, new Date("2026-09-18T09:59:00Z")),
    ).toBe(true)
    expect(
      isPeakPricingTime(deepseekPeakWindows, new Date("2026-09-18T10:00:00Z")),
    ).toBe(false)
    expect(
      isPeakPricingTime(deepseekPeakWindows, new Date("2026-09-19T02:00:00Z")),
    ).toBe(false)
    expect(
      isPeakPricingTime(dashscopePeakWindows, new Date("2026-09-19T13:59:00Z")),
    ).toBe(true)
    expect(
      isPeakPricingTime(dashscopePeakWindows, new Date("2026-09-19T14:00:00Z")),
    ).toBe(false)
  })

  test("ignores off-peak prices when no peak window is configured", () => {
    expect(
      resolveTokenUsageCost({
        at: deepseekOffPeakTime,
        input_tokens: 1_000,
        model: "custom-model",
        output_tokens: 1_000,
        pricing: {
          input: 1,
          offPeak: {
            input: 0.1,
            output: 0.2,
          },
          output: 2,
        },
        pricingCurrency: "USD",
        providerName: "anthropic",
        source: "provider",
      }),
    ).toEqual({
      currency: "USD",
      source: "config",
      total_cost_nanos: 3_000_000,
    })
  })

  test("records off-peak DeepSeek costs using the record time", async () => {
    setSystemTime(deepseekOffPeakTime)
    recordTokenUsageEvent({
      cache_read_input_tokens: 2_000,
      endpoint: "provider_messages",
      input_tokens: 1_000,
      model: "deepseek-flash",
      output_tokens: 3_000,
      providerName: "deepseek",
      source: "provider",
    })

    const page = await fetchEventsPage()
    expect(page.items[0]?.cost).toEqual({
      amount: 0.01304,
      currency: "CNY",
      source: "builtin",
      total_cost_nanos: 13_040_000,
    })
  })

  test("prices Kimi models in USD and DashScope Kimi in CNY", () => {
    const expectedCosts = [
      {
        currency: "USD",
        model: "k3",
        providerName: "kimi",
        totalCostNanos: 48_600_000,
      },
      {
        currency: "USD",
        model: "k3-256k",
        providerName: "kimi",
        totalCostNanos: 48_600_000,
      },
      {
        currency: "CNY",
        model: "kimi/kimi-k3",
        providerName: "dashscope",
        totalCostNanos: 324_000_000,
      },
    ]

    for (const expected of expectedCosts) {
      expect(
        resolveTokenUsageCost({
          cache_read_input_tokens: 2_000,
          input_tokens: 1_000,
          model: expected.model,
          output_tokens: 3_000,
          providerName: expected.providerName,
          source: "provider",
        }),
      ).toEqual({
        currency: expected.currency,
        source: "builtin",
        total_cost_nanos: expected.totalCostNanos,
      })
    }
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

  test("supports calendar-to-date and lifetime periods", async () => {
    const outside = localDate(2026, 3, 30, 23)
    const monthStart = localDate(2026, 4, 1, 0)
    const weekEvent = localDate(2026, 4, 12)
    const now = localDate(2026, 4, 15, 15, 30)

    setSystemTime(outside)
    recordTokenUsageEvent({
      endpoint: "responses",
      input_tokens: 1,
      model: "outside",
      source: "copilot",
    })
    setSystemTime(monthStart)
    recordTokenUsageEvent({
      endpoint: "responses",
      input_tokens: 2,
      model: "month-start",
      source: "copilot",
    })
    setSystemTime(weekEvent)
    recordTokenUsageEvent({
      endpoint: "responses",
      input_tokens: 4,
      model: "week-event",
      source: "copilot",
    })
    setSystemTime(now)
    recordTokenUsageEvent({
      endpoint: "responses",
      input_tokens: 8,
      model: "now",
      source: "copilot",
    })
    setSystemTime(localDate(2026, 4, 15, 18))
    recordTokenUsageEvent({
      endpoint: "responses",
      input_tokens: 16,
      model: "future",
      source: "copilot",
    })
    setSystemTime(now)

    const app = createTokenUsageApp()
    const summary = async (period: string) => {
      const response = await app.request(`/token-usage?period=${period}`)
      expect(response.status).toBe(200)
      return (await response.json()) as TokenUsageSummary
    }
    const week = await summary("this_week")
    expect(week.range.start_ms).toBe(localDate(2026, 4, 11, 0).getTime())
    expect(week.range.end_ms).toBe(now.getTime() + 1)
    expect(week.totals.input_tokens).toBe(12)
    const month = await summary("this_month")
    expect(month.range.start_ms).toBe(monthStart.getTime())
    expect(month.range.end_ms).toBe(now.getTime() + 1)
    expect(month.totals.input_tokens).toBe(14)
    const lifetime = await summary("lifetime")
    expect(lifetime.range.start_ms).toBe(outside.getTime())
    expect(lifetime.range.end_ms).toBe(now.getTime() + 1)
    expect(lifetime.totals.input_tokens).toBe(15)

    const dailyResponse = await app.request(
      "/token-usage/daily?period=this_week",
    )
    const daily = (await dailyResponse.json()) as TokenUsageDailySummary
    expect(daily.days).toHaveLength(5)
    expect(daily.days[1]?.totals.input_tokens).toBe(4)
    expect(daily.days[4]?.totals.input_tokens).toBe(8)

    const monthDailyResponse = await app.request(
      "/token-usage/daily?period=this_month",
    )
    const monthDaily =
      (await monthDailyResponse.json()) as TokenUsageDailySummary
    expect(monthDaily.days).toHaveLength(15)
    expect(monthDaily.days[0]?.totals.input_tokens).toBe(2)

    const eventsResponse = await app.request(
      "/token-usage/events?period=lifetime",
    )
    const events = (await eventsResponse.json()) as TokenUsageEventsPage
    expect(events.total).toBe(4)
  })

  test("returns an empty lifetime range when there are no events", async () => {
    setSystemTime(localDate(2026, 4, 15))
    const app = createTokenUsageApp()
    const summaryResponse = await app.request("/token-usage?period=lifetime")
    const dailyResponse = await app.request(
      "/token-usage/daily?period=lifetime",
    )
    const summary = (await summaryResponse.json()) as TokenUsageSummary
    const daily = (await dailyResponse.json()) as TokenUsageDailySummary

    expect(summary.range.start_ms).toBe(summary.range.end_ms)
    expect(summary.totals.request_count).toBe(0)
    expect(daily.range.start_ms).toBe(daily.range.end_ms)
    expect(daily.days).toEqual([])
  })

  test("maps legacy period names to the renamed periods", async () => {
    const now = localDate(2026, 4, 15, 15, 30)
    setSystemTime(now)
    const app = createTokenUsageApp()
    const legacyPeriods: Array<[string, TokenUsagePeriod]> = [
      ["day", "today"],
      ["week", "last_7_days"],
      ["month", "last_30_days"],
    ]

    for (const [legacy, expected] of legacyPeriods) {
      const response = await app.request(`/token-usage?period=${legacy}`)
      expect(response.status).toBe(200)
      const summary = (await response.json()) as TokenUsageSummary
      expect(summary.period).toBe(expected)
      expect(summary.range.end_ms).toBe(now.getTime() + 1)
    }

    const weekResponse = await app.request("/token-usage?period=week")
    const weekSummary = (await weekResponse.json()) as TokenUsageSummary
    expect(weekSummary.range.start_ms).toBe(localDate(2026, 4, 9, 0).getTime())
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
      "/token-usage/daily?period=last_7_days",
    )
    expect(response.status).toBe(200)

    const daily = (await response.json()) as TokenUsageDailySummary
    expect(daily.period).toBe("last_7_days")
    expect(daily.days).toHaveLength(7)
    expect(daily.totals).toEqual({
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 6,
      costs: [
        {
          amount: 0.000000006,
          currency: "USD",
          total_cost_nanos: 6,
        },
      ],
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
      costs: [
        {
          amount: 0.000000003,
          currency: "USD",
          total_cost_nanos: 3,
        },
      ],
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

  test("returns empty daily buckets and falls back invalid period to today", async () => {
    setSystemTime(localDate(2026, 4, 15))
    const response = await createTokenUsageApp().request(
      "/token-usage/daily?period=invalid",
    )
    expect(response.status).toBe(200)

    const daily = (await response.json()) as TokenUsageDailySummary
    expect(daily.period).toBe("today")
    expect(daily.days).toHaveLength(1)
    expect(daily.days[0]?.date).toBe(localDateLabel(localDate(2026, 4, 15)))
    expect(daily.days[0]?.totals.total_tokens).toBe(0)
    expect(daily.byModel).toEqual([])
    expect(daily.totals.request_count).toBe(0)
  })
})
