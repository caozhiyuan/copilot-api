import { describe, expect, test } from "bun:test"

import type { AnthropicStreamEventData } from "~/lib/types/anthropic"
import type {
  ResponseCompletedEvent,
  ResponseOutputItemAddedEvent,
  ResponseOutputItemDoneEvent,
  ResponseFunctionCallArgumentsDeltaEvent,
  ResponseFunctionCallArgumentsDoneEvent,
  ResponseReasoningSummaryPartAddedEvent,
  ResponseReasoningSummaryTextDeltaEvent,
  ResponseReasoningSummaryTextDoneEvent,
  ResponseTextDeltaEvent,
  ResponseTextDoneEvent,
} from "~/lib/types/responses"

import {
  createResponsesStreamState,
  translateResponsesStreamEvent,
} from "~/routes/messages/responses-stream-translation"
import { REASONING_SUMMARY_SEPARATOR } from "~/routes/messages/responses-translation"

const createFunctionCallAddedEvent = (options?: {
  callId?: string
  itemId?: string
  name?: string
  outputIndex?: number
  sequenceNumber?: number
}): ResponseOutputItemAddedEvent => ({
  type: "response.output_item.added",
  sequence_number: options?.sequenceNumber ?? 1,
  output_index: options?.outputIndex ?? 1,
  item: {
    id: options?.itemId ?? "item-1",
    type: "function_call",
    call_id: options?.callId ?? "call-1",
    name: options?.name ?? "TodoWrite",
    arguments: "",
    status: "in_progress",
  },
})

