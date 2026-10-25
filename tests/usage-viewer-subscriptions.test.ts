import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { runInNewContext } from "node:vm"
import { Window } from "happy-dom"
import type { SubscriptionUsage } from "~/lib/types/subscription-usage"

const html = await readFile(
  new URL("../pages/index.html", import.meta.url),
  "utf8",
)
function extract(start: string, end: string): string {
  const first = html.indexOf(start)
  const last = html.indexOf(end, first)
  if (first < 0 || last < 0) throw new Error(`Missing page script: ${start}`)
  return html.slice(first, last)
}

const business: SubscriptionUsage = {
  provider: "codex",
  planType: "business",
  limitReached: true,
  limitReason: "workspace_member_usage_limit_reached",
  windows: [
    {
      id: "member",
      kind: "spend",
      usedPercent: 100,
      used: 25000,
      limit: 25000,
      unit: "credits",
      resetAt: 1793491200,
    },
  ],
  credits: {
    balance: 17000,
    hasCredits: true,
    unlimited: false,
    unit: "credits",
  },
}
const go: SubscriptionUsage = {
  provider: "opencode-go",
  limitReached: false,
  windows: [
    {
      id: "opencode-go:rolling",
      kind: "usage",
      windowSeconds: 18000,
      usedPercent: 45,
      resetAt: 1793491200,
    },
    {
      id: "opencode-go:weekly",
      kind: "usage",
      period: "weekly",
      usedPercent: 20,
    },
    {
      id: "opencode-go:monthly",
      kind: "usage",
      period: "monthly",
      usedPercent: 10,
    },
  ],
}
function createState() {
  return {
    subscriptionUsage: {} as Record<string, SubscriptionUsage>,
    subscriptionUsageErrors: {} as Record<string, boolean>,
    isSubscriptionsLoading: false,
    subscriptionRequestId: 0,
    subscriptionRequests: {} as Record<string, number>,
    subscriptionLoadingProviders: {} as Record<string, boolean>,
    subscriptionsLoaded: false,
    subscriptionsConnectionKey: null as string | null,
    subscriptionPageError: null as string | null,
    collapsedSections: {},
  }
}

