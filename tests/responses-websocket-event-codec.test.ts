import { expect, test } from "bun:test"

import { createCodexResponsesWebSocketStreamChunk } from "~/services/codex/create-responses"
import { createResponsesWebSocketStreamChunk } from "~/services/copilot/create-responses"
import { getResponsesStreamTerminalDisposition } from "~/services/responses-websocket-helpers"

const normalEvent =
  '{ "type" : "response.output_text.delta", "id": "evt-1", "delta": "hello\\nworld" }'
const completedEvent =
  '{ "type" : "response.completed", "id": "evt-2", "response": { "usage": null } }'

for (const [name, decode] of [
  ["Codex", createCodexResponsesWebSocketStreamChunk],
  ["Copilot", createResponsesWebSocketStreamChunk],
] as const) {
  test(`${name} forwards normal websocket event JSON without re-encoding`, () => {
    const delta = decode(normalEvent)
    expect(delta).toEqual({
      data: normalEvent,
      event: "response.output_text.delta",
      id: "evt-1",
    })
    expect(getResponsesStreamTerminalDisposition(delta)).toBe("continue")

    const completed = decode(completedEvent)
    expect(completed.data).toBe(completedEvent)
    expect(getResponsesStreamTerminalDisposition(completed)).toBe("reuse")

    expect(decode("[DONE]")).toEqual({ data: "[DONE]" })
    expect(decode("not json")).toEqual({ data: "not json" })
  })
}

test("Codex websocket errors retain the top-level message", () => {
  const raw =
    '{ "type": "error", "error": { "message": "quota exceeded" }, "status_code": 429 }'
  const chunk = createCodexResponsesWebSocketStreamChunk(raw)
  expect(chunk.event).toBe("error")
  expect(JSON.parse(chunk.data ?? "")).toMatchObject({
    error: { message: "quota exceeded" },
    message: "quota exceeded",
    status_code: 429,
    type: "error",
  })
  expect(getResponsesStreamTerminalDisposition(chunk)).toBe("discard")
})

test("Copilot websocket errors retain top-level code and message", () => {
  const raw =
    '{"type":"error","error":{"code":"rate_limit","message":"slow down"}}'
  const chunk = createResponsesWebSocketStreamChunk(raw)
  expect(chunk.event).toBe("error")
  expect(JSON.parse(chunk.data ?? "")).toMatchObject({
    code: "rate_limit",
    error: { code: "rate_limit", message: "slow down" },
    message: "slow down",
    type: "error",
  })
  expect(getResponsesStreamTerminalDisposition(chunk)).toBe("discard")
})

test("terminal disposition uses decoded event metadata and retains raw fallback", () => {
  expect(
    getResponsesStreamTerminalDisposition({
      data: "not json",
      event: "response.failed",
    }),
  ).toBe("discard")
  expect(
    getResponsesStreamTerminalDisposition({
      data: "not json",
      event: "response.incomplete",
    }),
  ).toBe("reuse")
  expect(
    getResponsesStreamTerminalDisposition({
      data: '{"type":"response.failed"}',
    }),
  ).toBe("discard")
  expect(
    getResponsesStreamTerminalDisposition({
      data: '{"type":"response.completed"}',
    }),
  ).toBe("reuse")
  expect(getResponsesStreamTerminalDisposition({ data: "not json" })).toBe(
    "continue",
  )
})