describe("translateResponsesStreamEvent tool calls", () => {
  test("streams function call arguments across deltas", () => {
    const state = createResponsesStreamState()

    const events = [
      translateResponsesStreamEvent(createFunctionCallAddedEvent(), state),
      translateResponsesStreamEvent(
        {
          type: "response.function_call_arguments.delta",
          item_id: "item-1",
          output_index: 1,
          sequence_number: 2,
          delta: '{"todos":',
        } as ResponseFunctionCallArgumentsDeltaEvent,
        state,
      ),
      translateResponsesStreamEvent(
        {
          type: "response.function_call_arguments.delta",
          item_id: "item-1",
          output_index: 1,
          sequence_number: 3,
          delta: "[]}",
        } as ResponseFunctionCallArgumentsDeltaEvent,
        state,
      ),
      translateResponsesStreamEvent(
        {
          type: "response.function_call_arguments.done",
          item_id: "item-1",
          name: "TodoWrite",
          output_index: 1,
          sequence_number: 4,
          arguments: '{"todos":[]}',
        } as ResponseFunctionCallArgumentsDoneEvent,
        state,
      ),
    ].flat()

    const blockStart = events.find(
      (event) => event.type === "content_block_start",
    )
    expect(blockStart).toBeDefined()
    if (blockStart?.type === "content_block_start") {
      expect(blockStart.content_block).toEqual({
        type: "tool_use",
        id: "call-1",
        name: "TodoWrite",
        input: {},
      })
    }

    const deltas = events.filter(
      (
        event,
      ): event is Extract<
        AnthropicStreamEventData,
        { type: "content_block_delta" }
      > => event.type === "content_block_delta",
    )
    expect(deltas).toHaveLength(2)
    expect(deltas[0].delta).toEqual({
      type: "input_json_delta",
      partial_json: '{"todos":',
    })
    expect(deltas[1].delta).toEqual({
      type: "input_json_delta",
      partial_json: "[]}",
    })

    expect(state.openBlocks.size).toBe(1)
    expect(state.functionCallStateByOutputIndex.size).toBe(0)
  })

  test("closes the previous function call block when a new one starts", () => {
    const state = createResponsesStreamState()

    const events = [
      translateResponsesStreamEvent(
        createFunctionCallAddedEvent({
          callId: "call-1",
          itemId: "item-1",
          name: "FirstTool",
          outputIndex: 0,
          sequenceNumber: 1,
        }),
        state,
      ),
      translateResponsesStreamEvent(
        {
          type: "response.function_call_arguments.delta",
          item_id: "item-1",
          output_index: 0,
          sequence_number: 2,
          delta: '{"value":1}',
        } satisfies ResponseFunctionCallArgumentsDeltaEvent,
        state,
      ),
      translateResponsesStreamEvent(
        {
          type: "response.function_call_arguments.done",
          item_id: "item-1",
          name: "FirstTool",
          output_index: 0,
          sequence_number: 3,
          arguments: '{"value":1}',
        } satisfies ResponseFunctionCallArgumentsDoneEvent,
        state,
      ),
      translateResponsesStreamEvent(
        createFunctionCallAddedEvent({
          callId: "call-2",
          itemId: "item-2",
          name: "SecondTool",
          outputIndex: 1,
          sequenceNumber: 4,
        }),
        state,
      ),
      translateResponsesStreamEvent(
        {
          type: "response.function_call_arguments.done",
          item_id: "item-2",
          name: "SecondTool",
          output_index: 1,
          sequence_number: 5,
          arguments: '{"value":2}',
        } satisfies ResponseFunctionCallArgumentsDoneEvent,
        state,
      ),
      translateResponsesStreamEvent(
        {
          type: "response.completed",
          sequence_number: 6,
          response: {
            id: "resp-sequential",
            object: "response",
            created_at: 0,
            model: "gpt-5",
            output: [],
            output_text: "",
            status: "completed",
            usage: null,
            error: null,
            incomplete_details: null,
            instructions: null,
            metadata: null,
            parallel_tool_calls: true,
            temperature: null,
            tool_choice: null,
            tools: [],
            top_p: null,
          },
        } as ResponseCompletedEvent,
        state,
      ),
    ].flat()

    expect(
      events.filter(
        (event) =>
          event.type === "content_block_start"
          || event.type === "content_block_stop",
      ),
    ).toEqual([
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "call-1",
          name: "FirstTool",
          input: {},
        },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "call-2",
          name: "SecondTool",
          input: {},
        },
      },
      { type: "content_block_stop", index: 1 },
    ])
    expect(state.openBlocks.size).toBe(0)
    expect(state.functionCallStateByOutputIndex.size).toBe(0)
  })

  test("ignores output_text.done after a tool call", () => {
    const state = createResponsesStreamState()

    const events = [
      translateResponsesStreamEvent(
        {
          type: "response.output_text.delta",
          item_id: "msg-1",
          output_index: 0,
          content_index: 0,
          sequence_number: 1,
          delta: "Hello",
        } satisfies ResponseTextDeltaEvent,
        state,
      ),
      translateResponsesStreamEvent(
        createFunctionCallAddedEvent({
          callId: "call-1",
          itemId: "item-1",
          name: "FirstTool",
          outputIndex: 1,
          sequenceNumber: 2,
        }),
        state,
      ),
      translateResponsesStreamEvent(
        {
          type: "response.function_call_arguments.done",
          item_id: "item-1",
          name: "FirstTool",
          output_index: 1,
          sequence_number: 3,
          arguments: '{"value":1}',
        } satisfies ResponseFunctionCallArgumentsDoneEvent,
        state,
      ),
      translateResponsesStreamEvent(
        {
          type: "response.output_text.done",
          item_id: "msg-1",
          output_index: 0,
          content_index: 0,
          sequence_number: 4,
          text: "Hello",
        } satisfies ResponseTextDoneEvent,
        state,
      ),
      translateResponsesStreamEvent(
        {
          type: "response.completed",
          sequence_number: 5,
          response: {
            id: "resp-late-text-done",
            object: "response",
            created_at: 0,
            model: "grok-4.5",
            output: [],
            output_text: "",
            status: "completed",
            usage: null,
            error: null,
            incomplete_details: null,
            instructions: null,
            metadata: null,
            parallel_tool_calls: true,
            temperature: null,
            tool_choice: null,
            tools: [],
            top_p: null,
          },
        } as ResponseCompletedEvent,
        state,
      ),
    ].flat()

    expect(
      events.filter((event) => event.type === "content_block_start"),
    ).toEqual([
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "text",
          text: "",
        },
      },
      {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "call-1",
          name: "FirstTool",
          input: {},
        },
      },
    ])
    expect(
      events.filter(
        (event) =>
          event.type === "content_block_delta"
          && event.delta.type === "text_delta",
      ),
    ).toEqual([
      {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text: "Hello",
        },
      },
    ])
    expect(
      events.filter((event) => event.type === "content_block_stop"),
    ).toEqual([
      { type: "content_block_stop", index: 0 },
      { type: "content_block_stop", index: 1 },
    ])
    expect(state.openBlocks.size).toBe(0)
  })

  test("emits full arguments when only done payload is present", () => {
    const state = createResponsesStreamState()

    const events = [
      translateResponsesStreamEvent(createFunctionCallAddedEvent(), state),
      translateResponsesStreamEvent(
        {
          type: "response.function_call_arguments.done",
          item_id: "item-1",
          name: "TodoWrite",
          output_index: 1,
          sequence_number: 2,
          arguments:
            '{"todos":[{"content":"Review src/routes/responses/translation.ts"}]}',
        } as ResponseFunctionCallArgumentsDoneEvent,
        state,
      ),
    ].flat()

    const deltas = events.filter(
      (
        event,
      ): event is Extract<
        AnthropicStreamEventData,
        { type: "content_block_delta" }
      > => event.type === "content_block_delta",
    )
    expect(deltas).toHaveLength(1)
    expect(deltas[0].delta).toEqual({
      type: "input_json_delta",
      partial_json:
        '{"todos":[{"content":"Review src/routes/responses/translation.ts"}]}',
    })

    expect(state.openBlocks.size).toBe(1)
    expect(state.functionCallStateByOutputIndex.size).toBe(0)
  })

  test("uses streamed tool call state when completed output is empty", () => {
    const state = createResponsesStreamState()

    const events = [
      translateResponsesStreamEvent(createFunctionCallAddedEvent(), state),
      translateResponsesStreamEvent(
        {
          type: "response.function_call_arguments.done",
          item_id: "item-1",
          name: "TodoWrite",
          output_index: 1,
          sequence_number: 2,
          arguments: '{"todos":[]}',
        } as ResponseFunctionCallArgumentsDoneEvent,
        state,
      ),
      translateResponsesStreamEvent(
        {
          type: "response.completed",
          sequence_number: 3,
          response: {
            id: "resp-1",
            object: "response",
            created_at: 0,
            model: "gpt-5.4",
            output: [],
            output_text: "",
            status: "completed",
            usage: null,
            error: null,
            incomplete_details: null,
            instructions: null,
            metadata: null,
            parallel_tool_calls: false,
            temperature: null,
            tool_choice: null,
            tools: [],
            top_p: null,
          },
        } as ResponseCompletedEvent,
        state,
      ),
    ].flat()

    const messageDelta = events.find((event) => event.type === "message_delta")
    expect(messageDelta).toEqual({
      type: "message_delta",
      delta: {
        stop_reason: "tool_use",
        stop_sequence: null,
      },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
    })
    expect(state.hasToolCall).toBe(true)
  })

  test("uses namespace as streamed function call tool name", () => {
    const state = createResponsesStreamState()

    const events = translateResponsesStreamEvent(
      {
        ...createFunctionCallAddedEvent(),
        item: {
          id: "item-1",
          type: "function_call",
          call_id: "call-1",
          name: "invoke",
          namespace: "mcp__fetch__fetch",
          arguments: "",
          status: "in_progress",
        },
      },
      state,
    )

    const blockStart = events.find(
      (event) => event.type === "content_block_start",
    )
    expect(blockStart).toBeDefined()
    if (blockStart?.type === "content_block_start") {
      expect(blockStart.content_block).toEqual({
        type: "tool_use",
        id: "call-1",
        name: "mcp__fetch__fetch",
        input: {},
      })
    }
  })

  test("streams tool_search_call as the bridge tool use", () => {
    const state = createResponsesStreamState()

    const events = [
      translateResponsesStreamEvent(
        {
          type: "response.output_item.added",
          sequence_number: 1,
          output_index: 1,
          item: {
            id: "search-1",
            type: "tool_search_call",
            call_id: "call-search",
            arguments: { names: ["mcp__fetch__fetch", "TaskList"] },
            status: "in_progress",
          },
        },
        state,
      ),
      translateResponsesStreamEvent(
        {
          type: "response.output_item.done",
          sequence_number: 2,
          output_index: 1,
          item: {
            id: "search-1",
            type: "tool_search_call",
            call_id: "call-search",
            arguments: { names: ["mcp__fetch__fetch", "TaskList"] },
            status: "completed",
          },
        },
        state,
      ),
    ].flat()

    const blockStart = events.find(
      (event) => event.type === "content_block_start",
    )
    expect(blockStart).toBeDefined()
    if (blockStart?.type === "content_block_start") {
      expect(blockStart.content_block).toEqual({
        type: "tool_use",
        id: "call-search",
        name: "mcp__tool_search__search",
        input: {},
      })
    }

    const deltas = events.filter(
      (
        event,
      ): event is Extract<
        AnthropicStreamEventData,
        { type: "content_block_delta" }
      > => event.type === "content_block_delta",
    )
    expect(deltas).toHaveLength(1)
    expect(deltas[0].delta).toEqual({
      type: "input_json_delta",
      partial_json: '{"names":"mcp__fetch__fetch,TaskList"}',
    })
    expect(state.functionCallStateByOutputIndex.size).toBe(0)
  })

  test("streams tool_search_call with the configured bridge alias", () => {
    const state = createResponsesStreamState({
      toolSearchName: "tool_search_search",
    })

    const events = translateResponsesStreamEvent(
      {
        type: "response.output_item.added",
        sequence_number: 1,
        output_index: 1,
        item: {
          id: "search-1",
          type: "tool_search_call",
          call_id: "call-search",
          arguments: { names: ["mcp__fetch__fetch"] },
          status: "in_progress",
        },
      },
      state,
    )

    const blockStart = events.find(
      (event) => event.type === "content_block_start",
    )
    expect(blockStart).toBeDefined()
    if (blockStart?.type === "content_block_start") {
      expect(blockStart.content_block).toEqual({
        type: "tool_use",
        id: "call-search",
        name: "tool_search_search",
        input: {},
      })
    }
  })
})

