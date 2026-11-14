import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { requestContext } from "~/lib/request-context"
import {
  closeUsageStore,
  getTokenUsageEventsPage,
  getTokenUsageSummary,
  recordTokenUsageEvent,
} from "~/lib/token-usage"
import { recordNativeAlphaSearchUsage } from "~/lib/token-usage/alpha-search"

const originalDbPath = process.env.COPILOT_API_SQLITE_DB_PATH
const payload = {
  id: "payload-session",
  model: "deepseek-flash",
  commands: { search_query: [{ q: "query" }] },
}
const result = {
  output: "Search answer",
  results: [{ url: "https://example.com", title: "Example" }],
}
const events = () =>
  getTokenUsageEventsPage({ period: "today", page: 1, pageSize: 100 })

beforeEach(async () => {
  await closeUsageStore()
  process.env.COPILOT_API_SQLITE_DB_PATH = ":memory:"
})

afterEach(async () => {
  await closeUsageStore()
  if (originalDbPath === undefined)
    delete process.env.COPILOT_API_SQLITE_DB_PATH
  else process.env.COPILOT_API_SQLITE_DB_PATH = originalDbPath
})

async function record(
  options: {
    provider?: string
    body?: unknown
    result?: unknown
    status?: number
    headers?: ConstructorParameters<typeof Headers>[0]
    rawRequest?: string
    rawResponse?: string
    currency?: string
  } = {},
) {
  const providerName = options.provider ?? "deepseek"
  const response = new Response(
    options.rawResponse ?? JSON.stringify(options.result ?? result),
    { status: options.status ?? 200 },
  )
  await recordNativeAlphaSearchUsage(response, {
    providerName,
    officialDeepSeek: providerName === "deepseek",
    pricingCurrency: options.currency ?? "USD",
    requestHeaders: new Headers(options.headers),
    requestBody: await new Response(
      options.rawRequest ?? JSON.stringify(options.body ?? payload),
    ).arrayBuffer(),
  })
  expect(await response.text()).toBe(
    options.rawResponse ?? JSON.stringify(options.result ?? result),
  )
  return (await events()).items[0]
}

