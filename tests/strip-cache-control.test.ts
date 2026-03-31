import { describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { stripCacheControl } from "~/routes/messages/utils"

describe("stripCacheControl", () => {
  test("strips unsupported cache_control fields from system and message text blocks", () => {
    const payload = {
      model: "claude-sonnet-4-20250514",
      max_tokens: 128,
      system: [
        {
          type: "text",
          text: "system",
          cache_control: {
            type: "ephemeral",
            scope: "system",
            extra: "drop-me",
          },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "user",
              cache_control: {
                type: "ephemeral",
                scope: "message",
              },
            },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "assistant",
              cache_control: {
                type: "ephemeral",
                scope: "assistant",
                extra: "drop-me",
              },
            },
          ],
        },
      ],
    } as unknown as AnthropicMessagesPayload

    stripCacheControl(payload)

    expect(payload.system).toEqual([
      {
        type: "text",
        text: "system",
        cache_control: {
          type: "ephemeral",
        },
      },
    ])
    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: "user",
          cache_control: {
            type: "ephemeral",
          },
        },
      ],
    })
    expect(payload.messages[1]).toEqual({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "assistant",
          cache_control: {
            type: "ephemeral",
          },
        },
      ],
    })
  })

  test("strips nested tool_result text blocks and removes malformed cache_control", () => {
    const payload = {
      model: "claude-sonnet-4-20250514",
      max_tokens: 128,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_1",
              content: [
                {
                  type: "text",
                  text: "nested",
                  cache_control: {
                    scope: "message",
                  },
                },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: "abcd",
                  },
                },
              ],
            },
          ],
        },
      ],
    } as unknown as AnthropicMessagesPayload

    stripCacheControl(payload)

    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool_1",
          content: [
            {
              type: "text",
              text: "nested",
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "abcd",
              },
            },
          ],
        },
      ],
    })
  })
})
