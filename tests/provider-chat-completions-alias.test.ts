import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test"
import { Hono } from "hono"

import type { ResolvedProviderConfig } from "~/lib/config"
import { installModelsDevCatalog } from "~/lib/models-dev-cache"

import { modelsDevCatalogFixture } from "./fixtures/models-dev-catalog"

const actualConfigModule = await import("~/lib/config")
const actualTokenUsageModule = await import("~/lib/token-usage")

let providerConfig: ResolvedProviderConfig | null = null
let modelMappings: Record<string, string> = {}

const noopTokenUsageRecorder = () => {}
let restoreTokenUsageRecorder = () => {}

await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  getProviderConfig: () => providerConfig,
  resolveMappedModel: (model: string) => modelMappings[model] ?? model,
}))

const { completionRoutes } = await import("~/routes/chat-completions/route")

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
  app.route("/v1/chat/completions", completionRoutes)
  return app
}

beforeEach(() => {
  const recorder = spyOn(
    actualTokenUsageModule,
    "createProviderTokenUsageRecorder",
  ).mockImplementation(() => noopTokenUsageRecorder)
  restoreTokenUsageRecorder = () => recorder.mockRestore()
  providerConfig = {
    apiKey: "provider-key",
    authType: "authorization",
    baseUrl: "https://dashscope.example/compatible-mode",
    models: {
      "qwen-plus": {
        extraBody: {
          enable_thinking: true,
          preserve_thinking: true,
        },
        temperature: 0.2,
        topK: 50,
        topP: 0.8,
      },
    },
    name: "dash",
    type: "openai-compatible",
  }

  modelMappings = {}
  fetchMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  restoreTokenUsageRecorder()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  providerConfig = null
})

describe("provider/model aliases on top-level chat completions route", () => {
  test("forwards a selected models.dev model to its own API URL", async () => {
    installModelsDevCatalog({
      ...modelsDevCatalogFixture,
      example: {
        npm: "@ai-sdk/openai-compatible",
        api: "https://api.example.com/v1",
        models: {
          "qwen-plus": {
            id: "qwen-plus",
            provider: {
              api: "https://model.example.com/api/v4",
              npm: "@ai-sdk/openai-compatible",
            },
          },
        },
      },
    })
    providerConfig = {
      ...providerConfig!,
      baseUrl: "https://api.example.com/v1",
      modelsDevProviderId: "example",
    }

    const response = await createApp().request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: "hello", role: "user" }],
        model: "dash/qwen-plus",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://model.example.com/api/v4/chat/completions",
    )
  })

  test("routes mapped models to provider chat completions before rate limiting", async () => {
    modelMappings = {
      "gpt-provider": "dash/qwen-plus",
    }

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: "hello", role: "user" }],
        model: "gpt-provider",
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
    expect((init as RequestInit).headers).toEqual({
      "content-type": "application/json",
      accept: "application/json",
      authorization: "Bearer provider-key",
    })

    const upstreamBody = JSON.parse((init as RequestInit).body as string) as {
      model: string
    }
    expect(upstreamBody.model).toBe("qwen-plus")
  })

  test("strips provider prefix and applies provider model defaults", async () => {
    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
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

    const init = fetchMock.mock.calls[0][1] as RequestInit
    const upstreamBody = JSON.parse(init.body as string) as Record<
      string,
      unknown
    >
    expect(upstreamBody).toMatchObject({
      enable_thinking: true,
      model: "qwen-plus",
      preserve_thinking: true,
      temperature: 0.2,
      top_k: 50,
      top_p: 0.8,
    })
  })

  test("keeps request fields over provider defaults and adds stream usage option", async () => {
    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        enable_thinking: false,
        messages: [{ content: "hello", role: "user" }],
        model: "dash/qwen-plus",
        stream: true,
        stream_options: {
          include_usage: false,
        },
        temperature: 0.4,
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const upstreamBody = JSON.parse(init.body as string) as Record<
      string,
      unknown
    >
    expect(upstreamBody.temperature).toBe(0.4)
    expect(upstreamBody.enable_thinking).toBe(false)
    expect(upstreamBody.stream_options).toEqual({
      include_usage: true,
    })
  })

  test("rejects providers without chat completions support", async () => {
    providerConfig = {
      ...(providerConfig as ResolvedProviderConfig),
      type: "openai-responses",
    }

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: "hello", role: "user" }],
        model: "dash/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await response.json()).toEqual({
      error: {
        message:
          "Provider 'dash' does not support the /v1/chat/completions endpoint",
        type: "invalid_request_error",
      },
    })
  })
})

