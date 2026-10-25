import { afterEach, describe, expect, spyOn, test } from "bun:test"

import * as providerResolver from "~/lib/provider-resolver"
import * as grokBuild from "~/lib/grok-build"
import * as xaiToken from "~/lib/xai-token"
import { state } from "~/lib/state"
import * as subscriptionUsage from "~/services/subscription-usage"
import {
  getSubscriptionUsage,
  normalizeCodexUsage,
  normalizeXaiUsage,
} from "~/services/subscription-usage"
import * as copilotUsage from "~/services/github/get-copilot-usage"
import { usageRoute } from "~/routes/usage/route"

const initialState = { ...state }
afterEach(() => {
  for (const key of Object.keys(state) as Array<keyof typeof state>) {
    if (!(key in initialState)) Reflect.deleteProperty(state, key)
  }
  Object.assign(state, initialState)
  // All spies in this file are scoped to one test.
  for (const restore of restores.splice(0).reverse()) restore()
})
const restores: Array<() => void> = []
function track<T extends { mockRestore: () => void }>(spy: T): T {
  restores.push(() => spy.mockRestore())
  return spy
}

const codexWindow = {
  used_percent: 42,
  limit_window_seconds: 18000,
  reset_after_seconds: 120,
  reset_at: 1793000000,
}

describe("Codex subscription usage", () => {
  test("preserves personal windows, names, and explicit zero values", () => {
    const result = normalizeCodexUsage({
      plan_type: "plus",
      user_id: "not-for-the-renderer",
      rate_limit: {
        allowed: true,
        primary_window: codexWindow,
        secondary_window: {
          ...codexWindow,
          used_percent: 0,
          reset_at: 0,
          limit_window_seconds: 604800,
        },
      },
      additional_rate_limits: [
        {
          limit_name: "Codex Other",
          metered_feature: "codex_other",
          rate_limit: { primary_window: { ...codexWindow, used_percent: 88 } },
        },
      ],
    })
    expect(result.windows).toHaveLength(3)
    expect(result.windows[0]).toMatchObject({
      usedPercent: 42,
      windowSeconds: 18000,
      resetAt: 1793000000,
    })
    expect(result.windows[1]).toMatchObject({
      usedPercent: 0,
      windowSeconds: 604800,
      resetAt: 0,
    })
    expect(result.windows[2]).toMatchObject({
      name: "Codex Other",
      usedPercent: 88,
    })
    expect(JSON.stringify(result)).not.toContain("not-for-the-renderer")
  })

  test("supports Business without personal windows and with a monthly member credit limit", () => {
    const result = normalizeCodexUsage(
      {
        plan_type: "self_serve_business_usage_based",
        rate_limit: null,
        credits: { has_credits: true, unlimited: false, balance: "17000.25" },
        spend_control: {
          reached: false,
          individual_limit: {
            limit: "25000",
            used: "8000",
            used_percent: 32,
            remaining: "17000",
            reset_after_seconds: 3600,
          },
        },
        additional_rate_limits: [
          {
            limit_name: "Absent",
            metered_feature: "missing",
            rate_limit: null,
          },
        ],
      },
      1000000,
    )
    expect(result.planType).toBe("self_serve_business_usage_based")
    expect(result.windows).toEqual([
      {
        id: "individual-limit",
        kind: "spend",
        period: "monthly",
        usedPercent: 32,
        used: 8000,
        limit: 25000,
        unit: "credits",
        resetAt: 4600,
        limitReached: false,
      },
    ])
    expect(result.credits).toEqual({
      balance: 17000.25,
      hasCredits: true,
      unlimited: false,
      unit: "credits",
    })
    expect(result.limitReached).toBe(false)
  })

  test("supports unlimited Business credits, depleted pools, and spend-control limits", () => {
    expect(
      normalizeCodexUsage({
        plan_type: "business",
        credits: { has_credits: true, unlimited: true, balance: null },
      }).credits?.unlimited,
    ).toBe(true)
    const reached = normalizeCodexUsage({
      plan_type: "business",
      rate_limit: { allowed: false },
      credits: { has_credits: false, unlimited: false, balance: "0" },
      spend_control: { reached: true, individual_limit: null },
      rate_limit_reached_type: { type: "workspace_member_credits_depleted" },
    })
    expect(reached.limitReached).toBe(true)
    expect(reached.limitReason).toBe("workspace_member_credits_depleted")
    expect(reached.credits?.balance).toBe(0)
    expect(
      normalizeCodexUsage({
        plan_type: "team",
        rate_limit: {
          limit_reached: true,
          primary_window: { used_percent: 100 },
        },
      }).windows[0],
    ).toMatchObject({ limitReached: true, resetAt: undefined })
  })

  test("rejects malformed quotas instead of inventing remaining usage", () => {
    expect(() => normalizeCodexUsage({})).toThrow()
    expect(() =>
      normalizeCodexUsage({
        plan_type: "business",
        credits: { has_credits: true, unlimited: false, balance: "" },
      }),
    ).toThrow()
    expect(() =>
      normalizeCodexUsage({
        plan_type: "plus",
        rate_limit: { primary_window: { used_percent: NaN } },
      }),
    ).toThrow()
  })
})

