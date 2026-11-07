import { describe, test, expect } from "bun:test"
import { z } from "zod"

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  Delta,
} from "~/lib/types/chat-completions"

import { type AnthropicStreamState } from "~/lib/types/anthropic"
import { translateToAnthropic } from "~/routes/messages/completions-translation"
import {
  flushPendingAnthropicStreamEvents,
  translateChunkToAnthropicEvents,
} from "~/routes/messages/completions-stream-translation"

const anthropicUsageSchema = z.object({
  input_tokens: z.number().int(),
  output_tokens: z.number().int(),
})

const anthropicContentBlockTextSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
})

const anthropicContentBlockToolUseSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.any()),
})

const anthropicMessageResponseSchema = z.object({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  content: z.array(
    z.union([
      anthropicContentBlockTextSchema,
      anthropicContentBlockToolUseSchema,
    ]),
  ),
  model: z.string(),
  stop_reason: z.enum(["end_turn", "max_tokens", "stop_sequence", "tool_use"]),
  stop_sequence: z.string().nullable(),
  usage: anthropicUsageSchema,
})

/**
 * Validates if a response payload conforms to the Anthropic Message shape.
 * @param payload The response payload to validate.
 * @returns True if the payload is valid, false otherwise.
 */
function isValidAnthropicResponse(payload: unknown): boolean {
  return anthropicMessageResponseSchema.safeParse(payload).success
}

const anthropicStreamEventSchema = z.looseObject({
  type: z.enum([
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]),
})

function isValidAnthropicStreamEvent(payload: unknown): boolean {
  return anthropicStreamEventSchema.safeParse(payload).success
}

describe("OpenAI to Anthropic Non-Streaming Response Translation", () => {
  test("should translate a simple text response correctly", () => {
    const openAIResponse: ChatCompletionResponse = {
      id: "chatcmpl-123",
      object: "chat.completion",
      created: 1677652288,
      model: "gpt-4o-2024-05-13",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Hello! How can I help you today?",
          },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 9,
        completion_tokens: 12,
        total_tokens: 21,
      },
    }

    const anthropicResponse = translateToAnthropic(openAIResponse)

    expect(isValidAnthropicResponse(anthropicResponse)).toBe(true)

    expect(anthropicResponse.id).toBe("chatcmpl-123")
    expect(anthropicResponse.stop_reason).toBe("end_turn")
    expect(anthropicResponse.usage.input_tokens).toBe(9)
    expect(anthropicResponse.content[0].type).toBe("text")
    if (anthropicResponse.content[0].type === "text") {
      expect(anthropicResponse.content[0].text).toBe(
        "Hello! How can I help you today?",
      )
    } else {
      throw new Error("Expected text block")
    }
  })

  test("should translate a response with tool calls", () => {
    const openAIResponse: ChatCompletionResponse = {
      id: "chatcmpl-456",
      object: "chat.completion",
      created: 1677652288,
      model: "gpt-4o-2024-05-13",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_abc",
                type: "function",
                function: {
                  name: "get_current_weather",
                  arguments: '{"location": "Boston, MA"}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 30,
        completion_tokens: 20,
        total_tokens: 50,
      },
    }

    const anthropicResponse = translateToAnthropic(openAIResponse)

    expect(isValidAnthropicResponse(anthropicResponse)).toBe(true)

    expect(anthropicResponse.stop_reason).toBe("tool_use")
    expect(anthropicResponse.content[0].type).toBe("tool_use")
    if (anthropicResponse.content[0].type === "tool_use") {
      expect(anthropicResponse.content[0].id).toBe("call_abc")
      expect(anthropicResponse.content[0].name).toBe("get_current_weather")
      expect(anthropicResponse.content[0].input).toEqual({
        location: "Boston, MA",
      })
    } else {
      throw new Error("Expected tool_use block")
    }
  })

  test("should translate a response stopped due to length", () => {
    const openAIResponse: ChatCompletionResponse = {
      id: "chatcmpl-789",
      object: "chat.completion",
      created: 1677652288,
      model: "gpt-4o-2024-05-13",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "This is a very long response that was cut off...",
          },
          finish_reason: "length",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2048,
        total_tokens: 2058,
      },
    }

    const anthropicResponse = translateToAnthropic(openAIResponse)

    expect(isValidAnthropicResponse(anthropicResponse)).toBe(true)
    expect(anthropicResponse.stop_reason).toBe("max_tokens")
  })

  test("should translate OpenAI cache creation usage details", () => {
    const openAIResponse: ChatCompletionResponse = {
      id: "chatcmpl-cache",
      object: "chat.completion",
      created: 1677652288,
      model: "qwen-plus",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "cached answer",
          },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 10,
        total_tokens: 110,
        prompt_tokens_details: {
          cache_creation_input_tokens: 20,
          cached_tokens: 12,
        },
      },
    }

    const anthropicResponse = translateToAnthropic(openAIResponse)

    expect(anthropicResponse.usage).toEqual({
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 12,
      input_tokens: 68,
      output_tokens: 10,
    })
  })
})

