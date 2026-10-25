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
function createState() {
  return {
    subscriptionUsage: {} as Record<string, SubscriptionUsage>,
    subscriptionUsageErrors: {} as Record<string, boolean>,
    isSubscriptionsLoading: false,
    subscriptionRequestId: 0,
    collapsedSections: {},
  }
}

describe("web subscription quota rendering", () => {
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
      expect(win.document.body.textContent).toContain("Subscription Quotas")
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
        win.document.querySelector(
          '[data-collapse-toggle="subscriptionQuotas"]',
        ),
      ).not.toBeNull()
    } finally {
      await win.happyDOM.close()
    }
  })

  test("handles loading, errors, empty data, unlimited and hidden credit balances", () => {
    const state = createState()
    const viewer = createRenderer(state)
    expect(viewer.renderSubscriptionUsageSection()).toBe("")
    state.isSubscriptionsLoading = true
    expect(viewer.renderSubscriptionUsageSection()).toContain(
      "Loading subscription quotas",
    )
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
    expect(rendered).not.toContain("<img")
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
  const pending: Array<{
    url: string
    resolve: (data: unknown) => void
    reject: (reason: unknown) => void
  }> = []
  const source = [
    extract(
      "        function resolveUsageUrl(endpoint) {",
      "        async function fetchJson(url) {",
    ),
    extract(
      "        async function fetchSubscriptionQuotas(usageUrl) {",
      "        /**\n         * Fetches usage data",
    ),
    "({ fetchSubscriptionQuotas })",
  ].join("\n")
  let renders = 0
  const viewer = runInNewContext(source, {
    state,
    endpointUrlInput,
    URL,
    window: { location: { href: "http://gateway/usage-viewer" } },
    render: () => {
      renders += 1
    },
    fetchJson: (url: string) =>
      new Promise((resolve, reject) => {
        pending.push({ url, resolve, reject })
      }),
  }) as { fetchSubscriptionQuotas: (url: string) => Promise<void> }
  return {
    state,
    endpointUrlInput,
    pending,
    viewer,
    renderCount: () => renders,
  }
}

describe("web subscription quota fetching", () => {
  test("loads providers independently from CLI endpoints and preserves path prefixes", async () => {
    const h = createFetcher()
    const done = h.viewer.fetchSubscriptionQuotas(h.endpointUrlInput.value)
    expect(h.pending.map((request) => request.url)).toEqual([
      "http://gateway/prefix/usage/codex",
      "http://gateway/prefix/usage/xai",
    ])
    h.pending[0].resolve(business)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.state.subscriptionUsage.codex).toEqual(business)
    expect(h.state.isSubscriptionsLoading).toBe(true)
    expect(h.renderCount()).toBeGreaterThan(1)
    h.pending[1].reject(
      Object.assign(new Error("upstream failed"), { status: 502 }),
    )
    await done
    expect(h.state.subscriptionUsageErrors.xai).toBe(true)
    expect(h.state.subscriptionUsage.codex).toEqual(business)
    expect(h.state.isSubscriptionsLoading).toBe(false)
  })

  test("ignores disabled subscriptions and older servers without endpoints", async () => {
    const h = createFetcher()
    h.state.subscriptionUsage.codex = business
    const done = h.viewer.fetchSubscriptionQuotas(h.endpointUrlInput.value)
    expect(h.state.subscriptionUsage).toEqual({})
    for (const request of h.pending)
      request.reject(Object.assign(new Error("missing"), { status: 404 }))
    await done
    expect(h.state.subscriptionUsageErrors).toEqual({})
    expect(createRenderer(h.state).renderSubscriptionUsageSection()).toBe("")
  })

  test("discards responses and errors after switching endpoints or refreshing", async () => {
    const h = createFetcher()
    const old = h.viewer.fetchSubscriptionQuotas(h.endpointUrlInput.value)
    h.endpointUrlInput.value = "http://other/usage"
    const current = h.viewer.fetchSubscriptionQuotas(h.endpointUrlInput.value)
    h.pending[2].resolve(business)
    h.pending[3].resolve({ provider: "xai", windows: [], limitReached: false })
    await current
    h.pending[0].reject(new Error("old error"))
    h.pending[1].resolve({
      provider: "xai",
      windows: [],
      planType: "old",
      limitReached: false,
    })
    await old
    expect(h.state.subscriptionUsageErrors).toEqual({})
    expect(h.state.subscriptionUsage.xai.planType).toBeUndefined()
    const stale = h.viewer.fetchSubscriptionQuotas(h.endpointUrlInput.value)
    h.endpointUrlInput.value = "http://third/usage"
    h.pending[4].resolve(business)
    h.pending[5].reject(new Error("late"))
    await stale
    expect(h.state.subscriptionUsage).toEqual({})
    expect(h.state.subscriptionUsageErrors).toEqual({})
  })

  test("reports malformed quota responses independently", async () => {
    const h = createFetcher()
    const done = h.viewer.fetchSubscriptionQuotas(h.endpointUrlInput.value)
    h.pending[0].resolve({ provider: "codex", windows: null })
    h.pending[1].resolve({ provider: "other", windows: [] })
    await done
    expect(h.state.subscriptionUsageErrors).toEqual({ codex: true, xai: true })
  })
})
