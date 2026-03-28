import { describe, expect, test } from "bun:test"

import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { isCompactRequest } from "~/routes/messages/utils"

describe("isCompactRequest", () => {
  const compactSystemPrefix =
    "You are a helpful AI assistant tasked with summarizing conversations"
  const compactUserPrefix =
    "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools."

  test("detects legacy compact via system string", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 4096,
      system: `${compactSystemPrefix} between a user and an AI assistant.`,
    }
    expect(isCompactRequest(payload)).toBe(true)
  })

  test("detects legacy compact via system array", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 4096,
      system: [
        { type: "text", text: "some preamble" },
        {
          type: "text",
          text: `${compactSystemPrefix} between a user and an AI assistant.`,
        },
      ],
    }
    expect(isCompactRequest(payload)).toBe(true)
  })

  test("detects new compact via last user message string content", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "user", content: "first message" },
        { role: "assistant", content: "ok" },
        {
          role: "user",
          content: `${compactUserPrefix}\n\nSummarize the conversation so far.`,
        },
      ],
      max_tokens: 4096,
    }
    expect(isCompactRequest(payload)).toBe(true)
  })

  test("detects new compact via last user message content array", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "user", content: "first message" },
        { role: "assistant", content: "ok" },
        {
          role: "user",
          content: [
            { type: "text", text: "some context" },
            {
              type: "text",
              text: `${compactUserPrefix}\n\nSummarize the conversation so far.`,
            },
          ],
        },
      ],
      max_tokens: 4096,
    }
    expect(isCompactRequest(payload)).toBe(true)
  })

  test("returns false for normal user message", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "user", content: "Write a function that adds two numbers" },
      ],
      max_tokens: 4096,
    }
    expect(isCompactRequest(payload)).toBe(false)
  })

  test("returns false when last message is assistant", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ],
      max_tokens: 4096,
    }
    expect(isCompactRequest(payload)).toBe(false)
  })

  test("returns false when messages array is empty", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4-20250514",
      messages: [],
      max_tokens: 4096,
    }
    expect(isCompactRequest(payload)).toBe(false)
  })
})