describe("context cache on provider chat completions route", () => {
  test("applies context cache for dashscope providers by default", async () => {
    providerConfig = {
      ...providerConfig,
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
      name: "dashscope",
      models: {
        "qwen-plus": {
          extraBody: {
            enable_thinking: true,
            preserve_thinking: true,
          },
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [
          { content: "system prompt", role: "system" },
          { content: "hello", role: "user" },
        ],
        model: "dashscope/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: unknown; role: string }>
    }

    const systemMessage = body.messages[0]
    expect(Array.isArray(systemMessage.content)).toBe(true)
    const systemPart = (
      systemMessage.content as Array<Record<string, unknown>>
    )[0]
    expect(systemPart.cache_control).toEqual({ type: "ephemeral" })

    const userMessage = body.messages[1]
    expect(Array.isArray(userMessage.content)).toBe(true)
    const userPart = (userMessage.content as Array<Record<string, unknown>>)[0]
    expect(userPart.cache_control).toEqual({ type: "ephemeral" })
  })

  test("detects dashscope via aliyuncs.com in baseUrl", async () => {
    providerConfig = {
      ...providerConfig,
      baseUrl: "https://bailian.aliyuncs.com/api/v1",
      name: "my-bailian",
      models: {
        "qwen-plus": {},
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: "hello", role: "user" }],
        model: "my-bailian/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: unknown; role: string }>
    }
    const userMessage = body.messages[0]
    expect(Array.isArray(userMessage.content)).toBe(true)
    const userPart = (userMessage.content as Array<Record<string, unknown>>)[0]
    expect(userPart.cache_control).toEqual({ type: "ephemeral" })
  })

  test("does not apply context cache for non-dashscope providers by default", async () => {
    providerConfig = {
      ...providerConfig,
      baseUrl: "https://api.example.com/v1",
      name: "custom",
      models: {
        "qwen-plus": {},
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [
          { content: "system prompt", role: "system" },
          { content: "hello", role: "user" },
        ],
        model: "custom/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: unknown; role: string }>
    }
    for (const message of body.messages) {
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (typeof part === "object" && part !== null) {
            expect(part).not.toHaveProperty("cache_control")
          }
        }
      }
    }
  })

  test("applies context cache for non-dashscope providers when explicitly enabled", async () => {
    providerConfig = {
      ...providerConfig,
      baseUrl: "https://api.example.com/v1",
      name: "custom",
      models: {
        "qwen-plus": {
          contextCache: true,
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [
          { content: "system prompt", role: "system" },
          { content: "hello", role: "user" },
        ],
        model: "custom/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: unknown; role: string }>
    }
    const systemMessage = body.messages[0]
    expect(Array.isArray(systemMessage.content)).toBe(true)
    const systemPart = (
      systemMessage.content as Array<Record<string, unknown>>
    )[0]
    expect(systemPart.cache_control).toEqual({ type: "ephemeral" })
  })

  test("disables context cache for dashscope when contextCache is false", async () => {
    providerConfig = {
      ...providerConfig,
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
      name: "dashscope",
      models: {
        "qwen-plus": {
          contextCache: false,
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: "hello", role: "user" }],
        model: "dashscope/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: unknown; role: string }>
    }
    for (const message of body.messages) {
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (typeof part === "object" && part !== null) {
            expect(part).not.toHaveProperty("cache_control")
          }
        }
      }
    }
  })
})

describe("dashscope preserve_thinking default on chat completions route", () => {
  test("defaults preserve_thinking to true for dashscope when not set", async () => {
    providerConfig = {
      ...providerConfig,
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
      name: "dashscope",
      models: {
        "qwen-plus": {},
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: "hello", role: "user" }],
        model: "dashscope/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.preserve_thinking).toBe(true)
  })

  test("keeps explicit preserve_thinking false from extraBody", async () => {
    providerConfig = {
      ...providerConfig,
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
      name: "dashscope",
      models: {
        "qwen-plus": {
          extraBody: {
            preserve_thinking: false,
          },
        },
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: "hello", role: "user" }],
        model: "dashscope/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.preserve_thinking).toBe(false)
  })

  test("keeps explicit preserve_thinking false from request", async () => {
    providerConfig = {
      ...providerConfig,
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode",
      name: "dashscope",
      models: {
        "qwen-plus": {},
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: "hello", role: "user" }],
        model: "dashscope/qwen-plus",
        preserve_thinking: false,
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body.preserve_thinking).toBe(false)
  })

  test("does not set preserve_thinking for non-dashscope providers", async () => {
    providerConfig = {
      ...providerConfig,
      baseUrl: "https://api.example.com/v1",
      name: "custom",
      models: {
        "qwen-plus": {},
      },
    } as ResolvedProviderConfig

    const app = createApp()
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({
        messages: [{ content: "hello", role: "user" }],
        model: "custom/qwen-plus",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(200)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body).not.toHaveProperty("preserve_thinking")
  })
})
