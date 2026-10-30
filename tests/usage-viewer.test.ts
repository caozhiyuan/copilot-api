import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { runInNewContext } from "node:vm"
import { Window } from "happy-dom"
import type { TokenUsageSummary } from "../desktop/src/types/ipc"

const pagePath = new URL("../pages/index.html", import.meta.url)

async function readUsageViewerPage(): Promise<string> {
  return readFile(pagePath, "utf8")
}

function extractInlineFunctionRange(
  html: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = html.indexOf(startMarker)
  const end = html.indexOf(endMarker, start)
  if (start === -1 || end === -1) {
    throw new Error(`Unable to find inline function range: ${startMarker}`)
  }
  return html.slice(start, end)
}

function extractCollapseHelpers(html: string): string {
  return extractInlineFunctionRange(
    html,
    "        // --- Collapsible Sections ---",
    "        function getModelField(model, fields) {",
  )
}

describe("usage viewer image model discovery", () => {
  test.each([
    ["http://localhost:4141/usage", "http://localhost:4141/models"],
    [
      "https://gateway.example/proxy/v1/usage?old=1#quota",
      "https://gateway.example/proxy/v1/models",
    ],
    ["/v1/usage", "https://viewer.example/v1/models"],
  ])(
    "loads image models from %s with gateway credentials",
    async (endpoint, expectedUrl) => {
      const html = await readUsageViewerPage()
      const source = [
        [
          "function parseCredential(value)",
          "function resolveUsageUrl(endpoint)",
        ],
        [
          "function deriveEndpointUrl(usageEndpoint, targetPath)",
          "function buildTokenUsageSummaryUrl(usageEndpoint, period)",
        ],
        ["async function fetchJson(url)", "function syncUrlState()"],
        ["async function fetchModels()", "function activateTab(tab)"],
      ]
        .map(([start, end]) => extractInlineFunctionRange(html, start, end))
        .join("\n")
      const imageModels = [
        { id: "codex/gpt-image-2", type: "image" },
        { id: "xai/grok-imagine-image-2.0", type: "image" },
      ]
      const state = {
        models: null as typeof imageModels | null,
        modelsError: null,
        modelsConnectionKey: "connection",
        modelsRequestId: 0,
        isModelsLoading: false,
      }
      const requests: Array<{ url: string; headers: Headers }> = []
      const viewer = runInNewContext(`${source}\n({ fetchModels })`, {
        URL,
        window: { location: { href: "https://viewer.example/usage-viewer" } },
        endpointUrlInput: { value: endpoint },
        apiKeyInput: { value: "Bearer viewer-key" },
        state,
        syncEndpointCredential: () => {},
        syncModelsConnection: () => {},
        getConnectionKey: () => "connection",
        render: () => {},
        getErrorMessage: String,
        fetch: (url: string, init: RequestInit) => {
          requests.push({ url, headers: new Headers(init.headers) })
          return Promise.resolve(Response.json({ data: imageModels }))
        },
      }) as { fetchModels: () => Promise<void> }
      await viewer.fetchModels()
      expect(requests).toHaveLength(1)
      expect(requests[0].url).toBe(expectedUrl)
      expect(requests[0].headers.get("authorization")).toBe("Bearer viewer-key")
      expect(state.models).toEqual(imageModels)
      expect(state.modelsError).toBeNull()
      expect(state.isModelsLoading).toBe(false)
    },
  )
})

describe("usage viewer period contract", () => {
  test("supports all periods in the selector and usage requests", async () => {
    const html = await readUsageViewerPage()
    const options = [
      ...(
        html.match(/<select\s+id="token-usage-period"[\s\S]*?<\/select>/)?.[0]
        ?? ""
      ).matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g),
    ].map((match) => [match[1], match[2]])

    expect(options).toEqual([
      ["today", "Today"],
      ["this_week", "This week"],
      ["last_7_days", "Last 7 days"],
      ["this_month", "This month"],
      ["last_30_days", "Last 30 days"],
      ["lifetime", "Lifetime"],
    ])

    expect(html).toContain("if (VALID_PERIODS.has(value)) {")
    expect(html).toContain(
      "LEGACY_PERIODS[value] || DEFAULT_TOKEN_USAGE_PERIOD",
    )
    expect(html).toContain("const MAX_LIFETIME_TREND_POINTS = 180")
    expect(html).toContain(
      "getDailyTrendTotals(day, selectedModel).request_count > 0",
    )
    expect(html).toContain("tokenUsageTrendDay: null")
    expect(html).toContain('data-trend-day="${escapeHtml(day.date)}"')
    expect(html).not.toContain('data-trend-day="${day.date}"')
    expect(html).toContain(
      "fetchJson(buildTokenUsageSummaryUrl(usageUrl, period))",
    )
    expect(html).toContain(
      "fetchJson(buildTokenUsageDailyUrl(usageUrl, period))",
    )
    expect(html).toContain(
      "fetchJson(buildTokenUsageEventsUrl(usageUrl, period, page))",
    )
    expect(html).toContain(
      "buildTokenUsageEventsUrl(usageUrl, getSelectedPeriod(), page)",
    )

    for (const builder of ["Summary", "Daily", "Events"]) {
      expect(html).toContain(`function buildTokenUsage${builder}Url`)
      expect(html).toContain('url.searchParams.set("period", period)')
    }
  })
})

