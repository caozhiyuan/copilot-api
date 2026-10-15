import { describe, expect, test } from "bun:test"

import type {
  AnthropicAssistantContentBlock,
  AnthropicStreamEventData,
} from "~/lib/types/anthropic"
import { GoogleMessagesStreamTranslator } from "~/routes/messages/google-stream-translation"
import { translateAnthropicToGoogle } from "~/routes/messages/google-translation"

function collectContent(
  events: Array<AnthropicStreamEventData>,
): Array<AnthropicAssistantContentBlock> {
  const content: Array<AnthropicAssistantContentBlock> = []
  for (const event of events) {
    if (event.type === "content_block_start") {
      const block = event.content_block
      if (block.type === "text" || block.type === "tool_use")
        content[event.index] = { ...block }
      else if (block.type === "thinking")
        content[event.index] = { ...block, signature: "" }
    } else if (event.type === "content_block_delta") {
      const block = content[event.index]
      if (block.type === "text" && event.delta.type === "text_delta")
        block.text += event.delta.text
      if (block.type === "thinking" && event.delta.type === "thinking_delta")
        block.thinking += event.delta.thinking
      if (block.type === "thinking" && event.delta.type === "signature_delta")
        block.signature += event.delta.signature
      if (block.type === "tool_use" && event.delta.type === "input_json_delta")
        block.input = JSON.parse(event.delta.partial_json) as Record<
          string,
          unknown
        >
    }
  }
  return content
}

describe("Google SSE to Anthropic", () => {
  test("streams thinking, text and parallel tool calls while retaining all thought signatures", () => {
    const translator = new GoogleMessagesStreamTranslator("gemini-3.8-flash")
    const events = [
      ...translator.push({
        responseId: "google-id",
        candidates: [
          { content: { parts: [{ text: "Think ", thought: true }] } },
        ],
        usageMetadata: { promptTokenCount: 20 },
      }),
      ...translator.push({
        candidates: [{ content: { parts: [{ text: "more", thought: true }] } }],
      }),
      ...translator.push({
        candidates: [
          { content: { parts: [{ thoughtSignature: "thought-sig" }] } },
        ],
      }),
      ...translator.push({
        candidates: [{ content: { parts: [{ text: "hello " }] } }],
      }),
      ...translator.push({
        candidates: [{ content: { parts: [{ text: "world" }] } }],
      }),
      ...translator.push({
        candidates: [
          { content: { parts: [{ text: "", thoughtSignature: "text-sig" }] } },
        ],
      }),
      ...translator.push({
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    id: "call-a",
                    name: "read",
                    args: { path: "a" },
                  },
                  thoughtSignature: "tool-sig",
                },
                { functionCall: { name: "read" } },
              ],
            },
            finishReason: "STOP",
          },
        ],
      }),
      ...translator.push({
        usageMetadata: {
          cachedContentTokenCount: 4,
          candidatesTokenCount: 8,
          thoughtsTokenCount: 10,
        },
      }),
      ...translator.finish(),
    ]
    expect(
      events.filter((event) => event.type === "message_start"),
    ).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: "message_start",
      message: { id: "google-id", model: "gemini-3.8-flash" },
    })
    expect(events.at(-2)).toMatchObject({
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: {
        input_tokens: 16,
        cache_read_input_tokens: 4,
        output_tokens: 18,
      },
    })
    expect(events.at(-1)).toEqual({ type: "message_stop" })
    const content = collectContent(events)
    const restored = translateAnthropicToGoogle({
      model: "gemini-3.8-flash",
      max_tokens: 100,
      messages: [{ role: "assistant", content }],
    })
    expect(restored.contents[0].parts.slice(0, 3)).toEqual([
      { text: "Think more", thought: true, thoughtSignature: "thought-sig" },
      { text: "hello world", thoughtSignature: "text-sig" },
      {
        functionCall: { id: "call-a", name: "read", args: { path: "a" } },
        thoughtSignature: "tool-sig",
      },
    ])
    expect(restored.contents[0].parts[3].functionCall?.id).toStartWith("toolu_")
    const starts = events
      .filter((event) => event.type === "content_block_start")
      .map((event) => event.index)
    const stops = events
      .filter((event) => event.type === "content_block_stop")
      .map((event) => event.index)
    expect(stops).toEqual(starts)
    expect(starts).toEqual(starts.map((_, index) => index))
  })

  test("closes unsigned thinking blocks and completes length-limited text streams", () => {
    const translator = new GoogleMessagesStreamTranslator("gemini")
    const events = [
      ...translator.push({
        candidates: [
          {
            content: {
              parts: [{ text: "thought", thought: true }, { text: "answer" }],
            },
            finishReason: "MAX_TOKENS",
          },
        ],
      }),
      ...translator.finish(),
    ]
    expect(collectContent(events)).toEqual([
      { type: "thinking", thinking: "thought", signature: "" },
      { type: "text", text: "answer" },
    ])
    expect(events.at(-2)).toMatchObject({
      delta: { stop_reason: "max_tokens" },
    })
  })

  test("accepts empty signed thinking and prompt-blocked responses", () => {
    const translator = new GoogleMessagesStreamTranslator("gemini")
    const content = collectContent(
      translator.push({
        candidates: [
          {
            content: { parts: [{ thought: true, thoughtSignature: "sig" }] },
            finishReason: "STOP",
          },
        ],
      }),
    )
    expect(content[0]).toMatchObject({
      type: "thinking",
      thinking: "",
    })
    expect(content[0]).toHaveProperty(
      "signature",
      expect.stringMatching(/^google:/u),
    )
    expect(translator.finish().at(-2)).toMatchObject({
      delta: { stop_reason: "end_turn" },
    })
    const blocked = new GoogleMessagesStreamTranslator("gemini")
    blocked.push({ promptFeedback: { blockReason: "SAFETY" } })
    expect(blocked.finish().at(-2)).toMatchObject({
      delta: { stop_reason: "refusal" },
    })
  })

  test("does not report success for truncated or errored streams", () => {
    const translator = new GoogleMessagesStreamTranslator("gemini")
    translator.push({
      candidates: [{ content: { parts: [{ text: "partial" }] } }],
    })
    expect(() => translator.finish()).toThrow("missing")
    expect(() => translator.push({ error: { message: "overloaded" } })).toThrow(
      "overloaded",
    )
    expect(() => translator.push({ error: {} })).toThrow("Google stream failed")
  })
})