describe("OpenAI to Anthropic Streaming Response Translation", () => {
  test("should translate a simple text stream correctly", () => {
    const openAIStream: Array<ChatCompletionChunk> = [
      {
        id: "cmpl-1",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: { role: "assistant" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-1",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: { content: "Hello" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-1",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: { content: " there" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-1",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          { index: 0, delta: {}, finish_reason: "stop", logprobs: null },
        ],
      },
    ]

    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      messageCompleted: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
    }
    const translatedStream = openAIStream.flatMap((chunk) =>
      translateChunkToAnthropicEvents(chunk, streamState),
    )

    for (const event of translatedStream) {
      expect(isValidAnthropicStreamEvent(event)).toBe(true)
    }
  })

  test("should translate a stream with tool calls", () => {
    const openAIStream: Array<ChatCompletionChunk> = [
      {
        id: "cmpl-2",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: { role: "assistant" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-2",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_xyz",
                  type: "function",
                  function: { name: "get_weather", arguments: "" },
                },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-2",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"loc' } }],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-2",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: 'ation": "Paris"}' } },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-2",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          { index: 0, delta: {}, finish_reason: "tool_calls", logprobs: null },
        ],
      },
    ]

    // Streaming translation requires state
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      messageCompleted: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
    }
    const translatedStream = openAIStream.flatMap((chunk) =>
      translateChunkToAnthropicEvents(chunk, streamState),
    )

    // These tests will fail until the stub is implemented
    for (const event of translatedStream) {
      expect(isValidAnthropicStreamEvent(event)).toBe(true)
    }
  })
})

