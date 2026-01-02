import { describe, expect, test } from "bun:test"

import type { ChatCompletionChunk } from "~/services/copilot/create-chat-completions"

import { type AnthropicStreamState } from "~/routes/messages/anthropic-types"
import { translateChunkToAnthropicEvents } from "~/routes/messages/stream-translation"

describe("reasoning_opaque with thinkingBlockOpen check", () => {
  test("should handle reasoning_opaque with empty content when thinking block is open", () => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
    }

    // First chunk: start thinking
    const chunk1: ChatCompletionChunk = {
      id: "test-1",
      object: "chat.completion.chunk",
      created: 1677652288,
      model: "claude-3-5-sonnet-20241022",
      choices: [
        {
          index: 0,
          delta: { reasoning_text: "Let me think..." },
          finish_reason: null,
          logprobs: null,
        },
      ],
    }

    const events1 = translateChunkToAnthropicEvents(chunk1, streamState)
    expect(streamState.thinkingBlockOpen).toBe(true)
    expect(events1.length).toBeGreaterThan(0)
    expect(events1[0].type).toBe("message_start")
    expect(events1[1].type).toBe("content_block_start")

    // Second chunk: close thinking with reasoning_opaque
    const chunk2: ChatCompletionChunk = {
      id: "test-1",
      object: "chat.completion.chunk",
      created: 1677652288,
      model: "claude-3-5-sonnet-20241022",
      choices: [
        {
          index: 0,
          delta: {
            content: "",
            reasoning_opaque: "signature_data_here",
          },
          finish_reason: null,
          logprobs: null,
        },
      ],
    }

    const events2 = translateChunkToAnthropicEvents(chunk2, streamState)
    expect(streamState.thinkingBlockOpen).toBe(false)
    expect(events2.some((e) => e.type === "content_block_stop")).toBe(true)
  })

  test("should NOT process reasoning_opaque with empty content when thinking block is NOT open", () => {
    const streamState: AnthropicStreamState = {
      messageStartSent: true,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false, // Key: thinking block is NOT open
    }

    // Chunk with reasoning_opaque but no open thinking block
    const chunk: ChatCompletionChunk = {
      id: "test-1",
      object: "chat.completion.chunk",
      created: 1677652288,
      model: "claude-3-5-sonnet-20241022",
      choices: [
        {
          index: 0,
          delta: {
            content: "",
            reasoning_opaque: "orphan_signature",
          },
          finish_reason: null,
          logprobs: null,
        },
      ],
    }

    const events = translateChunkToAnthropicEvents(chunk, streamState)
    // Should not generate any events since thinkingBlockOpen is false
    expect(events.length).toBe(0)
    expect(streamState.thinkingBlockOpen).toBe(false)
  })
})

describe("reasoning_text to content conversion workaround", () => {
  test("should convert reasoning_text to content when contentBlockOpen is true", () => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
    }

    // First: open a content block with regular content
    const chunk1: ChatCompletionChunk = {
      id: "test-1",
      object: "chat.completion.chunk",
      created: 1677652288,
      model: "claude-3-5-sonnet-20241022",
      choices: [
        {
          index: 0,
          delta: { content: "Hello" },
          finish_reason: null,
          logprobs: null,
        },
      ],
    }

    translateChunkToAnthropicEvents(chunk1, streamState)
    expect(streamState.contentBlockOpen).toBe(true)

    // Second: receive reasoning_text while content block is open
    // This should be converted to content
    const chunk2: ChatCompletionChunk = {
      id: "test-1",
      object: "chat.completion.chunk",
      created: 1677652288,
      model: "claude-3-5-sonnet-20241022",
      choices: [
        {
          index: 0,
          delta: { reasoning_text: " world" },
          finish_reason: null,
          logprobs: null,
        },
      ],
    }

    const events2 = translateChunkToAnthropicEvents(chunk2, streamState)
    // Should be processed as text_delta, not thinking_delta
    const textDelta = events2.find(
      (e) =>
        e.type === "content_block_delta"
        && "delta" in e
        && e.delta.type === "text_delta",
    )
    expect(textDelta).toBeDefined()
    if (
      textDelta
      && "delta" in textDelta
      && textDelta.delta.type === "text_delta"
    ) {
      expect(textDelta.delta.text).toBe(" world")
    }
    // Thinking block should not be opened
    expect(streamState.thinkingBlockOpen).toBe(false)
  })

  test("should handle normal reasoning_text flow when contentBlockOpen is false", () => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
    }

    // Receive reasoning_text when no content block is open
    const chunk: ChatCompletionChunk = {
      id: "test-1",
      object: "chat.completion.chunk",
      created: 1677652288,
      model: "claude-3-5-sonnet-20241022",
      choices: [
        {
          index: 0,
          delta: { reasoning_text: "Let me analyze..." },
          finish_reason: null,
          logprobs: null,
        },
      ],
    }

    const events = translateChunkToAnthropicEvents(chunk, streamState)
    expect(streamState.thinkingBlockOpen).toBe(true)
    expect(streamState.contentBlockOpen).toBe(false)
    const thinkingStart = events.find((e) => e.type === "content_block_start")
    expect(thinkingStart).toBeDefined()
    if (thinkingStart && "content_block" in thinkingStart) {
      expect(thinkingStart.content_block.type).toBe("thinking")
    }
  })
})

