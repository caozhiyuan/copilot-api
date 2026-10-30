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
import type {
  ChatCompletionsPayload,
  FilePart,
} from "~/lib/types/chat-completions"

import { installModelsDevCatalog } from "~/lib/models-dev-cache"
import { createFallbackModel } from "~/lib/provider-model"
import { RICH_TOOL_RESULT_MOVED_TEXT } from "~/routes/messages/completions-translation"

import { modelsDevCatalogFixture } from "./fixtures/models-dev-catalog"

const actualConfigModule = await import("~/lib/config")
const actualTokenUsageModule = await import("~/lib/token-usage")

let providerConfig: ResolvedProviderConfig | null = null
let modelMappings: Record<string, string> = {}

type TokenCountPayload = Pick<ChatCompletionsPayload, "model" | "messages">

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
let restoreTokenUsageRecorder = () => {}

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

const { messageRoutes } = await import("~/routes/messages/route")
const { providerMessageRoutes } = await import(
  "~/routes/provider/messages/route"
)
const { responsesRoutes } = await import("~/routes/responses/route")
const { messagesFlowHandlers } = await import("~/routes/messages/handler")
const { state } = await import("~/lib/state")
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
  app.route("/:provider/v1/messages", providerMessageRoutes)
  app.route("/v1/responses", responsesRoutes)
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
  restoreTokenUsageRecorder()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  providerConfig = null
})