describe("OpenAI stream interleaved tool/content translation", () => {
  test.each([false, true])(
    "serializes interleaved tool arguments with declarations in one chunk=%s",
    (sameChunk) => {
      const streamState: AnthropicStreamState = {
        messageStartSent: false,
        messageCompleted: false,
        contentBlockIndex: 0,
        contentBlockOpen: false,
        toolCalls: {},
        thinkingBlockOpen: false,
      }
      const toolCalls: NonNullable<Delta["tool_calls"]> = [
        {
          index: 0,
          id: "call_weather",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":' },
        },
        {
          index: 1,
          id: "call_time",
          type: "function",
          function: { name: "get_time", arguments: '{"zone":' },
        },
        {
          index: 2,
          id: "call_search",
          type: "function",
          function: { name: "search", arguments: "" },
        },
      ]
      const deltas: Array<Delta> = [
        { content: "Checking." },
        ...(sameChunk ?
          [{ tool_calls: toolCalls }]
        : toolCalls.map((toolCall) => ({ tool_calls: [toolCall] }))),
        { content: "Done." },
        {
          tool_calls: [
            { index: 1, function: { arguments: '"UTC"}' } },
            { index: 0, function: { arguments: '"Paris"}' } },
          ],
        },
        {
          tool_calls: [
            { index: 2, function: { arguments: sameChunk ? "{}" : "" } },
          ],
        },
      ]
      const chunks: Array<ChatCompletionChunk> = [...deltas, {}].map(
        (delta, index) => ({
          id: "chatcmpl-parallel-tools",
          object: "chat.completion.chunk",
          created: 0,
          model: "test-model",
          choices: [
            {
              index: 0,
              delta,
              finish_reason: index === deltas.length ? "tool_calls" : null,
              logprobs: null,
            },
          ],
        }),
      )
      const translatedChunks = chunks.map((chunk) =>
        translateChunkToAnthropicEvents(chunk, streamState),
      )
      expect(translatedChunks[1]).toContainEqual({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"city":' },
      })
      const events = translatedChunks.flat()
      events.push(...flushPendingAnthropicStreamEvents(streamState))

      let openIndex: number | undefined
      const inputs = new Map<number, string>()
      const names: Array<string> = []
      for (const event of events) {
        if (event.type === "content_block_start") {
          expect(openIndex).toBeUndefined()
          openIndex = event.index
          if (event.content_block.type === "tool_use") {
            names.push(event.content_block.name)
            inputs.set(event.index, "")
          }
        } else if (event.type === "content_block_delta") {
          expect(openIndex).toBe(event.index)
          if (event.delta.type === "input_json_delta") {
            inputs.set(
              event.index,
              inputs.get(event.index)! + event.delta.partial_json,
            )
          }
        } else if (event.type === "content_block_stop") {
          expect(openIndex).toBe(event.index)
          openIndex = undefined
        }
      }
      expect(openIndex).toBeUndefined()
      expect(names).toEqual(["get_weather", "get_time", "search"])
      expect(
        [...inputs.values()].map(
          (input) => JSON.parse(input || "{}") as unknown,
        ),
      ).toEqual([{ city: "Paris" }, { zone: "UTC" }, {}])
      expect(events.at(-1)?.type).toBe("message_stop")
    },
  )

  test("emits text before a tool call when both start in the same chunk", () => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      messageCompleted: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
    }
    const chunks: Array<ChatCompletionChunk> = [
      {
        id: "chatcmpl-be6d5639-41fd-44c4-9a16-d8c4ce48ded9",
        object: "chat.completion.chunk",
        created: 1790258959,
        model: "deepseek-v4.1-flash",
        choices: [
          {
            index: 0,
            delta: {
              content: "）**",
              tool_calls: [
                {
                  id: "call_1f4a0f06a6d4487da8350d28",
                  type: "function",
                  index: 0,
                  function: { name: "read", arguments: "" },
                },
              ],
              reasoning_content: "",
            },
            logprobs: null,
            finish_reason: null,
          },
        ],
        usage: null,
      },
      {
        id: "chatcmpl-be6d5639-41fd-44c4-9a16-d8c4ce48ded9",
        object: "chat.completion.chunk",
        created: 1790258959,
        model: "deepseek-v4.1-flash",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: "{}" } }],
            },
            logprobs: null,
            finish_reason: null,
          },
        ],
        usage: null,
      },
      {
        id: "chatcmpl-be6d5639-41fd-44c4-9a16-d8c4ce48ded9",
        object: "chat.completion.chunk",
        created: 1790258959,
        model: "deepseek-v4.1-flash",
        choices: [
          {
            index: 0,
            delta: {},
            logprobs: null,
            finish_reason: "tool_calls",
          },
        ],
        usage: null,
      },
    ]

    const translatedStream = chunks.flatMap((chunk) =>
      translateChunkToAnthropicEvents(chunk, streamState),
    )
    translatedStream.push(...flushPendingAnthropicStreamEvents(streamState))

    expect(translatedStream).toEqual([
      {
        type: "message_start",
        message: {
          id: "chatcmpl-be6d5639-41fd-44c4-9a16-d8c4ce48ded9",
          type: "message",
          role: "assistant",
          content: [],
          model: "deepseek-v4.1-flash",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "）**" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "call_1f4a0f06a6d4487da8350d28",
          name: "read",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: "{}" },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      { type: "message_stop" },
    ])
  })

  test("should defer content while a tool call is still streaming", () => {
    const openAIStream: Array<ChatCompletionChunk> = [
      {
        id: "cmpl-tool-content",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: { role: "assistant" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-tool-content",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_weather",
                  type: "function",
                  function: { name: "get_weather", arguments: "" },
                },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-tool-content",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"loc' } }],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-tool-content",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: { content: "I will check that." },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-tool-content",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: 'ation": "Paris"}' } },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-tool-content",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          { index: 0, delta: {}, finish_reason: "tool_calls", logprobs: null },
        ],
      },
    ]

    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      messageCompleted: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
    }
    const translatedStream = openAIStream.flatMap((chunk) =>
      translateChunkToAnthropicEvents(chunk, streamState),
    )

    const lateToolDeltaIndex = translatedStream.findIndex(
      (event) =>
        event.type === "content_block_delta"
        && event.index === 0
        && event.delta.type === "input_json_delta"
        && event.delta.partial_json === 'ation": "Paris"}',
    )
    const toolStopIndex = translatedStream.findIndex(
      (event) => event.type === "content_block_stop" && event.index === 0,
    )
    const deferredTextStartIndex = translatedStream.findIndex(
      (event) =>
        event.type === "content_block_start"
        && event.index === 1
        && event.content_block.type === "text",
    )

    expect(lateToolDeltaIndex).toBeGreaterThan(-1)
    expect(toolStopIndex).toBeGreaterThan(lateToolDeltaIndex)
    expect(deferredTextStartIndex).toBeGreaterThan(toolStopIndex)
    expect(translatedStream).toContainEqual({
      type: "content_block_delta",
      index: 1,
      delta: {
        type: "text_delta",
        text: "I will check that.",
      },
    })
  })
})

