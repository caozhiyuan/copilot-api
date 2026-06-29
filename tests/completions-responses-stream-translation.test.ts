import { describe, expect, it } from "bun:test"

import type { ChatCompletionChunk } from "~/services/copilot/create-chat-completions"
import type {
  ResponseCompletedEvent,
  ResponseFailedEvent,
  ResponseIncompleteEvent,
  ResponseOutputFunctionCall,
  ResponseOutputItemAddedEvent,
  ResponseOutputMessage,
  ResponsesResult,
  ResponseStreamEvent,
  ResponseTextDeltaEvent,
} from "~/services/copilot/create-responses"

import {
  createCompletionsStreamState,
  translateResponsesStreamEventToCompletions,
} from "~/routes/chat-completions/completions-responses-stream-translation"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const parseChunks = (
  messages: Array<{ data?: string }>,
): Array<ChatCompletionChunk> =>
  messages
    .filter((m) => m.data && m.data !== "[DONE]")
    .map((m) => JSON.parse(m.data!) as ChatCompletionChunk)

const isDone = (messages: Array<{ data?: string }>): boolean =>
  messages.some((m) => m.data === "[DONE]")

const baseResponse = (
  overrides: Partial<ResponsesResult> = {},
): ResponsesResult => ({
  id: "resp-1",
  object: "response",
  created_at: 1000,
  model: "gpt-5.4-mini",
  output: [],
  output_text: "",
  status: "completed",
  usage: {
    input_tokens: 10,
    output_tokens: 20,
    total_tokens: 30,
  },
  error: null,
  incomplete_details: null,
  instructions: null,
  metadata: null,
  parallel_tool_calls: true,
  temperature: null,
  tool_choice: null,
  tools: [],
  top_p: null,
  ...overrides,
})

// ---------------------------------------------------------------------------
// Text streaming
// ---------------------------------------------------------------------------

describe("text delta streaming", () => {
  it("emits role chunk on first text delta, then content", () => {
    const state = createCompletionsStreamState()

    const msgs1 = translateResponsesStreamEventToCompletions(
      {
        type: "response.output_text.delta",
        delta: "Hello",
        content_index: 0,
        item_id: "item-1",
        output_index: 0,
        sequence_number: 1,
      } as ResponseTextDeltaEvent,
      state,
    )

    const chunks = parseChunks(msgs1)
    expect(chunks).toHaveLength(2)
    // First chunk is the role marker
    expect(chunks[0].choices[0].delta).toEqual({ role: "assistant" })
    // Second chunk is the actual content
    expect(chunks[1].choices[0].delta).toEqual({ content: "Hello" })
  })

  it("skips role chunk on subsequent text deltas", () => {
    const state = createCompletionsStreamState()

    // First delta - triggers role chunk
    translateResponsesStreamEventToCompletions(
      {
        type: "response.output_text.delta",
        delta: "Hello",
        content_index: 0,
        item_id: "item-1",
        output_index: 0,
        sequence_number: 1,
      } as ResponseTextDeltaEvent,
      state,
    )

    // Second delta - no role chunk
    const msgs2 = translateResponsesStreamEventToCompletions(
      {
        type: "response.output_text.delta",
        delta: " world",
        content_index: 0,
        item_id: "item-1",
        output_index: 0,
        sequence_number: 2,
      } as ResponseTextDeltaEvent,
      state,
    )

    const chunks = parseChunks(msgs2)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].choices[0].delta).toEqual({ content: " world" })
  })

  it("emits role chunk when message item is added", () => {
    const state = createCompletionsStreamState()

    const msgs = translateResponsesStreamEventToCompletions(
      {
        type: "response.output_item.added",
        output_index: 0,
        sequence_number: 1,
        item: {
          id: "msg-1",
          type: "message",
          role: "assistant",
          status: "in_progress",
        } satisfies ResponseOutputMessage,
      } satisfies ResponseOutputItemAddedEvent,
      state,
    )

    const chunks = parseChunks(msgs)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].choices[0].delta).toEqual({ role: "assistant" })
    expect(state.started).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Function call streaming
// ---------------------------------------------------------------------------

