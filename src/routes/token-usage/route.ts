import { Hono } from "hono"

import {
  getTokenUsageDailySummary,
  getTokenUsageEventsPage,
  getTokenUsageSummary,
  type TokenUsagePeriod,
} from "~/lib/token-usage"

export const tokenUsageRoute = new Hono()

const periods = new Set<TokenUsagePeriod>([
  "day",
  "weekToDate",
  "week",
  "monthToDate",
  "month",
  "lifetime",
])
const DEFAULT_EVENTS_PAGE_SIZE = 20

function parsePeriod(value: string | undefined): TokenUsagePeriod {
  return periods.has(value as TokenUsagePeriod) ?
      (value as TokenUsagePeriod)
    : "day"
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

tokenUsageRoute.get("/", async (c) => {
  const period = parsePeriod(c.req.query("period"))
  const summary = await getTokenUsageSummary(period)
  return c.json(summary)
})

tokenUsageRoute.get("/daily", async (c) => {
  const period = parsePeriod(c.req.query("period"))
  const summary = await getTokenUsageDailySummary(period)
  return c.json(summary)
})

tokenUsageRoute.get("/events", async (c) => {
  const period = parsePeriod(c.req.query("period"))
  const page = parsePositiveInt(c.req.query("page"), 1)
  const pageSize = parsePositiveInt(
    c.req.query("page_size"),
    DEFAULT_EVENTS_PAGE_SIZE,
  )
  const eventsPage = await getTokenUsageEventsPage({ page, pageSize, period })
  return c.json(eventsPage)
})
