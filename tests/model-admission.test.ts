import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import {
  isAllowedModel,
  MODEL_NOT_ALLOWED_ERROR,
  normalizeModelIdForAdmission,
} from "~/lib/model-admission"
import { alphaSearchRoutes } from "~/routes/alpha-search/route"
import { completionRoutes } from "~/routes/chat-completions/route"
import { embeddingRoutes } from "~/routes/embeddings/route"
import { imageRoutes } from "~/routes/images/route"
import { messageRoutes } from "~/routes/messages/route"
import { responsesRoutes } from "~/routes/responses/route"

const createApp = (): Hono => {
  const app = new Hono()
  app.route("/v1/alpha/search", alphaSearchRoutes)
  app.route("/v1/chat/completions", completionRoutes)
  app.route("/v1/embeddings", embeddingRoutes)
  app.route("/v1/images", imageRoutes)
  app.route("/v1/messages", messageRoutes)
  app.route("/v1/responses", responsesRoutes)
  return app
}

const expectModelNotAllowed = async (response: Response): Promise<void> => {
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: MODEL_NOT_ALLOWED_ERROR })
}

describe("model admission policy", () => {
  test("allows OpenAI and Microsoft MAI model families", () => {
    for (const model of [
      "gpt-5.6-luna",
      "GPT-5.4",
      "codex-mini-latest",
      "o3",
      "o4-mini",
      "openai/gpt-5.4",
      "gpt-image-1",
      "text-embedding-3-large",
      "MAI-1-preview",
      "microsoft/mai-ds-r1",
    ]) {
      expect(isAllowedModel(model)).toBe(true)
    }
  })

  test("rejects Claude and other unsupported families after normalization", () => {
    for (const model of [
      "claude-sonnet-4.6",
      " CLAUDE-OPUS-4-1 ",
      "provider/anthropic/claude-haiku-4.5",
      "ｃｌａｕｄｅ-sonnet-4",
      "gemini-3-pro",
      "grok-4.5",
      "qwen3-coder",
      "deepseek-v4",
      "",
    ]) {
      expect(isAllowedModel(model)).toBe(false)
    }
    expect(normalizeModelIdForAdmission(" ＣＬＡＵＤＥ-OPUS-4 ")).toBe(
      "claude-opus-4",
    )
  })

  test("rejects disallowed Responses fallback models", async () => {
    const response = await createApp().request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4",
        models: ["gpt-5.4", "claude-sonnet-4"],
        input: "hello",
      }),
    })

    await expectModelNotAllowed(response)
  })

  test("returns the same client error from every JSON request protocol", async () => {
    const app = createApp()
    const requests = [
      ["/v1/chat/completions", { model: "claude-sonnet-4", messages: [] }],
      ["/v1/responses", { model: "Claude-Opus-4", input: "hello" }],
      [
        "/v1/messages",
        {
          model: " claude-haiku-4 ",
          max_tokens: 128,
          messages: [{ role: "user", content: "hello" }],
        },
      ],
      [
        "/v1/messages/count_tokens",
        {
          model: "openrouter/anthropic/CLAUDE-sonnet-4",
          max_tokens: 128,
          messages: [{ role: "user", content: "hello" }],
        },
      ],
      ["/v1/embeddings", { model: "claude-embedding", input: "hello" }],
      [
        "/v1/images/generations",
        { model: "provider/claude-image", prompt: "hello" },
      ],
      [
        "/v1/alpha/search",
        { model: "CLAUDE-search", id: "search-1", commands: {} },
      ],
    ] as const

    for (const [path, body] of requests) {
      await expectModelNotAllowed(
        await app.request(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      )
    }
  })
})
