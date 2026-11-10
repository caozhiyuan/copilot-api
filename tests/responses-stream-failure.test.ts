import { describe, expect, test } from "bun:test"

import type {
  ResponseErrorEvent,
  ResponseFailedEvent,
  ResponsesResult,
  ResponseStreamEvent,
} from "~/lib/types/responses"

import { createResponsesStreamTerminalTracker } from "~/routes/responses/stream-failure"

const createResult = (status: string): ResponsesResult => ({
  created_at: 0,
  error: null,
  id: "resp_upstream",
  incomplete_details: null,
  instructions: null,
  metadata: null,
  model: "gpt-test",
  object: "response",
  output: [],
  output_text: "",
  parallel_tool_calls: false,
  status,
  temperature: null,
  tool_choice: "auto",
  tools: [],
  top_p: null,
})

const createdEvent = (sequenceNumber: number): ResponseStreamEvent => ({
  response: createResult("in_progress"),
  sequence_number: sequenceNumber,
  type: "response.created",
})

const parse = (message: { data: string }) =>
  JSON.parse(message.data) as ResponseFailedEvent

describe("createResponsesStreamTerminalTracker", () => {
  for (const type of [
    "response.completed",
    "response.incomplete",
    "response.failed",
  ] as const) {
    test(`adds nothing after the upstream sent ${type}`, () => {
      const tracker = createResponsesStreamTerminalTracker("gpt-test")
      tracker.observe(createdEvent(0))
      tracker.observe({
        response: createResult("done"),
        sequence_number: 1,
        type,
      })

      expect(tracker.finalize()).toBeNull()
    })
  }

  test("closes a silently ended stream with response.failed", () => {
    const tracker = createResponsesStreamTerminalTracker("gpt-test")
    tracker.observe(null)
    tracker.observe(createdEvent(4))

    const failure = tracker.finalize("resp_client_visible")

    expect(failure).toMatchObject({
      code: "server_error",
      message:
        "The upstream Responses stream ended before sending a terminal event.",
      sse: { event: "response.failed" },
    })
    expect(parse(failure!.sse)).toMatchObject({
      sequence_number: 5,
      type: "response.failed",
      response: {
        error: { code: "server_error", message: failure?.message },
        id: "resp_client_visible",
        model: "gpt-test",
        object: "response",
        status: "failed",
      },
    })
  })

  test("reuses the code and message of an upstream error event", () => {
    const tracker = createResponsesStreamTerminalTracker("gpt-test")
    const upstreamError: ResponseErrorEvent = {
      code: "upstream_code",
      message: "Upstream connection lost",
      param: null,
      sequence_number: 2,
      type: "error",
    }
    tracker.observe(upstreamError)

    const failure = tracker.finalize()

    expect(failure).toMatchObject({
      code: "upstream_code",
      message: "Upstream connection lost",
    })
    expect(parse(failure!.sse)).toMatchObject({
      sequence_number: 3,
      response: {
        error: { code: "upstream_code", message: "Upstream connection lost" },
      },
    })
  })

  test("prefers the nested error object and falls back to the default code", () => {
    const nested = createResponsesStreamTerminalTracker("gpt-test")
    nested.observe({
      code: null,
      error: { code: "rate_limit_exceeded", message: "Slow down" },
      message: "outer message",
      param: null,
      sequence_number: 0,
      type: "error",
    })
    const bare = createResponsesStreamTerminalTracker("gpt-test")
    bare.observe({
      code: null,
      message: "Something broke",
      param: null,
      sequence_number: 0,
      type: "error",
    })

    expect(nested.finalize()).toMatchObject({
      code: "rate_limit_exceeded",
      message: "Slow down",
    })
    expect(bare.finalize()).toMatchObject({
      code: "server_error",
      message: "Something broke",
    })
  })

  test("ignores upstream events without a numeric sequence number", () => {
    const tracker = createResponsesStreamTerminalTracker("gpt-test")
    tracker.observe({
      ...createdEvent(3),
      sequence_number: undefined,
    } as unknown as ResponseStreamEvent)

    expect(parse(tracker.finalize()!.sse).sequence_number).toBe(1)
  })

  test("generates a response id when none was seen and finalizes only once", () => {
    const tracker = createResponsesStreamTerminalTracker("gpt-test")

    const failure = tracker.finalize()

    expect(parse(failure!.sse).response.id).toMatch(/^resp_[0-9a-f]{32}$/)
    expect(tracker.finalize()).toBeNull()
  })
})
