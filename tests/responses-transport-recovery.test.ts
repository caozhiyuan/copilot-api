import { expect, test } from "bun:test"

import {
  buildResponsesRecoveryKey,
  canUseResponsesHttpFallback,
  ResponsesTransportRecovery,
} from "~/services/responses-transport-recovery"
import {
  isFailedResponsesStreamChunk,
  isSuccessfulResponsesStreamChunk,
} from "~/services/responses-websocket-helpers"

test("recovery expires and is isolated by session", () => {
  let now = 0
  const recovery = new ResponsesTransportRecovery(100, 2, () => now)
  expect(recovery.shouldUseHttp("a")).toBe(false)
  recovery.recordFailure("a")
  expect(recovery.shouldUseHttp("a")).toBe(true)
  expect(recovery.shouldUseHttp("b")).toBe(false)
  now = 100
  expect(recovery.shouldUseHttp("a")).toBe(false)
})

test("recovery bounds memory, refreshes failures and prunes expired entries", () => {
  let now = 0
  const recovery = new ResponsesTransportRecovery(100, 2, () => now)
  recovery.recordFailure("a")
  recovery.recordFailure("b")
  recovery.recordFailure("a")
  recovery.recordFailure("c")
  expect(recovery.shouldUseHttp("a")).toBe(true)
  expect(recovery.shouldUseHttp("b")).toBe(false)
  expect(recovery.shouldUseHttp("c")).toBe(true)
  now = 100
  recovery.recordFailure("d")
  expect(recovery.shouldUseHttp("a")).toBe(false)
  expect(recovery.shouldUseHttp("c")).toBe(false)
  expect(recovery.shouldUseHttp("d")).toBe(true)
})

test("recovery keys include all boundaries without retaining credentials", () => {
  const parts = ["upstream", "token-secret", "model", "session"]
  const key = buildResponsesRecoveryKey(parts)
  expect(key).toBe(buildResponsesRecoveryKey([...parts]))
  expect(key).not.toContain("token-secret")
  for (let index = 0; index < parts.length; index++) {
    const other = [...parts]
    other[index] += "-other"
    expect(buildResponsesRecoveryKey(other)).not.toBe(key)
  }
  expect(buildResponsesRecoveryKey(["a|b", "c"])).not.toBe(
    buildResponsesRecoveryKey(["a", "b|c"]),
  )
})

test("connection-local response references are not silently switched to HTTP", () => {
  expect(canUseResponsesHttpFallback({ input: "hello" })).toBe(true)
  expect(canUseResponsesHttpFallback({ previous_response_id: null })).toBe(true)
  expect(
    canUseResponsesHttpFallback({ previous_response_id: "resp-old" }),
  ).toBe(false)
})

test("only completed Responses streams qualify for connection reuse", () => {
  for (const type of [
    "response.completed",
    "response.failed",
    "response.incomplete",
    "error",
    "response.created",
  ]) {
    const chunk = { data: JSON.stringify({ type }) }
    expect(isSuccessfulResponsesStreamChunk(chunk)).toBe(
      type === "response.completed",
    )
    expect(isFailedResponsesStreamChunk(chunk)).toBe(
      type === "error" || type === "response.failed",
    )
  }
  for (const chunk of [{}, { data: "[DONE]" }, { data: "null" }]) {
    expect(isSuccessfulResponsesStreamChunk(chunk)).toBe(false)
    expect(isFailedResponsesStreamChunk(chunk)).toBe(false)
  }
})
