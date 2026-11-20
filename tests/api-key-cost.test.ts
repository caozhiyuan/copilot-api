import { expect, test } from "bun:test"
import { resolveUsdRate, toUsdCostNanos } from "~/lib/token-usage/currency"
import {
  getTokenUsagePricingCurrency,
  resolveTokenUsageCost,
} from "~/lib/token-usage/pricing"
import {
  normalizeOpenAIUsage,
  normalizeResponsesUsage,
} from "~/lib/token-usage"

test("uses the existing OpenCode USD rate without mixing unsupported currencies", () => {
  expect(resolveUsdRate("USD")).toBe(1)
  expect(toUsdCostNanos("USD", 1_234_567)).toBe(1_234_567)
  expect(toUsdCostNanos("CNY", 6_700_000_000)).toBe(1_000_000_000)
  expect(toUsdCostNanos("CNY", 0)).toBe(0)
  expect(toUsdCostNanos("EUR", 100)).toBeNull()
  expect(toUsdCostNanos("USD", NaN)).toBeNull()
  expect(toUsdCostNanos("USD", -1)).toBeNull()
})

test("retains reported costs from JSON or final streaming usage, including explicit zero", () => {
  for (const ticks of [0, 12_345_678]) {
    const cost = ticks / 10_000_000_000
    expect(
      normalizeOpenAIUsage({ cost_in_usd_ticks: ticks, cost: 99 }).cost,
    ).toBe(cost)
    expect(
      normalizeResponsesUsage({ cost_in_usd_ticks: ticks, cost: 99 }).cost,
    ).toBe(cost)
  }
  expect(normalizeOpenAIUsage({ cost: 0.125 }).cost).toBe(0.125)
  expect(normalizeOpenAIUsage({ cost: -1 }).cost).toBeUndefined()
  const reported = resolveTokenUsageCost({
    source: "provider",
    providerName: "custom",
    model: "model",
    cost: 0.125,
    input_tokens: 1_000_000,
    pricing: { input: 99, output: 99 },
  })
  expect(reported).toEqual({
    currency: "USD",
    source: "upstream",
    total_cost_nanos: 125_000_000,
  })
  expect(
    resolveTokenUsageCost({
      source: "copilot",
      model: "model",
      total_nano_aiu: 100_000_000_000,
    })?.total_cost_nanos,
  ).toBe(1_000_000_000)
  expect(
    resolveTokenUsageCost({
      source: "copilot",
      model: "model",
      total_nano_aiu: 0,
    })?.total_cost_nanos,
  ).toBe(0)
  expect(
    resolveTokenUsageCost({ source: "copilot", model: "model" }),
  ).toBeNull()
})

test("requires complete pricing or a supported reported-cost source before forwarding", () => {
  const model = {
    source: "provider" as const,
    model: "unlisted",
    providerName: "custom",
    pricingCurrency: "USD",
  }
  expect(getTokenUsagePricingCurrency(model)).toBeNull()
  expect(
    getTokenUsagePricingCurrency({ ...model, pricing: { input: 1 } }),
  ).toBeNull()
  expect(
    getTokenUsagePricingCurrency({
      ...model,
      pricing: { input: 0, output: 0 },
    }),
  ).toBe("USD")
  expect(
    getTokenUsagePricingCurrency({
      ...model,
      pricing: { input: 1 },
      endpoint: "embeddings",
    }),
  ).toBe("USD")
  expect(
    getTokenUsagePricingCurrency({
      ...model,
      pricing: { input: 1, output: 2 },
      pricingCurrency: "CNY",
    }),
  ).toBe("CNY")
  expect(
    getTokenUsagePricingCurrency({
      ...model,
      pricing: {
        tiers: [
          { input: 1, output: 2, maxInputTokens: 100 },
          { input: 3, output: 4 },
        ],
      },
    }),
  ).toBe("USD")
  expect(
    getTokenUsagePricingCurrency({
      ...model,
      pricing: {
        input: 1,
        output: 2,
        offPeak: { input: 0.5 },
        peakWindows: [{ startMinuteUtc: 0, endMinuteUtc: 60 }],
      },
    }),
  ).toBe("USD")
  expect(getTokenUsagePricingCurrency({ ...model, providerName: "xai" })).toBe(
    "USD",
  )
  expect(getTokenUsagePricingCurrency({ ...model, source: "copilot" })).toBe(
    "USD",
  )
  expect(
    getTokenUsagePricingCurrency({ ...model, providerName: "openrouter" }),
  ).toBe("USD")
})

test("prices native search, image and video operations using their own billing paths", () => {
  const model = {
    source: "provider" as const,
    model: "model",
    providerName: "custom",
  }
  expect(
    getTokenUsagePricingCurrency({ ...model, endpoint: "alpha_search" }),
  ).toBeNull()
  expect(
    getTokenUsagePricingCurrency({
      ...model,
      providerName: "codex",
      endpoint: "alpha_search",
    }),
  ).toBe("USD")
  expect(
    getTokenUsagePricingCurrency({
      ...model,
      providerName: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      endpoint: "alpha_search",
    }),
  ).toBe("CNY")
  expect(
    getTokenUsagePricingCurrency({
      ...model,
      providerName: "deepseek",
      baseUrl: "https://example.com",
      endpoint: "alpha_search",
    }),
  ).toBeNull()
  for (const endpoint of ["images_generations", "images_edits"] as const) {
    expect(
      getTokenUsagePricingCurrency({
        ...model,
        providerName: "codex",
        model: "gpt-image-2",
        endpoint,
      }),
    ).toBe("USD")
    expect(
      getTokenUsagePricingCurrency({
        ...model,
        providerName: "codex",
        model: "unpriced-image",
        endpoint,
      }),
    ).toBeNull()
    expect(
      getTokenUsagePricingCurrency({ ...model, providerName: "xai", endpoint }),
    ).toBe("USD")
  }
  expect(
    getTokenUsagePricingCurrency({
      ...model,
      providerName: "xai",
      endpoint: "videos_generations",
    }),
  ).toBe("USD")
  expect(
    getTokenUsagePricingCurrency({ ...model, endpoint: "videos_generations" }),
  ).toBeNull()
})

