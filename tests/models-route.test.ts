import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { ResolvedProviderConfig } from "~/lib/config"
import type { ModelsResponse } from "~/lib/types/models"

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

let codexCatalogModels: Array<Record<string, unknown>> =
  createDefaultCodexCatalogModels()

const fetchMock = mock((url: string | URL | Request, _init?: RequestInit) => {
  const requestUrl =
    typeof url === "string" ? url
    : url instanceof URL ? url.toString()
    : url.url

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
            id: "kimi-k2.5",
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
            id: "deepseek-v4-pro",
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

  if (requestUrl === "https://opencode.example/v1/models") {
    return Promise.resolve(
      Response.json({
        object: "list",
        data: [
          { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
          { id: "gpt-provider-only", name: "GPT Provider Only" },
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

  const providerModelIds: Record<string, string> = {
    "first.example": "first-model",
    "second.example": "second-model",
  }
  const providerModelId =
    providerModelIds[new URL(requestUrl).host] ?? "qwen-plus"

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
      "dash/qwen-plus",
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
      "second/second-model",
      "first/first-model",
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
    expect(body.data.map((model) => model.id)).toEqual(["dash/qwen-plus"])
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
    expect(modelIds).toContain("deepseek/deepseek-v4-flash")
    expect(modelIds).toContain("deepseek/deepseek-v4-pro")
    expect(modelIds).toContain("kimi/k3")
    expect(modelIds).toContain("kimi/k3-256k")
    expect(modelIds).toContain("opencode-go/hy3")
    expect(modelIds).toContain("opencode-go/gpt-5.6-luna")
    expect(
      body.data.find((model) => model.id === "deepseek/deepseek-v4-flash"),
    ).toMatchObject({
      display_name: "deepseek-v4-flash",
      object: "model",
      owned_by: "deepseek",
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  test("ignores providers whose models fetch rejects when merging the Codex catalog", async () => {
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
    expect(body.models.map((model) => model.slug)).toEqual([
      "claude-sonnet-4-6",
    ])
  })

  test("uses pricing models for failed providers in the Codex catalog", async () => {
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
    expect(modelSlugs).toContain("deepseek/deepseek-v4-flash")
    expect(modelSlugs).toContain("kimi/k3")
    expect(modelSlugs).toContain("opencode-go/hy3")
    expect(modelSlugs).toContain("opencode-go/qwen3.7-plus")
    expect(
      body.models.find((model) => model.slug === "deepseek/deepseek-v4-flash"),
    ).toMatchObject({
      context_window: 1_000_000,
      input_modalities: ["text"],
      max_output_tokens: 64_000,
    })
    expect(body.models.find((model) => model.slug === "kimi/k3")).toMatchObject(
      {
        context_window: 1_048_576,
        input_modalities: ["text", "image"],
        max_output_tokens: 64_000,
      },
    )
    expect(
      body.models.find((model) => model.slug === "opencode-go/hy3"),
    ).toMatchObject({
      context_window: 256_000,
      input_modalities: ["text"],
      max_output_tokens: 64_000,
    })
    expect(
      body.models.find((model) => model.slug === "opencode-go/qwen3.7-plus"),
    ).toMatchObject({
      context_window: 1_000_000,
      input_modalities: ["text", "image"],
      max_output_tokens: 64_000,
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  test("prefers user model config over upstream and built-in defaults", async () => {
    enabledProviders = ["deepseek"]
    providerConfigs = {
      deepseek: {
        ...createProviderConfig("deepseek", "https://deepseek.example"),
        models: {
          "deepseek-v4-pro": {
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
      body.models.find((model) => model.slug === "deepseek/deepseek-v4-pro"),
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
      body.models.find((model) => model.slug === "deepseek/deepseek-v4-pro"),
    ).toMatchObject({
      context_window: 128_000,
      input_modalities: ["text", "image"],
      max_output_tokens: 8_000,
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
    expect(body.data.map((model) => model.id)).toContain("codex/gpt-5.4")
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

  test("merges Messages-backed models into the Codex response_lite catalog", async () => {
    const copilotModels = createCopilotModels(["claude-sonnet-4.6"])
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
      "claude-sonnet-4-6",
    ])
    expect(
      body.models.find((model) => model.slug === "claude-sonnet-4-6"),
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
      "gpt-responses-http",
      "gpt-responses-websocket",
    ])
    expect(body.models[0]?.description).toBe(
      "gpt-responses-http through the Copilot Responses API.",
    )
    expect(body.models[1]?.description).toBe(
      "gpt-responses-websocket through the Copilot Responses API.",
    )
  })

  test("uses the default Codex template when the Codex provider is missing", async () => {
    const copilotModels = createCopilotModels(["claude-sonnet-4.6"])
    copilotModels.data[0].supported_endpoints = ["/v1/messages"]
    copilotModels.data[0].capabilities.supports.tool_calls = true
    state.models = copilotModels
    enabledProviders = ["claude"]
    providerConfigs = {
      claude: createProviderConfig("claude", "https://claude.example"),
    }

    const response = await createApp().request("/v1/models?client=codex", {
      headers: { "user-agent": "codex-cli/1.0.0" },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      models: Array<Record<string, unknown> & { slug: string }>
    }
    const synthetic = body.models.find(
      (model) => model.slug === "claude-sonnet-4-6",
    )
    expect(synthetic).toMatchObject({
      display_name: "claude-sonnet-4.6",
    })
    expect(synthetic?.available_in_plans).toContain("pro")
    const modelMessages = synthetic?.model_messages as
      | { instructions_template?: string }
      | undefined
    expect(modelMessages?.instructions_template).toContain(
      "You are Codex, an agent based on GPT-5.",
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
    expect(
      body.models.find((model) => model.slug === "opencode-go/qwen3-coder"),
    ).toMatchObject({ display_name: "Qwen3 Coder (opencode-go)" })
    expect(body.models.map((model) => model.slug)).not.toContain(
      "opencode-go/gpt-provider-only",
    )
  })

  test("orders merged Codex models as catalog, codex, copilot, opencode-go, then providers", async () => {
    const copilotModels = createCopilotModels(["claude-sonnet-4.6"])
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
      "claude-sonnet-4-6",
      "opencode-go/qwen3-coder",
      "kimi/kimi-k2.5",
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
    expect(body.models.map((model) => model.slug)).toEqual([
      "claude-sonnet-4-6",
    ])
  })

  test("prefers max as the built-in default reasoning effort for Codex models", async () => {
    const copilotModels = createCopilotModels([
      "claude-sonnet-4.6",
      "claude-opus-4.1",
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
      body.models.find((model) => model.slug === "claude-sonnet-4-6"),
    ).toMatchObject({ default_reasoning_level: "max" })
    expect(
      body.models.find((model) => model.slug === "claude-opus-4-1"),
    ).toMatchObject({ default_reasoning_level: "low" })
  })

  test("defaults reasoning efforts to high, xhigh, max, and ultra for Codex models", async () => {
    const copilotModels = createCopilotModels(["claude-sonnet-4.6"])
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
    for (const slug of ["claude-sonnet-4-6", "chat/qwen-plus"]) {
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

  test("merges Anthropic and OpenAI-compatible provider models for Codex", async () => {
    enabledProviders = ["anthropic", "chat"]
    providerConfigs = {
      anthropic: {
        apiKey: "anthropic-key",
        authType: "x-api-key",
        baseUrl: "https://anthropic.example",
        models: {
          "claude-provider": {
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
        models: { "chat-provider": {} },
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
      (model) => model.slug === "anthropic/claude-provider",
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
      "chat/chat-provider",
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
      body.models.find((model) => model.slug === "kimi/kimi-k2.5"),
    ).toMatchObject({ input_modalities: ["text", "image"] })
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
    expect(body.data.map((model) => model.id)).toContain("gpt-5.4")
    expect(body.data.map((model) => model.id)).toContain("gpt-5.6-sol")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