describe("web subscription quota rendering", () => {
  test("shows OpenCode Go's logo, remaining allowance and all three windows", async () => {
    const state = createState()
    state.subscriptionUsage["opencode-go"] = go
    const win = new Window()
    try {
      win.document.body.innerHTML =
        createRenderer(state).renderSubscriptionUsageSection()
      expect(win.document.body.textContent).toContain("OpenCode Go")
      expect(win.document.body.textContent).toContain("55%")
      for (const label of [
        "5-hour limit",
        "Weekly limit",
        "Monthly limit",
        "Resets",
      ])
        expect(win.document.body.textContent).toContain(label)
      expect(
        win.document.querySelectorAll('[role="progressbar"]'),
      ).toHaveLength(3)
      expect(
        win.document.querySelector("img")?.getAttribute("src"),
      ).toStartWith("data:image/svg+xml,")
      expect(
        win.document.querySelector('[data-quota-refresh="opencode-go"]'),
      ).not.toBeNull()
    } finally {
      await win.happyDOM.close()
    }
  })

  test("renders Business credit caps, reset times, named windows and xAI balances", async () => {
    const state = createState()
    state.subscriptionUsage.codex = business
    state.subscriptionUsage.xai = {
      provider: "xai",
      planType: "SuperGrok",
      limitReached: false,
      windows: [
        { id: "weekly", kind: "usage", period: "weekly", usedPercent: 42.5 },
      ],
      credits: {
        balance: 12.5,
        hasCredits: true,
        unlimited: false,
        unit: "USD",
      },
    }
    const viewer = createRenderer(state)
    const win = new Window()
    try {
      win.document.body.innerHTML = viewer.renderSubscriptionUsageSection()
      expect(win.document.body.textContent).toContain("Subscriptions")
      expect(win.document.body.textContent).toContain("Monthly credit limit")
      expect(win.document.body.textContent).toContain("25,000 / 25,000 Credits")
      expect(win.document.body.textContent).toContain(
        "Workspace spending limit reached",
      )
      expect(win.document.body.textContent).toContain("17,000")
      expect(win.document.body.textContent).toContain("Resets")
      expect(win.document.body.textContent).toContain("Weekly limit")
      expect(win.document.body.textContent).toContain("42.5% used")
      expect(win.document.body.textContent).toContain("Prepaid balance")
      expect(win.document.body.textContent).toContain("$12.50")
      expect(
        win.document.querySelectorAll('[role="progressbar"]'),
      ).toHaveLength(2)
      expect(
        win.document.querySelectorAll(".quota-provider-logo img"),
      ).toHaveLength(2)
    } finally {
      await win.happyDOM.close()
    }
  })

  test("handles loading, errors, empty data, unlimited and hidden credit balances", () => {
    const state = createState()
    const viewer = createRenderer(state)
    expect(viewer.renderSubscriptionUsageSection()).toContain(
      "Your subscriptions will appear here",
    )
    state.isSubscriptionsLoading = true
    state.subscriptionLoadingProviders.codex = true
    expect(viewer.renderSubscriptionUsageSection()).toContain("quota-skeleton")
    state.subscriptionLoadingProviders = {}
    state.isSubscriptionsLoading = false
    state.subscriptionUsageErrors.xai = true
    expect(viewer.renderSubscriptionUsageSection()).toContain(
      "Could not load quota",
    )
    state.subscriptionUsageErrors = {}
    state.subscriptionUsage.codex = {
      ...business,
      windows: [],
      limitReached: false,
      credits: undefined,
    }
    expect(viewer.renderSubscriptionUsageSection()).toContain(
      "No quota details reported",
    )
    for (const [credits, text] of [
      [{ hasCredits: true, unlimited: true, unit: "credits" }, "Unlimited"],
      [{ hasCredits: true, unlimited: false, unit: "credits" }, "Available"],
      [{ hasCredits: false, unlimited: false, unit: "credits" }, "—"],
    ] as const) {
      state.subscriptionUsage.codex.credits = credits
      expect(viewer.renderSubscriptionUsageSection()).toContain(text)
    }
    state.subscriptionUsage.codex.limitReached = true
    state.subscriptionUsage.codex.limitReason =
      "workspace_owner_credits_depleted"
    expect(viewer.renderSubscriptionUsageSection()).toContain(
      "Workspace credits are depleted",
    )
    state.subscriptionUsage.codex.limitReason = "rate_limit_reached"
    expect(viewer.renderSubscriptionUsageSection()).toContain(
      "Usage limit reached",
    )
  })

  test("escapes server text and clamps bars while preserving reported percentages", () => {
    const state = createState()
    state.subscriptionUsage.codex = {
      ...business,
      planType: "<script>alert(1)</script>",
      windows: [
        {
          id: "5h",
          kind: "usage",
          windowSeconds: 18000,
          name: '<img src=x onerror="alert(1)">',
          usedPercent: 120,
          limitReached: true,
        },
        { id: "day", kind: "usage", windowSeconds: 172800, usedPercent: -2 },
        { id: "minute", kind: "usage", windowSeconds: 600 },
        { id: "week", kind: "usage", windowSeconds: 604800, usedPercent: 20 },
        { id: "month", kind: "usage", period: "monthly", usedPercent: 40 },
        { id: "unknown", kind: "usage", used: 1, resetAt: NaN },
        { id: "on-demand", kind: "on-demand", limit: 20, unit: "USD" },
      ],
    }
    const rendered = createRenderer(state).renderSubscriptionUsageSection()
    expect(rendered).not.toContain("<script>")
    expect(rendered).not.toContain("<img src=x")
    expect(rendered).toContain("&lt;img")
    expect(rendered).toContain("120% used")
    expect(rendered).toContain('aria-valuenow="100"')
    expect(rendered).toContain('aria-valuenow="0"')
    for (const label of [
      "5-hour limit",
      "2-day limit",
      "10-minute limit",
      "Weekly limit",
      "Monthly limit",
      "Included allowance",
      "Pay as you go",
    ])
      expect(rendered).toContain(label)
    expect(rendered).toContain("— / $20.00")
    expect(rendered).not.toContain("Invalid Date")
  })
})

