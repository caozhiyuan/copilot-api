import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test"

import { resolveTokenUsageRetentionDays } from "~/lib/config-store"
import {
  closeUsageStore,
  getTokenUsageEventsPage,
  pruneTokenUsageEvents,
  recordTokenUsageEvent,
} from "~/lib/token-usage"

const DB_PATH_ENV = "COPILOT_API_SQLITE_DB_PATH"
const DAY_MS = 24 * 60 * 60 * 1000
const nowMs = Date.parse("2026-06-15T00:00:00.000Z")

beforeEach(async () => {
  process.env[DB_PATH_ENV] = ":memory:"
  await closeUsageStore()
})

afterEach(async () => {
  setSystemTime()
  await closeUsageStore()
  Reflect.deleteProperty(process.env, DB_PATH_ENV)
})

test("unset token usage retention keeps every row", async () => {
  expect(resolveTokenUsageRetentionDays(undefined)).toBeNull()
  expect(resolveTokenUsageRetentionDays(null)).toBeNull()
  expect(resolveTokenUsageRetentionDays("")).toBeNull()
  expect(resolveTokenUsageRetentionDays(0)).toBeNull()
  expect(resolveTokenUsageRetentionDays(-2)).toBeNull()
  expect(resolveTokenUsageRetentionDays(1.5)).toBeNull()
  expect(resolveTokenUsageRetentionDays(30)).toBe(30)

  recordAt(nowMs - 40 * DAY_MS, "old-model")
  recordAt(nowMs - DAY_MS, "recent-model")
  setSystemTime(new Date(nowMs))

  expect(await pruneTokenUsageEvents({ nowMs, retentionDays: null })).toBe(0)
  expect(await models()).toEqual(["old-model", "recent-model"])
})

test("set token usage retention deletes old rows and keeps recent rows", async () => {
  recordAt(nowMs - 40 * DAY_MS, "old-model")
  recordAt(nowMs - DAY_MS, "recent-model")
  recordAt(nowMs - 30 * DAY_MS, "boundary-model")
  setSystemTime(new Date(nowMs))

  expect(await pruneTokenUsageEvents({ nowMs, retentionDays: 30 })).toBe(1)
  expect(await models()).toEqual(["boundary-model", "recent-model"])
})

function recordAt(createdAtMs: number, model: string): void {
  setSystemTime(new Date(createdAtMs))
  recordTokenUsageEvent({
    endpoint: "responses",
    input_tokens: 2,
    model,
    output_tokens: 1,
    source: "copilot",
  })
}

async function models(): Promise<Array<string>> {
  const page = await getTokenUsageEventsPage({
    page: 1,
    pageSize: 10,
    period: "lifetime",
  })
  return page.items.map((item) => item.model).sort()
}