describe("Grok Build subscription usage", () => {
  test("prefers weekly credits-config percentages over legacy budgets", () => {
    const result = normalizeXaiUsage({
      config: {
        creditUsagePercent: 0,
        monthlyLimit: { val: 2000 },
        used: { val: 1200 },
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          end: "2026-11-01T00:00:00Z",
        },
        prepaidBalance: { val: "-1250" },
      },
      subscription_tier: "SuperGrok Heavy",
    })
    expect(result.windows[0]).toMatchObject({
      usedPercent: 0,
      period: "weekly",
      resetAt: Date.parse("2026-11-01T00:00:00Z") / 1000,
      used: undefined,
      limit: undefined,
    })
    expect(result.credits?.balance).toBe(12.5)
    expect(result.planType).toBe("SuperGrok Heavy")
  })

  test("supports legacy cents and proto3 zero omission", () => {
    const result = normalizeXaiUsage({
      config: {
        monthlyLimit: { val: "2000" },
        used: {},
        onDemandCap: { val: 5000 },
        onDemandUsed: { val: -300 },
        prepaidBalance: {},
        billingPeriodEnd: "2026-11-01T00:00:00Z",
      },
    })
    expect(result.windows[0]).toMatchObject({
      usedPercent: 0,
      used: 0,
      limit: 20,
      period: "monthly",
    })
    expect(result.windows[1]).toMatchObject({
      usedPercent: 6,
      used: 3,
      limit: 50,
    })
    expect(result.credits?.balance).toBe(0)
  })

  test("handles monthly percentages, exhausted allowances, missing and zero limits", () => {
    const monthly = normalizeXaiUsage({
      config: {
        creditUsagePercent: 105,
        currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY", end: "invalid" },
      },
    })
    expect(monthly.limitReached).toBe(true)
    expect(monthly.windows[0]).toMatchObject({
      period: "monthly",
      resetAt: undefined,
    })
    expect(
      normalizeXaiUsage({
        config: { monthlyLimit: {}, used: { val: 10 }, onDemandCap: {} },
      }).windows[0].usedPercent,
    ).toBeUndefined()
    expect(
      normalizeXaiUsage({
        config: { monthlyLimit: { val: 2000 }, used: { val: 1000 } },
      }).windows[0].usedPercent,
    ).toBe(50)
    expect(
      normalizeXaiUsage({ config: { used: { val: 10 } } }).windows[0],
    ).toMatchObject({ period: undefined, resetAt: undefined })
    expect(normalizeXaiUsage({ config: null }).windows).toEqual([])
    expect(normalizeXaiUsage({}).windows).toEqual([])
    expect(
      normalizeXaiUsage({ config: { onDemandUsed: {} } }).windows[0].limit,
    ).toBe(0)
  })
})

function mockProvider(
  provider: "codex" | "xai",
  authType: "oauth2" | "authorization" = "oauth2",
) {
  return track(
    spyOn(providerResolver, "resolveProviderConfig"),
  ).mockResolvedValue({
    name: provider,
    type: "openai-responses",
    baseUrl: "https://ignored.invalid",
    apiKey: "upstream-token",
    authType,
  })
}

