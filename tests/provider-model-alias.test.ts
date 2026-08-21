import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { ResolvedProviderConfig } from "~/lib/config"

const actualConfigModule = await import("~/lib/config")
const actualTokenUsageModule = await import("~/lib/token-usage")

let providerConfig: ResolvedProviderConfig | null = null
let modelMappings: Record<string, string> = {}

interface TokenCountPayload {
  model: string
}

interface TokenCountModel {
  capabilities: {
    tokenizer: string
  }
  id: string
}

const getTokenCount = mock(
  (_payload: TokenCountPayload, _model: TokenCountModel) =>
    Promise.resolve({ input: 40, output: 2 }),
)
const noopTokenUsageRecorder = () => {}

await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  getProviderConfig: (name: string) =>
    providerConfig && name === providerConfig.name ? providerConfig : null,
  getRawProviderConfig: (name: string) =>
    providerConfig && name === providerConfig.name ? providerConfig : null,
  resolveMappedModel: (model: string) => modelMappings[model] ?? model,
}))

await mock.module("~/lib/tokenizer", () => ({
  getTokenCount,
}))

await mock.module("~/lib/token-usage", () => ({
  ...actualTokenUsageModule,
  createProviderTokenUsageRecorder: () => noopTokenUsageRecorder,
}))

const { messageRoutes } = await import("~/routes/messages/route")
const { resolveCountTokensModel } = await import(
  "~/routes/messages/count-tokens-handler"
)

const originalFetch = globalThis.fetch

const fetchMock = mock((_url: string | URL | Request, _init?: RequestInit) =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            index: 0,
            logprobs: null,
            message: {
              content: "answer text",
              role: "assistant",
            },
          },
        ],
        created: 0,
        id: "chatcmpl-test",
        model: "qwen-plus",
        object: "chat.completion",
        usage: {
          completion_tokens: 2,
          prompt_tokens: 8,
          total_tokens: 10,
        },
      }),
      {
        headers: {
          "content-type": "application/json",
        },
      },
    ),
  ),
)

const createApp = () => {
  const app = new Hono()
  app.route("/v1/messages", messageRoutes)
  return app
}

beforeEach(() => {
  providerConfig = {
    apiKey: "provider-key",
    authType: "authorization",
    baseUrl: "https://dashscope.example/compatible-mode",
    models: {
      "qwen-plus": {
        temperature: 0.2,
        toolContentSupportType: [],
      },
    },
    name: "dash",
    type: "openai-compatible",
  }

  modelMappings = {}
  fetchMock.mockClear()
  getTokenCount.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  providerConfig = null
})

describe("provider/model aliases on top-level messages routes", () => {
  test("routes mapped /v1/messages models to the provider before rate limiting", async () => {
    modelMappings = {
      "claude-opus-4-7": "dash/qwen-plus",
    }

    const app = createApp()
    const response = await app.request("/v1/messages", {
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ content: "hello", role: "user" }],
        model: "claude-opus-4-7",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(
      "https://dashscope.example/compatible-mode/v1/chat/completions",
    )

    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      model: string
    }
    expect(upstreamBody.model).toBe("qwen-plus")
  })

  test("routes /v1/messages to the provider and strips the provider prefix", async () => {
    const app = createApp()
    const response = await app.request("/v1/messages", {
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ content: "hello", role: "user" }],
        model: "dash/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(
      "https://dashscope.example/compatible-mode/v1/chat/completions",
    )

    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      model: string
    }
    expect(upstreamBody.model).toBe("qwen-plus")

    const json = (await response.json()) as { model: string }
    expect(json.model).toBe("qwen-plus")
  })

  test("routes /v1/messages/count_tokens to provider token counting with the stripped model", async () => {
    const app = createApp()
    const response = await app.request("/v1/messages/count_tokens", {
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ content: "hello", role: "user" }],
        model: "dash/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      input_tokens: 42,
    })
    expect(getTokenCount).toHaveBeenCalledTimes(1)

    const [openAIPayload, selectedModel] = getTokenCount.mock.calls[0] as [
      TokenCountPayload,
      TokenCountModel,
    ]
    expect(openAIPayload.model).toBe("qwen-plus")
    expect(selectedModel.id).toBe("qwen-plus")
    expect(selectedModel.capabilities.tokenizer).toBe("o200k_base")
  })

  test("routes mapped /v1/messages/count_tokens models to provider token counting", async () => {
    modelMappings = {
      "claude-opus-4-7": "dash/qwen-plus",
    }

    const app = createApp()
    const response = await app.request("/v1/messages/count_tokens", {
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ content: "hello", role: "user" }],
        model: "claude-opus-4-7",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      input_tokens: 42,
    })
    expect(getTokenCount).toHaveBeenCalledTimes(1)

    const [openAIPayload, selectedModel] = getTokenCount.mock.calls[0] as [
      TokenCountPayload,
      TokenCountModel,
    ]
    expect(openAIPayload.model).toBe("qwen-plus")
    expect(selectedModel.id).toBe("qwen-plus")
    expect(selectedModel.capabilities.tokenizer).toBe("o200k_base")
  })

  test("resolves missing top-level count_tokens models to the o200k_base fallback model", () => {
    const resolved = resolveCountTokensModel("missing-model", () => undefined)

    expect(resolved.fallback).toBe(true)
    expect(resolved.model.id).toBe("missing-model")
    expect(resolved.model.capabilities.tokenizer).toBe("o200k_base")
  })

  test("does not return a fake count when provider token counting fails", async () => {
    getTokenCount.mockImplementationOnce(
      (_payload: TokenCountPayload, _model: TokenCountModel) =>
        Promise.reject(new Error("tokenizer failed")),
    )

    const app = createApp()
    const response = await app.request("/v1/messages/count_tokens", {
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ content: "hello", role: "user" }],
        model: "dash/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: {
        message: "tokenizer failed",
        type: "error",
      },
    })
  })
})

describe("namespaced model ids fall through to the default lookup", () => {
  test("does not route a namespaced id with an unconfigured prefix to the provider path", async () => {
    // Models such as "org/family/model" must not be misrouted to a
    // non-existent provider and surfaced as a 400. They should fall through to
    // the default model lookup just like a plain model id.
    const app = createApp()
    const response = await app.request("/v1/messages", {
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ content: "hello", role: "user" }],
        model: "org/family/model",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    // The request must not be misrouted to the configured "dash" provider:
    // either no fetch happens, or fetch is called against a non-provider URL,
    // and the error wording is never the provider 400 from
    // handleProviderMessagesForProvider.
    if (fetchMock.mock.calls.length > 0) {
      const [url] = fetchMock.mock.calls[0] as [string]
      expect(url).not.toContain("dashscope.example")
    }
    const body = (await response.json()) as { error?: { message?: string } }
    expect(body.error?.message).not.toContain("does not support")
  })
})
