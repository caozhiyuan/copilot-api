import { expect, test } from "bun:test"

import {
  getCopilotRateLimitUsageFromSnapshots,
  getCopilotRateLimitUsage,
  parseCopilotRateLimitHeader,
} from "~/lib/providers/copilot-rate-limit"

test("parseCopilotRateLimitHeader extracts remaining quota and reset time", () => {
  expect(
    parseCopilotRateLimitHeader(
      "ent=0&ov=0.0&ovPerm=false&rem=99.6&rst=2026-04-22T14%3A30%3A56Z",
    ),
  ).toEqual({
    remaining: "99.6",
    resetAt: "2026-04-22T14:30:56Z",
  })
})

test("getCopilotRateLimitUsage reads session and weekly headers", () => {
  const headers = new Headers({
    "x-usage-ratelimit-session":
      "ent=0&ov=0.0&ovPerm=false&rem=99.6&rst=2026-04-22T14%3A30%3A56Z",
    "x-usage-ratelimit-weekly":
      "ent=0&ov=0.0&ovPerm=false&rem=95.9&rst=2026-04-27T00%3A00%3A00Z",
  })

  expect(getCopilotRateLimitUsage(headers, "session")).toEqual({
    type: "session",
    remaining: "99.6",
    resetAt: "2026-04-22T14:30:56Z",
  })
  expect(getCopilotRateLimitUsage(headers, "weekly")).toEqual({
    type: "weekly",
    remaining: "95.9",
    resetAt: "2026-04-27T00:00:00Z",
  })
})

test("getCopilotRateLimitUsageFromSnapshots reads websocket response completed snapshots", () => {
  const snapshots = {
    "5Hour-Session-RateLimits": {
      entitlement: "0",
      overage_count: 0,
      overage_permitted: false,
      percent_remaining: 99.6,
      reset_date: "2026-05-13T17:54:08Z",
    },
    "Weekly-Session-RateLimits": {
      entitlement: "0",
      overage_count: 0,
      overage_permitted: false,
      percent_remaining: 94.2,
      reset_date: "2026-05-18T00:00:00Z",
    },
  }

  expect(getCopilotRateLimitUsageFromSnapshots(snapshots, "session")).toEqual({
    remaining: "99.6",
    resetAt: "2026-05-13T17:54:08Z",
    type: "session",
  })
  expect(getCopilotRateLimitUsageFromSnapshots(snapshots, "weekly")).toEqual({
    remaining: "94.2",
    resetAt: "2026-05-18T00:00:00Z",
    type: "weekly",
  })
})