describe("translateResponsesStreamEvent reasoning summaries", () => {
  test("uses empty thinking text for signature-only reasoning blocks", () => {
    const state = createResponsesStreamState()
    const events = [
      translateResponsesStreamEvent(
        {
          type: "response.output_item.done",
          sequence_number: 1,
          output_index: 0,
          item: {
            id: "reasoning-1",
            type: "reasoning",
            summary: [],
            encrypted_content: "encrypted-reasoning",
            status: "completed",
          },
        } satisfies ResponseOutputItemDoneEvent,
        state,
      ),
      translateResponsesStreamEvent(
        {
          type: "response.output_item.done",
          sequence_number: 2,
          output_index: 1,
          item: {
            id: "compaction-1",
            type: "compaction",
            encrypted_content: "encrypted-compaction",
          },
        } satisfies ResponseOutputItemDoneEvent,
        state,
      ),
    ].flat()

    const thinkingDeltas = events.flatMap((event) =>
      (
        event.type === "content_block_delta"
        && event.delta.type === "thinking_delta"
      ) ?
        [event.delta.thinking]
      : [],
    )

    expect(thinkingDeltas).toEqual(["", ""])
  })

  test("separates delta and done-only summaries exactly once", () => {
    const state = createResponsesStreamState()
    const partAdded = (summaryIndex: number, sequenceNumber: number) =>
      translateResponsesStreamEvent(
        {
          type: "response.reasoning_summary_part.added",
          item_id: "reasoning-1",
          output_index: 0,
          summary_index: summaryIndex,
          sequence_number: sequenceNumber,
          part: { type: "summary_text", text: "" },
        } satisfies ResponseReasoningSummaryPartAddedEvent,
        state,
      )

    const events = [
      partAdded(0, 1),
      translateResponsesStreamEvent(
        {
          type: "response.reasoning_summary_text.done",
          item_id: "reasoning-1",
          output_index: 0,
          summary_index: 0,
          sequence_number: 2,
          text: "**Preparing the request**",
        } satisfies ResponseReasoningSummaryTextDoneEvent,
        state,
      ),
      partAdded(1, 3),
      translateResponsesStreamEvent(
        {
          type: "response.reasoning_summary_text.delta",
          item_id: "reasoning-1",
          output_index: 0,
          summary_index: 1,
          sequence_number: 4,
          delta: "**Running ",
        } satisfies ResponseReasoningSummaryTextDeltaEvent,
        state,
      ),
      translateResponsesStreamEvent(
        {
          type: "response.reasoning_summary_text.delta",
          item_id: "reasoning-1",
          output_index: 0,
          summary_index: 1,
          sequence_number: 5,
          delta: "the tool**",
        } satisfies ResponseReasoningSummaryTextDeltaEvent,
        state,
      ),
      partAdded(2, 6),
      translateResponsesStreamEvent(
        {
          type: "response.reasoning_summary_text.done",
          item_id: "reasoning-1",
          output_index: 0,
          summary_index: 2,
          sequence_number: 7,
          text: "**Finishing**",
        } satisfies ResponseReasoningSummaryTextDoneEvent,
        state,
      ),
    ].flat()

    const thinking = events
      .flatMap((event) =>
        (
          event.type === "content_block_delta"
          && event.delta.type === "thinking_delta"
        ) ?
          [event.delta.thinking]
        : [],
      )
      .join("")

    expect(thinking).toBe(
      "**Preparing the request**"
        + REASONING_SUMMARY_SEPARATOR
        + "**Running the tool**"
        + REASONING_SUMMARY_SEPARATOR
        + "**Finishing**",
    )
  })
})

