import { describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { isWarmupProbeRequest } from "~/routes/messages/utils"

describe("isWarmupProbeRequest", () => {
  test("detects Claude Code hello warmup probe", () => {
    const payload: AnthropicMessagesPayload = {
      model: "copilot/gpt-5.2",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "<system-reminder>SessionStart:startup hook success: Success</system-reminder>",
            },
            {
              type: "text",
              text: "hello",
              cache_control: {
                type: "ephemeral",
              },
            },
          ],
        },
      ],
      max_tokens: 1,
    }

    expect(isWarmupProbeRequest(payload)).toBe(true)
  })
})