function createRenderer(state: ReturnType<typeof createState>) {
  const source = [
    extract(
      "        const SUBSCRIPTION_PROVIDERS =",
      "        const DEFAULT_ENDPOINT =",
    ),
    extract(
      "        function escapeHtml(value) {",
      "        function getErrorMessage(error) {",
    ),
    extract(
      "        // --- Collapsible Sections ---",
      "        function getModelField(model, fields) {",
    ),
    extract(
      "        // Subscription quotas use",
      "        function renderTokenUsageSection() {",
    ),
    "({ renderSubscriptionUsageSection })",
  ].join("\n")
  return runInNewContext(source, { state }) as {
    renderSubscriptionUsageSection: () => string
  }
}

function createFetcher() {
  const state = createState()
  const endpointUrlInput = { value: "http://gateway/prefix/usage" }
  const apiKeyInput = { value: "gateway-key" }
  const pending: Array<{
    url: string
    resolve: (data: unknown) => void
    reject: (reason: unknown) => void
  }> = []
  const source = [
    extract(
      "        const SUBSCRIPTION_PROVIDERS =",
      "        const DEFAULT_ENDPOINT =",
    ),
    extract(
      "        function resolveUsageUrl(endpoint) {",
      "        async function fetchJson(url) {",
    ),
    extract(
      "        function getConnectionKey() {",
      "        function syncModelsConnection() {",
    ),
    extract(
      "        function syncSubscriptionsConnection() {",
      "        function handleModelsConnectionChange() {",
    ),
    extract(
      "        async function refreshSubscriptionQuotas(provider) {",
      "        /**\n         * Fetches usage data",
    ),
    "({ fetchSubscriptionQuotas, refreshSubscriptionQuotas, syncSubscriptionsConnection })",
  ].join("\n")
  let renders = 0
  const viewer = runInNewContext(source, {
    state,
    endpointUrlInput,
    apiKeyInput,
    URL,
    window: { location: { href: "http://gateway/usage-viewer" } },
    render: () => {
      renders += 1
    },
    getErrorMessage: (error: Error) => error.message,
    fetchJson: (url: string) =>
      new Promise((resolve, reject) => {
        pending.push({ url, resolve, reject })
      }),
  }) as {
    fetchSubscriptionQuotas: (url: string, provider?: string) => Promise<void>
    refreshSubscriptionQuotas: (provider?: string) => Promise<void>
    syncSubscriptionsConnection: () => void
  }
  return {
    state,
    endpointUrlInput,
    apiKeyInput,
    pending,
    viewer,
    renderCount: () => renders,
  }
}
const copilot: SubscriptionUsage = {
  provider: "github-copilot",
  windows: [],
  limitReached: false,
}
const xai: SubscriptionUsage = {
  provider: "xai",
  windows: [],
  limitReached: false,
}

