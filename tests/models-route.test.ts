import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { ResolvedProviderConfig } from "~/lib/config"
import type { ModelsResponse } from "~/lib/types/models"
import { MAX_MODELS_CATALOG_SIZE_BYTES } from "~/routes/models/catalog-response"
import bundledCodexCatalogJson from "~/routes/models/models.json"

const actualConfigModule = await import("~/lib/config")
const actualTokenModule = await import("~/lib/token")

let enabledProviders: Array<string> = []
let providerConfigs: Record<string, ResolvedProviderConfig | null> = {}
let codexSetupError: Error | null = null

await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  getProviderConfig: (provider: string) => providerConfigs[provider] ?? null,
  getRawProviderConfig: (provider: string) => providerConfigs[provider] ?? null,
  listEnabledProviders: () => enabledProviders,
}))

await mock.module("~/lib/token", () => ({
  ...actualTokenModule,
  setupCodexToken: () => {
    if (codexSetupError) return Promise.reject(codexSetupError)
    return Promise.resolve()
  },
}))

const { state } = await import("~/lib/state")
const { modelRoutes } = await import("~/routes/models/route")
const { providerModelRoutes } = await import("~/routes/provider/models/route")

const originalFetch = globalThis.fetch

const createProviderConfig = (
  name: string,
  baseUrl: string,
): ResolvedProviderConfig => ({
  apiKey: `${name}-key`,
  authType: "authorization",
  baseUrl,
  name,
  type: "openai-compatible",
})

const createCopilotModels = (ids: Array<string>): ModelsResponse => ({
  object: "list",
  data: ids.map((id) => ({
    capabilities: {
      family: "gpt",
      limits: {
        max_context_window_tokens: 200_000,
      },
      object: "model_capabilities",
      supports: {},
      tokenizer: "o200k_base",
      type: "chat",
    },
    id,
    model_picker_enabled: true,
    name: id,
    object: "model",
    preview: false,
    vendor: "openai",
    version: "test",
  })),
})

const createDefaultCodexCatalogModels = () => [
  {
    slug: "gpt-native",
    display_name: "GPT Native",
    base_instructions: "Native instructions",
    available_in_plans: ["pro"],
  },
]

const bundledCodexModels = (
  bundledCodexCatalogJson as {
    models: Array<{
      slug: string
      visibility?: string
      supported_in_api?: boolean
      model_messages?: { instructions_template?: string }
    }>
  }
).models
const bundledCodexSlugs = bundledCodexModels.map((model) => model.slug)

let codexCatalogModels: Array<Record<string, unknown>> =
  createDefaultCodexCatalogModels()
let malformedCatalogUrls = new Set<string>()
let oversizedCatalogUrls = new Set<string>()

