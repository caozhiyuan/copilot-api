import { describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "../src/routes/messages/anthropic-types"

import {
  mergeToolResultForClaude,
  prepareMessagesApiPayload,
} from "../src/routes/messages/preprocess"

describe("mergeToolResultForClaude", () => {
  test("merges text blocks into matching tool_result blocks", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "Launching skill: foo",
            },
            {
              type: "text",
              text: "Follow-up details",
            },
          ],
        },
      ],
    }

    mergeToolResultForClaude(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "Launching skill: foo\n\nFollow-up details",
        },
      ],
    })
  })

  test("appends all text blocks to the last tool_result when counts differ", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-opus-4.6",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "first",
            },
            {
              type: "tool_result",
              tool_use_id: "tool-2",
              content: "second",
            },
            {
              type: "text",
              text: "extra one",
            },
            {
              type: "text",
              text: "extra two",
            },
            {
              type: "text",
              text: "extra three",
            },
          ],
        },
      ],
    }

    mergeToolResultForClaude(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "first",
        },
        {
          type: "tool_result",
          tool_use_id: "tool-2",
          content: "second\n\nextra one\n\nextra two\n\nextra three",
        },
      ],
    })
  })
})

describe("prepareMessagesApiPayload", () => {
  test("strips cache_control scope, filters thinking blocks, and enables adaptive thinking", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gpt-5.4",
      max_tokens: 128,
      system: [
        {
          type: "text",
          text: "system prompt",
          cache_control: {
            type: "ephemeral",
            scope: "user",
          },
        } as AnthropicMessagesPayload["system"] extends Array<infer T> ? T
        : never,
      ],
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "Thinking...",
              signature: "sig-1",
            },
            {
              type: "thinking",
              thinking: "Keep this",
              signature: "sig-2",
            },
            {
              type: "thinking",
              thinking: "Drop this too",
              signature: "bad@sig",
            },
            {
              type: "text",
              text: "Visible text",
            },
          ],
        },
        {
          role: "user",
          content: "hello",
        },
      ],
    }

    prepareMessagesApiPayload(payload, {
      capabilities: {
        supports: {
          adaptive_thinking: true,
        },
      },
    } as never)

    const systemBlock = (
      payload.system as unknown as Array<Record<string, unknown>>
    )[0]
    expect(systemBlock).toEqual({
      type: "text",
      text: "system prompt",
      cache_control: {
        type: "ephemeral",
      },
    })
    expect(payload.messages[0]).toEqual({
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "Keep this",
          signature: "sig-2",
        },
        {
          type: "text",
          text: "Visible text",
        },
      ],
    })
    expect(payload.thinking).toEqual({ type: "adaptive" })
    expect(payload.output_config).toEqual({ effort: "max" })
  })

  test("does not enable adaptive thinking when tool choice forces tool use", () => {
    const payload: AnthropicMessagesPayload = {
      model: "gpt-5.4",
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
      tool_choice: {
        type: "tool",
        name: "apply_patch",
      },
    }

    prepareMessagesApiPayload(payload, {
      capabilities: {
        supports: {
          adaptive_thinking: true,
        },
      },
    } as never)

    expect(payload.thinking).toBeUndefined()
    expect(payload.output_config).toBeUndefined()
  })
})