describe("function call streaming", () => {
  it("emits tool_call start when function_call item is added", () => {
    const state = createCompletionsStreamState()

    const msgs = translateResponsesStreamEventToCompletions(
      {
        type: "response.output_item.added",
        output_index: 1,
        sequence_number: 1,
        item: {
          id: "fc-1",
          type: "function_call",
          call_id: "call-1",
          name: "get_weather",
          arguments: "",
          status: "in_progress",
        } satisfies ResponseOutputFunctionCall,
      } satisfies ResponseOutputItemAddedEvent,
      state,
    )

    const chunks = parseChunks(msgs)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].choices[0].delta.tool_calls).toEqual([
      {
        index: 1,
        id: "call-1",
        type: "function",
        function: {
          name: "get_weather",
          arguments: "",
        },
      },
    ])
    expect(state.started).toBe(true)
  })

  it("streams function call argument deltas", () => {
    const state = createCompletionsStreamState()

    // Start the function call first
    translateResponsesStreamEventToCompletions(
      {
        type: "response.output_item.added",
        output_index: 1,
        sequence_number: 1,
        item: {
          id: "fc-1",
          type: "function_call",
          call_id: "call-1",
          name: "get_weather",
          arguments: "",
          status: "in_progress",
        } satisfies ResponseOutputFunctionCall,
      } satisfies ResponseOutputItemAddedEvent,
      state,
    )

    const msgs = translateResponsesStreamEventToCompletions(
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc-1",
        output_index: 1,
        sequence_number: 2,
        delta: '{"location":',
      },
      state,
    )

    const chunks = parseChunks(msgs)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].choices[0].delta.tool_calls).toEqual([
      {
        index: 1,
        type: "function",
        function: {
          arguments: '{"location":',
        },
      },
    ])
  })

  it("skips arguments delta when output_index is undefined", () => {
    const state = createCompletionsStreamState()

    const msgs = translateResponsesStreamEventToCompletions(
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc-1",
        output_index: undefined,
        sequence_number: 2,
        delta: '{"x":1}',
      } as unknown as ResponseStreamEvent,
      state,
    )

    expect(msgs).toHaveLength(0)
  })

  it("uses empty string when delta is undefined", () => {
    const state = createCompletionsStreamState()
    state.started = true // skip role chunk

    const msgs = translateResponsesStreamEventToCompletions(
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc-1",
        output_index: 1,
        sequence_number: 2,
        delta: undefined,
      } as unknown as ResponseStreamEvent,
      state,
    )

    const chunks = parseChunks(msgs)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].choices[0].delta.tool_calls![0].function!.arguments).toBe(
      "",
    )
  })
})

// ---------------------------------------------------------------------------
// Terminal events
// ---------------------------------------------------------------------------

describe("terminal events", () => {
  it("emits finish_reason stop and [DONE] on response.completed", () => {
    const state = createCompletionsStreamState()

    const msgs = translateResponsesStreamEventToCompletions(
      {
        type: "response.completed",
        sequence_number: 10,
        response: baseResponse(),
      } satisfies ResponseCompletedEvent,
      state,
    )

    const chunks = parseChunks(msgs)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].choices[0].finish_reason).toBe("stop")
    expect(isDone(msgs)).toBe(true)
  })

  it("emits tool_calls finish_reason when function calls present in completed", () => {
    const state = createCompletionsStreamState()

    const msgs = translateResponsesStreamEventToCompletions(
      {
        type: "response.completed",
        sequence_number: 10,
        response: baseResponse({
          output: [
            {
              id: "fc-1",
              type: "function_call",
              call_id: "call-1",
              name: "fn",
              arguments: "{}",
              status: "completed",
            } satisfies ResponseOutputFunctionCall,
          ],
        }),
      } satisfies ResponseCompletedEvent,
      state,
    )

    const chunks = parseChunks(msgs)
    expect(chunks[0].choices[0].finish_reason).toBe("tool_calls")
  })

  it("emits length finish_reason on response.incomplete with max_output_tokens", () => {
    const state = createCompletionsStreamState()

    const msgs = translateResponsesStreamEventToCompletions(
      {
        type: "response.incomplete",
        sequence_number: 10,
        response: baseResponse({
          incomplete_details: { reason: "max_output_tokens" },
        }),
      } satisfies ResponseIncompleteEvent,
      state,
    )

    const chunks = parseChunks(msgs)
    expect(chunks[0].choices[0].finish_reason).toBe("length")
    expect(isDone(msgs)).toBe(true)
  })

  it("emits content_filter finish_reason on response.incomplete with content_filter", () => {
    const state = createCompletionsStreamState()

    const msgs = translateResponsesStreamEventToCompletions(
      {
        type: "response.incomplete",
        sequence_number: 10,
        response: baseResponse({
          incomplete_details: { reason: "content_filter" },
        }),
      } satisfies ResponseIncompleteEvent,
      state,
    )

    const chunks = parseChunks(msgs)
    expect(chunks[0].choices[0].finish_reason).toBe("content_filter")
  })

  it("emits stop and [DONE] on response.failed", () => {
    const state = createCompletionsStreamState()

    const msgs = translateResponsesStreamEventToCompletions(
      {
        type: "response.failed",
        sequence_number: 10,
        response: baseResponse({
          status: "failed",
          error: { code: "server_error", message: "Internal error" },
        }),
      } satisfies ResponseFailedEvent,
      state,
    )

    const chunks = parseChunks(msgs)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].choices[0].finish_reason).toBe("stop")
    expect(isDone(msgs)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Usage and copilot_usage on stream
// ---------------------------------------------------------------------------

describe("usage on stream completion", () => {
  it("includes translated usage on completed chunk", () => {
    const state = createCompletionsStreamState()

    const msgs = translateResponsesStreamEventToCompletions(
      {
        type: "response.completed",
        sequence_number: 10,
        response: baseResponse({
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            total_tokens: 150,
            input_tokens_details: { cached_tokens: 80 },
          },
        }),
      } satisfies ResponseCompletedEvent,
      state,
    )

    const chunks = parseChunks(msgs)
    expect(chunks[0].usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 80 },
    })
  })

  it("includes copilot_usage on completed chunk when present", () => {
    const state = createCompletionsStreamState()

    const msgs = translateResponsesStreamEventToCompletions(
      {
        type: "response.completed",
        sequence_number: 10,
        copilot_usage: { total_nano_aiu: 42 },
        response: baseResponse(),
      } satisfies ResponseCompletedEvent,
      state,
    )

    const chunks = parseChunks(msgs)
    expect(chunks[0].copilot_usage).toEqual({ total_nano_aiu: 42 })
  })

  it("omits copilot_usage when absent", () => {
    const state = createCompletionsStreamState()

    const msgs = translateResponsesStreamEventToCompletions(
      {
        type: "response.completed",
        sequence_number: 10,
        response: baseResponse(),
      } satisfies ResponseCompletedEvent,
      state,
    )

    const chunks = parseChunks(msgs)
    expect(chunks[0]).not.toHaveProperty("copilot_usage")
  })
})

