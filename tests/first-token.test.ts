import { describe, expect, test } from "bun:test"

import {
  recordAnthropicFirstToken,
  recordChatCompletionFirstToken,
  recordGoogleFirstToken,
  recordResponsesFirstToken,
} from "~/lib/first-token"
import { requestContext } from "~/lib/request-context"
import type { AnthropicStreamEventData } from "~/lib/types/anthropic"
import type { ChatCompletionChunk, Delta } from "~/lib/types/chat-completions"
import type { ResponseStreamEvent } from "~/lib/types/responses"

function observed(run: () => void): number {
  let count = 0
  requestContext.run(
    {
      traceId: "trace",
      startTime: 0,
      userAgent: "test",
      sessionAffinity: undefined,
      parentSessionId: undefined,
      pluginRequest: {
        id: "request",
        setModel: () => {},
        setActualModel: () => {},
        setSessionId: () => {},
        recordUsage: () => {},
        recordFirstToken: () => {
          count++
        },
      },
    },
    run,
  )
  return count
}

const chunk = (delta: Delta): ChatCompletionChunk => ({
  id: "chat-1",
  object: "chat.completion.chunk",
  created: 0,
  model: "test",
  choices: [{ index: 0, delta, finish_reason: null, logprobs: null }],
})

describe("first thinking start or model output", () => {
  test.each<Delta>([
    {},
    { role: "assistant" },
    { content: "" },
    { reasoning_text: "", reasoning_content: null },
    { reasoning_opaque: "signature-only" },
    {
      tool_calls: [
        { index: 0, id: "tool-1", function: { name: "lookup", arguments: "" } },
      ],
    },
  ])("ignores Chat Completions envelopes: %j", (delta) => {
    expect(observed(() => recordChatCompletionFirstToken(chunk(delta)))).toBe(0)
  })

  test.each<Delta>([
    { content: "hello" },
    { content: " " },
    { reasoning_text: "thinking" },
    { reasoning_content: "thinking" },
    { reasoning: "thinking" },
    { tool_calls: [{ index: 0, function: { arguments: "{" } }] },
  ])("observes Chat Completions output: %j", (delta) => {
    expect(observed(() => recordChatCompletionFirstToken(chunk(delta)))).toBe(1)
  })

  test("ignores null chunks and usage-only Chat Completions chunks", () => {
    expect(
      observed(() => {
        recordChatCompletionFirstToken(null)
        recordChatCompletionFirstToken({
          ...chunk({}),
          choices: [],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        })
      }),
    ).toBe(0)
  })

  const responseDelta = {
    content_index: 0,
    item_id: "msg-1",
    output_index: 0,
    sequence_number: 1,
    summary_index: 0,
  }
  test.each([
    "response.output_text.delta",
    "response.reasoning_summary_text.delta",
    "response.function_call_arguments.delta",
    "response.custom_tool_call_input.delta",
  ] as const)("observes nonempty %s only", (type) => {
    expect(
      observed(() =>
        recordResponsesFirstToken({ ...responseDelta, type, delta: "" }),
      ),
    ).toBe(0)
    expect(
      observed(() =>
        recordResponsesFirstToken({ ...responseDelta, type, delta: " " }),
      ),
    ).toBe(1)
  })

  test("ignores Responses tool starts, search status, annotations, done events and errors", () => {
    const events: Array<ResponseStreamEvent | null> = [
      null,
      {
        ...responseDelta,
        type: "response.output_item.added",
        item: {
          type: "function_call",
          id: "fc-1",
          call_id: "tool-1",
          name: "lookup",
          arguments: "",
        },
      },
      { ...responseDelta, type: "response.web_search_call.searching" },
      {
        ...responseDelta,
        type: "response.output_text.annotation.added",
        annotation: { text: "citation" },
      },
      {
        ...responseDelta,
        type: "response.output_text.done",
        text: "full result",
      },
      {
        type: "error",
        sequence_number: 1,
        code: null,
        message: "failed",
        param: null,
      },
    ]
    expect(observed(() => events.forEach(recordResponsesFirstToken))).toBe(0)
  })

  test.each<AnthropicStreamEventData>([
    { type: "ping" },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "tool-1",
        name: "lookup",
        input: {},
      },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "signed" },
    },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 12 },
    },
    { type: "error", error: { type: "api_error", message: "failed" } },
  ])("ignores Anthropic metadata: %j", (event) => {
    expect(observed(() => recordAnthropicFirstToken(event))).toBe(0)
  })

  test.each<AnthropicStreamEventData>([
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: " " },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "think" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: "{" },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "hello" },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "think" },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "tool-1",
        name: "lookup",
        input: { query: "test" },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "server_tool_use",
        id: "tool-1",
        name: "web_search",
        input: { query: "test" },
      },
    },
  ])("observes Anthropic output: %j", (event) => {
    expect(observed(() => recordAnthropicFirstToken(event))).toBe(1)
  })

  test("counts Responses reasoning item/summary starts before any reasoning text", () => {
    expect(
      observed(() =>
        recordResponsesFirstToken({
          type: "response.output_item.added",
          output_index: 0,
          sequence_number: 0,
          item: {
            id: "reasoning-1",
            type: "reasoning",
            status: "in_progress",
            summary: [],
          },
        }),
      ),
    ).toBe(1)
    expect(
      observed(() =>
        recordResponsesFirstToken({
          ...responseDelta,
          type: "response.reasoning_summary_part.added",
          part: { type: "summary_text", text: "" },
        }),
      ),
    ).toBe(1)
  })

  test("observes Google text, thoughts and complete calls, excluding metadata and signatures", () => {
    const google = (parts: Array<import("~/lib/types/google").GooglePart>) => ({
      candidates: [{ content: { parts } }],
    })
    expect(
      observed(() => {
        recordGoogleFirstToken({})
        recordGoogleFirstToken({ usageMetadata: { candidatesTokenCount: 2 } })
        recordGoogleFirstToken(
          google([{ text: "", thoughtSignature: "signature" }]),
        )
        recordAnthropicFirstToken(null)
      }),
    ).toBe(0)
    expect(
      observed(() => recordGoogleFirstToken(google([{ text: "hello" }]))),
    ).toBe(1)
    expect(
      observed(() =>
        recordGoogleFirstToken(google([{ text: "think", thought: true }])),
      ),
    ).toBe(1)
    expect(
      observed(() =>
        recordGoogleFirstToken(google([{ thought: true, text: "" }])),
      ),
    ).toBe(1)
    expect(
      observed(() =>
        recordGoogleFirstToken(
          google([{ functionCall: { name: "lookup", args: {} } }]),
        ),
      ),
    ).toBe(1)
  })

  test("does nothing without an enabled request observer", () => {
    recordChatCompletionFirstToken(chunk({ content: "hello" }))
    recordResponsesFirstToken({
      ...responseDelta,
      type: "response.output_text.delta",
      delta: "hello",
    })
    recordAnthropicFirstToken({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hello" },
    })
    recordGoogleFirstToken({
      candidates: [{ content: { parts: [{ text: "hello" }] } }],
    })
  })
})