describe("OpenAI usage-only stream translation", () => {
  test("should emit final Anthropic usage from an OpenAI usage-only chunk", () => {
    const openAIStream: Array<ChatCompletionChunk> = [
      {
        id: "cmpl-usage",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "qwen-plus",
        choices: [
          {
            index: 0,
            delta: { role: "assistant" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-usage",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "qwen-plus",
        choices: [
          {
            index: 0,
            delta: { content: "Hello" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-usage",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "qwen-plus",
        choices: [
          { index: 0, delta: {}, finish_reason: "stop", logprobs: null },
        ],
      },
      {
        id: "cmpl-usage",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "qwen-plus",
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_tokens_details: {
            cache_creation_input_tokens: 3,
            cached_tokens: 12,
          },
        },
      },
    ]

    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      messageCompleted: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
    }
    const translatedStream = openAIStream.flatMap((chunk) =>
      translateChunkToAnthropicEvents(chunk, streamState),
    )
    translatedStream.push(...flushPendingAnthropicStreamEvents(streamState))

    const messageDeltaEvents = translatedStream.filter(
      (event) => event.type === "message_delta",
    )
    expect(messageDeltaEvents).toHaveLength(1)
    expect(messageDeltaEvents[0]).toEqual({
      type: "message_delta",
      delta: {
        stop_reason: "end_turn",
        stop_sequence: null,
      },
      usage: {
        input_tokens: 85,
        output_tokens: 20,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 12,
      },
    })
    expect(translatedStream.at(-1)).toEqual({ type: "message_stop" })
  })

  test("should not complete message on empty-choices metadata chunk without usage", () => {
    const openAIStream: Array<ChatCompletionChunk> = [
      {
        id: "cmpl-metadata",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "kimi-k3",
        choices: [
          {
            index: 0,
            delta: { role: "assistant" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-metadata",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "kimi-k3",
        choices: [
          {
            index: 0,
            delta: { content: "Hello" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-metadata",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "kimi-k3",
        choices: [
          { index: 0, delta: {}, finish_reason: "stop", logprobs: null },
        ],
      },
      // Metadata-only event (e.g. inference cost) arriving before the
      // final usage chunk. It must not complete the pending message.
      {
        id: "cmpl-metadata",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "kimi-k3",
        choices: [],
      },
      {
        id: "cmpl-metadata",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "kimi-k3",
        choices: [],
        usage: {
          prompt_tokens: 8544,
          completion_tokens: 174,
          total_tokens: 8718,
        },
      },
    ]

    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      messageCompleted: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
    }
    const translatedStream: Array<unknown> = []
    const metadataChunkEvents: Array<unknown> = []
    for (const [index, chunk] of openAIStream.entries()) {
      const events = translateChunkToAnthropicEvents(chunk, streamState)
      if (index === 3) {
        metadataChunkEvents.push(...events)
      }
      translatedStream.push(...events)
    }
    translatedStream.push(...flushPendingAnthropicStreamEvents(streamState))

    // The metadata-only chunk must not emit any event.
    expect(metadataChunkEvents).toHaveLength(0)

    const messageDeltaEvents = translatedStream.filter(
      (event) => (event as { type: string }).type === "message_delta",
    )
    expect(messageDeltaEvents).toHaveLength(1)
    expect(messageDeltaEvents[0]).toEqual({
      type: "message_delta",
      delta: {
        stop_reason: "end_turn",
        stop_sequence: null,
      },
      usage: {
        input_tokens: 8544,
        output_tokens: 174,
      },
    })
    expect(translatedStream.at(-1)).toEqual({ type: "message_stop" })
  })

  test("should complete pending message at flush when no usage chunk arrives", () => {
    const openAIStream: Array<ChatCompletionChunk> = [
      {
        id: "cmpl-no-usage",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "kimi-k3",
        choices: [
          {
            index: 0,
            delta: { role: "assistant" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-no-usage",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "kimi-k3",
        choices: [
          { index: 0, delta: {}, finish_reason: "stop", logprobs: null },
        ],
      },
      // Metadata-only event without usage; stream ends afterwards.
      {
        id: "cmpl-no-usage",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "kimi-k3",
        choices: [],
      },
    ]

    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      messageCompleted: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
    }
    const translatedStream = openAIStream.flatMap((chunk) =>
      translateChunkToAnthropicEvents(chunk, streamState),
    )
    translatedStream.push(...flushPendingAnthropicStreamEvents(streamState))

    const messageDeltaEvents = translatedStream.filter(
      (event) => event.type === "message_delta",
    )
    expect(messageDeltaEvents).toHaveLength(1)
    expect(messageDeltaEvents[0]).toEqual({
      type: "message_delta",
      delta: {
        stop_reason: "end_turn",
        stop_sequence: null,
      },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
    })
    expect(translatedStream.at(-1)).toEqual({ type: "message_stop" })
  })

  test("should mark the stream completed after finish_reason and flush", () => {
    const openAIStream: Array<ChatCompletionChunk> = [
      {
        id: "cmpl-complete",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "kimi-k3",
        choices: [
          {
            index: 0,
            delta: { content: "hi" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-complete",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "kimi-k3",
        choices: [
          { index: 0, delta: {}, finish_reason: "stop", logprobs: null },
        ],
        usage: {
          prompt_tokens: 3,
          completion_tokens: 1,
          total_tokens: 4,
        },
      },
    ]

    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      messageCompleted: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
    }
    const translatedStream = openAIStream.flatMap((chunk) =>
      translateChunkToAnthropicEvents(chunk, streamState),
    )
    translatedStream.push(...flushPendingAnthropicStreamEvents(streamState))

    expect(streamState.messageCompleted).toBe(true)
    expect(translatedStream.at(-1)).toEqual({ type: "message_stop" })
  })

  test("should keep the stream incomplete when interrupted during thinking output", () => {
    const openAIStream: Array<ChatCompletionChunk> = [
      {
        id: "cmpl-thinking-cut",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "kimi-k3",
        choices: [
          {
            index: 0,
            delta: { reasoning_text: "partial thought" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      // The stream ends here: no finish_reason and no usage chunk arrive.
    ]

    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      messageCompleted: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
    }
    const translatedStream = openAIStream.flatMap((chunk) =>
      translateChunkToAnthropicEvents(chunk, streamState),
    )
    const flushedEvents = flushPendingAnthropicStreamEvents(streamState)

    // The thinking block was opened but the stream never finished.
    expect(streamState.thinkingBlockOpen).toBe(true)
    expect(streamState.messageCompleted).toBe(false)
    expect(flushedEvents).toHaveLength(0)
    expect(
      translatedStream.some((event) => event.type === "message_stop"),
    ).toBe(false)
  })
})