describe("PDF capabilities across provider request routes", () => {
  const modelId = "org/pdf-model"
  const pdfData = Buffer.from("%PDF-1.7 fixture").toString("base64")
  const document = {
    type: "document",
    source: {
      type: "base64",
      media_type: "application/pdf",
      data: pdfData,
    },
    title: "report.pdf",
  }
  const filePart: FilePart = {
    type: "file",
    file: {
      file_data: `data:application/pdf;base64,${pdfData}`,
      filename: "report.pdf",
    },
  }
  const pdfModel = {
    id: modelId,
    modalities: { input: ["text", "pdf"], output: ["text"] },
  }

  function getUpstreamPayload(): ChatCompletionsPayload {
    const body = fetchMock.mock.calls[0]?.[1]?.body
    if (typeof body !== "string") {
      throw new Error("Expected a serialized Chat Completions request")
    }
    return JSON.parse(body) as ChatCompletionsPayload
  }

  beforeEach(() => {
    installModelsDevCatalog({
      ...modelsDevCatalogFixture,
      "opencode-go": {
        ...modelsDevCatalogFixture["opencode-go"],
        models: {
          ...modelsDevCatalogFixture["opencode-go"].models,
          [modelId]: pdfModel,
        },
      },
      catalog: {
        npm: "@ai-sdk/openai-compatible",
        api: "https://catalog.example/v1",
        models: { [modelId]: pdfModel },
      },
    })
  })

  afterEach(() => installModelsDevCatalog(modelsDevCatalogFixture))

  test.each([
    {
      name: "catalog",
      modelsDevProviderId: undefined,
      supportPdf: undefined,
      expectedPdf: true,
    },
    {
      name: "custom",
      modelsDevProviderId: "catalog",
      supportPdf: undefined,
      expectedPdf: true,
    },
    {
      name: "opencode-go",
      modelsDevProviderId: undefined,
      supportPdf: undefined,
      expectedPdf: true,
    },
    {
      name: "custom",
      modelsDevProviderId: "catalog",
      supportPdf: false,
      expectedPdf: false,
    },
    {
      name: "custom",
      modelsDevProviderId: undefined,
      supportPdf: true,
      expectedPdf: true,
    },
    {
      name: "custom",
      modelsDevProviderId: undefined,
      supportPdf: undefined,
      expectedPdf: false,
    },
    {
      name: "custom",
      modelsDevProviderId: "catalog",
      supportPdf: undefined,
      expectedPdf: true,
      providerType: "anthropic" as const,
      modelType: "openai-compatible" as const,
    },
    {
      name: "custom",
      modelsDevProviderId: "catalog",
      supportPdf: undefined,
      expectedPdf: true,
      providerType: "anthropic" as const,
    },
  ])(
    "resolves PDF capabilities consistently for Messages and token counting: %j",
    async ({
      name,
      modelsDevProviderId,
      supportPdf,
      expectedPdf,
      providerType,
      modelType,
    }) => {
      providerConfig = {
        ...providerConfig!,
        name,
        type: providerType ?? providerConfig!.type,
        modelsDevProviderId,
        models: { [modelId]: { supportPdf, type: modelType } },
      }
      const app = createApp()
      for (const prefix of [`/${name}/v1/messages`, "/v1/messages"]) {
        fetchMock.mockClear()
        getTokenCount.mockClear()
        const body = JSON.stringify({
          model: prefix === "/v1/messages" ? `${name}/${modelId}` : modelId,
          max_tokens: 128,
          messages: [{ role: "user", content: [document] }],
        })
        const request = {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }

        const response = await app.request(prefix, request)
        expect(response.status).toBe(200)
        const upstreamPayload = getUpstreamPayload()
        expect(upstreamPayload.model).toBe(modelId)
        expect(upstreamPayload.messages[0].content).toEqual(
          expectedPdf ?
            [filePart]
          : [
              {
                type: "text",
                text: "PDF/document content is not supported by this Chat Completions upstream. Use the available text extracted from the document.",
              },
            ],
        )

        const countResponse = await app.request(
          `${prefix}/count_tokens`,
          request,
        )
        expect(countResponse.status).toBe(200)
        expect(await countResponse.json()).toEqual({ input_tokens: 42 })
        expect(getTokenCount.mock.calls[0]?.[0].messages).toEqual(
          upstreamPayload.messages,
        )
      }
    },
  )

  test.each([
    {
      providerType: "openai-compatible",
      modelType: undefined,
      expectedToolPdf: true,
    },
    {
      providerType: "anthropic",
      modelType: undefined,
      expectedToolPdf: false,
    },
    {
      providerType: "openai-responses",
      modelType: undefined,
      expectedToolPdf: false,
    },
    {
      providerType: "anthropic",
      modelType: "openai-compatible",
      expectedToolPdf: true,
    },
    {
      providerType: "openai-compatible",
      modelType: "anthropic",
      expectedToolPdf: false,
    },
  ] as const)(
    "uses PDF tool content only for the effective Chat Completions protocol: %j",
    async ({ providerType, modelType, expectedToolPdf }) => {
      providerConfig = {
        ...providerConfig!,
        name: "catalog",
        type: providerType,
        models: {
          [modelId]: { type: modelType, toolContentSupportType: ["pdf"] },
        },
      }

      const response = await createApp().request(
        "/catalog/v1/messages/count_tokens",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: modelId,
            max_tokens: 128,
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    id: "read-pdf",
                    name: "read_file",
                    input: { path: "report.pdf" },
                  },
                ],
              },
              {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "read-pdf",
                    content: [document],
                  },
                ],
              },
            ],
          }),
        },
      )

      expect(response.status).toBe(200)
      const messages = getTokenCount.mock.calls[0]?.[0].messages
      expect(messages?.find((message) => message.role === "tool")).toEqual({
        role: "tool",
        tool_call_id: "read-pdf",
        content: expectedToolPdf ? [filePart] : RICH_TOOL_RESULT_MOVED_TEXT,
      })
      if (!expectedToolPdf) {
        expect(messages?.at(-1)).toEqual({
          role: "user",
          content: [
            { type: "text", text: "Tool result for read-pdf:" },
            filePart,
          ],
        })
      }
    },
  )

  test("preserves an OpenCode Responses PDF through the Messages and Chat Completions adapters", async () => {
    providerConfig = {
      ...providerConfig!,
      name: "custom",
      modelsDevProviderId: "catalog",
      models: { [modelId]: {} },
    }

    const response = await createApp().request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "opencode" },
      body: JSON.stringify({
        model: `custom/${modelId}`,
        input: [
          { role: "user", content: [{ type: "input_file", ...filePart.file }] },
        ],
      }),
    })

    expect(response.status).toBe(200)
    const upstreamPayload = getUpstreamPayload()
    expect(upstreamPayload.messages[0].content).toEqual([filePart])
  })

  test.each(["catalog", "live", "disabled"])(
    "applies %s Copilot PDF capabilities before token counting",
    async (source) => {
      installModelsDevCatalog({
        ...modelsDevCatalogFixture,
        "github-copilot": {
          models: {
            [modelId]: {
              ...pdfModel,
              modalities: {
                input: source === "live" ? ["text"] : ["text", "pdf"],
              },
            },
          },
        },
      })
      providerConfig = {
        ...providerConfig!,
        name: "github-copilot",
        models: {
          [modelId]: { supportPdf: source === "disabled" ? false : undefined },
        },
      }
      const originalModels = state.models
      const selectedModel = createFallbackModel(modelId)
      if (source === "live") {
        selectedModel.capabilities.limits.vision = {
          supported_media_types: ["application/pdf"],
        }
      }
      state.models = { object: "list", data: [selectedModel] }

      try {
        const response = await createApp().request(
          "/v1/messages/count_tokens",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: modelId,
              max_tokens: 128,
              messages: [{ role: "user", content: [document] }],
            }),
          },
        )

        expect(response.status).toBe(200)
        const content = getTokenCount.mock.calls[0]?.[0].messages[0].content
        expect(content).toEqual(
          source === "disabled" ?
            [
              {
                type: "text",
                text: "PDF/document content is not supported by this Chat Completions upstream. Use the available text extracted from the document.",
              },
            ]
          : [filePart],
        )
      } finally {
        state.models = originalModels
      }
    },
  )
})

