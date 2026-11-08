import { describe, expect, test } from "bun:test"

import { prepareResponsesContinuation } from "~/lib/responses-continuation"
import type {
  ResponseOutputFunctionCall,
  ResponseOutputItem,
  ResponsesPayload,
  ResponsesResult,
  ResponseStreamEvent,
} from "~/lib/types/responses"
import {
  createStreamIdTracker,
  fixStreamIds,
} from "~/routes/responses/stream-id-sync"

const result = (
  id: string,
  output: Array<ResponseOutputItem> = [],
  status = "completed",
): ResponsesResult => ({
  created_at: 0,
  error: null,
  id,
  incomplete_details: null,
  instructions: null,
  metadata: null,
  model: "gpt-test",
  object: "response",
  output,
  output_text: "",
  parallel_tool_calls: false,
  status,
  temperature: null,
  tool_choice: "auto",
  tools: [],
  top_p: null,
  usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
})

const fix = <T extends ResponseStreamEvent>(
  event: T,
  tracker: ReturnType<typeof createStreamIdTracker>,
  eventName: string | undefined = event.type,
): T => JSON.parse(fixStreamIds(JSON.stringify(event), eventName, tracker)) as T

const checkpoint = (id: string, encrypted_content = "final-checkpoint") =>
  ({ id, type: "compaction", encrypted_content }) as const