describe("Complex sequence: content -> reasoning_text -> reasoning_opaque", () => {
  test("should handle abnormal sequence gracefully", () => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
    }

    // Step 1: Regular content
    const chunk1: ChatCompletionChunk = {
      id: "test-1",
      object: "chat.completion.chunk",
      created: 1677652288,
      model: "claude-3-5-sonnet-20241022",
      choices: [
        {
          index: 0,
          delta: { content: "Here is my answer: " },
          finish_reason: null,
          logprobs: null,
        },
      ],
    }
    translateChunkToAnthropicEvents(chunk1, streamState)
    expect(streamState.contentBlockOpen).toBe(true)
    expect(streamState.thinkingBlockOpen).toBe(false)

    // Step 2: reasoning_text arrives while content block is open (abnormal!)
    const chunk2: ChatCompletionChunk = {
      id: "test-1",
      object: "chat.completion.chunk",
      created: 1677652288,
      model: "claude-3-5-sonnet-20241022",
      choices: [
        {
          index: 0,
          delta: { reasoning_text: "42" },
          finish_reason: null,
          logprobs: null,
        },
      ],
    }
    translateChunkToAnthropicEvents(chunk2, streamState)
    // Should be converted to content and appended to existing content block
    expect(streamState.contentBlockOpen).toBe(true)
    expect(streamState.thinkingBlockOpen).toBe(false)

    // Step 3: reasoning_opaque arrives
    const chunk3: ChatCompletionChunk = {
      id: "test-1",
      object: "chat.completion.chunk",
      created: 1677652288,
      model: "claude-3-5-sonnet-20241022",
      choices: [
        {
          index: 0,
          delta: {
            content: "",
            reasoning_opaque: "some_signature",
          },
          finish_reason: null,
          logprobs: null,
        },
      ],
    }
    const events3 = translateChunkToAnthropicEvents(chunk3, streamState)
    // Should not process since thinkingBlockOpen is false
    expect(events3.length).toBe(0)
  })
})

describe("Tool block interactions", () => {
  test("should convert reasoning_text to content when tool block is open", () => {
    const streamState: AnthropicStreamState = {
      messageStartSent: true,
      contentBlockIndex: 0,
      contentBlockOpen: true, // Tool block is open
      toolCalls: {
        0: {
          id: "call_123",
          name: "test_tool",
          anthropicBlockIndex: 0,
        },
      },
      thinkingBlockOpen: false,
    }

    // reasoning_text arrives while tool block is open
    const chunk: ChatCompletionChunk = {
      id: "test-1",
      object: "chat.completion.chunk",
      created: 1677652288,
      model: "claude-3-5-sonnet-20241022",
      choices: [
        {
          index: 0,
          delta: { reasoning_text: "Some thinking" },
          finish_reason: null,
          logprobs: null,
        },
      ],
    }

    const events = translateChunkToAnthropicEvents(chunk, streamState)
    // Should convert to content since contentBlockOpen is true
    // This will be handled as text which should close the tool block first
    expect(events.some((e) => e.type === "content_block_stop")).toBe(true)
  })
})