describe("translateResponsesStreamEvent error handling", () => {
  test("closes open blocks and prefers nested error.message on error events", () => {
    const state = createResponsesStreamState()
    const events = [
      translateResponsesStreamEvent(
        {
          type: "response.output_text.delta",
          item_id: "msg-1",
          output_index: 0,
          content_index: 0,
          sequence_number: 1,
          delta: "Partial reply",
        } satisfies ResponseTextDeltaEvent,
        state,
      ),
      translateResponsesStreamEvent(
        {
          type: "error",
          code: null,
          message: "",
          param: null,
          sequence_number: 2,
          error: {
            code: "rate_limit_exceeded",
            message: "Upstream rate limit exceeded",
          },
        },
        state,
      ),
    ].flat()

    expect(events).toEqual([
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Partial reply" },
      },
      {
        type: "content_block_stop",
        index: 0,
      },
      {
        type: "error",
        error: {
          type: "api_error",
          message: "Upstream rate limit exceeded",
        },
      },
    ])
    expect(state.messageCompleted).toBe(true)
    expect(state.openBlocks.size).toBe(0)
  })

  test("supports top-level error message, fallback error message, and response.failed", () => {
    const topLevelState = createResponsesStreamState()
    expect(
      translateResponsesStreamEvent(
        {
          type: "error",
          code: "bad_request",
          message: "Top-level stream error",
          param: null,
          sequence_number: 1,
        },
        topLevelState,
      ),
    ).toEqual([
      {
        type: "error",
        error: {
          type: "api_error",
          message: "Top-level stream error",
        },
      },
    ])

    const fallbackState = createResponsesStreamState()
    expect(
      translateResponsesStreamEvent(
        {
          type: "error",
          code: null,
          message: "",
          param: null,
          sequence_number: 1,
        },
        fallbackState,
      ),
    ).toEqual([
      {
        type: "error",
        error: {
          type: "api_error",
          message: "An unexpected error occurred during streaming.",
        },
      },
    ])

    const failedState = createResponsesStreamState()
    expect(
      translateResponsesStreamEvent(
        {
          type: "response.failed",
          sequence_number: 1,
          response: {
            id: "resp-failed",
            object: "response",
            created_at: 0,
            model: "gpt-5",
            output: [],
            output_text: "",
            status: "failed",
            usage: null,
            error: {
              code: "server_error",
              message: "Response failed upstream",
            },
            incomplete_details: null,
            instructions: null,
            metadata: null,
            parallel_tool_calls: true,
            temperature: null,
            tool_choice: null,
            tools: [],
            top_p: null,
          },
        },
        failedState,
      ),
    ).toEqual([
      {
        type: "error",
        error: {
          type: "api_error",
          message: "Response failed upstream",
        },
      },
    ])
  })
})
