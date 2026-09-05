import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

const pagePath = new URL("../pages/index.html", import.meta.url)

async function readUsageViewerPage(): Promise<string> {
  return readFile(pagePath, "utf8")
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
      ["day", "Day"],
      ["weekToDate", "Week to date"],
      ["week", "Week"],
      ["monthToDate", "Month to date"],
      ["month", "Month"],
      ["lifetime", "Lifetime"],
    ])

    expect(html).toContain("return VALID_PERIODS.has(value)")
    expect(html).toContain("const MAX_LIFETIME_TREND_POINTS = 180")
    expect(html).toContain(
      "getDailyTrendTotals(day, selectedModel).request_count > 0",
    )
    expect(html).toContain("tokenUsageTrendDay: null")
    expect(html).toContain('data-trend-day="${day.date}"')
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