describe("usage viewer model cache hit rate", () => {
  test("renders rates including cache writes and excluding output tokens", async () => {
    const html = await readUsageViewerPage()
    const source = [
      extractInlineFunctionRange(
        html,
        "        function escapeHtml(value) {",
        "        function getErrorMessage(error) {",
      ),
      extractInlineFunctionRange(
        html,
        "        function formatNumber(value) {",
        "        function formatDateTime(value) {",
      ),
      extractInlineFunctionRange(
        html,
        "        function formatCellText(value) {",
        "        function formatRangeDate(value) {",
      ),
      extractInlineFunctionRange(
        html,
        "        function renderTokenUsageValueLines(value) {",
        "        function renderTokenUsageEventsTable(eventsPage) {",
      ),
      extractInlineFunctionRange(
        html,
        "        function renderEmptyState(message) {",
        "        function renderSpinner() {",
      ),
      extractInlineFunctionRange(
        html,
        "        function renderTokenUsageSection() {",
        "        function getTokenUsageTrendMetrics() {",
      ),
      extractCollapseHelpers(html),
      "({ renderTokenUsageModelBreakdown, formatCacheHitRate, renderTokenUsageSection })",
    ].join("\n")
    const state: {
      isTokenUsageLoading: boolean
      tokenUsageSummary?: TokenUsageSummary
      isSessionsLoading: boolean
      tokenUsageSessionsError: string | null
      tokenUsageSessionsPage: unknown
      collapsedSections: Record<string, boolean>
    } = {
      collapsedSections: {},
      isTokenUsageLoading: false,
      isSessionsLoading: false,
      tokenUsageSessionsError: null,
      tokenUsageSessionsPage: null,
    }
    const viewer = runInNewContext(source, {
      state,
      renderError: (message: string) => `<p>${message}</p>`,
      renderTokenUsageRangeText: () => "Today",
      renderTokenUsageDailyTrend: () => "",
      renderPaginationButton: () => "",
      renderTokenUsageEventsTable: () => "",
    }) as {
      renderTokenUsageModelBreakdown: (summary: TokenUsageSummary) => string
      formatCacheHitRate: (usage: TokenUsageSummary["totals"]) => string
      renderTokenUsageSection: () => string
    }
    const totals = {
      average_first_token_ms: null,
      output_tokens_per_second: null,
      request_count: 10,
      input_tokens: 200,
      output_tokens: 9000,
      cache_read_input_tokens: 600,
      cache_creation_input_tokens: 200,
      costs: [
        { currency: "USD", amount: 1.25, total_cost_nanos: 1_250_000_000 },
        { currency: "CNY", amount: 9.5, total_cost_nanos: 9_500_000_000 },
      ],
      total_tokens: 10000,
    }
    const examples = [
      { ...totals, model: "<cached-model>", expected: "60.0%" },
      {
        ...totals,
        model: "uncached-model",
        cache_read_input_tokens: 0,
        expected: "0.0%",
      },
      {
        ...totals,
        model: "fully-cached",
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        expected: "100.0%",
      },
      {
        ...totals,
        model: "rounded",
        input_tokens: 2,
        cache_read_input_tokens: 1,
        cache_creation_input_tokens: 0,
        expected: "33.3%",
      },
      {
        ...totals,
        model: "empty-model",
        input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        expected: "—",
      },
    ]
    const summary: TokenUsageSummary = {
      period: "today",
      range: { start_ms: 0, end_ms: 1, start_utc: "", end_utc: "" },
      totals,
      byModel: examples,
    }
    const rendered = viewer.renderTokenUsageModelBreakdown(summary)
    const win = new Window()
    try {
      win.document.body.innerHTML = rendered
      expect(
        [...win.document.querySelectorAll("th")].map((node) =>
          node.textContent?.trim(),
        ),
      ).toEqual([
        "Model",
        "Requests",
        "Input",
        "Output",
        "Cache Read",
        "Cache Write",
        "Cache Hit Rate",
        "Avg. TTFT",
        "Output speed",
        "Total Tokens",
        "Total Cost",
      ])
      expect(win.document.querySelector("th")?.className).toContain("w-[200px]")
      for (const label of ["Cache Hit Rate", "Output speed"]) {
        const header = [...win.document.querySelectorAll("th")].find(
          (node) => node.textContent?.trim() === label,
        )
        expect(header?.className).toContain("whitespace-nowrap")
      }
      const rows = [...win.document.querySelectorAll("tbody tr")]
      expect(
        rows.map((row) => row.querySelectorAll("td")[6].textContent),
      ).toEqual(examples.map((example) => example.expected))
      expect(
        rows.every((row) => row.querySelectorAll("td").length === 11),
      ).toBe(true)
      expect(rows[0].querySelector("td")?.textContent).toBe("<cached-model>")
      expect(win.document.querySelector("cached-model")).toBeNull()
      for (const example of examples) {
        expect(viewer.formatCacheHitRate(example)).toBe(example.expected)
      }
      expect(
        viewer.renderTokenUsageModelBreakdown({ ...summary, byModel: [] }),
      ).toContain("No token usage recorded")
      state.tokenUsageSummary = summary
      win.document.body.innerHTML = viewer.renderTokenUsageSection()
      for (const [label, amount] of [
        ["Cost (USD)", "$1.250000"],
        ["Cost (CNY)", "¥9.500000"],
      ]) {
        const costMetric = [
          ...win.document.querySelectorAll(".metric-card"),
        ].find(
          (node) =>
            node.querySelector(".metric-label")?.textContent?.trim() === label,
        )
        expect(
          [...costMetric!.querySelectorAll(".metric-value span")].map(
            (node) => node.textContent,
          ),
        ).toEqual([amount])
      }
      const cacheMetric = [
        ...win.document.querySelectorAll(".metric-card"),
      ].find(
        (node) =>
          node.querySelector(".metric-label")?.textContent?.trim()
          === "Cache Hit Rate",
      )
      expect(cacheMetric?.querySelector(".metric-value")?.textContent).toBe(
        "60.0%",
      )
      state.tokenUsageSummary = {
        ...summary,
        totals: {
          ...totals,
          input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      }
      win.document.body.innerHTML = viewer.renderTokenUsageSection()
      expect(
        [...win.document.querySelectorAll(".metric-card")]
          .find(
            (node) =>
              node.querySelector(".metric-label")?.textContent?.trim()
              === "Cache Hit Rate",
          )
          ?.querySelector(".metric-value")?.textContent,
      ).toBe("—")
    } finally {
      await win.happyDOM.close()
    }
  })
})

describe("usage viewer cost metrics", () => {
  test("only renders cost metrics for currencies recorded in the summary", async () => {
    const html = await readUsageViewerPage()
    const source = [
      extractInlineFunctionRange(
        html,
        "        function escapeHtml(value) {",
        "        function getErrorMessage(error) {",
      ),
      extractInlineFunctionRange(
        html,
        "        function formatNumber(value) {",
        "        function formatDateTime(value) {",
      ),
      extractInlineFunctionRange(
        html,
        "        function formatCellText(value) {",
        "        function formatRangeDate(value) {",
      ),
      extractInlineFunctionRange(
        html,
        "        function renderTokenUsageValueLines(value) {",
        "        function renderTokenUsageEventsTable(eventsPage) {",
      ),
      extractInlineFunctionRange(
        html,
        "        function renderEmptyState(message) {",
        "        function renderSpinner() {",
      ),
      extractInlineFunctionRange(
        html,
        "        function renderTokenUsageSection() {",
        "        function getTokenUsageTrendMetrics() {",
      ),
      extractCollapseHelpers(html),
      "({ renderTokenUsageSection })",
    ].join("\n")
    const state: {
      isTokenUsageLoading: boolean
      tokenUsageSummary?: TokenUsageSummary
      isSessionsLoading: boolean
      tokenUsageSessionsError: string | null
      tokenUsageSessionsPage: unknown
      collapsedSections: Record<string, boolean>
    } = {
      collapsedSections: {},
      isTokenUsageLoading: false,
      isSessionsLoading: false,
      tokenUsageSessionsError: null,
      tokenUsageSessionsPage: null,
    }
    const viewer = runInNewContext(source, {
      state,
      renderError: (message: string) => `<p>${message}</p>`,
      renderTokenUsageRangeText: () => "Today",
      renderTokenUsageDailyTrend: () => "",
      renderPaginationButton: () => "",
      renderTokenUsageEventsTable: () => "",
    }) as { renderTokenUsageSection: () => string }
    const summaryFor = (
      costs: TokenUsageSummary["totals"]["costs"],
    ): TokenUsageSummary => ({
      period: "today",
      range: { start_ms: 0, end_ms: 1, start_utc: "", end_utc: "" },
      totals: {
        request_count: 10,
        input_tokens: 200,
        output_tokens: 9000,
        cache_read_input_tokens: 600,
        cache_creation_input_tokens: 200,
        costs,
        total_tokens: 10000,
      },
      byModel: [],
    })
    const win = new Window()
    try {
      state.tokenUsageSummary = summaryFor([
        { currency: "USD", amount: 1.25, total_cost_nanos: 1_250_000_000 },
      ])
      win.document.body.innerHTML = viewer.renderTokenUsageSection()
      const labels = [...win.document.querySelectorAll(".metric-label")].map(
        (node) => node.textContent?.trim(),
      )
      expect(labels).toContain("Cost (USD)")
      expect(labels).not.toContain("Cost (CNY)")

      state.tokenUsageSummary = summaryFor([])
      win.document.body.innerHTML = viewer.renderTokenUsageSection()
      const cards = [...win.document.querySelectorAll(".metric-card")]
      const cardLabels = cards.map((node) =>
        node.querySelector(".metric-label")?.textContent?.trim(),
      )
      expect(cardLabels).toContain("Cost")
      expect(cardLabels).not.toContain("Cost (USD)")
      expect(cardLabels).not.toContain("Cost (CNY)")
      const costCard = cards.find(
        (node) =>
          node.querySelector(".metric-label")?.textContent?.trim() === "Cost",
      )
      expect(costCard?.querySelector(".metric-value")?.textContent).toBe("—")

      state.tokenUsageSummary = summaryFor([])
      const sessionsPage = (page: number, count: number) => ({
        items: Array.from({ length: count }, (_, index) => ({
          ...summaryFor([]).totals,
          session_id: `session-${(page - 1) * 10 + index + 1}`,
        })),
        page,
        total: 25,
        total_pages: 3,
      })
      state.tokenUsageSessionsPage = sessionsPage(1, 10)
      const sessionPanel = () =>
        [...win.document.querySelectorAll(".panel")].find(
          (node) =>
            node.querySelector(".panel-title")?.textContent
            === "Session Breakdown",
        )!
      const sessionIds = () =>
        [...sessionPanel().querySelectorAll("tbody tr td:first-child")].map(
          (node) => node.textContent,
        )
      const nextButton = () =>
        sessionPanel().querySelector('[data-session-page="1"]')!
      const previousButton = () =>
        sessionPanel().querySelector('[data-session-page="-1"]')!

      win.document.body.innerHTML = viewer.renderTokenUsageSection()
      expect(sessionIds()).toHaveLength(10)
      expect(sessionIds()[0]).toBe("session-1")
      expect(sessionPanel().textContent).toContain("Page 1 / 3 - 25 sessions")
      expect(previousButton().hasAttribute("disabled")).toBe(true)
      expect(nextButton().hasAttribute("disabled")).toBe(false)

      state.tokenUsageSessionsPage = sessionsPage(3, 5)
      win.document.body.innerHTML = viewer.renderTokenUsageSection()
      expect(sessionIds()).toEqual([
        "session-21",
        "session-22",
        "session-23",
        "session-24",
        "session-25",
      ])
      expect(nextButton().hasAttribute("disabled")).toBe(true)

      state.isSessionsLoading = true
      win.document.body.innerHTML = viewer.renderTokenUsageSection()
      expect(previousButton().hasAttribute("disabled")).toBe(true)

      state.isSessionsLoading = false
      state.tokenUsageSessionsError = "boom"
      win.document.body.innerHTML = viewer.renderTokenUsageSection()
      expect(sessionPanel().textContent).toContain("boom")
      expect(
        sessionPanel().querySelector('[data-session-page="0"]'),
      ).not.toBeNull()
    } finally {
      await win.happyDOM.close()
    }
  })
})

describe("usage viewer session fetching", () => {
  async function createSessionsFetcher() {
    const html = await readUsageViewerPage()
    const source = [
      extractInlineFunctionRange(
        html,
        "        function resolveUsageUrl(endpoint) {",
        "        async function fetchJson(url) {",
      ),
      extractInlineFunctionRange(
        html,
        "        async function fetchData(page = 1) {",
        "        // --- Event Handlers & Initialization ---",
      ),
      "({ fetchData, fetchTokenUsageSummaryAndEvents, fetchTokenUsageSessionsPage, invalidateSessionsRequest })",
    ].join("\n")
    const pending: Array<{
      url: string
      resolve: (value: unknown) => void
      reject: (reason: unknown) => void
    }> = []
    const state = {
      isLoading: false,
      isTokenUsageLoading: false,
      tokenUsageSummaryError: null as string | null,
      isSessionsLoading: false,
      sessionsRequestId: 0,
      tokenUsageSessionsError: null as string | null,
      tokenUsageSessionsPage: null as unknown,
    }
    const endpointUrlInput = { value: "http://server-a/usage" }
    const rendering = { onRender: () => {} }
    const viewer = runInNewContext(source, {
      state,
      endpointUrlInput,
      window: { location: { href: "http://localhost/usage-viewer" } },
      URL,
      SESSION_PAGE_SIZE: 10,
      DEFAULT_TOKEN_USAGE_EVENTS_PAGE_SIZE: 20,
      render: () => rendering.onRender(),
      fetchSubscriptionQuotas: () => Promise.resolve(),
      getSelectedPeriod: () => "today",
      getErrorMessage: (error: Error) => error.message,
      isMissingTokenUsageEndpointError: (error: unknown) =>
        typeof error === "object"
        && error !== null
        && "status" in error
        && error.status === 404,
      fetchJson: (url: string) =>
        new Promise((resolve, reject) =>
          pending.push({ url, resolve, reject }),
        ),
    }) as {
      fetchData: () => Promise<void>
      fetchTokenUsageSummaryAndEvents: () => Promise<void>
      fetchTokenUsageSessionsPage: (page: number) => Promise<void>
      invalidateSessionsRequest: () => void
    }
    return { endpointUrlInput, pending, rendering, state, viewer }
  }

  test("ignores a response that arrives after the context changed", async () => {
    const { pending, state, viewer } = await createSessionsFetcher()
    const stale = viewer.fetchTokenUsageSessionsPage(2)
    viewer.invalidateSessionsRequest()
    const current = viewer.fetchTokenUsageSessionsPage(1)

    pending[1].resolve({ page: 1, items: [] })
    await current
    pending[0].resolve({ page: 2, items: [] })
    await stale

    expect(state.tokenUsageSessionsPage).toEqual({ page: 1, items: [] })
    expect(state.isSessionsLoading).toBe(false)
  })

  test("ignores a stale failure and surfaces a current failure", async () => {
    const { pending, state, viewer } = await createSessionsFetcher()
    const stale = viewer.fetchTokenUsageSessionsPage(2)
    viewer.invalidateSessionsRequest()
    pending[0].reject(new Error("old failure"))
    await stale
    expect(state.tokenUsageSessionsError).toBeNull()

    const current = viewer.fetchTokenUsageSessionsPage(1)
    pending[1].reject(new Error("sessions failed"))
    await current
    expect(state.tokenUsageSessionsError).toBe("sessions failed")
    expect(state.isSessionsLoading).toBe(false)
  })

  const refreshMethods = [
    "fetchData",
    "fetchTokenUsageSummaryAndEvents",
  ] as const

  test.each([...refreshMethods])(
    "%s clears old sessions when refreshing another endpoint fails",
    async (refreshMethod) => {
      const { endpointUrlInput, pending, state, viewer } =
        await createSessionsFetcher()
      const oldPage = { page: 2, items: [{ session_id: "server-a-session" }] }
      state.tokenUsageSessionsPage = oldPage
      const stale = viewer.fetchTokenUsageSessionsPage(2)
      state.tokenUsageSessionsError = "old sessions error"
      endpointUrlInput.value = "http://server-b/usage"

      const refresh = viewer[refreshMethod]()
      expect(state.tokenUsageSessionsPage).toBeNull()
      expect(state.tokenUsageSessionsError).toBeNull()
      expect(state.isSessionsLoading).toBe(false)
      expect(
        pending.slice(1).every(({ url }) => new URL(url).host === "server-b"),
      ).toBe(true)

      const unauthorized = Object.assign(new Error("Unauthorized"), {
        status: 401,
      })
      for (const request of pending.slice(1)) {
        request.reject(unauthorized)
      }
      await refresh
      pending[0].resolve(oldPage)
      await stale

      expect(state.tokenUsageSessionsPage).toBeNull()
      expect(state.tokenUsageSessionsError).toBeNull()
      expect(state.tokenUsageSummaryError).toBe("Unauthorized")
      expect(state.isSessionsLoading).toBe(false)
      expect(
        pending.filter(({ url }) =>
          new URL(url).pathname.endsWith("/sessions"),
        ),
      ).toHaveLength(1)
    },
  )

  test.each([...refreshMethods])(
    "%s clears old sessions and rejects a late response for an empty endpoint",
    async (refreshMethod) => {
      const { endpointUrlInput, pending, state, viewer } =
        await createSessionsFetcher()
      const oldPage = { page: 2, items: [{ session_id: "server-a-session" }] }
      state.tokenUsageSessionsPage = oldPage
      const stale = viewer.fetchTokenUsageSessionsPage(2)
      state.tokenUsageSessionsError = "old sessions error"
      endpointUrlInput.value = "   "

      await viewer[refreshMethod]()
      expect(state.tokenUsageSessionsPage).toBeNull()
      expect(state.tokenUsageSessionsError).toBeNull()
      expect(state.isSessionsLoading).toBe(false)
      expect(pending).toHaveLength(1)

      pending[0].resolve(oldPage)
      await stale
      expect(state.tokenUsageSessionsPage).toBeNull()
      expect(state.isSessionsLoading).toBe(false)
    },
  )

  test.each([...refreshMethods])(
    "%s loads the new endpoint's sessions after clearing the previous page",
    async (refreshMethod) => {
      const { endpointUrlInput, pending, rendering, state, viewer } =
        await createSessionsFetcher()
      state.tokenUsageSessionsPage = {
        page: 2,
        items: [{ session_id: "server-a-session" }],
      }
      endpointUrlInput.value = "http://server-b/usage"

      const refresh = viewer[refreshMethod]()
      expect(state.tokenUsageSessionsPage).toBeNull()
      for (const request of pending) {
        request.resolve({})
      }
      await refresh

      const sessions = pending.at(-1)!
      expect(sessions.url).toBe(
        "http://server-b/token-usage/sessions?period=today&page=1&page_size=10",
      )
      expect(state.isSessionsLoading).toBe(true)
      const newPage = { page: 1, items: [{ session_id: "server-b-session" }] }
      const sessionRendered = new Promise<void>((resolve) => {
        rendering.onRender = () => resolve()
      })
      sessions.resolve(newPage)
      await sessionRendered

      expect(state.tokenUsageSessionsPage).toEqual(newPage)
      expect(state.isSessionsLoading).toBe(false)
    },
  )
})

test("usage viewer omits the raw Copilot JSON section", async () => {
  const html = await readUsageViewerPage()
  expect(html).not.toContain("Copilot Usage API Response")
  expect(html).not.toContain("renderDetailedData")
  expect(html).not.toContain("function formatObject")
})

describe("usage viewer collapsible sections", () => {
  const storageKey = "copilot-api:usage-viewer:collapsed"
  const sectionKeys = [
    "tokenUsage",
    "modelBreakdown",
    "sessionBreakdown",
    "requestEvents",
  ] as const

  type CollapseState = {
    collapsedSections: Record<string, boolean>
    isTokenUsageLoading: boolean
    isSessionsLoading: boolean
    tokenUsageSessionsError: string | null
    tokenUsageSessionsPage: unknown
    tokenUsageSummary: unknown
    tokenUsageSummaryError: string | null
  }

  type CollapseViewer = {
    readCollapsedSections: () => Record<string, boolean>
    renderTokenUsageSection: () => string
    handleContentAreaClick: (event: unknown) => void
  }

  async function createHarness(
    options: {
      stored?: string
      failRead?: boolean
      failWrite?: boolean
    } = {},
  ) {
    const html = await readUsageViewerPage()
    const win = new Window()
    const store = new Map<string, string>()
    if (options.stored !== undefined) {
      store.set(storageKey, options.stored)
    }
    const writes: string[] = []
    const warnings: unknown[][] = []
    const localStorage = {
      getItem: (key: string) => {
        if (options.failRead) throw new Error("read denied")
        return store.get(key) ?? null
      },
      setItem: (key: string, value: string) => {
        if (options.failWrite) throw new Error("quota exceeded")
        writes.push(value)
        store.set(key, value)
      },
    }
    const totals = {
      request_count: 1,
      input_tokens: 1,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      costs: [],
      total_tokens: 2,
    }
    const state: CollapseState = {
      collapsedSections: {},
      isTokenUsageLoading: false,
      isSessionsLoading: false,
      tokenUsageSessionsError: null,
      tokenUsageSessionsPage: {
        items: [{ ...totals, session_id: "session-1" }],
        page: 2,
        total: 25,
        total_pages: 3,
      },
      tokenUsageSummary: {
        period: "today",
        range: { start_ms: 0, end_ms: 1, start_utc: "", end_utc: "" },
        totals,
        byModel: [],
      },
      tokenUsageSummaryError: null,
    }
    const source = [
      extractInlineFunctionRange(
        html,
        "        function escapeHtml(value) {",
        "        function isMissingTokenUsageEndpointError(error) {",
      ),
      extractInlineFunctionRange(
        html,
        "        function formatNumber(value) {",
        "        function formatDateTime(value) {",
      ),
      extractInlineFunctionRange(
        html,
        "        function formatCellText(value) {",
        "        function formatRangeDate(value) {",
      ),
      extractInlineFunctionRange(
        html,
        "        function renderTokenUsageValueLines(value) {",
        "        function renderTokenUsageEventsTable(eventsPage) {",
      ),
      extractInlineFunctionRange(
        html,
        "        function renderEmptyState(message) {",
        "        function renderSpinner() {",
      ),
      extractCollapseHelpers(html),
      extractInlineFunctionRange(
        html,
        "        function renderTokenUsageSection() {",
        "        function getTokenUsageTrendMetrics() {",
      ),
      extractInlineFunctionRange(
        html,
        "        function handleContentAreaClick(event) {",
        "        function handleContentAreaChange(event) {",
      ),
      `({
        readCollapsedSections,
        renderTokenUsageSection,
        handleContentAreaClick,
      })`,
    ].join("\n")
    const viewer = runInNewContext(source, {
      state,
      document: win.document,
      Element: win.Element,
      window: { localStorage },
      console: { warn: (...args: unknown[]) => warnings.push(args) },
      renderError: (message: string) => `<p>${message}</p>`,
      renderTokenUsageRangeText: () => "Today",
      renderTokenUsageDailyTrend: () => "",
      renderPaginationButton: (action: string, label: string) =>
        `<button type="button" data-events-page="${action}">${label}</button>`,
      renderTokenUsageEventsTable: () => "<table></table>",
    }) as CollapseViewer

    const root = win.document.body
    root.addEventListener("click", viewer.handleContentAreaClick)
    state.collapsedSections = viewer.readCollapsedSections()

    const render = () => {
      root.innerHTML = [viewer.renderTokenUsageSection()].join("")
    }
    const toggle = (key: string) =>
      root.querySelector(`[data-collapse-toggle="${key}"]`)!
    const body = (key: string) => root.querySelector(`#collapse-body-${key}`)!
    const isExpanded = (key: string) =>
      toggle(key).getAttribute("aria-expanded") === "true"
    const isBodyHidden = (key: string) => body(key).hasAttribute("hidden")
    const stored = () => store.get(storageKey)

    return {
      win,
      state,
      viewer,
      root,
      render,
      toggle,
      body,
      isExpanded,
      isBodyHidden,
      stored,
      writes,
      warnings,
    }
  }

  test("renders every section expanded by default with accessible toggles", async () => {
    const h = await createHarness()
    try {
      h.render()
      for (const key of sectionKeys) {
        const button = h.toggle(key)
        expect(button.tagName).toBe("BUTTON")
        expect(button.getAttribute("type")).toBe("button")
        expect(button.getAttribute("aria-expanded")).toBe("true")
        expect(button.getAttribute("aria-controls")).toBe(
          `collapse-body-${key}`,
        )
        expect(h.body(key)).not.toBeNull()
        expect(h.isBodyHidden(key)).toBe(false)
      }
      expect(h.root.querySelectorAll("[data-collapse-toggle]")).toHaveLength(4)
      expect(h.root.querySelector("[hidden]")).toBeNull()
      expect(h.toggle("tokenUsage").textContent).toBe("Token Usage")
      expect(h.toggle("requestEvents").textContent).toBe("Request Events")
    } finally {
      await h.win.happyDOM.close()
    }
  })

  test("renders collapsed sections from stored state", async () => {
    const h = await createHarness({
      stored: JSON.stringify({
        tokenUsage: true,
        requestEvents: true,
      }),
    })
    try {
      h.render()
      for (const key of ["tokenUsage", "requestEvents"]) {
        expect(h.isExpanded(key)).toBe(false)
        expect(h.isBodyHidden(key)).toBe(true)
      }
      for (const key of ["modelBreakdown", "sessionBreakdown"]) {
        expect(h.isExpanded(key)).toBe(true)
        expect(h.isBodyHidden(key)).toBe(false)
      }
    } finally {
      await h.win.happyDOM.close()
    }
  })

  test("click toggles the section, updates aria state and persists", async () => {
    const h = await createHarness()
    try {
      h.render()
      const chevron = h.toggle("modelBreakdown").querySelector("i")!
      chevron.dispatchEvent(new h.win.MouseEvent("click", { bubbles: true }))
      expect(h.isExpanded("modelBreakdown")).toBe(false)
      expect(h.isBodyHidden("modelBreakdown")).toBe(true)
      expect(h.state.collapsedSections).toEqual({ modelBreakdown: true })
      expect(JSON.parse(h.stored()!)).toEqual({ modelBreakdown: true })

      h.toggle("requestEvents").dispatchEvent(
        new h.win.MouseEvent("click", { bubbles: true }),
      )
      expect(JSON.parse(h.stored()!)).toEqual({
        modelBreakdown: true,
        requestEvents: true,
      })

      h.toggle("modelBreakdown").dispatchEvent(
        new h.win.MouseEvent("click", { bubbles: true }),
      )
      expect(h.isExpanded("modelBreakdown")).toBe(true)
      expect(h.isBodyHidden("modelBreakdown")).toBe(false)
      expect(JSON.parse(h.stored()!)).toEqual({ requestEvents: true })
      expect(h.writes).toHaveLength(3)
    } finally {
      await h.win.happyDOM.close()
    }
  })

  test("collapsed state survives re-render and reload", async () => {
    const h = await createHarness()
    try {
      h.render()
      h.toggle("sessionBreakdown").dispatchEvent(
        new h.win.MouseEvent("click", { bubbles: true }),
      )
      h.state.isTokenUsageLoading = true
      h.render()
      expect(h.isExpanded("sessionBreakdown")).toBe(false)
      expect(h.isBodyHidden("sessionBreakdown")).toBe(true)
      expect(h.isBodyHidden("requestEvents")).toBe(false)
      expect(h.viewer.readCollapsedSections()).toEqual({
        sessionBreakdown: true,
      })
    } finally {
      await h.win.happyDOM.close()
    }
  })

  test("falls back to expanded for corrupt or unknown stored values", async () => {
    for (const stored of [
      "{not json",
      "",
      "null",
      "[]",
      '"tokenUsage"',
      "42",
      '{"tokenUsage":"true","requestEvents":1,"bogus":true}',
    ]) {
      const h = await createHarness({ stored })
      try {
        expect(h.state.collapsedSections).toEqual({})
        h.render()
        expect(h.root.querySelector("[hidden]")).toBeNull()
      } finally {
        await h.win.happyDOM.close()
      }
    }

    const mixed = await createHarness({
      stored: '{"tokenUsage":true,"bogus":true,"requestEvents":false}',
    })
    try {
      expect(mixed.state.collapsedSections).toEqual({ tokenUsage: true })
    } finally {
      await mixed.win.happyDOM.close()
    }
  })

  test("storage errors do not break reading or toggling", async () => {
    const readFailure = await createHarness({ failRead: true })
    try {
      expect(readFailure.state.collapsedSections).toEqual({})
      expect(readFailure.warnings).toHaveLength(1)
    } finally {
      await readFailure.win.happyDOM.close()
    }

    const writeFailure = await createHarness({ failWrite: true })
    try {
      writeFailure.render()
      writeFailure
        .toggle("tokenUsage")
        .dispatchEvent(
          new writeFailure.win.MouseEvent("click", { bubbles: true }),
        )
      expect(writeFailure.isExpanded("tokenUsage")).toBe(false)
      expect(writeFailure.isBodyHidden("tokenUsage")).toBe(true)
      expect(writeFailure.state.collapsedSections).toEqual({ tokenUsage: true })
      expect(writeFailure.warnings).toHaveLength(1)
    } finally {
      await writeFailure.win.happyDOM.close()
    }
  })

  test("paging buttons and other header content do not toggle", async () => {
    const h = await createHarness()
    try {
      h.render()
      const header = h.body("sessionBreakdown").previousElementSibling
      for (const target of [
        header.querySelector('[data-session-page="1"]')!,
        header.querySelector('[data-session-page="-1"]')!,
        header.querySelector(".panel-meta")!,
        header,
      ]) {
        target.dispatchEvent(new h.win.MouseEvent("click", { bubbles: true }))
      }
      expect(h.isExpanded("sessionBreakdown")).toBe(true)
      expect(h.isBodyHidden("sessionBreakdown")).toBe(false)
      expect(h.writes).toHaveLength(0)

      h.toggle("sessionBreakdown").dispatchEvent(
        new h.win.MouseEvent("click", { bubbles: true }),
      )
      expect(
        header
          .querySelector('[data-session-page="1"]')
          ?.hasAttribute("disabled"),
      ).toBe(false)
      expect(h.isBodyHidden("sessionBreakdown")).toBe(true)
    } finally {
      await h.win.happyDOM.close()
    }
  })

  test("nested panels keep their own state when the parent collapses", async () => {
    const h = await createHarness()
    try {
      h.render()
      const click = (key: string) =>
        h
          .toggle(key)
          .dispatchEvent(new h.win.MouseEvent("click", { bubbles: true }))
      click("modelBreakdown")
      click("tokenUsage")

      const tokenBody = h.body("tokenUsage")
      expect(h.isBodyHidden("tokenUsage")).toBe(true)
      expect(tokenBody.contains(h.body("modelBreakdown"))).toBe(true)
      expect(tokenBody.contains(h.body("sessionBreakdown"))).toBe(true)
      expect(tokenBody.contains(h.body("requestEvents"))).toBe(true)
      expect(h.isBodyHidden("sessionBreakdown")).toBe(false)

      click("tokenUsage")
      expect(h.isBodyHidden("tokenUsage")).toBe(false)
      expect(h.isBodyHidden("modelBreakdown")).toBe(true)
      expect(h.isBodyHidden("sessionBreakdown")).toBe(false)
      expect(h.isBodyHidden("requestEvents")).toBe(false)
      expect(JSON.parse(h.stored()!)).toEqual({ modelBreakdown: true })
    } finally {
      await h.win.happyDOM.close()
    }
  })

  test("collapsed state applies to loading and error variants", async () => {
    const h = await createHarness({
      stored: JSON.stringify({ tokenUsage: true, requestEvents: true }),
    })
    try {
      h.state.isTokenUsageLoading = true
      h.state.tokenUsageSummaryError = "usage failed"
      h.render()
      expect(h.root.textContent).toContain("Refreshing summary...")
      expect(h.root.textContent).toContain("usage failed")
      expect(h.isExpanded("tokenUsage")).toBe(false)
      expect(h.isBodyHidden("tokenUsage")).toBe(true)
      expect(h.isExpanded("requestEvents")).toBe(false)
      expect(h.isBodyHidden("requestEvents")).toBe(true)
      expect(h.body("tokenUsage").textContent).toContain("usage failed")
      expect(
        h.root.querySelector('[data-collapse-toggle="usageApiResponse"]'),
      ).toBeNull()
    } finally {
      await h.win.happyDOM.close()
    }
  })

  test("ignores unknown keys and tolerates a missing body element", async () => {
    const h = await createHarness()
    try {
      h.render()
      h.root.insertAdjacentHTML(
        "beforeend",
        '<button type="button" id="rogue" data-collapse-toggle="bogus" aria-expanded="true"></button>',
      )
      h.root
        .querySelector("#rogue")!
        .dispatchEvent(new h.win.MouseEvent("click", { bubbles: true }))
      expect(h.state.collapsedSections).toEqual({})
      expect(h.writes).toHaveLength(0)

      h.body("requestEvents").remove()
      h.toggle("requestEvents").dispatchEvent(
        new h.win.MouseEvent("click", { bubbles: true }),
      )
      expect(h.isExpanded("requestEvents")).toBe(false)
      expect(h.state.collapsedSections).toEqual({ requestEvents: true })
    } finally {
      await h.win.happyDOM.close()
    }
  })

  test("page wires collapsed state into init and styles", async () => {
    const html = await readUsageViewerPage()
    expect(html).toContain(`"${storageKey}"`)
    expect(html).toContain("state.collapsedSections = readCollapsedSections();")
    expect(html).toContain('.collapse-toggle[aria-expanded="false"]')
    expect(html).toContain(".collapse-body[hidden]")
  })
})

describe("usage viewer request/model timing", () => {
  test("renders model timing, request duration, missing fields and session columns", async () => {
    const html = await readUsageViewerPage()
    const source = [
      extractInlineFunctionRange(
        html,
        "        function escapeHtml(value) {",
        "        function getErrorMessage(error) {",
      ),
      extractInlineFunctionRange(
        html,
        "        function formatNumber(value) {",
        "        function formatDateTime(value) {",
      ),
      extractInlineFunctionRange(
        html,
        "        function formatCellText(value) {",
        "        function formatRangeDate(value) {",
      ),
      extractInlineFunctionRange(
        html,
        "        function renderTokenUsageValueLines(value) {",
        "        function renderPaginationButton(",
      ),
      "({ renderTokenUsageModelBreakdown, renderTokenUsageEventsTable, formatLatency, formatOutputSpeed })",
    ].join("\n")
    const viewer = runInNewContext(source, {
      state: {},
      formatDateTime: () => "now",
      renderEmptyState: () => "empty",
    }) as {
      renderTokenUsageModelBreakdown: (summary: unknown, by?: string) => string
      renderTokenUsageEventsTable: (page: unknown) => string
      formatLatency: (value: unknown) => string
      formatOutputSpeed: (value: unknown) => string
    }
    const row = {
      model: "test",
      session_id: "session",
      first_token_ms: 1250,
      duration_ms: 3250,
      average_first_token_ms: 750,
      output_tokens_per_second: 42.6,
    }
    const win = new Window()
    try {
      win.document.body.innerHTML = viewer.renderTokenUsageModelBreakdown({
        byModel: [row, { model: "old" }],
      })
      expect(win.document.querySelectorAll("th").length).toBe(11)
      expect(win.document.querySelector("tbody")?.textContent).toContain(
        "750 ms",
      )
      expect(win.document.querySelector("tbody")?.textContent).toContain(
        "42.6 tok/s",
      )
      const old = win.document
        .querySelectorAll("tbody tr")[1]
        .querySelectorAll("td")
      expect(old[7].textContent).toBe("—")
      expect(old[8].textContent).toBe("—")
      win.document.body.innerHTML = viewer.renderTokenUsageModelBreakdown(
        { bySession: [row] },
        "session",
      )
      expect(win.document.querySelectorAll("th").length).toBe(9)
      const eventsHtml = viewer.renderTokenUsageEventsTable({
        items: [row, {}],
      })
      expect(eventsHtml).toContain("min-w-[1140px]")
      expect(eventsHtml).not.toContain("min-w-[1060px]")
      win.document.body.innerHTML = eventsHtml
      expect(win.document.querySelectorAll("th").length).toBe(12)
      expect(
        [...win.document.querySelectorAll("th")].map((node) =>
          node.textContent?.trim(),
        ),
      ).toEqual([
        "Time",
        "User",
        "Model",
        "Session",
        "Trace",
        "Input",
        "Output",
        "Cache Read",
        "Cache Write",
        "Duration",
        "Total Tokens",
        "Total Cost",
      ])
      expect(win.document.body.textContent).not.toContain("TTFT")
      expect(win.document.body.textContent).not.toContain("Output speed")
      expect(win.document.body.textContent).toContain("Duration")
      expect(win.document.body.textContent).toContain("3.25 s")
      for (const value of [undefined, null, NaN, Infinity, -1, "100"]) {
        expect(viewer.formatLatency(value)).toBe("—")
        expect(viewer.formatOutputSpeed(value)).toBe("—")
      }
      expect(viewer.formatLatency(0)).toBe("0 ms")
      expect(viewer.formatOutputSpeed(0)).toBe("0.0 tok/s")
    } finally {
      await win.happyDOM.close()
    }
  })
})
