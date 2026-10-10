import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { ResolvedProviderConfig } from "~/lib/config"
import { installModelsDevCatalog } from "~/lib/models-dev-cache"
import { PATHS } from "~/lib/paths"
import { defaultConfig, invalidateConfigCache } from "~/lib/config-store"
import type { ModelsResponse } from "~/lib/types/models"
import type { CodexModelsResponse } from "~/routes/models/codex-models-types"
import {
  isOpencodeUserAgent,
  type OpencodeModel,
} from "~/routes/models/opencode-models"
import bundledCodexCatalogJson from "~/routes/models/models.json"

import {
  modelsDevReleaseModelsFixture,
  modelsDevCatalogFixture,
  modelsDevProviderCatalogFixture,
} from "./fixtures/models-dev-catalog"

const actualConfigModule = await import("~/lib/config")
const actualTokenModule = await import("~/lib/token")

let enabledProviders: Array<string> = []
let providerConfigs: Record<
  string,
  (ResolvedProviderConfig & { enabled?: boolean }) | null
> = {}
let codexSetupError: Error | null = null
let codexCatalogMetadata: Record<string, unknown> = {}
let modelMappings: Record<string, string> = {}
const originalConfigPath = PATHS.CONFIG_PATH
let catalogConfigDir: string | undefined

function setRouteConfig(config: Record<string, unknown>) {
  if (!catalogConfigDir) {
    const tempRoot = path.join(os.tmpdir(), "opencode")
    fs.mkdirSync(tempRoot, { recursive: true })
    catalogConfigDir = fs.mkdtempSync(path.join(tempRoot, "catalog-route-"))
  }
  PATHS.CONFIG_PATH = path.join(catalogConfigDir, "config.json")
  fs.writeFileSync(PATHS.CONFIG_PATH, JSON.stringify(config))
  invalidateConfigCache()
}

function setCatalogLimit(maxModels: number) {
  setRouteConfig({ codexModelCatalog: { maxModels } })
}

function enableCodexCatalog() {
  enabledProviders = ["codex"]
  providerConfigs.codex = {
    name: "codex",
    type: "openai-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    apiKey: "codex-token",
    authType: "oauth2",
  }
  state.codexAccessToken = "codex-access-token"
  state.codexAccountId = "account-123"
}

await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  getProviderConfig: (provider: string) => providerConfigs[provider] ?? null,
  getRawProviderConfig: (provider: string) => providerConfigs[provider] ?? null,
  getModelMappings: () => modelMappings,
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

const bundledCodexModels = (bundledCodexCatalogJson as CodexModelsResponse)
  .models
const bundledCodexSlugs = bundledCodexModels
  .toSorted((a, b) => a.priority - b.priority)
  .map((model) => model.slug)
const CODEX_CATALOG_ETAG = 'W/"catalog-1"'

let codexCatalogModels: Array<Record<string, unknown>> =
  createDefaultCodexCatalogModels()

