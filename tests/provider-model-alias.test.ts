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
  // Regression guard for namespaced model ids returned by the GitHub Copilot
  // gateway for enterprise accounts. The gateway lists enterprise-configured
  // models with the account handle as a prefix, e.g. "contoso/glm-5.2" or a
  // deeper org-scoped "contoso/family/glm-5.2". parseProviderModelAlias
  // previously treated the first segment ("contoso") as a custom provider
  // alias prefix, but no "contoso" entry exists in config.providers, so the
  // request was misrouted to the provider path and surfaced as a 400/404.
  // These ids must fall through to the default model lookup (Copilot
  // upstream) and be sent as-is, exactly like a plain model id.
  test("does not route a namespaced /v1/messages id to the provider path", async () => {
    // Single-segment namespacing: "contoso/glm-5.2".
    const app = createApp()
    const response = await app.request("/v1/messages", {
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ content: "hello", role: "user" }],
        model: "contoso/glm-5.2",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    // Negative: the request was never sent to the configured "dash" provider
    // and the provider 400 wording is absent (it reached the default flow,
    // which errors out upstream without a Copilot token, not at the provider).
    expect(fetchMock).not.toHaveBeenCalled()
    const body = (await response.json()) as { error?: { message?: string } }
    expect(body.error?.message).not.toContain("does not support")
  })

  test("does not route a namespaced /v1/messages/count_tokens id to the provider path and reaches the estimation fallback", async () => {
    // Multi-segment namespacing: "contoso/family/glm-5.2". count_tokens is
    // called as a preflight by clients like Claude Code; it must not 404 on
    // a namespaced id while the main /v1/messages flow works.
    const app = createApp()
    const response = await app.request("/v1/messages/count_tokens", {
      body: JSON.stringify({
        max_tokens: 128,
        messages: [{ content: "hello", role: "user" }],
        model: "contoso/family/glm-5.2",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(getTokenCount).toHaveBeenCalledTimes(1)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ input_tokens: 42 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("still routes a configured provider alias on /v1/messages/count_tokens to the provider path", async () => {
    // Regression guard for the happy path: a real provider alias must still
    // be routed to the provider token counter (not fall through).
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
    expect(getTokenCount).toHaveBeenCalledTimes(1)
    const [, selectedModel] = getTokenCount.mock.calls[0] as [
      TokenCountPayload,
      TokenCountModel,
    ]
    expect(selectedModel.id).toBe("qwen-plus")
  })
})
