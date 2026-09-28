import { expect, test } from "bun:test"

import { buildAnthropicBetaHeader } from "~/services/copilot/create-messages"

test("forwards the extended-cache-ttl beta requested by the client", () => {
  const header = buildAnthropicBetaHeader(
    "extended-cache-ttl-2025-04-11",
    undefined,
    "claude-sonnet-5",
  )

  expect(header).toBe("extended-cache-ttl-2025-04-11")
})

test("keeps only allowlisted betas and drops unknown ones", () => {
  const header = buildAnthropicBetaHeader(
    "extended-cache-ttl-2025-04-11,some-unsupported-beta-2099-01-01",
    undefined,
    "claude-sonnet-5",
  )

  expect(header).toBe("extended-cache-ttl-2025-04-11")
})

test("returns undefined when the client sends no allowlisted beta", () => {
  const header = buildAnthropicBetaHeader(
    "some-unsupported-beta-2099-01-01",
    undefined,
    "claude-sonnet-5",
  )

  expect(header).toBeUndefined()
})
