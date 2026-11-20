import { describe, expect, test } from "bun:test"

import { applyOpenAICompatibleContextCache } from "~/lib/providers/dashscope"
import type { Message } from "~/lib/types/chat-completions"

const buildPayload = (model: string) => ({
  model,
  messages: [
    { content: "system prompt", role: "system" },
    { content: "hello", role: "user" },
  ] as Array<Message>,
})

const collectCacheControls = (messages: Array<Message>): Array<unknown> =>
  messages.flatMap((message) =>
    Array.isArray(message.content) ?
      message.content.flatMap((part) =>
        "cache_control" in part ? [part.cache_control] : [],
      )
    : [],
  )

describe("applyOpenAICompatibleContextCache model restriction", () => {
  test("applies cache_control for qwen models", () => {
    const payload = buildPayload("qwen-plus")
    applyOpenAICompatibleContextCache(payload)
    expect(collectCacheControls(payload.messages)).toEqual([
      { type: "ephemeral" },
      { type: "ephemeral" },
    ])
  })

  test("matches qwen case-insensitively", () => {
    const payload = buildPayload("Qwen3-Max")
    applyOpenAICompatibleContextCache(payload)
    expect(collectCacheControls(payload.messages)).toEqual([
      { type: "ephemeral" },
      { type: "ephemeral" },
    ])
  })

  test("skips cache_control for non-qwen models", () => {
    const payload = buildPayload("glm-5.2")
    applyOpenAICompatibleContextCache(payload)
    expect(collectCacheControls(payload.messages)).toEqual([])
    expect(payload.messages[0]?.content).toBe("system prompt")
  })

  test("skips cache_control for models with provider prefix", () => {
    const payload = buildPayload("dashscope/qwen-plus")
    applyOpenAICompatibleContextCache(payload)
    expect(collectCacheControls(payload.messages)).toEqual([])
    expect(payload.messages[0]?.content).toBe("system prompt")
  })
})
