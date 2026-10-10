import { beforeAll, describe, expect, test } from "bun:test"

import {
  builtinProviderModelRegistry,
  BuiltinProviderModelRegistry,
} from "~/lib/builtin-provider-models"
import { installModelsDevCatalog } from "~/lib/models-dev-cache"

import { modelsDevCatalogFixture } from "./fixtures/models-dev-catalog"

beforeAll(() => {
  installModelsDevCatalog(modelsDevCatalogFixture)
})

describe("builtin provider model registry", () => {
  test.each(["codex", " CODEX "])(
    "provides PDF defaults for %s without adding model IDs",
    (provider) => {
      expect(
        builtinProviderModelRegistry.getProviderDefaults(provider),
      ).toEqual({ supportPdf: true })
      expect(
        builtinProviderModelRegistry.getModelConfig(provider, "unknown-model"),
      ).toBeUndefined()
      expect(builtinProviderModelRegistry.getModelIds(provider)).not.toContain(
        "unknown-model",
      )
    },
  )

  test("keeps PDF defaults unset for other providers", () => {
    expect(
      builtinProviderModelRegistry.getProviderDefaults("deepseek"),
    ).toBeUndefined()
    expect(
      builtinProviderModelRegistry.getProviderDefaults("unknown"),
    ).toBeUndefined()
  })

  test.each(["xai", "openrouter", "deepseek", "kimi", "dashscope"])(
    "does not embed model information for %s",
    (provider) => {
      expect(builtinProviderModelRegistry.getModelIds(provider)).toEqual([])
      expect(
        builtinProviderModelRegistry.getProviderDefaults(provider),
      ).toBeUndefined()
    },
  )
  test("normalizes provider and model names when resolving model config", () => {
    expect(builtinProviderModelRegistry).toBeInstanceOf(
      BuiltinProviderModelRegistry,
    )
    expect(
      builtinProviderModelRegistry.getModelConfig(" Codex ", " GPT-5.5 "),
    ).toMatchObject({
      pricing: {
        tiers: [
          { cachedInput: 0.5, input: 5, maxInputTokens: 272_000, output: 30 },
          { cachedInput: 1, input: 10, output: 45 },
        ],
      },
    })
  })

  test("lists model ids for a normalized provider name", () => {
    const modelIds = builtinProviderModelRegistry.getModelIds(" OPENCODE-GO ")
    for (const modelId of [
      "qwen3.8-max",
      "minimax-m3",
      "glm-5.3-flash",
      "hy4-preview",
      "qwen3.8-flash",
    ]) {
      expect(modelIds).toContain(modelId)
    }
  })

  test("filters deprecated OpenCode Go models", () => {
    expect(
      builtinProviderModelRegistry.getModelConfig(
        "opencode-go",
        "ox-alpha-free",
      ),
    ).toBeUndefined()
    expect(
      builtinProviderModelRegistry.getModelIds("opencode-go"),
    ).not.toContain("grok-4.5")
  })

  test("maps OpenCode Go metadata and pricing from models.dev", () => {
    expect(
      builtinProviderModelRegistry.getModelConfig(
        "opencode-go",
        "glm-5.3-flash",
      ),
    ).toEqual({
      contextWindow: 1_000_000,
      inputModalities: ["text", "image"],
      maxOutputTokens: 131_072,
      pricing: {
        cachedInput: 0.03,
        input: 0.15,
        output: 0.5,
      },
      reasoningEfforts: ["low", "high", "max"],
    })
  })

  test("flags models that expect the OpenRouter-style reasoning field", () => {
    expect(
      builtinProviderModelRegistry.getModelConfig("opencode-go", "hy4-preview"),
    ).toMatchObject({
      reasoningField: "reasoning",
    })
  })

  test("reads Grok reasoning efforts without inferring a family default", () => {
    const config = builtinProviderModelRegistry.getModelConfig(
      "opencode-go",
      "grok-4.7",
    )
    expect(config?.reasoningEfforts).toEqual(["low", "medium", "high", "xhigh"])
    expect(config?.defaultReasoningEffort).toBeUndefined()
  })

  test("keeps GPT entries pricing-only", () => {
    expect(
      builtinProviderModelRegistry.getModelConfig("codex", "gpt-5.6-sol"),
    ).toEqual({
      pricing: {
        tiers: [
          {
            cacheCreationInput: 5,
            cachedInput: 0.4,
            input: 4,
            maxInputTokens: 272_000,
            output: 20,
          },
          {
            cacheCreationInput: 10,
            cachedInput: 0.8,
            input: 8,
            output: 30,
          },
        ],
      },
    })

    expect(
      builtinProviderModelRegistry.getModelConfig("codex", "gpt-6.1-sol"),
    ).toEqual({
      pricing: {
        tiers: [
          {
            cacheCreationInput: 2.5,
            cachedInput: 0.1,
            input: 2,
            maxInputTokens: 272_000,
            output: 10,
          },
          {
            cacheCreationInput: 5,
            cachedInput: 0.2,
            input: 4,
            output: 15,
          },
        ],
      },
    })
  })

  test("prices Codex review and reserve models exactly like GPT-6 Luna", () => {
    const luna = builtinProviderModelRegistry.getModelConfig(
      "codex",
      "gpt-6-luna",
    )
    expect(luna?.pricing?.tiers).toHaveLength(2)
    for (const modelId of ["codex-auto-review", "gpt-reserve"]) {
      expect(builtinProviderModelRegistry.getModelIds("codex")).toContain(
        modelId,
      )
      expect(
        builtinProviderModelRegistry.getModelConfig("codex", modelId),
      ).toEqual(luna)
    }
  })

  test("removes selected older Codex models while retaining GPT-5.5 pricing", () => {
    for (const modelId of ["gpt-5.3-codex", "gpt-5.4", "gpt-5.4-mini"]) {
      expect(builtinProviderModelRegistry.getModelIds("codex")).not.toContain(
        modelId,
      )
      expect(
        builtinProviderModelRegistry.getModelConfig("codex", modelId),
      ).toBeUndefined()
    }
    expect(
      builtinProviderModelRegistry.getModelConfig("codex", "gpt-5.5"),
    ).toEqual({
      pricing: {
        tiers: [
          { cachedInput: 0.5, input: 5, maxInputTokens: 272_000, output: 30 },
          { cachedInput: 1, input: 10, output: 45 },
        ],
      },
    })
  })

  test("returns empty results for unknown providers and models", () => {
    expect(builtinProviderModelRegistry.getModelIds("unknown")).toEqual([])
    expect(
      builtinProviderModelRegistry.getModelConfig("deepseek", "unknown"),
    ).toBeUndefined()
  })

  test("uses models.dev prices for OpenCode Go DeepSeek models", () => {
    const expectedPricing = {
      "deepseek-v4-pro": {
        cachedInput: 0.022,
        input: 0.66,
        output: 1.98,
      },
      "deepseek-v4.1-flash": {
        cachedInput: 0.003,
        input: 0.15,
        output: 0.6,
      },
    }

    for (const [model, pricing] of Object.entries(expectedPricing)) {
      expect(
        builtinProviderModelRegistry.getModelConfig("opencode-go", model)
          ?.pricing,
      ).toEqual(pricing)
    }
  })
})