describe("native Alpha Search usage", () => {
  test("keeps search requests separate from normal model summaries", async () => {
    recordTokenUsageEvent({
      endpoint: "responses",
      source: "provider",
      providerName: "deepseek",
      model: "deepseek-flash",
      input_tokens: 10,
    })
    await record()

    const summary = await getTokenUsageSummary("today")
    expect(summary.byModel.map((row) => row.model).sort()).toEqual([
      "deepseek-flash",
      "deepseek-flash_search",
    ])
    expect(summary.byModel.every((row) => row.request_count === 1)).toBe(true)
  })

  test.each([200, 429])(
    "records Codex with zero tokens and zero cost, status %s",
    async (status) => {
      const row = await record({
        provider: "codex",
        status,
        rawResponse: "opaque Codex body",
        body: { ...payload, model: "codex/gpt-6-luna" },
      })
      expect(row).toMatchObject({
        endpoint: "alpha_search",
        source: "provider",
        provider_name: "codex",
        model: "gpt-6-luna_search",
        session_id: "payload-session",
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        cost: {
          amount: 0,
          currency: "USD",
          source: "builtin",
          total_cost_nanos: 0,
        },
      })
      expect((await getTokenUsageSummary("today")).totals.request_count).toBe(1)
    },
  )

  test("estimates DeepSeek queries and fetches using the official USD unit price", async () => {
    const row = await record({
      body: {
        ...payload,
        commands: {
          search_query: [{ q: "one" }, { q: "two" }],
          open: [{ ref_id: "page" }],
          find: [{ ref_id: "page", pattern: "needle" }],
          time: [{ utc_offset: "+08:00" }],
          screenshot: [{ ref_id: "page", pageno: 0 }],
        },
      },
    })
    expect(row.cost).toEqual({
      amount: 0.003,
      currency: "USD",
      source: "estimate",
      total_cost_nanos: 3_000_000,
    })
    expect(row.total_tokens).toBe(0)
  })

  test("uses reported successful operation counts when available", async () => {
    const row = await record({
      result: {
        ...result,
        usage: {
          server_tool_use: {
            tool_search: 2,
            tool_fetch: 1,
            tool_image_search: 0,
          },
        },
      },
    })
    expect(row.cost?.total_cost_nanos).toBe(2_250_000)
  })

  test("uses the official CNY price when the provider uses CNY", async () => {
    const row = await record({ currency: "CNY" })
    expect(row.cost).toEqual({
      amount: 0.005,
      currency: "CNY",
      source: "estimate",
      total_cost_nanos: 5_000_000,
    })
  })

  test("preserves explicit zero successful counts", async () => {
    const row = await record({
      result: {
        ...result,
        usage: { server_tool_use: { tool_search: 0, tool_fetch: 0 } },
      },
    })
    expect(row.cost?.amount).toBe(0)
  })

  test("does not bill by the number of search result pages", async () => {
    const row = await record({
      result: {
        ...result,
        results: Array.from({ length: 10 }, () => ({
          url: "https://example.com",
        })),
      },
    })
    expect(row.cost?.total_cost_nanos).toBe(750_000)
  })

  test("estimates legacy text-only search responses", async () => {
    const row = await record({
      result: { output: "Search results with citations" },
    })
    expect(row.cost?.total_cost_nanos).toBe(750_000)
  })

  test("falls back from invalid usage counts to command estimation", async () => {
    const row = await record({
      result: {
        ...result,
        usage: { server_tool_use: { tool_search: -1, tool_fetch: "invalid" } },
      },
    })
    expect(row.cost?.total_cost_nanos).toBe(750_000)
  })

  test("records empty searches at zero cost", async () => {
    const row = await record({
      result: { output: "No results found", results: [] },
    })
    expect(row.cost?.amount).toBe(0)
  })

  test("records unsuccessful requests at zero cost", async () => {
    const row = await record({ status: 429, rawResponse: "rate limited" })
    expect(row.cost?.amount).toBe(0)
  })

  test("retains unreadable responses as unpriced request records", async () => {
    const row = await record({ rawResponse: "not JSON" })
    expect(row.cost).toBeNull()
    expect(row.endpoint).toBe("alpha_search")
  })

  test("keeps unknown provider costs unset", async () => {
    const row = await record({ provider: "custom" })
    expect(row.cost).toBeNull()
    expect(row.provider_name).toBe("custom")
  })

  test.each([
    {
      metadata: { session_id: "codex-session", thread_id: "codex-thread" },
      expected: "codex-session",
    },
    { metadata: { thread_id: "codex-thread" }, expected: "codex-thread" },
    {
      metadata: { session_id: " ", thread_id: "codex-thread" },
      expected: "codex-thread",
    },
    { metadata: { session_id: 123 }, expected: "payload-session" },
    { metadata: null, expected: "payload-session" },
  ])(
    "resolves Codex metadata session $expected",
    async ({ metadata, expected }) => {
      const row = await record({
        headers: { "x-codex-turn-metadata": JSON.stringify(metadata) },
      })
      expect(row.session_id).toBe(expected)
    },
  )

  test("ignores malformed metadata and request JSON", async () => {
    const row = await record({
      provider: "codex",
      rawRequest: "invalid JSON",
      headers: { "x-codex-turn-metadata": "invalid JSON" },
    })
    expect(row.model).toBe("unknown_search")
    expect(row.session_id).toBe("")
  })

  test("preserves explicit header sessions, trace ID and User-Agent", async () => {
    const row = await requestContext.run(
      {
        traceId: "native-trace",
        startTime: Date.now(),
        userAgent: "codex-tui/0.169.0",
        sessionAffinity: "header-session",
        rootSessionId: "root-session",
        parentSessionId: undefined,
      },
      () =>
        record({
          headers: {
            "x-codex-turn-metadata": JSON.stringify({
              session_id: "metadata-session",
            }),
          },
        }),
    )
    expect(row).toMatchObject({
      trace_id: "native-trace",
      session_id: "header-session",
      user_agent: "codex-tui/0.169.0",
    })
  })
})
