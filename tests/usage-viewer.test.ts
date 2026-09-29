import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { runInNewContext } from "node:vm"

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