describe("provider/model aliases on top-level messages routes", () => {
  test.each([
    { path: "/v1/messages", model: "dash/my-claude-qwen-plus" },
    { path: "/dash/v1/messages", model: "my-claude-qwen-plus" },
    { path: "/v1/messages", model: "dash/my-claude-qwen-plus[1m]" },
    { path: "/dash/v1/messages", model: "my-claude-qwen-plus[1m]" },
  ])(
    "restores discovery IDs on $path before provider dispatch",
    async ({ path, model }) => {
      const response = await createApp().request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          max_tokens: 128,
          messages: [{ role: "user", content: "hello" }],
        }),
      })
      expect(response.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe(
        "https://dashscope.example/compatible-mode/v1/chat/completions",
      )
      const upstream = JSON.parse(init?.body as string) as {
        model: string
        temperature: number
      }
      expect(upstream.model).toBe("qwen-plus")
      expect(upstream.temperature).toBe(0.2)
    },
  )

  test.each([
    { path: "/v1/messages/count_tokens", model: "dash/my-claude-qwen-plus" },
    { path: "/dash/v1/messages/count_tokens", model: "my-claude-qwen-plus" },
    {
      path: "/v1/messages/count_tokens",
      model: "dash/my-claude-qwen-plus[1m]",
    },
    {
      path: "/dash/v1/messages/count_tokens",
      model: "my-claude-qwen-plus[1m]",
    },
  ])(
    "restores discovery IDs on $path before token counting",
    async ({ path, model }) => {
      const response = await createApp().request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          max_tokens: 128,
          messages: [{ role: "user", content: "hello" }],
        }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ input_tokens: 42 })
      const [payload, selectedModel] = getTokenCount.mock.calls[0]
      expect(payload.model).toBe("qwen-plus")
      expect(selectedModel.id).toBe("qwen-plus")
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  test.each(["/v1/messages", "/v1/messages/count_tokens"])(
    "applies model mappings after restoring discovery IDs on %s",
    async (path) => {
      modelMappings = { friendly: "dash/qwen-plus" }
      const response = await createApp().request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "my-claude-friendly[1m]",
          max_tokens: 128,
          messages: [{ role: "user", content: "hello" }],
        }),
      })
      expect(response.status).toBe(200)
      if (path.endsWith("count_tokens")) {
        expect(getTokenCount.mock.calls[0][0].model).toBe("qwen-plus")
        expect(getTokenCount.mock.calls[0][1].id).toBe("qwen-plus")
      } else {
        const upstream = JSON.parse(
          fetchMock.mock.calls[0][1]?.body as string,
        ) as {
          model: string
        }
        expect(upstream.model).toBe("qwen-plus")
      }
    },
  )

  test.each([
    { path: "/v1/messages", model: "dash/my-claude-openai/gpt-6-luna" },
    { path: "/dash/v1/messages", model: "my-claude-openai/gpt-6-luna" },
    { path: "/v1/messages", model: "dash/my-claude-openai/gpt-6-luna[1m]" },
    { path: "/dash/v1/messages", model: "my-claude-openai/gpt-6-luna[1m]" },
  ])(
    "keeps nested provider model namespaces on $path",
    async ({ path, model }) => {
      const response = await createApp().request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          max_tokens: 128,
          messages: [{ role: "user", content: "hello" }],
        }),
      })
      expect(response.status).toBe(200)
      const upstream = JSON.parse(
        fetchMock.mock.calls[0][1]?.body as string,
      ) as {
        model: string
      }
      expect(upstream.model).toBe("openai/gpt-6-luna")
    },
  )

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
  test.each([
    { model: "contoso/glm-5.2", copilotToken: undefined },
    { model: "contoso/glm-5.2", copilotToken: "test-copilot-token" },
    { model: "contoso/family/glm-5.2", copilotToken: undefined },
    { model: "contoso/family/glm-5.2", copilotToken: "test-copilot-token" },
  ])("routes %j through the Copilot flow", async ({ model, copilotToken }) => {
    const originalCopilotToken = state.copilotToken
    const originalModels = state.models
    const copilotFlow = spyOn(
      messagesFlowHandlers,
      "handleWithChatCompletions",
    ).mockImplementation((c, payload) =>
      Promise.resolve(c.json({ model: payload.model })),
    )

    state.copilotToken = copilotToken
    state.models = undefined

    try {
      const app = createApp()
      const response = await app.request("/v1/messages", {
        body: JSON.stringify({
          max_tokens: 128,
          messages: [{ content: "hello", role: "user" }],
          model,
        }),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      })

      expect(response.status).toBe(200)
      expect(copilotFlow).toHaveBeenCalledTimes(1)
      expect(copilotFlow.mock.calls[0][1].model).toBe(model)
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      copilotFlow.mockRestore()
      state.copilotToken = originalCopilotToken
      state.models = originalModels
    }
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
})