// ---------------------------------------------------------------------------
// Metadata capture
// ---------------------------------------------------------------------------

describe("metadata capture from response envelope", () => {
  it("captures responseId, model, and createdAt from completed event", () => {
    const state = createCompletionsStreamState()

    translateResponsesStreamEventToCompletions(
      {
        type: "response.completed",
        sequence_number: 10,
        response: baseResponse({
          id: "resp-abc",
          model: "gpt-5.5",
          created_at: 9999,
        }),
      } satisfies ResponseCompletedEvent,
      state,
    )

    expect(state.responseId).toBe("resp-abc")
    expect(state.model).toBe("gpt-5.5")
    expect(state.createdAt).toBe(9999)
  })

  it("uses captured metadata in subsequent chunk ids", () => {
    const state = createCompletionsStreamState()

    // First event sets metadata
    translateResponsesStreamEventToCompletions(
      {
        type: "response.output_item.added",
        output_index: 0,
        sequence_number: 1,
        item: {
          id: "msg-1",
          type: "message",
          role: "assistant",
          status: "in_progress",
        } satisfies ResponseOutputMessage,
      } satisfies ResponseOutputItemAddedEvent,
      state,
    )

    // Manually set metadata as if a response.created event came first
    state.responseId = "resp-xyz"
    state.model = "gpt-5.4-mini"
    state.createdAt = 2000

    const msgs = translateResponsesStreamEventToCompletions(
      {
        type: "response.output_text.delta",
        delta: "hi",
        content_index: 0,
        item_id: "item-1",
        output_index: 0,
        sequence_number: 2,
      } as ResponseTextDeltaEvent,
      state,
    )

    const chunks = parseChunks(msgs)
    expect(chunks[0].id).toBe("resp-xyz")
    expect(chunks[0].model).toBe("gpt-5.4-mini")
    expect(chunks[0].created).toBe(2000)
  })
})

// ---------------------------------------------------------------------------
// Unknown / unhandled events
// ---------------------------------------------------------------------------

describe("unhandled events", () => {
  it("produces no output for unknown event types", () => {
    const state = createCompletionsStreamState()

    const msgs = translateResponsesStreamEventToCompletions(
      {
        type: "response.reasoning_summary_text.delta",
        delta: "thinking...",
        item_id: "item-1",
        output_index: 0,
        sequence_number: 1,
        content_index: 0,
        summary_index: 0,
      } as unknown as ResponseStreamEvent,
      state,
    )

    expect(msgs).toHaveLength(0)
  })

  it("produces no output for web search events", () => {
    const state = createCompletionsStreamState()

    const msgs = translateResponsesStreamEventToCompletions(
      {
        type: "response.web_search_call.searching",
        item_id: "ws-1",
        output_index: 0,
        sequence_number: 1,
      } as ResponseStreamEvent,
      state,
    )

    expect(msgs).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Chunk structure
// ---------------------------------------------------------------------------

describe("chunk structure", () => {
  it("produces valid chat.completion.chunk objects", () => {
    const state = createCompletionsStreamState()

    const msgs = translateResponsesStreamEventToCompletions(
      {
        type: "response.output_text.delta",
        delta: "test",
        content_index: 0,
        item_id: "item-1",
        output_index: 0,
        sequence_number: 1,
      } as ResponseTextDeltaEvent,
      state,
    )

    const chunks = parseChunks(msgs)
    for (const chunk of chunks) {
      expect(chunk.object).toBe("chat.completion.chunk")
      expect(chunk.choices).toHaveLength(1)
      expect(chunk.choices[0].index).toBe(0)
      expect(chunk.choices[0].logprobs).toBeNull()
    }
  })
})
