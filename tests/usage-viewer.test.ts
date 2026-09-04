import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

const pagePath = new URL("../pages/index.html", import.meta.url)

async function readUsageViewerPage(): Promise<string> {
  return readFile(pagePath, "utf8")
}

describe("usage viewer period contract", () => {
  test("offers calendar-to-date periods in the documented order", async () => {
    const html = await readUsageViewerPage()
    const periodSelect = html.match(
      /<select\s+id="token-usage-period"[\s\S]*?<\/select>/,
    )?.[0]

    expect(periodSelect).toBeDefined()
    const options = [
      ...(periodSelect ?? "").matchAll(
        /<option value="([^"]+)">([^<]+)<\/option>/g,
      ),
    ].map((match) => [match[1], match[2]])

    expect(options).toEqual([
      ["day", "Day"],
      ["weekToDate", "Week to date"],
      ["week", "Week"],
      ["monthToDate", "Month to date"],
      ["month", "Month"],
      ["lifetime", "Lifetime"],
    ])
  })

  test("normalizes new period values and propagates the selection to requests", async () => {
    const html = await readUsageViewerPage()

    expect(html).toMatch(
      /const DEFAULT_TOKEN_USAGE_PERIOD = "day";[\s\S]*?const VALID_PERIODS = new Set\(\[\s*"day",\s*"weekToDate",\s*"week",\s*"monthToDate",\s*"month",\s*"lifetime",\s*\]\);/,
    )
    expect(html).toMatch(
      /function normalizePeriod\(value\)\s*\{[\s\S]*?return VALID_PERIODS\.has\(value\)[\s\S]*?\? value\s*:\s*DEFAULT_TOKEN_USAGE_PERIOD;/,
    )
    expect(html).toContain('weekToDate: "Week to date"')
    expect(html).toContain('monthToDate: "Month to date"')
    expect(html).toContain('lifetime: "Lifetime"')
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

    const requestBuilders = [
      "buildTokenUsageSummaryUrl",
      "buildTokenUsageDailyUrl",
      "buildTokenUsageEventsUrl",
    ]
    for (const builder of requestBuilders) {
      expect(html).toContain(`function ${builder}`)
      expect(html).toContain('url.searchParams.set("period", period)')
    }
  })
})
