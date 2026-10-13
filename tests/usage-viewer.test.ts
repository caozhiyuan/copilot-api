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

type UsageViewerFormatters = {
  escapeHtml: (value: unknown) => string
  formatObject: (value: unknown) => string
  renderDetailedData: (value: unknown) => string
}

async function loadUsageViewerFormatters(): Promise<UsageViewerFormatters> {
  const html = await readUsageViewerPage()
  const source = [
    extractInlineFunctionRange(
      html,
      "        function escapeHtml(value) {",
      "        function getErrorMessage(error) {",
    ),
    extractInlineFunctionRange(
      html,
      "        function formatObject(obj) {",
      "        function renderTokenUsageSection() {",
    ),
    "({ escapeHtml, formatObject, renderDetailedData })",
  ].join("\n")

  return runInNewContext(source) as UsageViewerFormatters
}

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
      "({ renderTokenUsageModelBreakdown, formatCacheHitRate, renderTokenUsageSection })",
    ].join("\n")
    const state: {
      isTokenUsageLoading: boolean
      tokenUsageSummary?: TokenUsageSummary
      isSessionsLoading: boolean
      tokenUsageSessionsError: string | null
      tokenUsageSessionsPage: unknown
    } = {
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
        [...win.document.querySelectorAll("th")].map(
          (node) => node.textContent,
        ),
      ).toEqual([
        "Model",
        "Requests",
        "Input",
        "Output",
        "Cache Read",
        "Cache Write",
        "Cache Hit Rate",
        "Total Tokens",
        "Total Cost",
      ])
      const rows = [...win.document.querySelectorAll("tbody tr")]
      expect(
        rows.map((row) => row.querySelectorAll("td")[6].textContent),
      ).toEqual(examples.map((example) => example.expected))
      expect(rows.every((row) => row.querySelectorAll("td").length === 9)).toBe(
        true,
      )
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
      "({ renderTokenUsageSection })",
    ].join("\n")
    const state: {
      isTokenUsageLoading: boolean
      tokenUsageSummary?: TokenUsageSummary
      isSessionsLoading: boolean
      tokenUsageSessionsError: string | null
      tokenUsageSessionsPage: unknown
    } = {
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
        "        async function fetchTokenUsageSessionsPage(page) {",
        "        // --- Event Handlers & Initialization ---",
      ),
      "({ fetchTokenUsageSessionsPage, invalidateSessionsRequest })",
    ].join("\n")
    const pending: Array<{
      resolve: (value: unknown) => void
      reject: (reason: unknown) => void
    }> = []
    const state = {
      isSessionsLoading: false,
      sessionsRequestId: 0,
      tokenUsageSessionsError: null as string | null,
      tokenUsageSessionsPage: null as unknown,
    }
    const viewer = runInNewContext(source, {
      state,
      endpointUrlInput: { value: "http://localhost/usage" },
      render: () => {},
      resolveUsageUrl: (value: string) => value,
      getSelectedPeriod: () => "today",
      buildTokenUsageEventsUrl: () => "http://localhost/token-usage/sessions",
      getErrorMessage: (error: Error) => error.message,
      isMissingTokenUsageEndpointError: () => false,
      fetchJson: () =>
        new Promise((resolve, reject) => pending.push({ resolve, reject })),
    }) as {
      fetchTokenUsageSessionsPage: (page: number) => Promise<void>
      invalidateSessionsRequest: () => void
    }
    return { pending, state, viewer }
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
})