const fetchMock = mock((url: string | URL | Request, _init?: RequestInit) => {
  const requestUrl =
    typeof url === "string" ? url
    : url instanceof URL ? url.toString()
    : url.url

  if (malformedCatalogUrls.has(requestUrl)) {
    return Promise.resolve(
      new Response("{", { headers: { "content-type": "application/json" } }),
    )
  }

  if (oversizedCatalogUrls.has(requestUrl)) {
    return Promise.resolve(
      new Response("{}", {
        headers: {
          "content-length": String(MAX_MODELS_CATALOG_SIZE_BYTES + 1),
          "content-type": "application/json",
        },
      }),
    )
  }

  if (requestUrl.startsWith("https://chatgpt.com/backend-api/codex/models")) {
    return Promise.resolve(
      Response.json({
        models: codexCatalogModels,
      }),
    )
  }

  if (requestUrl === "https://bad.example/v1/models") {
    return Promise.resolve(new Response("upstream failed", { status: 502 }))
  }

  if (requestUrl === "https://kimi.example/v1/models") {
    return Promise.resolve(
      Response.json({
        object: "list",
        data: [
          {
            id: "mai-kimi-test",
            input_modalities: ["text"],
            name: "Kimi K2.5",
            object: "model",
          },
        ],
      }),
    )
  }

  if (requestUrl === "https://deepseek.example/v1/models") {
    return Promise.resolve(
      Response.json({
        object: "list",
        data: [
          {
            id: "gpt-deepseek-test",
            context_window: 128_000,
            input_modalities: ["text", "image"],
            max_output_tokens: 8_000,
            name: "DeepSeek V4 Pro",
            object: "model",
          },
        ],
      }),
    )
  }

  if (requestUrl === "https://openrouter.example/v1/models") {
    return Promise.resolve(
      Response.json({
        data: [
          {
            architecture: {
              input_modalities: ["file", "image", "text"],
              modality: "text+image+file->text",
              output_modalities: ["text"],
            },
            canonical_slug: "openai/gpt-5.1-codex-20251113",
            context_length: 400_000,
            description: "Codex-optimized GPT model.",
            id: "openai/gpt-5.1-codex",
            name: "OpenAI: GPT-5.1-Codex",
            supported_parameters: ["include_reasoning", "reasoning", "tools"],
            top_provider: {
              context_length: 400_000,
              max_completion_tokens: 128_000,
            },
          },
        ],
      }),
    )
  }

  if (requestUrl === "https://opencode.example/v1/models") {
    return Promise.resolve(
      Response.json({
        object: "list",
        data: [
          { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
          { id: "gpt-provider-only", name: "GPT Provider Only" },
          { id: "mai-opencode", name: "MAI OpenCode" },
          { id: "grok-4.5", name: "Grok 4.5" },
          { id: "qwen3-coder", name: "Qwen3 Coder" },
        ],
      }),
    )
  }

  if (requestUrl === "https://reject.example/v1/models") {
    return Promise.reject(new Error("connection refused"))
  }

  if (requestUrl === "https://invalid.example/v1/models") {
    return Promise.resolve(Response.json({ models: [] }))
  }

  if (requestUrl === "https://mixed.example/v1/models") {
    return Promise.resolve(
      Response.json({
        object: "list",
        data: [
          { id: "claude-sonnet-4", object: "model" },
          { id: "openai/gpt-5.4", object: "model" },
          { id: "MAI-1-preview", object: "model" },
        ],
      }),
    )
  }

  const providerModelIds: Record<string, string> = {
    "first.example": "gpt-first-model",
    "second.example": "gpt-second-model",
  }
  const providerModelId =
    providerModelIds[new URL(requestUrl).host] ?? "gpt-provider"

  return Promise.resolve(
    Response.json({
      object: "list",
      data: [
        {
          id: providerModelId,
          name: providerModelId,
          object: "model",
        },
        {
          id: "",
          object: "model",
        },
      ],
    }),
  )
})

function createApp() {
  const app = new Hono()
  app.route("/v1/models", modelRoutes)
  app.route("/:provider/v1/models", providerModelRoutes)
  return app
}

beforeEach(() => {
  enabledProviders = []
  providerConfigs = {}
  codexSetupError = null
  codexCatalogModels = createDefaultCodexCatalogModels()
  malformedCatalogUrls = new Set()
  oversizedCatalogUrls = new Set()
  state.models = undefined
  fetchMock.mockClear()
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  state.models = undefined
  state.codexAccessToken = undefined
  state.codexAccountId = undefined
})

describe("model routes", () => {
  test("aggregates Copilot and provider models without mutating state.models", async () => {
    state.models = createCopilotModels(["gpt-5-mini"])
    enabledProviders = ["dash"]
    providerConfigs = {
      dash: createProviderConfig("dash", "https://dash.example"),
    }

    const response = await createApp().request("/v1/models")

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((model) => model.id)).toEqual([
      "gpt-5-mini",
      "dash/gpt-provider",
    ])
    expect(state.models.data.map((model) => model.id)).toEqual(["gpt-5-mini"])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://dash.example/v1/models")
  })

  test("keeps Copilot models first and provider models in provider order", async () => {
    state.models = createCopilotModels(["gpt-5-mini", "gpt-5"])
    enabledProviders = ["second", "first"]
    providerConfigs = {
      first: createProviderConfig("first", "https://first.example"),
      second: createProviderConfig("second", "https://second.example"),
    }

    const response = await createApp().request("/v1/models")

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((model) => model.id)).toEqual([
      "gpt-5-mini",
      "gpt-5",
      "second/gpt-second-model",
      "first/gpt-first-model",
    ])
  })

  test("returns provider models in provider-only mode and skips failed providers", async () => {
    enabledProviders = ["bad", "dash"]
    providerConfigs = {
      bad: createProviderConfig("bad", "https://bad.example"),
      dash: createProviderConfig("dash", "https://dash.example"),
    }

    const response = await createApp().request("/v1/models")

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((model) => model.id)).toEqual(["dash/gpt-provider"])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test("falls back to pricing models for each failed provider models request", async () => {
    enabledProviders = ["deepseek", "kimi", "opencode-go"]
    providerConfigs = {
      deepseek: createProviderConfig("deepseek", "https://bad.example"),
      kimi: createProviderConfig("kimi", "https://reject.example"),
      "opencode-go": createProviderConfig(
        "opencode-go",
        "https://invalid.example",
      ),
    }

    const response = await createApp().request("/v1/models")

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      data: Array<Record<string, unknown> & { id: string }>
    }
    const modelIds = body.data.map((model) => model.id)
    expect(modelIds).toEqual(["opencode-go/gpt-5.6-luna"])
    expect(modelIds).not.toContain("deepseek/deepseek-flash")
    expect(modelIds).not.toContain("kimi/k3")
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  test("filters disallowed Copilot models when a provider model fetch rejects", async () => {
    const copilotModels = createCopilotModels(["claude-sonnet-4.6"])
    copilotModels.data[0].supported_endpoints = ["/v1/messages"]
    copilotModels.data[0].capabilities.supports.tool_calls = true
    state.models = copilotModels
    enabledProviders = ["reject"]
    providerConfigs = {
      reject: createProviderConfig("reject", "https://reject.example"),
    }

    const response = await createApp().request("/v1/models?client=codex", {
      headers: { "user-agent": "codex-cli/1.0.0" },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      models: Array<Record<string, unknown> & { slug: string }>
    }
    expect(body.models.map((model) => model.slug)).toEqual(bundledCodexSlugs)
  })

  test("filters disallowed pricing models from failed-provider fallbacks", async () => {
    enabledProviders = ["deepseek", "kimi", "opencode-go"]
    providerConfigs = {
      deepseek: createProviderConfig("deepseek", "https://bad.example"),
      kimi: createProviderConfig("kimi", "https://reject.example"),
      "opencode-go": createProviderConfig(
        "opencode-go",
        "https://invalid.example",
      ),
    }

    const response = await createApp().request("/v1/models", {
      headers: { "user-agent": "codex-cli/1.0.0" },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      models: Array<Record<string, unknown> & { slug: string }>
    }
    const modelSlugs = body.models.map((model) => model.slug)
    expect(modelSlugs).toContain("opencode-go/gpt-5.6-luna")
    expect(modelSlugs).not.toContain("deepseek/deepseek-flash")
    expect(modelSlugs).not.toContain("kimi/k3")
    expect(modelSlugs).not.toContain("opencode-go/hy3")
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  test("prefers user model config over upstream and built-in defaults", async () => {
    enabledProviders = ["deepseek"]
    providerConfigs = {
      deepseek: {
        ...createProviderConfig("deepseek", "https://deepseek.example"),
        models: {
          "gpt-deepseek-test": {
            contextWindow: 123_456,
            inputModalities: ["text"],
            maxOutputTokens: 4_096,
          },
        },
      },
    }

    const response = await createApp().request("/v1/models", {
      headers: { "user-agent": "codex-cli/1.0.0" },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      models: Array<Record<string, unknown> & { slug: string }>
    }
    expect(
      body.models.find((model) => model.slug === "deepseek/gpt-deepseek-test"),
    ).toMatchObject({
      context_window: 123_456,
      input_modalities: ["text"],
      max_output_tokens: 4_096,
    })
  })

  test("prefers upstream capabilities over built-in catalog defaults", async () => {
    enabledProviders = ["deepseek"]
    providerConfigs = {
      deepseek: createProviderConfig("deepseek", "https://deepseek.example"),
    }

    const response = await createApp().request("/v1/models", {
      headers: { "user-agent": "codex-cli/1.0.0" },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      models: Array<Record<string, unknown> & { slug: string }>
    }
    expect(
      body.models.find((model) => model.slug === "deepseek/gpt-deepseek-test"),
    ).toMatchObject({
      context_window: 128_000,
      input_modalities: ["text", "image"],
      max_output_tokens: 8_000,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("maps the OpenRouter image modality into Codex candidates", async () => {
    enabledProviders = ["openrouter"]
    providerConfigs = {
      openrouter: {
        apiKey: "openrouter-key",
        authType: "authorization",
        baseUrl: "https://openrouter.example",
        name: "openrouter",
        type: "anthropic",
      },
    }

    const response = await createApp().request("/v1/models?client=codex", {
      headers: { "user-agent": "codex-cli/1.0.0" },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      models: Array<Record<string, unknown> & { slug: string }>
    }
    expect(
      body.models.find(
        (model) => model.slug === "openrouter/openai/gpt-5.1-codex",
      ),
    ).toMatchObject({
      input_modalities: ["image", "text"],
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("adds built-in Codex provider models without calling upstream", async () => {
    enabledProviders = ["codex"]
    providerConfigs = {
      codex: {
        apiKey: "codex-token",
        authType: "oauth2",
        baseUrl: "https://chatgpt.com/backend-api",
        name: "codex",
        type: "openai-responses",
      },
    }

    const response = await createApp().request("/v1/models")

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((model) => model.id)).toContain("codex/gpt-6-astra")
    expect(body.data.map((model) => model.id)).toContain("codex/gpt-5.6-sol")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("does not use pricing models when Codex credential setup fails", async () => {
    enabledProviders = ["codex"]
    providerConfigs = {
      codex: {
        apiKey: "codex-token",
        authType: "oauth2",
        baseUrl: "https://chatgpt.com/backend-api",
        name: "codex",
        type: "openai-responses",
      },
    }
    codexSetupError = new Error("refresh failed")

    const response = await createApp().request("/v1/models")

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Array<{ id: string }> }
    expect(body.data).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("forwards Codex clients to the fixed Codex models endpoint", async () => {
    providerConfigs = {
      codex: {
        apiKey: "codex-token",
        authType: "oauth2",
        baseUrl: "https://ignored.example/backend-api",
        name: "codex",
        type: "openai-responses",
      },
    }
    state.codexAccessToken = "codex-access-token"
    state.codexAccountId = "account-123"

    const response = await createApp().request("/v1/models?client=codex", {
      headers: {
        accept: "*/*",
        "user-agent": "codex-tui/0.144.1",
      },
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://chatgpt.com/backend-api/codex/models?client=codex",
    )
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
    expect(headers.get("authorization")).toBe("Bearer codex-access-token")
    expect(headers.get("chatgpt-account-id")).toBe("account-123")
    expect(headers.get("accept")).toBe("*/*")
  })

  test("filters Claude entries and defaults from the provider Codex catalog", async () => {
    providerConfigs = {
      codex: {
        apiKey: "codex-token",
        authType: "oauth2",
        baseUrl: "https://chatgpt.com/backend-api",
        name: "codex",
        type: "openai-responses",
      },
    }
    state.codexAccessToken = "codex-access-token"
    state.codexAccountId = "account-123"
    codexCatalogModels = [
      { slug: "claude-sonnet-4", display_name: "Claude" },
      {
        slug: "gpt-5.4",
        display_name: "GPT",
        auto_review_model_override: "claude-sonnet-4",
        upgrade: { model: "claude-opus-4" },
      },
    ]

    const response = await createApp().request("/codex/v1/models", {
      headers: { "user-agent": "codex-cli/1.0.0" },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      models: Array<Record<string, unknown> & { slug: string }>
    }
    expect(body.models).toEqual([
      {
        slug: "gpt-5.4",
        display_name: "GPT",
        auto_review_model_override: null,
        upgrade: null,
      },
    ])
  })

  test("merges allowed Messages-backed models into the Codex response_lite catalog", async () => {
    const copilotModels = createCopilotModels(["mai-1-preview"])
    copilotModels.data[0].supported_endpoints = ["/v1/messages"]
    copilotModels.data[0].capabilities.supports.tool_calls = true
    state.models = copilotModels
    providerConfigs = {
      codex: {
        apiKey: "codex-token",
        authType: "oauth2",
        baseUrl: "https://chatgpt.com/backend-api",
        name: "codex",
        type: "openai-responses",
      },
    }
    state.codexAccessToken = "codex-access-token"
    state.codexAccountId = "account-123"

    const response = await createApp().request("/v1/models?client=codex", {
      headers: { "user-agent": "codex-cli/1.0.0" },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      models: Array<Record<string, unknown> & { slug: string }>
    }
    expect(body.models.map((model) => model.slug)).toEqual([
      "gpt-native",
      "mai-1-preview",
    ])
    expect(
      body.models.find((model) => model.slug === "mai-1-preview"),
    ).toMatchObject({
      use_responses_lite: true,
      prefer_websockets: false,
      apply_patch_tool_type: "freeform",
      supports_search_tool: false,
      supports_parallel_tool_calls: true,
      tool_mode: "code_mode_only",
      multi_agent_version: "v2",
      default_reasoning_level: "max",
    })
  })

  test("merges Responses-backed Copilot models into the Codex catalog", async () => {
    const copilotModels = createCopilotModels([
      "gpt-responses-http",
      "gpt-responses-websocket",
    ])
    copilotModels.data[0].supported_endpoints = ["/responses"]
    copilotModels.data[1].supported_endpoints = ["ws:/responses"]
    for (const model of copilotModels.data) {
      model.capabilities.supports.tool_calls = true
    }
    state.models = copilotModels

    const response = await createApp().request("/v1/models?client=codex", {
      headers: { "user-agent": "codex-cli/1.0.0" },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      models: Array<Record<string, unknown> & { slug: string }>
    }
    expect(body.models.map((model) => model.slug)).toEqual([
      ...bundledCodexSlugs,
      "gpt-responses-http",
      "gpt-responses-websocket",
    ])
    expect(
      body.models.find((model) => model.slug === "gpt-responses-http")
        ?.description,
    ).toBe("gpt-responses-http through the Copilot Responses API.")
    expect(
      body.models.find((model) => model.slug === "gpt-responses-websocket")
        ?.description,
    ).toBe("gpt-responses-websocket through the Copilot Responses API.")
  })

  test("describes allowed non-GPT Responses-capable models and filters others", async () => {
    const copilotModels = createCopilotModels(["mai-1-preview", "gemini-3-pro"])
    copilotModels.data[0].supported_endpoints = ["/responses", "/v1/messages"]
    copilotModels.data[1].supported_endpoints = ["/responses"]
    for (const model of copilotModels.data) {
      model.capabilities.supports.tool_calls = true
    }
    state.models = copilotModels

    const response = await createApp().request("/v1/models?client=codex", {
      headers: { "user-agent": "codex-cli/1.0.0" },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      models: Array<Record<string, unknown> & { slug: string }>
    }
    expect(
      body.models.find((model) => model.slug === "mai-1-preview")?.description,
    ).toBe("mai-1-preview through the Copilot Messages adapter.")
    expect(body.models.map((model) => model.slug)).not.toContain("gemini-3-pro")
  })

  test("uses the bundled Codex catalog when the Codex provider is missing", async () => {
    const copilotModels = createCopilotModels(["mai-1-preview"])
    copilotModels.data[0].supported_endpoints = ["/v1/messages"]
    copilotModels.data[0].capabilities.supports.tool_calls = true
    state.models = copilotModels
    enabledProviders = []
    providerConfigs = {}

    const response = await createApp().request("/v1/models?client=codex", {
      headers: { "user-agent": "codex-cli/1.0.0" },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      models: Array<Record<string, unknown> & { slug: string }>
    }
    const synthetic = body.models.find(
      (model) => model.slug === "mai-1-preview",
    )
    expect(synthetic).toMatchObject({
      display_name: "mai-1-preview",
      shell_type: "unified_exec",
    })
    expect(synthetic?.available_in_plans).toContain("pro")
    const template = bundledCodexModels.find(
      (model) =>
        model.visibility === "list" && model.supported_in_api !== false,
    )
    const modelMessages = synthetic?.model_messages as
      | { instructions_template?: string }
      | undefined
    expect(modelMessages?.instructions_template).toBe(
      template?.model_messages?.instructions_template,
    )
  })

  test("copies matching Codex catalog models for provider-prefixed aliases", async () => {
    const solCatalogModel = {
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6 Sol",
      description: "Sol catalog description",
      base_instructions: "Sol catalog instructions",
      context_window: 372_000,
      default_reasoning_level: "max",
      priority: 11,
      supported_reasoning_levels: [
        { effort: "high", description: "High reasoning" },
        { effort: "xhigh", description: "Extra high reasoning" },
        { effort: "max", description: "Maximum reasoning" },
      ],
      use_responses_lite: false,
      custom_catalog_field: { source: "sol" },
    }
    const lunaCatalogModel = {
      slug: "gpt-5.6-luna",
      display_name: "GPT-5.6 Luna",
      description: "Luna catalog description",
      base_instructions: "Luna catalog instructions",
      context_window: 372_000,
      priority: 13,
      supported_reasoning_levels: [
        { effort: "max", description: "Maximum reasoning" },
      ],
      use_responses_lite: false,
      custom_catalog_field: { source: "luna" },
    }
    const remoteOnlyCatalogModel = {
      slug: "gpt-remote-only",
      display_name: "GPT Remote Only",
      description: "Only the remote catalog knows this model",
      priority: 17,
      use_responses_lite: false,
    }
    codexCatalogModels = [
      solCatalogModel,
      lunaCatalogModel,
      remoteOnlyCatalogModel,
    ]
    enabledProviders = ["codex", "opencode-go"]
    providerConfigs = {
      codex: {
        apiKey: "codex-token",
        authType: "oauth2",
        baseUrl: "https://chatgpt.com/backend-api",
        name: "codex",
        type: "openai-responses",
      },
      "opencode-go": {
        apiKey: "opencode-token",
        authType: "authorization",
        baseUrl: "https://opencode.example",
        name: "opencode-go",
        type: "openai-compatible",
      },
    }
    state.codexAccessToken = "codex-access-token"
    state.codexAccountId = "account-123"

    const response = await createApp().request("/v1/models", {
      headers: { "user-agent": "codex-cli/1.0.0" },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      models: Array<Record<string, unknown> & { slug: string }>
    }
    expect(body.models.find((model) => model.slug === "gpt-5.6-sol")).toEqual(
      solCatalogModel,
    )
    expect(
      body.models.find((model) => model.slug === "codex/gpt-5.6-sol"),
    ).toEqual({
      ...solCatalogModel,
      slug: "codex/gpt-5.6-sol",
      display_name: "codex GPT-5.6 Sol",
      priority: 1_000,
    })
    expect(
      body.models.find((model) => model.slug === "opencode-go/gpt-5.6-luna"),
    ).toEqual({
      ...lunaCatalogModel,
      slug: "opencode-go/gpt-5.6-luna",
      display_name: "opencode-go GPT-5.6 Luna",
      priority: 3_000,
    })
    expect(
      body.models.find((model) => model.slug === "codex/gpt-remote-only"),
    ).toEqual({
      ...remoteOnlyCatalogModel,
      slug: "codex/gpt-remote-only",
      display_name: "codex GPT Remote Only",
      priority: 1_002,
    })
    expect(body.models.map((model) => model.slug)).not.toContain(
      "opencode-go/qwen3-coder",
    )
    expect(body.models.map((model) => model.slug)).not.toContain(
      "opencode-go/grok-4.5",
    )
    expect(body.models.map((model) => model.slug)).not.toContain(
      "opencode-go/gpt-provider-only",
    )
  })

  test("orders allowed merged Codex models as catalog, codex, copilot, opencode-go, then providers", async () => {
    const copilotModels = createCopilotModels(["mai-1-preview"])
    copilotModels.data[0].supported_endpoints = ["/v1/messages"]
    copilotModels.data[0].capabilities.supports.tool_calls = true
    state.models = copilotModels
    enabledProviders = ["codex", "kimi", "opencode-go"]
    providerConfigs = {
      codex: {
        apiKey: "codex-token",
        authType: "oauth2",
        baseUrl: "https://chatgpt.com/backend-api",
        name: "codex",
        type: "openai-responses",
      },
      kimi: createProviderConfig("kimi", "https://kimi.example"),
      "opencode-go": createProviderConfig(
        "opencode-go",
        "https://opencode.example",
      ),
    }
    state.codexAccessToken = "codex-access-token"
    state.codexAccountId = "account-123"

    const response = await createApp().request("/v1/models?client=codex", {
      headers: { "user-agent": "codex-cli/1.0.0" },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      models: Array<Record<string, unknown> & { slug: string }>
    }
    expect(body.models.map((model) => model.slug)).toEqual([
      "gpt-native",
      "codex/gpt-native",
      "mai-1-preview",
      "opencode-go/mai-opencode",
      "kimi/mai-kimi-test",
    ])
    const priorities = body.models.map((model) =>
      typeof model.priority === "number" ? model.priority : 0,
    )
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b))
  })

  test("skips malformed Copilot model records when merging the Codex catalog", async () => {
    const copilotModels = createCopilotModels(["claude-sonnet-4.6"])
    copilotModels.data[0].supported_endpoints = ["/v1/messages"]
    copilotModels.data[0].capabilities.supports.tool_calls = true
    copilotModels.data.push({
      id: "broken-model",
    } as unknown as ModelsResponse["data"][number])
    state.models = copilotModels

    const response = await createApp().request("/v1/models?client=codex", {
      headers: { "user-agent": "codex-cli/1.0.0" },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      models: Array<Record<string, unknown> & { slug: string }>
    }
    expect(body.models.map((model) => model.slug)).toEqual(bundledCodexSlugs)
  })

  test("prefers max as the built-in default reasoning effort for Codex models", async () => {
    const copilotModels = createCopilotModels([
      "mai-reasoning-max",
      "mai-reasoning-low",
    ])
    for (const model of copilotModels.data) {
      model.supported_endpoints = ["/v1/messages"]
      model.capabilities.supports.tool_calls = true
    }
    copilotModels.data[0].capabilities.supports.reasoning_effort = [
      "minimal",
      "low",
      "medium",
      "max",
    ]
    copilotModels.data[1].capabilities.supports.reasoning_effort = [
      "low",
      "medium",
    ]
    state.models = copilotModels

    const response = await createApp().request("/v1/models", {
      headers: { "user-agent": "codex-cli/1.0.0" },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      models: Array<Record<string, unknown> & { slug: string }>
    }
    expect(
      body.models.find((model) => model.slug === "mai-reasoning-max"),
    ).toMatchObject({ default_reasoning_level: "max" })
    expect(
      body.models.find((model) => model.slug === "mai-reasoning-low"),
    ).toMatchObject({ default_reasoning_level: "low" })
  })

  test("defaults reasoning efforts to high, xhigh, max, and ultra for Codex models", async () => {
    const copilotModels = createCopilotModels(["mai-1-preview"])
    copilotModels.data[0].supported_endpoints = ["/v1/messages"]
    copilotModels.data[0].capabilities.supports.tool_calls = true
    state.models = copilotModels
    enabledProviders = ["chat"]
    providerConfigs = {
      chat: createProviderConfig("chat", "https://chat.example"),
    }

    const response = await createApp().request("/v1/models", {
      headers: { "user-agent": "codex-cli/1.0.0" },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      models: Array<Record<string, unknown> & { slug: string }>
    }
    for (const slug of ["mai-1-preview", "chat/gpt-provider"]) {
      expect(body.models.find((model) => model.slug === slug)).toMatchObject({
        default_reasoning_level: "max",
        supported_reasoning_levels: [
          { effort: "high", description: "high reasoning effort" },
          { effort: "xhigh", description: "xhigh reasoning effort" },
          { effort: "max", description: "max reasoning effort" },
          { effort: "ultra", description: "ultra reasoning effort" },
        ],
      })
    }
  })

  test("adds ultra reasoning effort at the end when it is missing", async () => {
    const copilotModels = createCopilotModels(["gpt-reasoning-test"])
    copilotModels.data[0].supported_endpoints = ["/v1/messages"]
    copilotModels.data[0].capabilities.supports.tool_calls = true
    copilotModels.data[0].capabilities.supports.reasoning_effort = [
      "low",
      "medium",
      "high",
      "xhigh",
    ]
    state.models = copilotModels

    const response = await createApp().request("/v1/models", {
      headers: { "user-agent": "codex-cli/1.0.0" },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      models: Array<Record<string, unknown> & { slug: string }>
    }
    expect(
      body.models.find((model) => model.slug === "gpt-reasoning-test"),
    ).toMatchObject({
      default_reasoning_level: "low",
      supported_reasoning_levels: [
        { effort: "low", description: "low reasoning effort" },
        { effort: "medium", description: "medium reasoning effort" },
        { effort: "high", description: "high reasoning effort" },
        { effort: "xhigh", description: "xhigh reasoning effort" },
        { effort: "ultra", description: "ultra reasoning effort" },
      ],
    })
  })

  test("merges Anthropic and OpenAI-compatible provider models for Codex", async () => {
    enabledProviders = ["anthropic", "chat"]
    providerConfigs = {
      anthropic: {
        apiKey: "anthropic-key",
        authType: "x-api-key",
        baseUrl: "https://anthropic.example",
        models: {
          "mai-provider": {
            contextWindow: 180_000,
            maxOutputTokens: 24_000,
            inputModalities: ["text", "image"],
            reasoningEfforts: ["low", "high"],
            defaultReasoningEffort: "high",
          },
        },
        name: "anthropic",
        type: "anthropic",
      },
      chat: {
        apiKey: "chat-key",
        authType: "authorization",
        baseUrl: "https://chat.example",
        models: { "gpt-chat-provider": {} },
        name: "chat",
        type: "openai-compatible",
      },
    }

    const response = await createApp().request("/v1/models", {
      headers: { "user-agent": "codex-cli/1.0.0" },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      models: Array<Record<string, unknown> & { slug: string }>
    }
    const anthropicModel = body.models.find(
      (model) => model.slug === "anthropic/mai-provider",
    )
    expect(anthropicModel).toMatchObject({
      use_responses_lite: true,
      context_window: 180_000,
      max_output_tokens: 24_000,
      input_modalities: ["text", "image"],
      default_reasoning_level: "high",
      supports_parallel_tool_calls: true,
      supports_search_tool: false,
    })
    expect(body.models.map((model) => model.slug)).toContain(
      "chat/gpt-chat-provider",
    )
  })

  test("adds image input to Kimi Codex models by default", async () => {
    enabledProviders = ["kimi"]
    providerConfigs = {
      kimi: {
        apiKey: "kimi-key",
        authType: "authorization",
        baseUrl: "https://kimi.example",
        name: "kimi",
        type: "openai-compatible",
      },
    }

    const response = await createApp().request("/v1/models", {
      headers: { "user-agent": "codex-cli/1.0.0" },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      models: Array<Record<string, unknown> & { slug: string }>
    }
    expect(
      body.models.find((model) => model.slug === "kimi/mai-kimi-test"),
    ).toMatchObject({ input_modalities: ["text", "image"] })
  })

  test("filters provider-scoped catalogs to OpenAI and MAI models", async () => {
    providerConfigs = {
      mixed: createProviderConfig("mixed", "https://mixed.example"),
    }

    const response = await createApp().request("/mixed/v1/models")

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((model) => model.id)).toEqual([
      "openai/gpt-5.4",
      "MAI-1-preview",
    ])
  })

  test("returns 502 for malformed provider catalog JSON", async () => {
    providerConfigs = {
      kimi: createProviderConfig("kimi", "https://kimi.example"),
    }
    malformedCatalogUrls.add("https://kimi.example/v1/models")

    const response = await createApp().request("/kimi/v1/models")

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      error: {
        message: "Provider 'kimi' returned an invalid models catalog",
        type: "upstream_error",
      },
    })
  })

  test("returns 502 for oversized provider catalogs", async () => {
    providerConfigs = {
      kimi: createProviderConfig("kimi", "https://kimi.example"),
    }
    oversizedCatalogUrls.add("https://kimi.example/v1/models")

    const response = await createApp().request("/kimi/v1/models")

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      error: {
        message: "Provider 'kimi' returned an invalid models catalog",
        type: "upstream_error",
      },
    })
  })

  test("returns 502 for malformed Codex catalog JSON", async () => {
    providerConfigs = {
      codex: {
        apiKey: "codex-token",
        authType: "oauth2",
        baseUrl: "https://ignored.example/backend-api",
        name: "codex",
        type: "openai-responses",
      },
    }
    state.codexAccessToken = "codex-access-token"
    state.codexAccountId = "account-123"
    malformedCatalogUrls.add("https://chatgpt.com/backend-api/codex/models")

    const response = await createApp().request("/codex/v1/models", {
      headers: { "user-agent": "codex-tui/0.144.1" },
    })

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      error: {
        message: "Codex returned an invalid models catalog",
        type: "upstream_error",
      },
    })
  })

  test("returns 502 for oversized Codex catalogs", async () => {
    providerConfigs = {
      codex: {
        apiKey: "codex-token",
        authType: "oauth2",
        baseUrl: "https://ignored.example/backend-api",
        name: "codex",
        type: "openai-responses",
      },
    }
    state.codexAccessToken = "codex-access-token"
    state.codexAccountId = "account-123"
    oversizedCatalogUrls.add("https://chatgpt.com/backend-api/codex/models")

    const response = await createApp().request("/codex/v1/models", {
      headers: { "user-agent": "codex-tui/0.144.1" },
    })

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      error: {
        message: "Codex returned an invalid models catalog",
        type: "upstream_error",
      },
    })
  })

  test("forwards Codex clients on the provider-scoped models route", async () => {
    providerConfigs = {
      codex: {
        apiKey: "codex-token",
        authType: "oauth2",
        baseUrl: "https://ignored.example/backend-api",
        name: "codex",
        type: "openai-responses",
      },
    }
    state.codexAccessToken = "codex-access-token"
    state.codexAccountId = "account-123"

    const response = await createApp().request(
      "/codex/v1/models?client=codex",
      {
        headers: {
          accept: "*/*",
          "user-agent": "codex-tui/0.144.1",
        },
      },
    )

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://chatgpt.com/backend-api/codex/models?client=codex",
    )
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
    expect(headers.get("authorization")).toBe("Bearer codex-access-token")
    expect(headers.get("chatgpt-account-id")).toBe("account-123")
  })

  test("returns built-in Codex models on the provider route without Codex UA", async () => {
    providerConfigs = {
      codex: {
        apiKey: "codex-token",
        authType: "oauth2",
        baseUrl: "https://ignored.example/backend-api",
        name: "codex",
        type: "openai-responses",
      },
    }

    const response = await createApp().request("/codex/v1/models")

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((model) => model.id)).toContain("gpt-6-astra")
    expect(body.data.map((model) => model.id)).toContain("gpt-5.6-sol")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