test("settles text, search, image, Copilot and deduplicated video costs into one USD budget", async () => {
  const { closeUsageStore, recordTokenUsageEvent, getTokenUsageSummary } =
    await import("~/lib/token-usage")
  const { getApiKeyQuotaUsage } = await import("~/lib/token-usage/store")
  const { requestContext } = await import("~/lib/http/request-context")
  const { recordNativeAlphaSearchUsage } = await import(
    "~/lib/token-usage/alpha-search"
  )
  const { observeImagesResponse } = await import("~/lib/token-usage/images")
  const { recordVideoResultUsage } = await import("~/lib/token-usage/videos")
  const fs = await import("node:fs")
  const os = await import("node:os")
  const path = await import("node:path")
  const originalDb = process.env.COPILOT_API_SQLITE_DB_PATH
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "key-cost-"))
  await closeUsageStore()
  process.env.COPILOT_API_SQLITE_DB_PATH = path.join(temp, "usage.sqlite")
  const key = {
    id: "money",
    key: "secret",
    quota: { period: "lifetime" as const, amount: 4 },
  }
  const run = <T>(callback: () => T): T =>
    requestContext.run(
      {
        apiKey: key,
        traceId: crypto.randomUUID(),
        startTime: Date.now(),
        userAgent: "test",
        sessionAffinity: undefined,
        parentSessionId: undefined,
      },
      callback,
    )
  const provider = {
    name: "xai",
    type: "openai-responses" as const,
    baseUrl: "https://api.x.ai",
    apiKey: "unused",
    authType: "authorization" as const,
  }
  try {
    await getApiKeyQuotaUsage(key)
    run(() =>
      recordTokenUsageEvent({
        source: "provider",
        providerName: "custom-cny",
        endpoint: "responses",
        model: "quoted",
        input_tokens: 1_000_000,
        pricing: { input: 6.7, output: 0 },
        pricingCurrency: "CNY",
      }),
    )
    await run(async () =>
      recordNativeAlphaSearchUsage(
        Response.json({ usage: { server_tool_use: { tool_search: 1340 } } }),
        {
          providerName: "deepseek",
          officialDeepSeek: true,
          pricingCurrency: "CNY",
          requestHeaders: new Headers(),
          requestBody: await new Response(
            JSON.stringify({ model: "deepseek-flash" }),
          ).arrayBuffer(),
        },
      ),
    )
    await run(async () => {
      const response = observeImagesResponse(
        Response.json({ usage: { cost_in_usd_ticks: 400_000_000 }, data: [] }),
        {
          model: "grok-image",
          operation: "generations",
          providerConfig: provider,
          onMetadata: () => {},
        },
      )
      await response.text()
    })
    run(() =>
      recordTokenUsageEvent({
        source: "copilot",
        endpoint: "responses",
        model: "copilot",
        total_nano_aiu: 100_000_000_000,
      }),
    )
    for (let i = 0; i < 3; i++)
      await run(() =>
        recordVideoResultUsage(
          Response.json({
            status: "done",
            usage: { cost_in_usd_ticks: 2_500_000_000 },
          }),
          {
            providerConfig: provider,
            requestId: "one-job",
            defaultModel: "grok-video",
            onBody: () => {},
          },
        ),
      )
    expect(await getApiKeyQuotaUsage(key)).toMatchObject({
      usedAmount: 3.29,
      remainingAmount: 0.71,
    })
    const summary = await getTokenUsageSummary("lifetime", key.id)
    expect(summary.totals.costs).toEqual([
      { amount: 13.4, currency: "CNY", total_cost_nanos: 13_400_000_000 },
      { amount: 1.29, currency: "USD", total_cost_nanos: 1_290_000_000 },
    ])
    await closeUsageStore()
    expect((await getApiKeyQuotaUsage(key)).usedAmount).toBe(3.29)
  } finally {
    await closeUsageStore()
    if (originalDb === undefined) delete process.env.COPILOT_API_SQLITE_DB_PATH
    else process.env.COPILOT_API_SQLITE_DB_PATH = originalDb
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test("rejects an unpriced dispatch before any upstream call", async () => {
  const { requestContext, setPluginRequestActualModel } = await import(
    "~/lib/http/request-context"
  )
  const context = {
    apiKey: {
      id: "limited",
      key: "key",
      quota: { period: "day" as const, amount: 10 },
    },
    traceId: "unpriced",
    startTime: Date.now(),
    userAgent: "test",
    sessionAffinity: undefined,
    parentSessionId: undefined,
  }
  expect(() =>
    requestContext.run(context, () =>
      setPluginRequestActualModel("no-price", "unpriced-provider"),
    ),
  ).toThrow("Model pricing unavailable")
  expect(() =>
    requestContext.run(context, () =>
      setPluginRequestActualModel("embedding", undefined, "embeddings"),
    ),
  ).toThrow("Model pricing unavailable")
})