describe("Responses stream ID synchronization", () => {
  test.each([
    "response.completed",
    "response.incomplete",
    "response.failed",
  ] as const)("keeps the response ID stable through %s", (type) => {
    const tracker = createStreamIdTracker()
    fix(
      {
        type: "response.created",
        sequence_number: 0,
        response: result("created-id", [], "in_progress"),
      },
      tracker,
    )
    const progress = fix(
      {
        type: "response.in_progress",
        sequence_number: 1,
        response: result("progress-id", [], "in_progress"),
      },
      tracker,
    )
    const terminal = {
      type,
      sequence_number: 2,
      response: result("terminal-id", [], type.slice("response.".length)),
    }

    expect(progress.response.id).toBe("created-id")
    expect(fix(terminal, tracker)).toEqual({
      ...terminal,
      response: { ...terminal.response, id: "created-id" },
    })
    expect(terminal.response.id).toBe("terminal-id")
  })

  test("uses the first response ID when response.created is absent", () => {
    const tracker = createStreamIdTracker()
    fix(
      {
        type: "response.in_progress",
        sequence_number: 0,
        response: result("first-id"),
      },
      tracker,
    )
    expect(
      fix(
        {
          type: "response.completed",
          sequence_number: 1,
          response: result("last-id"),
        },
        tracker,
      ).response.id,
    ).toBe("first-id")
  })

  test("correlates a compaction checkpoint across added, done and completed", () => {
    const tracker = createStreamIdTracker()
    const added = fix(
      {
        type: "response.output_item.added",
        sequence_number: 0,
        output_index: 0,
        item: checkpoint("added-id", "unfinished-checkpoint"),
      },
      tracker,
    )
    const done = fix(
      {
        type: "response.output_item.done",
        sequence_number: 1,
        output_index: 0,
        item: checkpoint("done-id"),
      },
      tracker,
    )
    const completed = fix(
      {
        type: "response.completed",
        sequence_number: 2,
        response: result("response-id", [
          checkpoint("completed-id", "rewrapped-checkpoint"),
        ]),
      },
      tracker,
    )

    expect(added.item.id).toBe("added-id")
    expect(done.item).toEqual(checkpoint("added-id"))
    expect(completed.response.output).toEqual([done.item])
  })

  test("correlates checkpoints without an output_item.added event", () => {
    const tracker = createStreamIdTracker()
    const done = fix(
      {
        type: "response.output_item.done",
        sequence_number: 0,
        output_index: 0,
        item: checkpoint("done-id"),
      },
      tracker,
    )
    const completed = fix(
      {
        type: "response.completed",
        sequence_number: 1,
        response: result("response-id", [
          checkpoint("completed-id", "rewrapped-checkpoint"),
        ]),
      },
      tracker,
    )

    expect(completed.response.output).toEqual([done.item])
  })

  test("preserves the first completed checkpoint across repeated done events", () => {
    const tracker = createStreamIdTracker()
    const done = {
      type: "response.output_item.done",
      sequence_number: 0,
      output_index: 0,
      item: checkpoint("first-id"),
    } as const
    fix(done, tracker)

    expect(
      fix(
        { ...done, item: checkpoint("other-id", "rewrapped-checkpoint") },
        tracker,
      ).item,
    ).toEqual(done.item)
  })

  test("tracks IDs first seen in a response snapshot by output index", () => {
    const tracker = createStreamIdTracker()
    fix(
      {
        type: "response.in_progress",
        sequence_number: 0,
        response: result("response-id", [checkpoint("snapshot-id")]),
      },
      tracker,
    )
    const added = fix(
      {
        type: "response.output_item.added",
        sequence_number: 1,
        output_index: 0,
        item: checkpoint("added-id"),
      },
      tracker,
    )
    const done = fix(
      {
        type: "response.output_item.done",
        sequence_number: 2,
        output_index: 1,
        item: checkpoint("second-id"),
      },
      tracker,
    )

    expect(added.item.id).toBe("snapshot-id")
    expect(done.item.id).toBe("second-id")
  })

  test.each([
    "response.output_item.added",
    "response.output_item.done",
  ] as const)(
    "generates a stable missing item ID from %s and preserves tool call IDs",
    (type) => {
      const tracker = createStreamIdTracker()
      const item: ResponseOutputFunctionCall = {
        type: "function_call",
        call_id: "call-id",
        name: "read",
        arguments: "{}",
      }
      const first = fix(
        { type, sequence_number: 0, output_index: 0, item },
        tracker,
      )
      const delta = fix(
        {
          type: "response.function_call_arguments.delta",
          sequence_number: 1,
          output_index: 0,
          item_id: "different-delta-id",
          delta: "{}",
        },
        tracker,
      )
      const completed = fix(
        {
          type: "response.completed",
          sequence_number: 2,
          response: result("response-id", [{ ...item, id: "different-id" }]),
        },
        tracker,
      )

      expect(first.item.id).toMatch(/^oi_0_[a-z0-9]{16}$/)
      expect(first.item.id).toBe(delta.item_id)
      expect(completed.response.output).toEqual([first.item])
      expect(first.item.call_id).toBe("call-id")
    },
  )

  test("uses the payload event type when SSE event metadata is absent", () => {
    const tracker = createStreamIdTracker()
    const event = {
      type: "response.output_item.added",
      sequence_number: 0,
      output_index: 0,
      item: checkpoint("added-id"),
    } as const
    fixStreamIds(JSON.stringify(event), undefined, tracker)
    const done = fix(
      {
        ...event,
        type: "response.output_item.done",
        item: checkpoint("done-id"),
      },
      tracker,
    )

    expect(done.item.id).toBe("added-id")
  })

  test("keeps trackers independent and preserves unmatched events", () => {
    const event = {
      type: "response.completed",
      sequence_number: 0,
      response: result("response-id", [checkpoint("checkpoint-id")]),
    } as const
    expect(fix(event, createStreamIdTracker())).toEqual(event)
    expect(
      fix(
        { ...event, response: result("other-response-id") },
        createStreamIdTracker(),
      ).response.id,
    ).toBe("other-response-id")

    const delta = {
      type: "response.output_text.delta",
      sequence_number: 0,
      output_index: 5,
      content_index: 0,
      item_id: "unmatched-id",
      delta: "hello",
    } as const
    expect(fix(delta, createStreamIdTracker())).toEqual(delta)
  })

  test("keeps the original completed response ID for WebSocket continuation", () => {
    const tracker = createStreamIdTracker()
    const connection = { id: "socket-id", closed: false }
    const user = { role: "user", content: "hello" } as const
    const payload: ResponsesPayload = { model: "gpt-test", input: [user] }
    const item: ResponseOutputFunctionCall = {
      type: "function_call",
      call_id: "call-id",
      name: "read",
      arguments: "{}",
    }
    const attempt = prepareResponsesContinuation(payload, connection, false)
    const events: Array<ResponseStreamEvent> = [
      {
        type: "response.created",
        sequence_number: 0,
        response: result("created-id", [], "in_progress"),
      },
      {
        type: "response.completed",
        sequence_number: 1,
        response: result("upstream-completed-id", [item]),
      },
    ]
    for (const event of events) {
      attempt.observe(event)
      const forwarded = fix(event, tracker)
      if ("response" in forwarded)
        expect(forwarded.response.id).toBe("created-id")
    }
    attempt.finish()
    const next = prepareResponsesContinuation(
      { ...payload, input: [user, item, user] },
      connection,
      false,
    )

    expect(next.usedPrevious).toBe(true)
    expect(next.payload.previous_response_id).toBe("upstream-completed-id")
  })

  test("passes empty data and the SSE completion marker through", () => {
    const tracker = createStreamIdTracker()
    expect(fixStreamIds("", undefined, tracker)).toBe("")
    expect(fixStreamIds("[DONE]", undefined, tracker)).toBe("[DONE]")
  })
})