const fetchModels = (url: string | URL | Request, _init?: RequestInit) => {
  const requestUrl =
    typeof url === "string" ? url
    : url instanceof URL ? url.toString()
    : url.url

  if (requestUrl.startsWith("https://chatgpt.com/backend-api/codex/models")) {
    return Promise.resolve(
      Response.json(
        { ...codexCatalogMetadata, models: codexCatalogModels },
        { headers: { ETag: CODEX_CATALOG_ETAG } },
      ),
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
}
const fetchMock = mock(fetchModels)

function createApp(fullCatalog = true) {
  const app = new Hono()
  // Translation tests inspect every model; quota tests opt into ordinary requests.
  if (fullCatalog)
    app.use("*", async (c, next) => {
      if (c.req.header("user-agent")?.startsWith("codex")) {
        c.req.raw.headers.set("x-full-model-catalog", "true")
      }
      await next()
    })
  app.route("/models", modelRoutes)
  app.route("/v1/models", modelRoutes)
  app.route("/:provider/v1/models", providerModelRoutes)
  return app
}

beforeEach(() => {
  setRouteConfig({})
  installModelsDevCatalog(modelsDevProviderCatalogFixture)
  enabledProviders = []
  providerConfigs = {}
  codexSetupError = null
  codexCatalogMetadata = {}
  modelMappings = { ...defaultConfig.modelMappings }
  codexCatalogModels = createDefaultCodexCatalogModels()
  state.models = undefined
  fetchMock.mockReset()
  fetchMock.mockImplementation(fetchModels)
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    fetchMock as unknown as typeof fetch
})

afterEach(() => {
  PATHS.CONFIG_PATH = originalConfigPath
  invalidateConfigCache()
  if (catalogConfigDir)
    fs.rmSync(catalogConfigDir, { recursive: true, force: true })
  catalogConfigDir = undefined
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch
  state.models = undefined
  state.codexAccessToken = undefined
  state.codexAccountId = undefined
})

describe("model routes", () => {
  test.each([
    ["/dashscope/v1/models", "curl/8.0"],
    ["/v1/models", "curl/8.0"],
    ["/v1/models", "opencode/2.0"],
    ["/v1/models", "claude-cli/2.1"],
    ["/v1/models", "codex/1.0"],
  ])(
    "filters old DashScope releases on %s for %s including explicit selections",
    async (endpoint, userAgent) => {
      installModelsDevCatalog({
        ...modelsDevProviderCatalogFixture,
        "alibaba-cn": { models: modelsDevReleaseModelsFixture },
      })
      enabledProviders = ["dashscope"]
      providerConfigs.dashscope = {
        ...createProviderConfig("dashscope", "https://gateway.example"),
        agentsModels: Object.keys(modelsDevReleaseModelsFixture),
        models: { "before-cutoff": {}, "qwen-plus": {} },
      }
      const response = await createApp().request(endpoint, {
        headers: { "user-agent": userAgent },
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        data?: Array<{ id: string }>
        models?: Array<{ slug: string }>
      }
      const ids =
        body.models?.map((model) => model.slug)
        ?? body.data?.map((model) => model.id)
        ?? []
      const dashScopeIds =
        endpoint.startsWith("/dashscope/") ? ids : (
          ids
            .filter((id) => id.startsWith("dashscope/"))
            .map((id) => id.slice("dashscope/".length))
        )
      const visibleIds = [
        "after-cutoff",
        "invalid-date",
        "on-cutoff",
        "unknown-date",
      ]
      expect(dashScopeIds.sort()).toEqual(
        userAgent.startsWith("claude") ?
          visibleIds.map((id) => `my-claude-${id}[1m]`)
        : visibleIds,
      )
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  test.each<[string, Array<string>]>([
    ["xai", ["grok-4.7", "grok-catalog-only"]],
    ["openrouter", ["openai/gpt-5.1-codex"]],
    ["deepseek", ["deepseek-flash", "deepseek-v4-pro"]],
    ["kimi", ["k3", "k3-256k"]],
    [
      "dashscope",
      [
        "deepseek-v4.1-flash",
        "glm-5.3",
        "kimi-k3",
        "qwen3.7-plus",
        "qwen3.8-flash",
        "qwen3.8-max",
      ],
    ],
  ])(
    "serves cached %s models on both endpoints without provider requests",
    async (provider, ids) => {
      enabledProviders = [provider]
      providerConfigs[provider] = createProviderConfig(
        provider,
        "https://reject.example",
      )
      const app = createApp()
      const raw = await app.request(`/${provider}/v1/models`)
      expect(raw.status).toBe(200)
      const rawBody = (await raw.json()) as { data: Array<{ id: string }> }
      expect(rawBody.data.map((model) => model.id)).toEqual(ids)
      const aggregated = await app.request("/v1/models")
      const body = (await aggregated.json()) as { data: Array<{ id: string }> }
      expect(body.data.map((model) => model.id)).toEqual(
        ids.map((id) => `${provider}/${id}`),
      )
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  test.each(["xai", "openrouter", "deepseek", "kimi", "dashscope"])(
    "returns a local catalog error for missing %s records without remote fallback",
    async (provider) => {
      installModelsDevCatalog(modelsDevCatalogFixture)
      enabledProviders = [provider]
      providerConfigs[provider] = createProviderConfig(
        provider,
        "https://reject.example",
      )
      const raw = await createApp().request(`/${provider}/v1/models`)
      expect(raw.status).toBe(503)
      expect(await raw.json()).toMatchObject({
        error: { type: "service_unavailable" },
      })
      const aggregated = await createApp().request("/v1/models")
      expect(await aggregated.json()).toMatchObject({ data: [] })
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  test("honors explicit models.dev provider mappings while keeping the gateway provider name", async () => {
    enabledProviders = ["kimi"]
    providerConfigs.kimi = {
      ...createProviderConfig("kimi", "https://reject.example"),
      modelsDevProviderId: "openrouter",
    }
    const response = await createApp().request("/v1/models", {
      headers: { "user-agent": "opencode" },
    })
    const { data } = (await response.json()) as { data: Array<OpencodeModel> }
    expect(data[0]).toMatchObject({
      id: "kimi/openai/gpt-5.1-codex",
      limit: { context: 300_000, output: 128_000 },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("keeps Codex catalog discovery remote and Copilot records intact while other providers stay local", async () => {
    enableCodexCatalog()
    enabledProviders.push("xai", "openrouter", "deepseek", "kimi", "dashscope")
    for (const provider of enabledProviders.filter((name) => name !== "codex"))
      providerConfigs[provider] = createProviderConfig(
        provider,
        "https://reject.example",
      )
    state.models = createCopilotModels(["claude-sonnet-4.6"])
    state.models.data[0].supported_endpoints = ["/v1/messages"]
    const original = structuredClone(state.models)
    const response = await createApp().request("/v1/models", {
      headers: { "user-agent": "codex/1.0" },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as CodexModelsResponse
    const slugs = body.models.map((model) => model.slug)
    for (const slug of [
      "gpt-native",
      "claude-sonnet-4-6",
      "xai/grok-catalog-only",
      "openrouter/openai/gpt-5.1-codex",
      "deepseek/deepseek-flash",
      "kimi/k3",
      "dashscope/qwen3.8-max",
    ])
      expect(slugs).toContain(slug)
    expect(state.models).toEqual(original)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toStartWith(
      "https://chatgpt.com/backend-api/codex/models",
    )
  })

  test.each(["curl/8.0", "claude-cli/2.1", "opencode/2.0", "codex/1.0"])(
    "serves cached Alibaba CN discovery for %s without remote requests",
    async (userAgent) => {
      enabledProviders = ["dashscope"]
      providerConfigs.dashscope = createProviderConfig(
        "dashscope",
        "https://reject.example",
      )
      const raw = await createApp().request("/dashscope/v1/models")
      expect(raw.status).toBe(200)
      const rawBody = (await raw.json()) as { data: Array<{ id: string }> }
      expect(rawBody.data).toHaveLength(6)
      expect(rawBody.data.map((model) => model.id)).not.toContain(
        "ZHIPU/GLM-5.3-FlashX",
      )
      const response = await createApp().request("/v1/models", {
        headers: { "user-agent": userAgent },
      })
      expect(response.status).toBe(200)
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  test.each([
    "opencode/2.0.24",
    "custom-client (OpenCode2; Windows)",
    "codex-cli/1.0.0 (opencode integration)",
  ])(
    "returns v2 models when the user agent contains OpenCode: %s",
    async (userAgent) => {
      state.models = createCopilotModels(["gpt-test", "claude-sonnet-4.6"])
      const response = await createApp().request("/v1/models", {
        headers: { "user-agent": userAgent },
      })
      const body = (await response.json()) as {
        data: Array<OpencodeModel>
        has_more: boolean
      }
      expect(response.status).toBe(200)
      expect(response.headers.get("cache-control")).toBe("private, no-store")
      expect(response.headers.get("vary")).toBe("User-Agent")
      expect(body.has_more).toBe(false)
      expect(body.data.map((model) => model.modelID)).toEqual([
        "gpt-test",
        "claude-sonnet-4-6",
      ])
      expect(body.data[0]).toMatchObject({
        providerID: "local",
        package: "@opencode/ai/providers/openai/responses",
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        limit: { context: 200_000, output: 32_000 },
        cost: [],
        status: "active",
      })
      expect(body.data[1].id).not.toContain("[1m]")
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  test("does not treat a missing or unrelated user agent as OpenCode", () => {
    expect(isOpencodeUserAgent(undefined)).toBe(false)
    expect(isOpencodeUserAgent("claude-cli/2.1.258")).toBe(false)
  })

  test.each<{
    name: string
    configured?: unknown
    context: number
    input?: number
    expectedContext: number
    expectedInput?: number
  }>([
    {
      name: "both limits above the default",
      context: 1_000_000,
      input: 900_000,
      expectedContext: 300_000,
      expectedInput: 300_000,
    },
    {
      name: "only context above the default",
      context: 400_000,
      input: 250_000,
      expectedContext: 300_000,
      expectedInput: 250_000,
    },
    {
      name: "both limits below the default",
      context: 200_000,
      input: 180_000,
      expectedContext: 200_000,
      expectedInput: 180_000,
    },
    {
      name: "both limits equal to the default",
      context: 300_000,
      input: 300_000,
      expectedContext: 300_000,
      expectedInput: 300_000,
    },
    {
      name: "missing input stays omitted",
      context: 1_000_000,
      expectedContext: 300_000,
    },
    {
      name: "input still cannot exceed the original context",
      context: 200_000,
      input: 400_000,
      expectedContext: 200_000,
      expectedInput: 200_000,
    },
    {
      name: "a lower configured ceiling",
      configured: 150_000,
      context: 400_000,
      input: 250_000,
      expectedContext: 150_000,
      expectedInput: 150_000,
    },
    {
      name: "a higher configured ceiling",
      configured: 750_000,
      context: 1_000_000,
      input: 900_000,
      expectedContext: 750_000,
      expectedInput: 750_000,
    },
    {
      name: "a higher ceiling never expands limits",
      configured: 1_000_000,
      context: 400_000,
      input: 250_000,
      expectedContext: 400_000,
      expectedInput: 250_000,
    },
    {
      name: "output is unaffected by a low ceiling",
      configured: 10_000,
      context: 400_000,
      input: 250_000,
      expectedContext: 10_000,
      expectedInput: 10_000,
    },
    {
      name: "fractional configuration is rounded down",
      configured: 150_000.9,
      context: 400_000,
      input: 250_000,
      expectedContext: 150_000,
      expectedInput: 150_000,
    },
    ...[0, -1, 0.5, null, "600000"].map((configured) => ({
      name: `invalid ceiling ${JSON.stringify(configured)} uses the default`,
      configured,
      context: 1_000_000,
      input: 900_000,
      expectedContext: 300_000,
      expectedInput: 300_000,
    })),
  ])(
    "applies the OpenCode context window ceiling: $name",
    async ({ configured, context, input, expectedContext, expectedInput }) => {
      setRouteConfig({ opencodeModelContextWindow: configured })
      state.models = createCopilotModels(["gpt-test"])
      state.models.data[0].capabilities.limits = {
        max_context_window_tokens: context,
        ...(input !== undefined && { max_prompt_tokens: input }),
        max_output_tokens: 32_000,
      }
      const original = structuredClone(state.models)
      const response = await createApp().request("/v1/models", {
        headers: { "user-agent": "opencode/2.0.24" },
      })
      expect(response.status).toBe(200)
      const { data } = (await response.json()) as { data: Array<OpencodeModel> }
      expect(data[0].limit).toEqual({
        context: expectedContext,
        ...(expectedInput !== undefined && { input: expectedInput }),
        output: 32_000,
      })
      expect(state.models).toEqual(original)
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  test("caps models.dev limits and per-model overrides without mutating their metadata", async () => {
    setRouteConfig({ opencodeModelContextWindow: 150_000 })
    const catalogModel = {
      id: "catalog-model",
      limit: { context: 1_000_000, input: 900_000, output: 64_000 },
    }
    const originalCatalog = structuredClone(catalogModel)
    installModelsDevCatalog({
      ...modelsDevCatalogFixture,
      catalog: { models: { "catalog-model": catalogModel } },
    })
    enabledProviders = ["custom"]
    providerConfigs.custom = {
      ...createProviderConfig("custom", "https://custom.example"),
      modelsDevProviderId: "catalog",
      models: {
        "catalog-model": { contextWindow: 800_000, maxOutputTokens: 128_000 },
      },
    }
    const originalConfig = structuredClone(providerConfigs.custom)
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(Response.json({ data: [{ id: "catalog-model" }] })),
    )
    const response = await createApp().request("/v1/models", {
      headers: { "user-agent": "opencode" },
    })
    expect(response.status).toBe(200)
    const { data } = (await response.json()) as { data: Array<OpencodeModel> }
    expect(data[0].limit).toEqual({
      context: 150_000,
      input: 150_000,
      output: 128_000,
    })
    expect(catalogModel).toEqual(originalCatalog)
    expect(providerConfigs.custom).toEqual(originalConfig)
  })

  test("uses the new ceiling after the gateway config cache is refreshed", async () => {
    state.models = createCopilotModels(["gpt-test"])
    state.models.data[0].capabilities.limits = {
      max_context_window_tokens: 1_000_000,
      max_prompt_tokens: 900_000,
      max_output_tokens: 128_000,
    }
    for (const ceiling of [150_000, 600_000]) {
      setRouteConfig({ opencodeModelContextWindow: ceiling })
      const response = await createApp().request("/v1/models", {
        headers: { "user-agent": "opencode" },
      })
      expect(response.status).toBe(200)
      const { data } = (await response.json()) as { data: Array<OpencodeModel> }
      expect(data[0].limit).toEqual({
        context: ceiling,
        input: ceiling,
        output: 128_000,
      })
    }
  })

  test.each(["curl/8.0", "claude-cli/2.1.258"])(
    "leaves non-OpenCode model limits unchanged for %s",
    async (userAgent) => {
      setRouteConfig({ opencodeModelContextWindow: 64_000 })
      state.models = createCopilotModels(["gpt-test"])
      const limits = {
        max_context_window_tokens: 1_000_000,
        max_prompt_tokens: 900_000,
        max_output_tokens: 128_000,
      }
      state.models.data[0].capabilities.limits = limits
      const response = await createApp().request("/v1/models", {
        headers: { "user-agent": userAgent },
      })
      expect(response.status).toBe(200)
      const { data } = (await response.json()) as ModelsResponse
      expect(data[0].capabilities.limits).toEqual(limits)
    },
  )

  test("reuses models.dev capabilities, limits and all price tiers over Responses", async () => {
    const catalogModel = {
      id: "catalog-model",
      name: "Catalog Model",
      family: "gpt",
      release_date: "2026-09-01",
      status: "beta",
      tool_call: false,
      modalities: { input: ["text", "image"], output: ["text"] },
      limit: { context: 150_000, input: 120_000, output: 40_000 },
      reasoning_options: [{ type: "effort", values: ["none", "high", "high"] }],
      cost: {
        input: 1,
        output: 3,
        cache_read: 0.1,
        cache_write: 1.25,
        tiers: [
          {
            input: 2,
            output: 6,
            cache_read: 0.2,
            cache_write: 2.5,
            tier: { type: "context", size: 100_000 },
          },
        ],
      },
      provider: {
        npm: "@ai-sdk/openai",
        api: "https://catalog.example/responses",
        headers: { authorization: "upstream-only" },
      },
    }
    const original = structuredClone(catalogModel)
    installModelsDevCatalog({
      ...modelsDevCatalogFixture,
      catalog: { models: { "catalog-model": catalogModel } },
    })
    enabledProviders = ["custom"]
    providerConfigs.custom = {
      ...createProviderConfig("custom", "https://custom.example"),
      modelsDevProviderId: "catalog",
      models: { "catalog-model": { supportPdf: true } },
    }
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(Response.json({ data: [{ id: "catalog-model" }] })),
    )
    const response = await createApp().request("/v1/models", {
      headers: { "user-agent": "opencode/2.0.24" },
    })
    const { data } = (await response.json()) as { data: Array<OpencodeModel> }
    expect(data[0]).toMatchObject({
      id: "custom/catalog-model",
      modelID: "custom/catalog-model",
      package: "@opencode/ai/providers/openai/responses",
      family: "gpt",
      capabilities: {
        tools: false,
        input: ["text", "image", "pdf"],
        output: ["text"],
      },
      limit: catalogModel.limit,
      time: { released: Date.parse(catalogModel.release_date) },
      status: "beta",
      variants: [
        {
          id: "none",
          body: { reasoning: { effort: "none" } },
        },
        { id: "high", body: { reasoning: { effort: "high" } } },
      ],
      cost: [
        { input: 1, output: 3, cache: { read: 0.1, write: 1.25 } },
        {
          input: 2,
          output: 6,
          cache: { read: 0.2, write: 2.5 },
          tier: { type: "context", size: 100_000 },
        },
      ],
    })
    expect(data[0]).not.toHaveProperty("headers")
    expect(data[0]).not.toHaveProperty("settings")
    expect(catalogModel).toEqual(original)
  })

  test("uses Copilot's live limits and looks up catalog prices using its original Claude ID", async () => {
    installModelsDevCatalog({
      ...modelsDevCatalogFixture,
      "github-copilot": {
        models: {
          "claude-sonnet-4.6": {
            id: "claude-sonnet-4.6",
            limit: { context: 1_000_000, output: 64_000 },
            cost: {
              input: 3,
              output: 15,
              context_over_200k: { input: 6, output: 22.5 },
            },
          },
        },
      },
    })
    state.models = createCopilotModels(["claude-sonnet-4.6"])
    state.models.data[0].preview = true
    state.models.data[0].capabilities.limits = {
      max_context_window_tokens: 200_000,
      max_prompt_tokens: 180_000,
      max_output_tokens: 16_000,
    }
    state.models.data[0].capabilities.supports = {
      tool_calls: false,
      vision: true,
      reasoning_effort: ["low", "high"],
    }
    const response = await createApp().request("/v1/models", {
      headers: { "user-agent": "opencode" },
    })
    const { data } = (await response.json()) as { data: Array<OpencodeModel> }
    expect(data[0]).toMatchObject({
      id: "claude-sonnet-4-6",
      limit: { context: 200_000, input: 180_000, output: 16_000 },
      capabilities: { tools: false, input: ["text", "image"] },
      status: "beta",
      cost: [
        { input: 3, output: 15, cache: { read: 0, write: 0 } },
        {
          input: 6,
          output: 22.5,
          cache: { read: 0, write: 0 },
          tier: { type: "context", size: 200_001 },
        },
      ],
    })
  })

  test("applies agent model selections and discovers configured models absent from upstream", async () => {
    enabledProviders = ["custom"]
    providerConfigs["github-copilot"] = {
      ...createProviderConfig("github-copilot", "https://copilot.example"),
      agentsModels: ["claude-sonnet-4-6"],
    }
    providerConfigs.custom = {
      ...createProviderConfig("custom", "https://custom.example"),
      pricingCurrency: "USD",
      agentsModels: ["configured"],
      models: {
        configured: {
          contextWindow: 80_000,
          maxOutputTokens: 12_000,
          inputModalities: ["text", "image"],
          reasoningEfforts: ["high"],
          pricing: { input: 0.5, output: 1, cachedInput: 0.05 },
        },
      },
    }
    state.models = createCopilotModels(["gpt-hidden", "claude-sonnet-4.6"])
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(Response.json({ data: [{ id: "hidden" }] })),
    )
    const response = await createApp().request("/v1/models", {
      headers: { "user-agent": "opencode" },
    })
    const { data } = (await response.json()) as { data: Array<OpencodeModel> }
    expect(data.map((model) => model.id)).toEqual([
      "claude-sonnet-4-6",
      "custom/configured",
    ])
    expect(data[1]).toMatchObject({
      limit: { context: 80_000, output: 12_000 },
      capabilities: { input: ["text", "image"] },
      variants: [{ id: "high" }],
      cost: [{ input: 0.5, output: 1, cache: { read: 0.05, write: 0 } }],
    })
  })

  test.each(["USD", "CNY"])(
    "converts %s pricing overrides to USD",
    async (pricingCurrency) => {
      enabledProviders = ["opencode-go"]
      providerConfigs["opencode-go"] = {
        ...createProviderConfig("opencode-go", "https://unused.example"),
        agentsModels: ["gpt-6-luna"],
        pricingCurrency,
        models: {
          "gpt-6-luna": {
            contextWindow: 10_000,
            maxOutputTokens: 20_000,
            inputModalities: ["text"],
            pricing: {
              input: 1,
              cachedInput: 0.1,
              tiers: [
                { input: 2, output: 8 },
                { input: 1, output: 4, maxInputTokens: 5_000 },
              ],
            },
          },
        },
      }
      const response = await createApp().request("/v1/models", {
        headers: { "user-agent": "opencode" },
      })
      const { data } = (await response.json()) as { data: Array<OpencodeModel> }
      expect(data[0].limit).toEqual({ context: 10_000, output: 10_000 })
      expect(data[0].capabilities.input).toEqual(["text", "pdf"])
      // CNY prices are divided by the fixed 6.7 rate and rounded to 6 decimals.
      expect(data[0].cost).toEqual(
        pricingCurrency === "USD" ?
          [
            { input: 1, output: 4, cache: { read: 0.1, write: 0 } },
            {
              input: 2,
              output: 8,
              cache: { read: 0.1, write: 0 },
              tier: { type: "context", size: 5_001 },
            },
          ]
        : [
            {
              input: 0.149254,
              output: 0.597015,
              cache: { read: 0.014925, write: 0 },
            },
            {
              input: 0.298507,
              output: 1.19403,
              cache: { read: 0.014925, write: 0 },
              tier: { type: "context", size: 5_001 },
            },
          ],
      )
    },
  )

  test("reads Alibaba CN prices in USD for OpenCode", async () => {
    enabledProviders = ["dashscope"]
    providerConfigs.dashscope = createProviderConfig(
      "dashscope",
      "https://dashscope.example",
    )
    providerConfigs.dashscope.agentsModels = ["deepseek-v4.1-flash"]
    const response = await createApp().request("/v1/models", {
      headers: { "user-agent": "opencode" },
    })
    const { data } = (await response.json()) as { data: Array<OpencodeModel> }
    expect(data[0].cost).toEqual([
      {
        input: 0.15,
        output: 0.6,
        cache: { read: 0.003, write: 0 },
      },
    ])
  })

  test("tolerates malformed models.dev metadata and unsupported efforts", async () => {
    enabledProviders = ["custom"]
    providerConfigs.custom = createProviderConfig(
      "custom",
      "https://custom.example",
    )
    installModelsDevCatalog({
      ...modelsDevCatalogFixture,
      custom: {
        models: {
          "broken-pricing": {
            id: "broken-pricing",
            cost: { input: 1, output: 2, tiers: {} },
          },
          "odd-efforts": {
            id: "odd-efforts",
            reasoning_options: [
              null,
              { type: "effort", values: ["high", "minimal", "default", "low"] },
            ],
          },
        },
      },
    })
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        Response.json({
          data: [{ id: "broken-pricing" }, { id: "odd-efforts" }],
        }),
      ),
    )
    const response = await createApp().request("/v1/models", {
      headers: { "user-agent": "opencode" },
    })
    expect(response.status).toBe(200)
    const { data } = (await response.json()) as { data: Array<OpencodeModel> }
    expect(data[0].variants).toEqual([])
    expect(data[0].cost).toEqual([
      { input: 1, output: 2, cache: { read: 0, write: 0 } },
    ])
    expect(data[1].variants).toEqual([
      { id: "high", body: { reasoning: { effort: "high" } } },
      { id: "minimal", body: { reasoning: { effort: "minimal" } } },
      { id: "low", body: { reasoning: { effort: "low" } } },
    ])
    expect(data[1].cost).toEqual([])
  })

  test("keeps unknown pricing empty and preserves published zero prices", async () => {
    enabledProviders = ["custom"]
    providerConfigs.custom = createProviderConfig(
      "custom",
      "https://custom.example",
    )
    installModelsDevCatalog({
      ...modelsDevCatalogFixture,
      custom: {
        models: {
          free: { id: "free", cost: { input: 0, output: 0 } },
          unknown: { id: "unknown" },
        },
      },
    })
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        Response.json({
          data: [{ id: "free" }, { id: "unknown" }, { id: "unknown" }],
        }),
      ),
    )
    const response = await createApp().request("/v1/models", {
      headers: { "user-agent": "opencode" },
    })
    const { data } = (await response.json()) as { data: Array<OpencodeModel> }
    expect(data).toHaveLength(2)
    expect(data[0].cost).toEqual([
      { input: 0, output: 0, cache: { read: 0, write: 0 } },
    ])
    expect(data[1].cost).toEqual([])
    expect(data[1].limit).toEqual({ context: 256_000, output: 32_000 })
  })

  test("discovers OpenRouter modalities and limits from models.dev", async () => {
    enabledProviders = ["openrouter"]
    providerConfigs.openrouter = createProviderConfig(
      "openrouter",
      "https://openrouter.example",
    )
    const response = await createApp().request("/v1/models", {
      headers: { "user-agent": "opencode" },
    })
    const { data } = (await response.json()) as { data: Array<OpencodeModel> }
    expect(data[0]).toMatchObject({
      id: "openrouter/openai/gpt-5.1-codex",
      modelID: "openrouter/openai/gpt-5.1-codex",
      capabilities: { input: ["text", "image"] },
      limit: { context: 300_000, output: 128_000 },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("uses built-in Codex prices and skips unavailable providers for OpenCode", async () => {
    enableCodexCatalog()
    const response = await createApp().request("/v1/models", {
      headers: { "user-agent": "opencode" },
    })
    const { data } = (await response.json()) as { data: Array<OpencodeModel> }
    expect(data.find((model) => model.id === "codex/gpt-6-luna")).toMatchObject(
      {
        capabilities: { input: ["text", "image", "pdf"] },
        limit: { context: 300_000, input: 300_000, output: 128_000 },
        cost: [
          { input: 0.1, output: 0.5, cache: { read: 0.01, write: 0.125 } },
          {
            input: 0.2,
            output: 0.75,
            cache: { read: 0.02, write: 0.25 },
            tier: { type: "context", size: 272_001 },
          },
        ],
      },
    )
    expect(fetchMock).not.toHaveBeenCalled()
    codexSetupError = new Error("codex unavailable")
    const failed = await createApp().request("/v1/models", {
      headers: { "user-agent": "opencode" },
    })
    expect(
      ((await failed.json()) as { data: Array<OpencodeModel> }).data,
    ).toEqual([])
  })

  test.each<{
    vision: ModelsResponse["data"][number]["capabilities"]["limits"]["vision"]
    expectedPdf: boolean
  }>([
    {
      vision: {
        supported_media_types: [
          "image/jpeg",
          "image/png",
          "image/webp",
          "image/gif",
          "application/pdf",
        ],
      },
      expectedPdf: true,
    },
    {
      vision: { supported_media_types: ["image/jpeg", "image/png"] },
      expectedPdf: false,
    },
    {
      vision: { supported_media_types: ["application/pdf", "application/pdf"] },
      expectedPdf: true,
    },
    { vision: { supported_media_types: [] }, expectedPdf: false },
    { vision: {}, expectedPdf: false },
    { vision: undefined, expectedPdf: false },
  ])(
    "derives Copilot PDF input from live supported media types: %j",
    async ({ vision, expectedPdf }) => {
      const catalogModel = {
        id: "gpt-test",
        modalities: { input: ["text", "image"], output: ["text"] },
      }
      const originalCatalogModel = structuredClone(catalogModel)
      installModelsDevCatalog({
        ...modelsDevCatalogFixture,
        "github-copilot": { models: { "gpt-test": catalogModel } },
      })
      state.models = createCopilotModels(["gpt-test"])
      state.models.data[0].capabilities.supports.vision = true
      state.models.data[0].capabilities.limits.vision = vision
      const originalModels = structuredClone(state.models)
      const response = await createApp().request("/v1/models", {
        headers: { "user-agent": "opencode" },
      })

      expect(response.status).toBe(200)
      const { data } = (await response.json()) as { data: Array<OpencodeModel> }
      expect(data).toHaveLength(1)
      expect(data[0].capabilities.input).toEqual(
        expectedPdf ? ["text", "image", "pdf"] : ["text", "image"],
      )
      expect(state.models).toEqual(originalModels)
      expect(catalogModel).toEqual(originalCatalogModel)
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  test.each([
    {
      mediaTypes: ["application/pdf"],
      supportPdf: undefined,
      expectedPdf: true,
    },
    { mediaTypes: ["application/pdf"], supportPdf: false, expectedPdf: false },
    { mediaTypes: ["application/pdf"], supportPdf: true, expectedPdf: true },
    { mediaTypes: ["image/png"], supportPdf: undefined, expectedPdf: false },
    { mediaTypes: ["image/png"], supportPdf: true, expectedPdf: true },
    { mediaTypes: ["image/png"], supportPdf: false, expectedPdf: false },
  ])(
    "lets Copilot model supportPdf override live metadata independently of image support: %j",
    async ({ mediaTypes, supportPdf, expectedPdf }) => {
      state.models = createCopilotModels(["claude-sonnet-4.6"])
      state.models.data[0].capabilities.supports.vision = false
      state.models.data[0].capabilities.limits.vision = {
        supported_media_types: mediaTypes,
      }
      providerConfigs["github-copilot"] = {
        ...createProviderConfig("github-copilot", "https://copilot.example"),
        models: { "claude-sonnet-4.6": { supportPdf } },
      }
      const response = await createApp().request("/v1/models", {
        headers: { "user-agent": "opencode" },
      })

      expect(response.status).toBe(200)
      const { data } = (await response.json()) as { data: Array<OpencodeModel> }
      expect(data).toHaveLength(1)
      expect(data[0].modelID).toBe("claude-sonnet-4-6")
      expect(data[0].capabilities.input).toEqual(
        expectedPdf ? ["text", "pdf"] : ["text"],
      )
    },
  )

  test("updates Copilot PDF discovery when its live model metadata changes", async () => {
    state.models = createCopilotModels(["gpt-test"])
    state.models.data[0].capabilities.supports.vision = true
    for (const mediaTypes of [["application/pdf"], ["image/png"]]) {
      state.models.data[0].capabilities.limits.vision = {
        supported_media_types: mediaTypes,
      }
      const response = await createApp().request("/v1/models", {
        headers: { "user-agent": "opencode" },
      })
      expect(response.status).toBe(200)
      const { data } = (await response.json()) as { data: Array<OpencodeModel> }
      expect(data[0].capabilities.input.includes("pdf")).toBe(
        mediaTypes.includes("application/pdf"),
      )
    }
  })

  test("does not infer other providers' PDF support from Copilot-shaped media metadata", async () => {
    enabledProviders = ["custom"]
    providerConfigs.custom = createProviderConfig(
      "custom",
      "https://custom.example",
    )
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        Response.json({
          data: [
            {
              id: "custom-model",
              capabilities: {
                supports: { vision: true },
                limits: {
                  vision: { supported_media_types: ["application/pdf"] },
                },
              },
            },
          ],
        }),
      ),
    )
    const response = await createApp().request("/v1/models", {
      headers: { "user-agent": "opencode" },
    })
    expect(response.status).toBe(200)
    const { data } = (await response.json()) as { data: Array<OpencodeModel> }
    expect(data[0].capabilities.input).toEqual(["text", "image"])
  })

  test.each(["codex", "xai"])(
    "advertises known PDF input for the %s provider",
    async (provider) => {
      if (provider === "codex") {
        enableCodexCatalog()
      } else {
        enabledProviders = ["xai"]
        providerConfigs.xai = {
          ...createProviderConfig("xai", "https://xai.example"),
          type: "openai-responses",
        }
        fetchMock.mockImplementationOnce(() =>
          Promise.resolve(
            Response.json({
              data: [{ id: "grok-4.7", input_modalities: ["text", "image"] }],
            }),
          ),
        )
      }
      const response = await createApp().request("/v1/models", {
        headers: { "user-agent": "opencode" },
      })
      expect(response.status).toBe(200)
      const { data } = (await response.json()) as { data: Array<OpencodeModel> }
      expect(data.length).toBeGreaterThan(0)
      expect(
        data.find(
          (model) =>
            model.id
            === (provider === "codex" ? "codex/gpt-6-luna" : "xai/grok-4.7"),
        )?.capabilities.input,
      ).toContain("pdf")
      if (provider === "xai")
        expect(
          data.find((model) => model.id === "xai/grok-catalog-only")
            ?.capabilities.input,
        ).not.toContain("pdf")
    },
  )

  test.each(["codex", "xai"])(
    "lets supportPdf=false disable the %s provider PDF default",
    async (provider) => {
      const modelId = provider === "codex" ? "gpt-6-luna" : "grok-4.7"
      if (provider === "codex") {
        enableCodexCatalog()
        providerConfigs.codex!.agentsModels = [modelId]
      } else {
        enabledProviders = ["xai"]
        providerConfigs.xai = {
          ...createProviderConfig("xai", "https://xai.example"),
          type: "openai-responses",
        }
        fetchMock.mockImplementationOnce(() =>
          Promise.resolve(
            Response.json({
              data: [
                { id: modelId, input_modalities: ["text", "image", "pdf"] },
              ],
            }),
          ),
        )
      }
      providerConfigs[provider]!.models = { [modelId]: { supportPdf: false } }
      providerConfigs[provider]!.agentsModels = [modelId]
      const response = await createApp().request("/v1/models", {
        headers: { "user-agent": "opencode" },
      })
      expect(response.status).toBe(200)
      const { data } = (await response.json()) as { data: Array<OpencodeModel> }
      expect(data).toHaveLength(1)
      expect(data[0].capabilities.input).toEqual(["text", "image"])
    },
  )

  test.each(
    [
      { provider: "custom", modelsDevProviderId: "catalog" },
      { provider: "catalog", modelsDevProviderId: undefined },
    ].flatMap((providerConfig) =>
      [undefined, false, true].map((supportPdf) => ({
        ...providerConfig,
        supportPdf,
      })),
    ),
  )(
    "uses models.dev PDF input for $provider with supportPdf=$supportPdf",
    async ({ provider, modelsDevProviderId, supportPdf }) => {
      const catalogModel = {
        id: "gpt-custom",
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
      }
      const originalCatalogModel = structuredClone(catalogModel)
      installModelsDevCatalog({
        ...modelsDevCatalogFixture,
        catalog: { models: { "gpt-custom": catalogModel } },
      })
      enabledProviders = [provider]
      providerConfigs[provider] = {
        ...createProviderConfig(provider, "https://custom.example"),
        modelsDevProviderId,
        models: { "gpt-custom": { supportPdf } },
      }
      fetchMock.mockImplementationOnce(() =>
        Promise.resolve(
          Response.json({
            data: [{ id: "gpt-custom", input_modalities: ["text", "image"] }],
          }),
        ),
      )
      const response = await createApp().request("/v1/models", {
        headers: { "user-agent": "opencode" },
      })
      expect(response.status).toBe(200)
      const { data } = (await response.json()) as { data: Array<OpencodeModel> }
      expect(data[0].modelID).toBe(`${provider}/gpt-custom`)
      expect(data[0].capabilities.input).toEqual(
        supportPdf !== false ? ["text", "image", "pdf"] : ["text", "image"],
      )
      expect(catalogModel).toEqual(originalCatalogModel)
    },
  )

  test.each([undefined, false, true])(
    "uses Copilot's original Claude ID for catalog PDF metadata with supportPdf=%j",
    async (supportPdf) => {
      installModelsDevCatalog({
        ...modelsDevCatalogFixture,
        "github-copilot": {
          models: {
            "claude-sonnet-4.6": {
              id: "claude-sonnet-4.6",
              modalities: { input: ["text", "image", "pdf"], output: ["text"] },
            },
          },
        },
      })
      state.models = createCopilotModels(["claude-sonnet-4.6"])
      state.models.data[0].capabilities.supports.vision = true
      state.models.data[0].capabilities.limits.vision = {
        supported_media_types: ["image/png"],
      }
      providerConfigs["github-copilot"] = {
        ...createProviderConfig("github-copilot", "https://copilot.example"),
        models: { "claude-sonnet-4.6": { supportPdf } },
      }
      const response = await createApp().request("/v1/models", {
        headers: { "user-agent": "opencode" },
      })

      expect(response.status).toBe(200)
      const { data } = (await response.json()) as { data: Array<OpencodeModel> }
      expect(data[0].modelID).toBe("claude-sonnet-4-6")
      expect(data[0].capabilities.input).toEqual(
        supportPdf !== false ? ["text", "image", "pdf"] : ["text", "image"],
      )
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  test.each([
    { modalities: undefined, expectedPdf: false },
    { modalities: { input: ["text"], output: ["pdf"] }, expectedPdf: false },
    { modalities: { input: [], output: ["text"] }, expectedPdf: false },
    { modalities: { input: ["text"], output: ["text"] }, expectedPdf: false },
    {
      modalities: { input: ["text", "pdf"], output: ["text"] },
      expectedPdf: true,
    },
    {
      modalities: { input: ["text", "pdf", "pdf"], output: ["text"] },
      expectedPdf: true,
    },
  ])(
    "only infers PDF from models.dev input modalities: %j",
    async ({ modalities, expectedPdf }) => {
      const catalogModel = { id: "catalog-model", modalities }
      installModelsDevCatalog({
        ...modelsDevCatalogFixture,
        custom: { models: { "catalog-model": catalogModel } },
      })
      enabledProviders = ["custom"]
      providerConfigs.custom = {
        ...createProviderConfig("custom", "https://custom.example"),
        models: { "catalog-model": { inputModalities: ["text"] } },
      }
      fetchMock.mockImplementationOnce(() =>
        Promise.resolve(Response.json({ data: [{ id: "catalog-model" }] })),
      )
      const response = await createApp().request("/v1/models", {
        headers: { "user-agent": "opencode" },
      })
      expect(response.status).toBe(200)
      const { data } = (await response.json()) as { data: Array<OpencodeModel> }
      expect(data[0].capabilities.input).toEqual(
        expectedPdf ? ["text", "pdf"] : ["text"],
      )
    },
  )

  test.each([
    { modelId: "qwen3.7-plus", efforts: ["low", "medium", "xhigh"] },
    { modelId: "qwen3.8-max", efforts: ["low", "medium", "xhigh"] },
    { modelId: "qwen3.8-flash", efforts: ["low", "medium", "xhigh"] },
    { modelId: "deepseek-v4.1-flash", efforts: ["low", "high", "max"] },
    { modelId: "kimi-k3", efforts: ["max"] },
  ])(
    "uses cached DashScope reasoning variants for $modelId",
    async ({ modelId, efforts }) => {
      enabledProviders = ["dashscope"]
      providerConfigs.dashscope = createProviderConfig(
        "dashscope",
        "https://dashscope.example",
      )
      providerConfigs.dashscope.agentsModels = [modelId]
      const response = await createApp().request("/v1/models", {
        headers: { "user-agent": "opencode" },
      })
      const { data } = (await response.json()) as { data: Array<OpencodeModel> }
      expect(data[0].id).toBe(`dashscope/${modelId}`)
      expect(data[0].variants.map((variant) => variant.id)).toEqual(efforts)
      expect(data[0].variants.at(-1)?.body).toEqual({
        reasoning: { effort: efforts.at(-1) },
      })
    },
  )

  test("allows user-configured reasoning levels to override DashScope defaults", async () => {
    enabledProviders = ["dashscope"]
    providerConfigs.dashscope = {
      ...createProviderConfig("dashscope", "https://dashscope.example"),
      agentsModels: ["qwen3.8-max"],
      models: { "qwen3.8-max": { reasoningEfforts: ["medium"] } },
    }
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        Response.json({
          data: [{ id: "qwen3.8-max", reasoning_efforts: ["low", "high"] }],
        }),
      ),
    )
    const response = await createApp().request("/v1/models", {
      headers: { "user-agent": "opencode" },
    })
    const { data } = (await response.json()) as { data: Array<OpencodeModel> }
    expect(data[0].variants).toEqual([
      { id: "medium", body: { reasoning: { effort: "medium" } } },
    ])
  })

  test.each([
    { path: "/v1/models", userAgent: "curl/8.0" },
    { path: "/v1/models", userAgent: "claude-cli/2.1.258" },
    { path: "/custom/v1/models", userAgent: "curl/8.0" },
    { path: "/custom/v1/models", userAgent: "claude-cli/2.1.258" },
  ])(
    "adds provider names to display_name on $path for $userAgent",
    async ({ path, userAgent }) => {
      enabledProviders = ["custom"]
      providerConfigs.custom = createProviderConfig(
        "custom",
        "https://custom.example",
      )
      fetchMock.mockImplementationOnce(() =>
        Promise.resolve(
          Response.json(
            {
              object: "list",
              data: [
                { id: "named-model", name: "Readable model" },
                { id: "id-only" },
                {
                  id: "labeled-model",
                  name: "Other name",
                  display_name: "Upstream label",
                },
                { id: "empty-label", name: "Other name", display_name: "" },
                { id: "null-label", name: "Other name", display_name: null },
              ],
              has_more: false,
            },
            {
              headers: {
                "x-provider-meta": "kept",
                etag: 'W/"upstream-models"',
              },
            },
          ),
        ),
      )
      const response = await createApp().request(path, {
        headers: { "user-agent": userAgent },
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        data: Array<{ display_name: unknown }>
      }
      expect(body.data.map((model) => model.display_name)).toEqual([
        "Readable model (custom)",
        "id-only (custom)",
        "Upstream label (custom)",
        "",
        null,
      ])
      if (path.startsWith("/custom/")) {
        expect(response.headers.get("x-provider-meta")).toBe("kept")
        expect(response.headers.has("etag")).toBe(false)
      }
    },
  )

  test("identifies Copilot in both generated and upstream display names", async () => {
    state.models = createCopilotModels(["gpt-labeled", "gpt-unlabeled"])
    Object.assign(state.models.data[0], {
      display_name: "Existing Copilot label",
    })
    state.models.data[1].name = "Readable Copilot name"
    const response = await createApp().request("/v1/models", {
      headers: { "user-agent": "claude-cli/2.1.258" },
    })
    const body = (await response.json()) as {
      data: Array<{ display_name: string }>
    }
    expect(body.data.map((model) => model.display_name)).toEqual([
      "Existing Copilot label (github-copilot)",
      "Readable Copilot name (github-copilot)",
    ])
    expect(state.models.data[1]).not.toHaveProperty("display_name")
  })

  test("preserves the upstream body and cache validators when display names already identify the provider", async () => {
    providerConfigs.custom = createProviderConfig(
      "custom",
      "https://custom.example",
    )
    const body =
      '{ "data": [{"id":"model","display_name":"Already labeled (custom)"}] }'
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(
        new Response(body, {
          headers: {
            "content-type": "application/json",
            etag: 'W/"upstream-models"',
          },
        }),
      ),
    )
    const response = await createApp().request("/custom/v1/models")
    expect(await response.text()).toBe(body)
    expect(response.headers.get("etag")).toBe('W/"upstream-models"')
  })

  test("does not apply the Codex 1 MiB limit to Claude discovery", async () => {
    state.models = createCopilotModels(["glm-5.3-flash"])
    state.models.data[0].name = "a".repeat(1024 * 1024)
    const response = await createApp().request("/v1/models", {
      headers: { "user-agent": "claude-cli/2.1.258" },
    })
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('"id":"my-claude-glm-5.3-flash[1m]"')
    expect(Buffer.byteLength(body)).toBeGreaterThan(1024 * 1024)
  })

  test.each([
    { body: "upstream error", status: 502 },
    { body: "invalid json", status: 200 },
    { body: '{"models":[]}', status: 200 },
  ])(
    "preserves provider model errors and unrecognized responses: %j",
    async ({ body, status }) => {
      providerConfigs.custom = createProviderConfig(
        "custom",
        "https://custom.example",
      )
      fetchMock.mockImplementationOnce(() =>
        Promise.resolve(new Response(body, { status })),
      )
      const response = await createApp().request("/custom/v1/models")
      expect(response.status).toBe(status)
      expect(await response.text()).toBe(body)
    },
  )

  test.each([
    {
      userAgent: "claude-cli/2.1.258 (external, cli)",
      contextWindow: 200_000,
    },
    {
      userAgent: "vscode_claude_code/2.1.258 (external, sdk-ts)",
      contextWindow: 1_000_000,
    },
    { userAgent: "Claude-Code/2.1.258", contextWindow: undefined },
  ])(
    "adapts discovery IDs only for Claude user agent $userAgent with context $contextWindow",
    async ({ userAgent, contextWindow }) => {
      state.models = createCopilotModels(["gpt-6-luna", "claude-opus-4.8"])
      for (const model of state.models.data) {
        model.capabilities.limits.max_context_window_tokens = contextWindow
      }
      enabledProviders = ["opencode-go"]
      providerConfigs["opencode-go"] = createProviderConfig(
        "opencode-go",
        "https://unused.example",
      )

      const response = await createApp().request("/v1/models", {
        headers: { "user-agent": userAgent },
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        data: Array<{ id: string; claude_model_id?: string; type: string }>
        has_more: boolean
      }
      expect(body.has_more).toBe(false)
      expect(body.data[0]).toMatchObject({
        id: "my-claude-gpt-6-luna[1m]",
        claude_model_id: "my-claude-gpt-6-luna[1m]",
        type: "model",
      })
      expect(body.data[1]).toMatchObject({
        id: "claude-opus-4-8[1m]",
        claude_model_id: "claude-opus-4-8[1m]",
      })
      expect(body.data.every((model) => model.id.endsWith("[1m]"))).toBe(true)
      expect(body.data.map((model) => model.id)).toContain(
        "opencode-go/my-claude-glm-5.3-flash[1m]",
      )
      expect(
        body.data.find(
          (model) => model.id === "opencode-go/my-claude-glm-5.3-flash[1m]",
        ),
      ).toMatchObject({ display_name: "GLM-5.3-Flash (opencode-go)" })
      expect(state.models.data.map((model) => model.id)).toEqual([
        "gpt-6-luna",
        "claude-opus-4.8",
      ])
      expect(fetchMock).not.toHaveBeenCalled()

      const ordinaryResponse = await createApp().request("/v1/models", {
        headers: { "user-agent": "opencode/1.0" },
      })
      const ordinary = (await ordinaryResponse.json()) as {
        data: Array<{ id: string }>
      }
      expect(ordinary.data[0].id).toBe("gpt-6-luna")
      expect(ordinary.data.map((model) => model.id)).toContain(
        "opencode-go/glm-5.3-flash",
      )
    },
  )

  test("applies provider selections to Claude discovery using raw model IDs", async () => {
    state.models = createCopilotModels([
      "claude-opus-4.8",
      "claude-sonnet-4.6",
      "gpt-6-luna",
    ])
    enabledProviders = ["opencode-go", "custom", "hidden"]
    providerConfigs = {
      "github-copilot": {
        ...createProviderConfig("github-copilot", "https://unused.example"),
        agentsModels: ["claude-opus-4-8", "gpt-6-luna"],
      },
      "opencode-go": {
        ...createProviderConfig("opencode-go", "https://unused.example"),
        agentsModels: ["glm-5.3-flash"],
      },
      custom: {
        ...createProviderConfig("custom", "https://custom.example"),
        agentsModels: ["qwen-plus", "anthropic/claude-opus-4.8", "new-model"],
      },
      hidden: {
        ...createProviderConfig("hidden", "https://hidden.example"),
        agentsModels: [],
      },
    }

    const response = await createApp().request("/v1/models", {
      headers: { "user-agent": "Claude-Code/2.1.258" },
    })
    const body = (await response.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((model) => model.id)).toEqual([
      "claude-opus-4-8[1m]",
      "my-claude-gpt-6-luna[1m]",
      "opencode-go/my-claude-glm-5.3-flash[1m]",
      "custom/my-claude-qwen-plus[1m]",
      "custom/anthropic/claude-opus-4.8[1m]",
      "custom/my-claude-new-model[1m]",
    ])

    const ordinaryResponse = await createApp().request("/v1/models")
    const ordinary = (await ordinaryResponse.json()) as {
      data: Array<{ id: string }>
    }
    expect(ordinary.data.map((model) => model.id)).toContain("hidden/qwen-plus")
    expect(ordinary.data.map((model) => model.id)).toContain(
      "claude-sonnet-4-6",
    )
  })

  test("preserves raw Copilot selections and Codex provider IDs for Claude discovery", async () => {
    enableCodexCatalog()
    state.models = createCopilotModels(["claude-opus-4.8", "gpt-6-luna"])
    providerConfigs["github-copilot"] = {
      ...createProviderConfig("github-copilot", "https://unused.example"),
      agentsModels: ["claude-opus-4.8"],
    }
    providerConfigs.codex!.agentsModels = ["gpt-6-luna"]

    const response = await createApp().request("/v1/models", {
      headers: { "user-agent": "claude-cli/2.1.258" },
    })
    const body = (await response.json()) as { data: Array<{ id: string }> }
    expect(body.data.map((model) => model.id)).toEqual([
      "claude-opus-4-8[1m]",
      "codex/my-claude-gpt-6-luna[1m]",
    ])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("serves an empty Claude discovery list when every source is hidden", async () => {
    state.models = createCopilotModels(["gpt-6-luna"])
    providerConfigs["github-copilot"] = {
      ...createProviderConfig("github-copilot", "https://unused.example"),
      agentsModels: [],
    }
    const response = await createApp().request("/v1/models", {
      headers: { "user-agent": "claude-cli/2.1.258" },
    })
    expect(await response.json()).toEqual({
      object: "list",
      data: [],
      has_more: false,
    })
  })

  test("ignores legacy count limits and strips full-export headers from all upstreams", async () => {
    enableCodexCatalog()
    enabledProviders.push("opencode-go")
    providerConfigs["opencode-go"] = createProviderConfig(
      "opencode-go",
      "https://opencode.example",
    )
    setCatalogLimit(1)
    const response = await createApp(false).request(
      "/models?client_version=0.160.0",
      {
        headers: {
          "user-agent": "codex-tui/0.160.0",
          "X-Full-Model-Catalog": "false",
        },
      },
    )
    const body = (await response.json()) as CodexModelsResponse
    expect(body.models.length).toBeGreaterThan(1)
    expect(body.models[0]).not.toHaveProperty("base_instructions")
    expect(body.models[0].model_messages.instructions_template).toBe(
      "Native instructions",
    )
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    for (const call of fetchMock.mock.calls) {
      expect(new Headers(call[1]?.headers).has("x-full-model-catalog")).toBe(
        false,
      )
    }
  })
  test("full export preserves configured selections despite the default exclusions and quotas", async () => {
    enabledProviders = ["custom"]
    providerConfigs = {
      codex: {
        ...createProviderConfig("codex", "https://unused.example"),
        enabled: false,
      },
      custom: {
        ...createProviderConfig("custom", "https://bad.example"),
        agentsModels: ["gpt-5.5", "chosen"],
        models: { "gpt-5.5": {}, chosen: {}, hidden: {} },
      },
    }
    setCatalogLimit(1)
    state.models = createCopilotModels(
      Array.from({ length: 25 }, (_, i) => `auto-${i}`),
    )
    for (const record of state.models.data)
      record.supported_endpoints = ["/v1/messages"]
    const response = await createApp(false).request(
      "/models?client_version=0.160.0",
      {
        headers: {
          "user-agent": "codex-tui/0.160.0",
          "x-full-model-catalog": "true",
        },
      },
    )
    const body = (await response.json()) as CodexModelsResponse
    const slugs = body.models.map((model) => model.slug)
    expect(slugs).toContain("custom/gpt-5.5")
    expect(slugs).toContain("custom/chosen")
    expect(slugs).not.toContain("custom/hidden")
    expect(slugs).not.toContain("codex/gpt-native")
    expect(body.models.length).toBeGreaterThan(20)
    const ordinary = await createApp(false).request(
      "/models?client_version=0.160.0",
      { headers: { "user-agent": "codex-tui/0.160.0" } },
    )
    const limited = (await ordinary.json()) as CodexModelsResponse
    expect(limited.models.length).toBeGreaterThan(1)
    expect(limited.models.map((model) => model.slug)).toContain(
      "custom/gpt-5.5",
    )
    expect(Buffer.byteLength(JSON.stringify(limited))).toBeLessThanOrEqual(
      1024 * 1024,
    )
    providerConfigs.custom!.baseUrl = "https://ordinary.example"
    const normal = await createApp(false).request("/v1/models")
    const normalBody = (await normal.json()) as { data: Array<{ id: string }> }
    expect(normalBody.data.map((model) => model.id)).toContain(
      "custom/qwen-plus",
    )
  })
  test.each([
    { source: "gpt-native", target: undefined, includeAlias: true },
    { source: "gpt-native", target: "codex/gpt-native", includeAlias: false },
    { source: "gpt-native", target: "gpt-native", includeAlias: true },
    { source: "gpt-native", target: "custom/gpt-native", includeAlias: true },
    { source: "gpt-native", target: "codex/other-model", includeAlias: true },
    { source: "other-name", target: "codex/gpt-native", includeAlias: true },
  ])(
    "omits a Codex alias only when its bare name maps to that same model: %j",
    async ({ source, target, includeAlias }) => {
      enableCodexCatalog()
      if (target !== undefined) modelMappings[source] = target
      for (const fullCatalog of [false, true]) {
        const response = await createApp(false).request("/models", {
          headers: {
            "user-agent": "codex-tui/0.160.0",
            ...(fullCatalog ? { "x-full-model-catalog": "true" } : {}),
          },
        })
        expect(response.status).toBe(200)
        const body = (await response.json()) as CodexModelsResponse
        expect(body.models.map((model) => model.slug)).toEqual(
          includeAlias ? ["gpt-native", "codex/gpt-native"] : ["gpt-native"],
        )
        expect(body.models[0]).toMatchObject({
          display_name: "GPT Native",
          model_messages: { instructions_template: "Native instructions" },
        })
      }
    },
  )
  test("omits default review and reserve aliases while retaining their bare catalog entries", async () => {
    enableCodexCatalog()
    codexCatalogModels = ["codex-auto-review", "gpt-reserve"].map((slug) => ({
      ...createDefaultCodexCatalogModels()[0],
      slug,
    }))
    const response = await createApp(false).request("/models", {
      headers: { "user-agent": "codex-tui/0.160.0" },
    })
    const body = (await response.json()) as CodexModelsResponse
    expect(body.models.map((model) => model.slug)).toEqual([
      "codex-auto-review",
      "gpt-reserve",
    ])
  })
  test.each(["codex-auto-review", "gpt-reserve"])(
    "retains the Codex alias when the default %s mapping is overridden",
    async (slug) => {
      enableCodexCatalog()
      modelMappings[slug] = slug
      codexCatalogModels = [{ ...createDefaultCodexCatalogModels()[0], slug }]
      const response = await createApp(false).request("/models", {
        headers: { "user-agent": "codex-tui/0.160.0" },
      })
      const body = (await response.json()) as CodexModelsResponse
      expect(body.models.map((model) => model.slug)).toEqual([
        slug,
        `codex/${slug}`,
      ])
    },
  )
  test("filters Codex native models and aliases without discarding the synthesis template", async () => {
    enableCodexCatalog()
    providerConfigs.codex!.agentsModels = ["gpt-native"]
    codexCatalogModels.push({ ...codexCatalogModels[0], slug: "hidden-native" })
    const response = await createApp(false).request(
      "/models?client_version=0.160.0",
      {
        headers: {
          "user-agent": "codex-tui/0.160.0",
          "x-full-model-catalog": "true",
        },
      },
    )
    const body = (await response.json()) as CodexModelsResponse
    expect(body.models.map((model) => model.slug)).toEqual([
      "gpt-native",
      "codex/gpt-native",
    ])
    providerConfigs.codex!.agentsModels = []
    const empty = await createApp(false).request("/models", {
      headers: { "user-agent": "codex-tui/0.160.0" },
    })
    expect(((await empty.json()) as CodexModelsResponse).models).toEqual([])
  })
  test.each(["claude-sonnet-4.6", "claude-sonnet-4-6"])(
    "keeps the Copilot Claude model selected as %s",
    async (selectedId) => {
      const copilotModels = createCopilotModels(["claude-sonnet-4.6"])
      copilotModels.data[0].supported_endpoints = ["/v1/messages"]
      state.models = copilotModels
      providerConfigs["github-copilot"] = {
        ...createProviderConfig(
          "github-copilot",
          "https://api.githubcopilot.com",
        ),
        agentsModels: [selectedId],
      }

      const response = await createApp().request("/v1/models", {
        headers: { "user-agent": "codex-cli/1.0.0" },
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as CodexModelsResponse
      expect(body.models.map((model) => model.slug)).toEqual([
        "claude-sonnet-4-6",
      ])
    },
  )

  test("returns a small 502 when catalog metadata alone exceeds the byte budget", async () => {
    enableCodexCatalog()
    codexCatalogMetadata = { huge: "x".repeat(1024 * 1024) }
    const response = await createApp(false).request("/models", {
      headers: { "user-agent": "codex-tui/0.160.0" },
    })
    expect(response.status).toBe(502)
    expect((await response.text()).length).toBeLessThan(200)
  })
  test("applies the same policy to provider-scoped Codex catalogs", async () => {
    enableCodexCatalog()
    providerConfigs.codex!.agentsModels = ["gpt-native"]
    codexCatalogModels.push({ ...codexCatalogModels[0], slug: "hidden-native" })
    const response = await createApp(false).request(
      "/codex/v1/models?client_version=0.160.0",
      {
        headers: {
          "user-agent": "codex-tui/0.160.0",
          "X-Full-Model-Catalog": "true",
        },
      },
    )
    const body = (await response.json()) as CodexModelsResponse
    expect(body.models.map((model) => model.slug)).toEqual(["gpt-native"])
    expect(body.models[0]).not.toHaveProperty("base_instructions")
    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has(
        "x-full-model-catalog",
      ),
    ).toBe(false)
  })
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

  test.each([
    {
      userAgent: "curl/8.0",
      copilotId: "claude-opus-4-8",
      providerId: "custom/shared-model",
      providerDisplayName: "First provider model (custom)",
    },
    {
      userAgent: "claude-cli/2.1.258",
      copilotId: "claude-opus-4-8[1m]",
      providerId: "custom/my-claude-shared-model[1m]",
      providerDisplayName: "First provider model (custom)",
    },
    {
      userAgent: "codex-tui/0.160.0 claude",
      copilotId: "claude-opus-4-8",
      providerId: "custom/shared-model",
      providerDisplayName: "Last provider model (custom)",
    },
  ])(
    "deduplicates normalized IDs and ignores malformed provider records for $userAgent",
    async ({ userAgent, copilotId, providerId, providerDisplayName }) => {
      state.models = createCopilotModels(["claude-opus-4.8", "claude-opus-4-8"])
      state.models.data[0].name = "First Copilot model"
      state.models.data[1].name = "Last Copilot model"
      for (const model of state.models.data) {
        model.supported_endpoints = ["/v1/messages"]
      }
      const originalModels = JSON.stringify(state.models)
      enabledProviders = ["custom"]
      providerConfigs.custom = createProviderConfig(
        "custom",
        "https://custom.example",
      )
      fetchMock.mockImplementationOnce(() =>
        Promise.resolve(
          Response.json({
            data: [
              null,
              false,
              [],
              {},
              { id: 42 },
              { id: "" },
              { id: " " },
              { id: "shared-model", name: "First provider model" },
              { id: "shared-model", name: "Last provider model" },
            ],
          }),
        ),
      )

      const response = await createApp().request("/v1/models", {
        headers: {
          "user-agent": userAgent,
          "x-full-model-catalog": "true",
        },
      })
      expect(response.status).toBe(200)
      if (userAgent.startsWith("codex")) {
        const body = (await response.json()) as CodexModelsResponse
        const models = body.models.filter(
          (model) =>
            model.slug === copilotId || model.slug.startsWith("custom/"),
        )
        expect(models.map((model) => model.slug)).toEqual([
          copilotId,
          providerId,
        ])
        expect(models[0].display_name).toBe("First Copilot model")
        expect(models[1].display_name).toBe(providerDisplayName)
      } else {
        const body = (await response.json()) as {
          data: Array<{ id: string; display_name: string }>
        }
        expect(body.data.map((model) => model.id)).toEqual([
          copilotId,
          providerId,
        ])
        expect(body.data[0].display_name).toBe(
          "First Copilot model (github-copilot)",
        )
        expect(body.data[1].display_name).toBe(providerDisplayName)
      }
      expect(JSON.stringify(state.models)).toBe(originalModels)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(
        new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has(
          "x-full-model-catalog",
        ),
      ).toBe(false)
    },
  )

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

  test("uses the models.dev catalog even when provider models endpoints are unavailable", async () => {
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
    expect(modelIds).toContain("deepseek/deepseek-flash")
    expect(modelIds).toContain("deepseek/deepseek-v4-pro")
    expect(modelIds).toContain("kimi/k3")
    expect(modelIds).toContain("kimi/k3-256k")
    expect(modelIds).toContain("opencode-go/gpt-6-luna")
    expect(modelIds).not.toContain("opencode-go/grok-4.5")
    expect(
      body.data.find((model) => model.id === "deepseek/deepseek-flash"),
    ).toMatchObject({
      display_name: "DeepSeek V4.1 Flash (deepseek)",
      object: "model",
      owned_by: "deepseek",
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("serves OpenCode Go provider models from models.dev without upstream fetch", async () => {
    providerConfigs = {
      "opencode-go": createProviderConfig(
        "opencode-go",
        "https://opencode.example",
      ),
    }

    const response = await createApp().request("/opencode-go/v1/models")

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      object: string
      data: Array<Record<string, unknown> & { id: string }>
    }
    expect(body.object).toBe("list")
    const modelIds = body.data.map((model) => model.id)
    expect(modelIds).toEqual([...modelIds].sort())
    expect(
      body.data.find((model) => model.id === "glm-5.3-flash"),
    ).toMatchObject({
      name: "GLM-5.3-Flash",
      display_name: "GLM-5.3-Flash (opencode-go)",
      context_window: 1_000_000,
      max_output_tokens: 131_072,
      input_modalities: ["text", "image"],
      reasoning_efforts: ["low", "high", "max"],
    })
    expect(body.data.map((model) => model.id)).not.toContain("grok-4.5")
    expect(fetchMock).not.toHaveBeenCalled()
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
    expect(response.headers.get("etag")).toBeNull()
    const body = (await response.json()) as CodexModelsResponse
    expect(body.models.map((model) => model.slug)).toEqual([
      ...bundledCodexSlugs,
      "claude-sonnet-4-6",
    ])
  })

  test("uses models.dev provider records in the Codex catalog without provider discovery", async () => {
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
    const body = (await response.json()) as CodexModelsResponse
    const modelSlugs = body.models.map((model) => model.slug)
    expect(modelSlugs).toContain("deepseek/deepseek-flash")
    expect(modelSlugs).toContain("kimi/k3")
    expect(modelSlugs).toContain("opencode-go/qwen3.7-plus")
    expect(
      body.models.find((model) => model.slug === "deepseek/deepseek-flash"),
    ).toMatchObject({
      context_window: 1_000_000,
      input_modalities: ["text", "image"],
      max_output_tokens: 393_216,
      shell_type: "shell_command",
    })
    expect(body.models.find((model) => model.slug === "kimi/k3")).toMatchObject(
      {
        context_window: 1_048_576,
        input_modalities: ["text", "image"],
        max_output_tokens: 64_000,
      },
    )
    expect(
      body.models.find((model) => model.slug === "opencode-go/qwen3.7-plus"),
    ).toMatchObject({
      context_window: 1_000_000,
      input_modalities: ["text", "image"],
      max_output_tokens: 64_000,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("prefers user model config over upstream and built-in defaults", async () => {
    installModelsDevCatalog({
      ...modelsDevCatalogFixture,
      deepseek: {
        models: { "deepseek-v4-pro": { limit: { output: 48_000 } } },
      },
    })
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

  test("prefers models.dev capabilities over built-in catalog defaults", async () => {
    installModelsDevCatalog({
      ...modelsDevCatalogFixture,
      deepseek: {
        models: {
          "deepseek-v4-pro": {
            id: "deepseek-v4-pro",
            limit: { context: 128_000, output: 48_000 },
            modalities: { input: ["text", "image"], output: ["text"] },
          },
        },
      },
    })
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
      max_output_tokens: 48_000,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("uses models.dev output limits before built-in defaults in the Codex catalog", async () => {
    installModelsDevCatalog({
      ...modelsDevCatalogFixture,
      "kimi-code-plan-cn": {
        models: {
          "kimi-k2.5": { id: "kimi-k2.5", limit: { output: 131_072 } },
        },
      },
    })
    enabledProviders = ["kimi"]
    providerConfigs.kimi = createProviderConfig("kimi", "https://kimi.example")

    const response = await createApp().request("/v1/models", {
      headers: { "user-agent": "codex-cli/0.160.0" },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as CodexModelsResponse
    expect(
      body.models.find((model) => model.slug === "kimi/kimi-k2.5")
        ?.max_output_tokens,
    ).toBe(131_072)
  })

  test.each([undefined, "catalog-provider", "openrouter"])(
    "uses models.dev mapping %j for namespaced model output limits",
    async (modelsDevProviderId) => {
      installModelsDevCatalog({
        ...modelsDevCatalogFixture,
        [modelsDevProviderId ?? "custom"]: {
          models: { "org/claude-model": { limit: { output: 65_536 } } },
        },
      })
      enabledProviders = ["custom"]
      providerConfigs.custom = {
        ...createProviderConfig("custom", "https://custom.example"),
        modelsDevProviderId,
        models: { "org/claude-model": {} },
      }

      const response = await createApp().request("/v1/models", {
        headers: { "user-agent": "codex-cli/0.160.0" },
      })

      expect(response.status).toBe(200)
      const body = (await response.json()) as CodexModelsResponse
      expect(
        body.models.find((model) => model.slug === "custom/org/claude-model")
          ?.max_output_tokens,
      ).toBe(65_536)
      expect(
        body.models.find((model) => model.slug === "custom/qwen-plus")
          ?.max_output_tokens,
      ).toBe(32_000)
    },
  )

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
      input_modalities: ["text", "image"],
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("adds built-in Codex models on both model routes without calling upstream", async () => {
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

    for (const path of ["/models", "/v1/models"]) {
      const response = await createApp().request(path)

      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        data: Array<{
          capabilities: {
            limits: Record<string, number>
            supports: Record<string, unknown>
          }
          id: string
          name: string
        }>
      }
      expect(body.data.map((model) => model.id)).toContain("codex/gpt-6-astra")
      expect(body.data.map((model) => model.id)).toContain(
        "codex/codex-auto-review",
      )
      expect(body.data.map((model) => model.id)).toContain("codex/gpt-reserve")
      expect(body.data.map((model) => model.id)).toContain("codex/gpt-5.6-sol")
      expect(
        body.data.find((model) => model.id === "codex/gpt-6.1-sol"),
      ).toMatchObject({
        capabilities: {
          limits: {
            max_context_window_tokens: 872_000,
            max_output_tokens: 128_000,
            max_prompt_tokens: 872_000,
          },
          supports: {
            reasoning_effort: ["low", "medium", "high", "xhigh", "max"],
            vision: true,
          },
        },
        id: "codex/gpt-6.1-sol",
        name: "GPT-6.1 Sol",
      })
    }
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
    expect(response.headers.get("etag")).toBeNull()
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
    expect(response.headers.get("etag")).toBeNull()
    expect(response.headers.get("cache-control")).toBe("private, no-store")
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

  test("describes non-GPT Responses-capable Copilot models as adapter-backed", async () => {
    const copilotModels = createCopilotModels([
      "claude-sonnet-4.6",
      "gemini-3-pro",
    ])
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
      body.models.find((model) => model.slug === "claude-sonnet-4-6")
        ?.description,
    ).toBe("claude-sonnet-4.6 through the Copilot Messages adapter.")
    expect(
      body.models.find((model) => model.slug === "gemini-3-pro")?.description,
    ).toBe("gemini-3-pro through the Copilot Messages-to-Responses adapter.")
  })

  test("uses the bundled Codex catalog when the Codex provider is missing", async () => {
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
    const body = (await response.json()) as CodexModelsResponse
    const synthetic = body.models.find(
      (model) => model.slug === "claude-sonnet-4-6",
    )
    const template = bundledCodexModels.find(
      (model) =>
        model.visibility === "list" && model.supported_in_api !== false,
    )
    if (!template) {
      throw new Error("Bundled Codex catalog has no visible API model")
    }
    expect(body.models).toContainEqual(template)
    const gpt61Sol = body.models.find((model) => model.slug === "gpt-6.1-sol")
    expect(gpt61Sol).toMatchObject({
      context_window: 272_000,
      default_reasoning_level: "low",
      input_modalities: ["text", "image"],
      max_context_window: 872_000,
      multi_agent_reasoning_effort: "xhigh",
      supported_in_api: true,
      visibility: "list",
    })
    expect(
      gpt61Sol?.supported_reasoning_levels.map((level) => level.effort),
    ).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"])
    expect(synthetic).toMatchObject({
      display_name: "claude-sonnet-4.6",
      shell_type: template?.shell_type,
      available_in_plans: template?.available_in_plans,
    })
    expect(synthetic?.model_messages.instructions_template).toBe(
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
    const expectedSol: Record<string, unknown> & { slug: string } = {
      ...solCatalogModel,
      model_messages: {
        ...bundledCodexCatalogJson.models[0].model_messages,
        instructions_template: solCatalogModel.base_instructions,
      },
    }
    const expectedLuna: Record<string, unknown> & { slug: string } = {
      ...lunaCatalogModel,
      model_messages: {
        ...bundledCodexCatalogJson.models[0].model_messages,
        instructions_template: lunaCatalogModel.base_instructions,
      },
    }
    delete expectedSol.base_instructions
    delete expectedLuna.base_instructions
    expect(body.models.find((model) => model.slug === "gpt-5.6-sol")).toEqual(
      expectedSol,
    )
    expect(
      body.models.find((model) => model.slug === "codex/gpt-5.6-sol"),
    ).toEqual({
      ...expectedSol,
      slug: "codex/gpt-5.6-sol",
      display_name: "codex GPT-5.6 Sol",
      priority: 1_000,
    })
    expect(
      body.models.find((model) => model.slug === "opencode-go/gpt-5.6-luna"),
    ).toEqual({
      ...expectedLuna,
      slug: "opencode-go/gpt-5.6-luna",
      display_name: "opencode-go GPT-5.6 Luna",
      priority: expect.any(Number),
    })
    expect(
      body.models.find((model) => model.slug === "codex/gpt-remote-only"),
    ).toEqual({
      ...remoteOnlyCatalogModel,
      model_messages: bundledCodexCatalogJson.models[0].model_messages,
      slug: "codex/gpt-remote-only",
      display_name: "codex GPT Remote Only",
      priority: 1_002,
    })
    expect(
      body.models.find((model) => model.slug === "opencode-go/qwen3.7-plus"),
    ).toMatchObject({ display_name: "Qwen3.7 Plus (opencode-go)" })
    expect(
      body.models.find(
        (model) => model.slug === "opencode-go/gpt-provider-only",
      ),
    ).toMatchObject({ display_name: "GPT Provider Only (opencode-go)" })
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
    const slugs = body.models.map((model) => model.slug)
    expect(slugs.slice(0, 3)).toEqual([
      "gpt-native",
      "codex/gpt-native",
      "claude-sonnet-4-6",
    ])
    expect(slugs).toContain("opencode-go/grok-4.7")
    expect(slugs).toContain("opencode-go/qwen3.7-plus")
    expect(slugs).not.toContain("opencode-go/grok-4.5")
    const kimiIndex = slugs.indexOf("kimi/k3")
    expect(slugs.slice(kimiIndex)).toEqual(["kimi/k3", "kimi/k3-256k"])
    expect(
      slugs
        .slice(3, kimiIndex)
        .every((slug) => slug.startsWith("opencode-go/")),
    ).toBe(true)
    const priorities = body.models.map((model) =>
      typeof model.priority === "number" ? model.priority : 0,
    )
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b))
  })

  test("uses bundled aliases when Codex catalog is malformed and skips malformed Copilot records", async () => {
    const copilotModels = createCopilotModels(["claude-sonnet-4.6"])
    copilotModels.data[0].supported_endpoints = ["/v1/messages"]
    copilotModels.data[0].capabilities.supports.tool_calls = true
    copilotModels.data.push({
      id: "broken-model",
    } as unknown as ModelsResponse["data"][number])
    state.models = copilotModels
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
    codexCatalogModels = [{ id: "invalid-model-without-slug" }]
    state.codexAccessToken = "codex-access-token"
    state.codexAccountId = "account-123"

    const response = await createApp().request("/v1/models?client=codex", {
      headers: { "user-agent": "codex-cli/1.0.0" },
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as CodexModelsResponse
    const slugs = body.models.map((model) => model.slug)
    expect(slugs).toContain("gpt-6.1-sol")
    expect(slugs).toContain("codex/gpt-6.1-sol")
    expect(slugs).toContain("claude-sonnet-4-6")
    expect(slugs).not.toContain("broken-model")
  })

  test("defaults Codex models to max or the first supported reasoning effort", async () => {
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
    enabledProviders = ["opencode-go"]
    providerConfigs = {
      "opencode-go": createProviderConfig(
        "opencode-go",
        "https://opencode.example",
      ),
    }

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
    expect(
      body.models.find((model) => model.slug === "opencode-go/hy3"),
    ).toMatchObject({ default_reasoning_level: "none" })
    expect(
      body.models.find((model) => model.slug === "opencode-go/grok-4.7"),
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

  test("uses the cached input modalities for each Kimi Codex model", async () => {
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
      body.models.find((model) => model.slug === "kimi/k3-256k"),
    ).toMatchObject({ input_modalities: ["text"] })
    expect(body.models.find((model) => model.slug === "kimi/k3")).toMatchObject(
      {
        input_modalities: ["text", "image"],
      },
    )
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
