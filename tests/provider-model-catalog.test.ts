import { beforeEach, describe, expect, test } from "bun:test"

import {
  getModelsDevProviderModelRecords,
  installModelsDevCatalog,
} from "~/lib/models-dev-cache"
import { resolveProviderConfigForModel } from "~/lib/provider-config"
import { resolveProviderEndpointUrl } from "~/services/providers/provider-proxy"
import {
  getLocalProviderModelRecords,
  getProviderModelConfig,
  resolveProviderModelsDevId,
} from "~/lib/provider-model-catalog"

import {
  modelsDevReleaseModelsFixture,
  modelsDevProviderCatalogFixture,
} from "./fixtures/models-dev-catalog"

beforeEach(() => installModelsDevCatalog(modelsDevProviderCatalogFixture))

describe("provider model catalogs", () => {
  test.each<[string | undefined, string]>([
    ["https://api.kimi.com/coding", "kimi-code-plan-cn"],
    ["https://api.kimi.ai/coding", "kimi-code-plan-global"],
    ["https://api.moonshot.ai/v1", "moonshotai"],
    ["https://api.moonshot.cn/v1", "moonshotai-cn"],
    ["https://custom.example", "kimi-code-plan-cn"],
    ["invalid", "kimi-code-plan-cn"],
    [undefined, "kimi-code-plan-cn"],
  ])("matches the Kimi catalog for %s", (baseUrl, expected) => {
    expect(resolveProviderModelsDevId("kimi", { baseUrl })).toBe(expected)
  })

  test("prefers an explicit directory and leaves other provider IDs unchanged", () => {
    expect(
      resolveProviderModelsDevId("kimi", { modelsDevProviderId: "custom" }),
    ).toBe("custom")
    expect(resolveProviderModelsDevId("deepseek")).toBe("deepseek")
  })

  test.each([
    ["https://dashscope.aliyuncs.com/compatible-mode", "alibaba-cn"],
    ["https://dashscope-intl.aliyuncs.com/compatible-mode", "alibaba"],
    ["https://coding.dashscope.aliyuncs.com", "alibaba-coding-plan-cn"],
    ["https://coding-intl.dashscope.aliyuncs.com", "alibaba-coding-plan"],
    [
      "https://token-plan.cn-beijing.maas.aliyuncs.com",
      "alibaba-token-plan-cn",
    ],
    [
      "https://token-plan.ap-southeast-1.maas.aliyuncs.com",
      "alibaba-token-plan",
    ],
  ])("matches the DashScope catalog for %s", (baseUrl, expected) => {
    expect(resolveProviderModelsDevId("dashscope", { baseUrl })).toBe(expected)
  })

  test.each([
    "xai",
    "openrouter",
    "deepseek",
    "kimi",
    "opencode-go",
    "dashscope",
  ])("reads %s models locally", (provider) => {
    const records = getLocalProviderModelRecords(provider)
    expect(records?.length).toBeGreaterThan(0)
    expect(records).toEqual(getLocalProviderModelRecords(provider))
  })

  test("uses cached provider defaults and maps DashScope to Alibaba CN", () => {
    expect(getProviderModelConfig("xai", "grok-4.7")).toMatchObject({
      contextWindow: 500_000,
      reasoningEfforts: ["low", "medium", "high", "xhigh"],
    })
    expect(getProviderModelConfig("kimi", "k3")).toMatchObject({
      contextWindow: 1_048_576,
    })
    expect(getProviderModelConfig("xai", "missing")).toBeUndefined()
    expect(getProviderModelConfig("dashscope", "qwen3.8-max")).toMatchObject({
      contextWindow: 1_000_000,
    })
    expect(resolveProviderModelsDevId("dashscope")).toBe("alibaba-cn")
    expect(
      getLocalProviderModelRecords("dashscope")?.map((model) => model.id),
    ).not.toContain("ZHIPU/GLM-5.3-FlashX")
  })

  test("preserves a custom DashScope gateway URL and protocol when using catalog prices", () => {
    const baseUrl = "https://gateway.example/model/cn397"
    const resolved = resolveProviderConfigForModel(
      {
        name: "dashscope",
        type: "openai-compatible",
        baseUrl,
        apiKey: "test-key",
        authType: "authorization",
        pricingCurrency: "CNY",
      },
      "qwen3.8-max",
    )
    expect(resolveProviderModelsDevId("dashscope", resolved)).toBe("alibaba-cn")
    expect(resolved).toMatchObject({
      baseUrl,
      type: "openai-compatible",
      pricingCurrency: "USD",
    })
    expect(resolved.modelsDevProviderId).toBeUndefined()
    expect(resolveProviderEndpointUrl(resolved, "chat/completions")).toBe(
      `${baseUrl}/v1/chat/completions`,
    )
  })

  test.each<[string, Parameters<typeof getLocalProviderModelRecords>[1]]>([
    ["dashscope", undefined],
    [
      "dashscope",
      { baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode" },
    ],
    ["dashscope", { modelsDevProviderId: "custom-catalog" }],
    ["xai", undefined],
    ["openrouter", undefined],
    ["deepseek", undefined],
    ["kimi", undefined],
    ["opencode-go", undefined],
  ])(
    "filters %s releases before May 2026 in the resolved catalog %j",
    (provider, config) => {
      const catalog = { models: modelsDevReleaseModelsFixture }
      const original = structuredClone(catalog)
      installModelsDevCatalog({
        ...modelsDevProviderCatalogFixture,
        "alibaba-cn": catalog,
        alibaba: catalog,
        "custom-catalog": catalog,
        xai: catalog,
        openrouter: catalog,
        deepseek: catalog,
        "kimi-code-plan-cn": catalog,
        "opencode-go": catalog,
      })
      expect(
        getLocalProviderModelRecords(provider, config)?.map(
          (model) => model.id,
        ),
      ).toEqual(["after-cutoff", "invalid-date", "on-cutoff", "unknown-date"])
      expect(
        getLocalProviderModelRecords("openrouter", {
          modelsDevProviderId: "alibaba-cn",
        })?.map((model) => model.id),
      ).not.toContain("before-cutoff")
      expect(catalog).toEqual(original)
    },
  )

  test("distinguishes providers that use remote discovery from missing cached catalogs", () => {
    expect(getLocalProviderModelRecords("custom")).toBeUndefined()
    expect(getLocalProviderModelRecords("codex")).toBeUndefined()
    expect(getLocalProviderModelRecords("github-copilot")).toBeUndefined()
    expect(
      getLocalProviderModelRecords("kimi", { modelsDevProviderId: "missing" }),
    ).toEqual([])
  })

  test("filters malformed and deprecated models while preserving sorted namespaced IDs", () => {
    const models = {
      "z/model": { id: "z/model", name: "", limit: { context: -1, output: 0 } },
      "a/model": {
        id: "a/model",
        name: "Model A",
        limit: { context: 120_000, output: 32_000 },
        modalities: {
          input: ["text", "image", "pdf", "image"],
          output: ["text"],
        },
        reasoning_options: [
          { type: "effort", values: ["high", "high", "unknown"] },
        ],
      },
      old: { id: "old", status: "deprecated" },
      mismatch: { id: "other" },
      malformed: null,
      missing: {},
      " ": { id: " " },
    }
    const original = structuredClone(models)
    installModelsDevCatalog({
      ...modelsDevProviderCatalogFixture,
      openrouter: { models },
    })
    expect(getModelsDevProviderModelRecords("openrouter")).toEqual([
      {
        id: "a/model",
        name: "Model A",
        object: "model",
        created: 0,
        owned_by: "openrouter",
        context_window: 120_000,
        max_output_tokens: 32_000,
        input_modalities: ["text", "image"],
        reasoning_efforts: ["high"],
      },
      {
        id: "z/model",
        name: "z/model",
        object: "model",
        created: 0,
        owned_by: "openrouter",
      },
    ])
    expect(getModelsDevProviderModelRecords("missing")).toEqual([])
    expect(models).toEqual(original)
  })
})