describe("subscription usage requests", () => {
  test("Codex uses server credentials and the official backend-client headers", async () => {
    mockProvider("codex")
    state.codexAccessToken = "selected-codex-token"
    state.codexAccountId = "business-workspace"
    const fetcher = track(spyOn(globalThis, "fetch")).mockResolvedValue(
      Response.json({ plan_type: "business", rate_limit: null }),
    )
    const controller = new AbortController()
    expect(
      (await getSubscriptionUsage("codex", controller.signal))?.provider,
    ).toBe("codex")
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe("https://chatgpt.com/backend-api/wham/usage")
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe("Bearer selected-codex-token")
    expect(headers.get("chatgpt-account-id")).toBe("business-workspace")
    expect(headers.get("originator")).toBe("codex_cli_rs")
    expect(headers.get("user-agent")).toMatch(
      /^codex_cli_rs\/0\.164\.0 \(.+; .+\) unknown$/u,
    )
    expect(headers.get("version")).toBe("0.164.0")
    expect(init?.redirect).toBe("error")
    controller.abort()
    expect(init?.signal?.aborted).toBe(true)
  })

  test("xAI matches the Grok Build billing endpoint, version, and account headers", async () => {
    mockProvider("xai")
    track(spyOn(xaiToken, "readXaiCredentials")).mockResolvedValue({
      accountId: "grok-user",
      accessToken: "upstream-token",
      refreshToken: "refresh",
      expiresAt: Date.now() + 60000,
    })
    track(spyOn(grokBuild, "getGrokBuildVersion")).mockResolvedValue("1.0.46")
    const fetcher = track(spyOn(globalThis, "fetch")).mockResolvedValue(
      Response.json({ config: { creditUsagePercent: 40 } }),
    )
    expect((await getSubscriptionUsage("xai"))?.windows[0].usedPercent).toBe(40)
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe(
      "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
    )
    const headers = new Headers(init?.headers)
    expect(headers.get("authorization")).toBe("Bearer upstream-token")
    expect(headers.get("x-xai-token-auth")).toBe("xai-grok-cli")
    expect(headers.get("x-userid")).toBe("grok-user")
    expect(headers.get("x-grok-client-version")).toBe("1.0.46")
    expect(headers.get("x-grok-client-mode")).toBe("headless")
    expect(headers.get("user-agent")).toMatch(
      /^grok-shell\/1\.0\.46 \([a-z0-9]+; [a-z0-9_]+\)$/u,
    )
  })

  test("skips unavailable subscriptions and API-key providers", async () => {
    const resolver = mockProvider("xai", "authorization")
    const fetcher = track(spyOn(globalThis, "fetch"))
    expect(await getSubscriptionUsage("xai")).toBeNull()
    resolver.mockResolvedValue(null)
    expect(await getSubscriptionUsage("codex")).toBeNull()
    resolver.mockResolvedValue({
      name: "xai",
      type: "openai-responses",
      baseUrl: "https://ignored.invalid",
      apiKey: "upstream-token",
      authType: "oauth2",
    })
    track(spyOn(xaiToken, "readXaiCredentials")).mockResolvedValue(null)
    expect(await getSubscriptionUsage("xai")).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })

  test("rejects account changes and redacts upstream errors", async () => {
    mockProvider("xai")
    track(spyOn(xaiToken, "readXaiCredentials")).mockResolvedValue({
      accountId: "changed",
      accessToken: "different",
      refreshToken: "refresh",
      expiresAt: Date.now() + 60000,
    })
    expect(
      await getSubscriptionUsage("xai").catch((error: unknown) => error),
    ).toMatchObject({
      message: "Subscription account changed during the usage query",
    })
    mockProvider("codex")
    state.codexAccessToken = "token"
    state.codexAccountId = "account"
    track(spyOn(globalThis, "fetch")).mockResolvedValue(
      new Response("private-account-data", { status: 401 }),
    )
    expect(
      await getSubscriptionUsage("codex").catch((error: unknown) => error),
    ).toMatchObject({ message: "Subscription usage request failed (HTTP 401)" })
  })
})

describe("subscription usage HTTP routes", () => {
  test("returns quotas, handles unavailable providers, and keeps Copilot usage compatible", async () => {
    const usage = {
      provider: "codex" as const,
      planType: "business",
      windows: [],
      limitReached: false,
    }
    const getter = track(
      spyOn(subscriptionUsage, "getSubscriptionUsage"),
    ).mockResolvedValue(usage)
    const response = await usageRoute.request("/codex")
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual(usage)
    getter.mockResolvedValue(null)
    expect((await usageRoute.request("/xai")).status).toBe(404)
    expect((await usageRoute.request("/unsupported")).status).toBe(404)
    getter.mockRejectedValue(new Error("private-upstream-body"))
    const failed = await usageRoute.request("/codex")
    expect(failed.status).toBe(502)
    expect(await failed.text()).not.toContain("private-upstream-body")
    track(spyOn(copilotUsage, "getCopilotUsage")).mockResolvedValue({
      copilot_plan: "individual",
    } as Awaited<ReturnType<typeof copilotUsage.getCopilotUsage>>)
    const copilot = await usageRoute.request("/")
    expect(await copilot.json()).toEqual({ copilot_plan: "individual" })
  })
})