describe("usage viewer Copilot quota", () => {
  test("uses upstream percentages and supports legacy remaining fields", async () => {
    const html = await readUsageViewerPage()
    const source = [
      extractInlineFunctionRange(
        html,
        "        function escapeHtml(value) {",
        "        function getErrorMessage(error) {",
      ),
      extractInlineFunctionRange(
        html,
        "        function getCopilotQuotaRemaining(details) {",
        "        function formatObject(obj) {",
      ),
      "({ renderQuotaCard, getCopilotQuotaRemaining, getCopilotQuotaPercentRemaining })",
    ].join("\n")
    const viewer = runInNewContext(source) as {
      renderQuotaCard: (
        title: string,
        details: import("../desktop/src/lib/copilot-usage-display").CopilotQuotaDetailLike,
      ) => string
      getCopilotQuotaPercentRemaining: (
        details: import("../desktop/src/lib/copilot-usage-display").CopilotQuotaDetailLike,
      ) => number
      getCopilotQuotaRemaining: (
        details: import("../desktop/src/lib/copilot-usage-display").CopilotQuotaDetailLike,
      ) => number | null
    }
    const quota = {
      entitlement: 1500,
      remaining: 1499,
      quota_remaining: 0,
      percent_remaining: 99.9,
      unlimited: false,
    }
    const win = new Window()
    try {
      win.document.body.innerHTML = viewer.renderQuotaCard(
        "premium_interactions",
        quota,
      )
      expect(win.document.body.textContent).toContain("0.1% used")
      expect(win.document.body.textContent).toContain("1 / 1,500")
      expect(win.document.body.textContent).toContain("1,499 remaining")
      const bar = win.document.querySelector(".progress-bar-fg")
      const width = bar?.getAttribute("style")?.match(/width:\s*([\d.]+)%/)?.[1]
      expect(parseFloat(width ?? "")).toBeCloseTo(0.1)
      expect(
        viewer.getCopilotQuotaPercentRemaining({ ...quota, remaining: 1200 }),
      ).toBe(99.9)
      expect(
        viewer.getCopilotQuotaRemaining({
          remaining: 0,
          quota_remaining: 1499,
        }),
      ).toBe(0)
      expect(viewer.getCopilotQuotaRemaining({ quota_remaining: 1499 })).toBe(
        1499,
      )
      expect(
        viewer.getCopilotQuotaPercentRemaining({
          entitlement: 1500,
          quota_remaining: 1499,
        }),
      ).toBeCloseTo(99.933333)
      expect(
        viewer.getCopilotQuotaPercentRemaining({
          entitlement: 0,
          remaining: 0,
        }),
      ).toBe(100)
      expect(
        viewer.getCopilotQuotaRemaining({ remaining: Infinity }),
      ).toBeNull()
      expect(
        viewer.getCopilotQuotaPercentRemaining({ percent_remaining: -10 }),
      ).toBe(0)
      expect(
        viewer.getCopilotQuotaPercentRemaining({ percent_remaining: 110 }),
      ).toBe(100)
      expect(
        viewer.getCopilotQuotaPercentRemaining({
          unlimited: true,
          percent_remaining: 0,
        }),
      ).toBe(100)
      win.document.body.innerHTML = viewer.renderQuotaCard("chat", {
        unlimited: true,
      })
      expect(win.document.body.textContent).toContain("Unlimited")
      expect(
        win.document.querySelector(".progress-bar-fg")?.getAttribute("style"),
      ).toContain("width: 100%")
    } finally {
      await win.happyDOM.close()
    }
  })
})

describe("usage viewer detailed response formatter", () => {
  test("escapes HTML in keys and values", async () => {
    const { escapeHtml, formatObject } = await loadUsageViewerFormatters()

    expect(escapeHtml(`<tag attr="x">&'`)).toBe(
      "&lt;tag attr=&quot;x&quot;&gt;&amp;&#39;",
    )
    const unsafeKey = `unsafe_<key&"'`
    const value = `<script>&"'`
    const html = formatObject({ [unsafeKey]: value })
    expect(html).toContain(escapeHtml(unsafeKey.replace(/_/g, " ")))
    expect(html).toContain(escapeHtml(JSON.stringify(value)))
  })

  test("renders every nested array entry and primitive", async () => {
    const { escapeHtml, formatObject } = await loadUsageViewerFormatters()
    const arrayValue = `<array & "'>`

    const html = formatObject({
      values: [
        "text",
        17,
        true,
        false,
        null,
        {},
        [],
        arrayValue,
        ["nested array", null],
        { nested_array: ["deep", { nested_null: null }] },
      ],
      enterprise_list: [{ enterprise_name: "Copilot Engineering" }],
    })

    for (const value of [
      "[0]",
      "[1]",
      "[2]",
      "[3]",
      "[4]",
      "[5]",
      "[6]",
      "[7]",
      "[8]",
      "Copilot Engineering",
      "enterprise name:",
      "&quot;text&quot;",
      "17",
      "true",
      "false",
      "null",
      "{}",
      "[]",
      "&quot;nested array&quot;",
      "&quot;deep&quot;",
      "nested null:",
    ]) {
      expect(html).toContain(value)
    }
    expect(html).toContain(escapeHtml(JSON.stringify(arrayValue)))
    expect(html).toContain("color: var(--color-green)")
    expect(html).toContain("color: var(--color-red)")
    expect(html).not.toContain("items]")
  })

  test("shows empty containers and renders the detailed response section", async () => {
    const { formatObject, renderDetailedData } =
      await loadUsageViewerFormatters()

    expect(formatObject({})).toContain("{}")
    expect(formatObject([])).toContain("[]")
    expect(formatObject({ empty_object: {}, empty_array: [] })).toContain("{}")
    expect(formatObject({ empty_object: {}, empty_array: [] })).toContain("[]")
    expect(renderDetailedData(null)).toBe("")
    expect(renderDetailedData(undefined)).toBe("")
    expect(renderDetailedData({})).toContain("{}")
    expect(renderDetailedData({ response: [null] })).toContain(
      "Copilot Usage API Response",
    )
  })
})
