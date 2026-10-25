import { afterEach, describe, expect, spyOn, test } from "bun:test"

import * as providerResolver from "~/lib/provider-resolver"
import * as grokBuild from "~/lib/grok-build"
import * as xaiToken from "~/lib/xai-token"
import * as githubProvider from "~/lib/github-copilot-provider"
import { state } from "~/lib/state"
import * as subscriptionUsage from "~/services/subscription-usage"
import {
  getSubscriptionUsage,
  normalizeCodexUsage,
  normalizeXaiUsage,
  normalizeCopilotUsage,
  normalizeOpencodeGoUsage,
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

const goWindow = { status: "ok", percent: 25, resetsAt: "2026-11-01T08:00:00Z" }

describe("OpenCode Go subscription usage", () => {
  test("normalizes rolling, weekly and monthly allowances without inventing monetary limits", () => {
    const usage = normalizeOpencodeGoUsage({
      usage: {
        rolling: { ...goWindow, percent: 0 },
        weekly: { ...goWindow, percent: 100 },
        monthly: { ...goWindow, status: "rate-limited", percent: 99.9 },
      },
      account: "private-account",
    })
    expect(usage.windows).toHaveLength(3)
    expect(usage.windows[0]).toMatchObject({
      id: "opencode-go:rolling",
      usedPercent: 0,
      windowSeconds: 18000,
      resetAt: Date.parse(goWindow.resetsAt) / 1000,
      limitReached: false,
    })
    expect(usage.windows[1]).toMatchObject({
      period: "weekly",
      usedPercent: 100,
      limitReached: true,
    })
    expect(usage.windows[2]).toMatchObject({
      period: "monthly",
      usedPercent: 99.9,
      limitReached: true,
    })
    expect(usage.limitReached).toBe(true)
    expect(usage.planType).toBeUndefined()
    expect(usage.credits).toBeUndefined()
    expect(
      usage.windows.every(
        (window) => window.used === undefined && window.limit === undefined,
      ),
    ).toBe(true)
    expect(JSON.stringify(usage)).not.toContain("private-account")
  })

  test("handles missing windows and rejects invalid percentage or status responses", () => {
    expect(
      normalizeOpencodeGoUsage({ usage: { rolling: null } }),
    ).toMatchObject({
      provider: "opencode-go",
      windows: [],
      limitReached: false,
    })
    expect(
      normalizeOpencodeGoUsage({
        usage: { monthly: { ...goWindow, resetsAt: "invalid" } },
      }).windows[0].resetAt,
    ).toBeUndefined()
    expect(
      normalizeOpencodeGoUsage({
        usage: { weekly: { ...goWindow, resetsAt: null } },
      }).windows[0].resetAt,
    ).toBeUndefined()
    for (const value of [
      {},
      { usage: { rolling: { ...goWindow, percent: NaN } } },
      { usage: { rolling: { ...goWindow, status: "unexpected" } } },
    ])
      expect(() => normalizeOpencodeGoUsage(value)).toThrow()
  })
})

describe("Copilot subscription usage", () => {
  test("normalizes Premium, Chat and Completions with exact reset dates", () => {
    const result = normalizeCopilotUsage({
      login: "private-login",
      copilot_plan: "individual",
      quota_reset_date: "2026-11-01",
      quota_snapshots: {
        premium_interactions: {
          entitlement: 1500,
          remaining: 1049,
          percent_remaining: 69.9,
        },
        chat: { entitlement: 100, quota_remaining: 0 },
        completions: { unlimited: true },
      },
    })
    expect(result.provider).toBe("github-copilot")
    expect(result.planType).toBe("individual")
    expect(result.windows[0]).toMatchObject({
      id: "copilot:premium_interactions",
      used: 451,
      limit: 1500,
      resetDate: "2026-11-01",
      unit: "requests",
    })
    expect(result.windows[0].usedPercent).toBeCloseTo(30.1)
    expect(result.windows[1]).toMatchObject({
      usedPercent: 100,
      limitReached: true,
    })
    expect(result.windows[2]).toMatchObject({
      unlimited: true,
      usedPercent: undefined,
      limitReached: false,
    })
    expect(result.limitReached).toBe(true)
    expect(JSON.stringify(result)).not.toContain("private-login")
  })

  test("handles percentage-only values and unknown or empty quotas", () => {
    const result = normalizeCopilotUsage({
      quota_snapshots: {
        premium_interactions: { percent_remaining: 25 },
        chat: {},
        completions: { entitlement: 100, remaining: 150 },
      },
    })
    expect(result.windows).toHaveLength(2)
    expect(result.windows[0]).toMatchObject({
      usedPercent: 75,
      used: undefined,
      limit: undefined,
    })
    expect(result.windows[1].used).toBe(0)
    expect(
      normalizeCopilotUsage({
        quota_snapshots: { premium_interactions: { percent_remaining: 99.9 } },
      }).windows[0].usedPercent,
    ).toBeCloseTo(0.1)
    expect(normalizeCopilotUsage({}).windows).toEqual([])
    expect(
      normalizeCopilotUsage({ quota_snapshots: { chat: { entitlement: 0 } } })
        .windows[0].usedPercent,
    ).toBeUndefined()
    expect(() =>
      normalizeCopilotUsage({
        quota_snapshots: { chat: { percent_remaining: NaN } },
      }),
    ).toThrow()
  })

  test("queries Copilot independently of third-party OAuth routing", async () => {
    const enabled = track(
      spyOn(githubProvider, "isGitHubCopilotEnabled"),
    ).mockReturnValue(true)
    const getUsage = track(
      spyOn(copilotUsage, "getCopilotUsage"),
    ).mockResolvedValue({ copilot_plan: "business" } as Awaited<
      ReturnType<typeof copilotUsage.getCopilotUsage>
    >)
    const controller = new AbortController()
    expect(
      await getSubscriptionUsage("github-copilot", controller.signal),
    ).toMatchObject({ provider: "github-copilot", planType: "business" })
    const signal = getUsage.mock.calls[0][1]
    controller.abort()
    expect(signal?.aborted).toBe(true)
    getUsage.mockResolvedValue(null)
    expect(await getSubscriptionUsage("github-copilot")).toBeNull()
    enabled.mockReturnValue(false)
    expect(await getSubscriptionUsage("github-copilot")).toBeNull()
    expect(getUsage).toHaveBeenCalledTimes(2)
  })

  test("forwards cancellation to the existing GitHub usage request", async () => {
    const fetcher = track(spyOn(globalThis, "fetch")).mockResolvedValue(
      Response.json({ copilot_plan: "individual" }),
    )
    const controller = new AbortController()
    await copilotUsage.getCopilotUsage("github-token", controller.signal)
    expect(fetcher.mock.calls[0][1]?.signal).toBe(controller.signal)
  })
})

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
  provider: "codex" | "xai" | "opencode-go",
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
  test("OpenCode Go uses the configured API key and the existing endpoint normalization", async () => {
    const resolver = mockProvider("opencode-go", "authorization")
    const fetcher = track(spyOn(globalThis, "fetch")).mockImplementation(
      Object.assign(
        () => Promise.resolve(Response.json({ usage: { rolling: goWindow } })),
        { preconnect: () => {} },
      ),
    )
    const controller = new AbortController()
    for (const [baseUrl, expected] of [
      [
        "https://opencode.ai/zen/go/",
        "https://opencode.ai/inference/go/v1/usage",
      ],
      [
        "https://opencode.ai/inference/go",
        "https://opencode.ai/inference/go/v1/usage",
      ],
      [
        "https://opencode.ai/inference/go/v1",
        "https://opencode.ai/inference/go/v1/usage",
      ],
      ["https://gateway.example/go", "https://gateway.example/go/v1/usage"],
    ]) {
      resolver.mockResolvedValue({
        name: "opencode-go",
        type: "openai-compatible",
        baseUrl,
        apiKey: "go-api-key",
        authType: "authorization",
      })
      expect(
        await getSubscriptionUsage("opencode-go", controller.signal),
      ).toMatchObject({ provider: "opencode-go" })
      const [url, init] = fetcher.mock.calls.at(-1)!
      expect(url).toBe(expected)
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer go-api-key",
      )
      expect(new Headers(init?.headers).get("accept")).toBe("application/json")
      expect(init?.redirect).toBe("error")
    }
    const signal = fetcher.mock.calls.at(-1)![1]?.signal
    controller.abort()
    expect(signal?.aborted).toBe(true)
    resolver.mockResolvedValue(null)
    expect(await getSubscriptionUsage("opencode-go")).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  test("OpenCode Go failures remain generic and do not expose account information", async () => {
    mockProvider("opencode-go", "authorization")
    const fetcher = track(spyOn(globalThis, "fetch")).mockResolvedValue(
      new Response("private-go-account", { status: 403 }),
    )
    expect(await getSubscriptionUsage("opencode-go")).toBeNull()
    fetcher.mockResolvedValue(
      new Response("private-go-account", { status: 401 }),
    )
    expect(
      await getSubscriptionUsage("opencode-go").catch(
        (error: unknown) => error,
      ),
    ).toMatchObject({
      message: "Subscription usage request failed (HTTP 401)",
    })
    fetcher.mockResolvedValue(
      Response.json({ unexpected: "private-go-account" }),
    )
    expect(
      await getSubscriptionUsage("opencode-go").catch(
        (error: unknown) => error,
      ),
    ).toBeInstanceOf(Error)
  })

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
    const go = {
      provider: "opencode-go" as const,
      windows: [],
      limitReached: false,
    }
    getter.mockResolvedValue(go)
    const goResponse = await usageRoute.request("/opencode-go")
    expect(goResponse.status).toBe(200)
    expect(await goResponse.json()).toEqual(go)
    getter.mockResolvedValue(null)
    expect((await usageRoute.request("/xai")).status).toBe(404)
    expect((await usageRoute.request("/opencode-go")).status).toBe(404)
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