describe("web subscription quota fetching", () => {
  test("loads all four subscriptions independently and preserves gateway prefixes", async () => {
    const h = createFetcher()
    const done = h.viewer.fetchSubscriptionQuotas(h.endpointUrlInput.value)
    expect(h.pending.map((request) => request.url)).toEqual([
      "http://gateway/prefix/usage/github-copilot",
      "http://gateway/prefix/usage/codex",
      "http://gateway/prefix/usage/xai",
      "http://gateway/prefix/usage/opencode-go",
    ])
    h.pending[1].resolve(business)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.state.subscriptionUsage.codex).toEqual(business)
    expect(h.state.isSubscriptionsLoading).toBe(true)
    expect(h.renderCount()).toBeGreaterThan(1)
    h.pending[0].resolve(copilot)
    h.pending[2].reject(
      Object.assign(new Error("upstream failed"), { status: 502 }),
    )
    h.pending[3].resolve(go)
    await done
    expect(h.state.subscriptionUsageErrors.xai).toBe(true)
    expect(h.state.subscriptionUsage.codex).toEqual(business)
    expect(h.state.subscriptionUsage["opencode-go"]).toEqual(go)
    expect(h.state.isSubscriptionsLoading).toBe(false)
  })

  test("shows an empty page when no subscriptions or endpoints are available", async () => {
    const h = createFetcher()
    const done = h.viewer.fetchSubscriptionQuotas(h.endpointUrlInput.value)
    for (const request of h.pending)
      request.reject(Object.assign(new Error("missing"), { status: 404 }))
    await done
    expect(h.state.subscriptionUsageErrors).toEqual({})
    expect(createRenderer(h.state).renderSubscriptionUsageSection()).toContain(
      "No subscriptions available",
    )
  })

  test("discards stale responses and invalidates quotas when endpoint or credentials change", async () => {
    const h = createFetcher()
    const old = h.viewer.fetchSubscriptionQuotas(h.endpointUrlInput.value)
    h.endpointUrlInput.value = "http://other/usage"
    const current = h.viewer.fetchSubscriptionQuotas(h.endpointUrlInput.value)
    h.pending[4].resolve(copilot)
    h.pending[5].resolve(business)
    h.pending[6].resolve(xai)
    h.pending[7].resolve(go)
    await current
    h.pending[0].reject(new Error("old error"))
    h.pending[1].resolve({ ...business, planType: "old" })
    h.pending[2].resolve({ ...xai, planType: "old" })
    h.pending[3].resolve({ ...go, planType: "old" })
    await old
    expect(h.state.subscriptionUsageErrors).toEqual({})
    expect(h.state.subscriptionUsage.codex.planType).toBe("business")
    expect(h.state.subscriptionUsage["opencode-go"].planType).toBeUndefined()
    h.viewer.syncSubscriptionsConnection()
    expect(h.state.subscriptionUsage).toEqual({})
    h.state.subscriptionUsage.codex = business
    h.apiKeyInput.value = "new-key"
    h.viewer.syncSubscriptionsConnection()
    expect(h.state.subscriptionUsage).toEqual({})
    expect(h.state.isSubscriptionsLoading).toBe(false)
  })

  test("refreshes one provider without disturbing the other providers", async () => {
    const h = createFetcher()
    h.state.subscriptionUsage["github-copilot"] = copilot
    h.state.subscriptionUsage.xai = xai
    const old = h.viewer.fetchSubscriptionQuotas(
      h.endpointUrlInput.value,
      "codex",
    )
    const latest = h.viewer.fetchSubscriptionQuotas(
      h.endpointUrlInput.value,
      "codex",
    )
    h.pending[1].resolve(business)
    await latest
    h.pending[0].reject(new Error("stale"))
    await old
    expect(h.pending).toHaveLength(2)
    expect(h.state.subscriptionUsageErrors).toEqual({})
    expect(h.state.subscriptionUsage).toEqual({
      codex: business,
      "github-copilot": copilot,
      xai,
    })
    expect(h.state.isSubscriptionsLoading).toBe(false)
    const refreshGo = h.viewer.fetchSubscriptionQuotas(
      h.endpointUrlInput.value,
      "opencode-go",
    )
    h.pending[2].resolve(go)
    await refreshGo
    expect(h.state.subscriptionUsage["opencode-go"]).toEqual(go)
    expect(h.state.subscriptionUsage.codex).toEqual(business)
    expect(h.state.subscriptionUsage.xai).toEqual(xai)
    await h.viewer.fetchSubscriptionQuotas(
      h.endpointUrlInput.value,
      "../unsupported",
    )
    expect(h.pending).toHaveLength(3)
  })

  test("handles invalid URLs and malformed responses", async () => {
    const h = createFetcher()
    h.endpointUrlInput.value = ""
    await h.viewer.refreshSubscriptionQuotas()
    expect(h.state.subscriptionPageError).toContain(
      "Endpoint URL cannot be empty",
    )
    h.endpointUrlInput.value = "http://gateway/usage"
    const done = h.viewer.refreshSubscriptionQuotas()
    h.pending[0].resolve(null)
    h.pending[1].resolve({ provider: "codex", windows: null })
    h.pending[2].resolve({ provider: "other", windows: [] })
    h.pending[3].resolve({ provider: "opencode-go", windows: null })
    await done
    expect(h.state.subscriptionUsageErrors).toEqual({
      "github-copilot": true,
      codex: true,
      xai: true,
      "opencode-go": true,
    })
  })
})
