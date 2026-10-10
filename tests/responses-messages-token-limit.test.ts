import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"

import type { ProviderConfig } from "~/lib/config"

import { installModelsDevCatalog } from "~/lib/models-dev-cache"
import * as providerConfig from "~/lib/provider-config"
import { createFallbackModel } from "~/lib/provider-model"
import { state } from "~/lib/state"
import { translateAnthropicMessagesToResponsesPayload } from "~/routes/messages/responses-translation"
import { translateResponsesToMessages } from "~/routes/responses/messages-translation"

import {
  modelsDevCatalogFixture,
  modelsDevProviderCatalogFixture,
} from "./fixtures/models-dev-catalog"

const translate = (model: string, maxOutputTokens?: number | null) =>
  translateResponsesToMessages(
    {
      model: "public-model-alias",
      input: "Hello",
      max_output_tokens: maxOutputTokens,
    },
    { model },
  ).messagesPayload

describe("Responses Messages output token defaults", () => {
  let originalModels = state.models
  let providers: Record<string, ProviderConfig> = {}
  let restoreProviderLookup = () => {}

  beforeEach(() => {
    originalModels = state.models
    state.models = undefined
    providers = {}
    installModelsDevCatalog(modelsDevProviderCatalogFixture)
    const lookup = spyOn(
      providerConfig,
      "getRawProviderConfig",
    ).mockImplementation((name) => providers[name] ?? null)
    restoreProviderLookup = () => lookup.mockRestore()
  })

  afterEach(() => {
    restoreProviderLookup()
    state.models = originalModels
  })

  test("prefers provider model configuration over builtin limits", () => {
    providers.deepseek = {
      models: { "deepseek-v4-pro": { maxOutputTokens: 8_192 } },
    }

    expect(translate("deepseek/deepseek-v4-pro").max_tokens).toBe(8_192)
  })

  test("matches model ids containing slashes within the selected provider", () => {
    providers.custom = {
      models: { "org/claude-model": { maxOutputTokens: 16_384 } },
    }
    providers.other = {
      models: { "org/claude-model": { maxOutputTokens: 4_096 } },
    }

    expect(translate("custom/org/claude-model").max_tokens).toBe(16_384)
    expect(translate("other/org/claude-model").max_tokens).toBe(4_096)
  })

  test.each([undefined, null])(
    "uses cached model metadata when max_output_tokens is %j",
    (maxOutputTokens) => {
      expect(
        translate("deepseek/deepseek-v4-pro", maxOutputTokens).max_tokens,
      ).toBe(64_000)
    },
  )

  test.each([0, -1, 1.5, NaN, Infinity])(
    "ignores invalid configured limits %j and uses cached metadata",
    (maxOutputTokens) => {
      providers.deepseek = {
        models: { "deepseek-v4-pro": { maxOutputTokens } },
      }

      expect(translate("deepseek/deepseek-v4-pro").max_tokens).toBe(64_000)
    },
  )

  test("matches models.dev provider and model limits ahead of builtin metadata", () => {
    installModelsDevCatalog({
      ...modelsDevCatalogFixture,
      deepseek: {
        models: { "deepseek-v4-pro": { limit: { output: 48_000 } } },
      },
    })

    expect(translate("deepseek/deepseek-v4-pro").max_tokens).toBe(48_000)
    expect(translate("deepseek/deepseek-v4-pro", 1_024).max_tokens).toBe(1_024)
  })

  test("prefers explicit model configuration over models.dev metadata", () => {
    providers.custom = {
      modelsDevProviderId: "catalog-provider",
      models: { "claude-model": { maxOutputTokens: 16_384 } },
    }
    installModelsDevCatalog({
      ...modelsDevCatalogFixture,
      "catalog-provider": {
        models: { "claude-model": { limit: { output: 65_536 } } },
      },
    })

    expect(translate("custom/claude-model").max_tokens).toBe(16_384)
  })

  test("uses modelsDevProviderId for custom provider names and namespaced models", () => {
    providers.custom = { modelsDevProviderId: "catalog-provider" }
    providers.other = { modelsDevProviderId: "another-provider" }
    installModelsDevCatalog({
      ...modelsDevCatalogFixture,
      "catalog-provider": {
        models: { "org/claude-model": { limit: { output: 131_072 } } },
      },
      "another-provider": {
        models: { "org/claude-model": { limit: { output: 8_192 } } },
      },
    })

    expect(translate("custom/org/claude-model").max_tokens).toBe(131_072)
    expect(translate("other/org/claude-model").max_tokens).toBe(8_192)
    expect(translate("custom/unknown-model").max_tokens).toBe(32_000)
  })

  test("does not use an alias provider's catalog when modelsDevProviderId differs", () => {
    providers.custom = { modelsDevProviderId: "unknown-catalog" }
    installModelsDevCatalog({
      ...modelsDevCatalogFixture,
      custom: {
        models: { "claude-model": { limit: { output: 131_072 } } },
      },
    })

    expect(translate("custom/claude-model").max_tokens).toBe(32_000)
  })

  test("uses cached limits for OpenCode Go and OpenRouter", () => {
    installModelsDevCatalog({
      ...modelsDevCatalogFixture,
      openrouter: {
        models: { "org/claude-model": { limit: { output: 65_536 } } },
      },
    })

    expect(translate("opencode-go/gpt-6-luna").max_tokens).toBe(128_000)
    expect(translate("openrouter/org/claude-model").max_tokens).toBe(65_536)
  })

  test.each([undefined, 0, -1, 1.5, NaN, Infinity])(
    "falls back to 32000 when models.dev output is invalid: %j",
    (output) => {
      installModelsDevCatalog({
        ...modelsDevCatalogFixture,
        deepseek: {
          models: { "deepseek-v4-pro": { limit: { output } } },
        },
      })

      expect(translate("deepseek/deepseek-v4-pro").max_tokens).toBe(32_000)
    },
  )

  test("uses Copilot capabilities and normalized Claude aliases", () => {
    const model = createFallbackModel("claude-sonnet-4.6")
    model.capabilities.limits.max_output_tokens = 48_000
    state.models = { object: "list", data: [model] }

    expect(translate(model.id).max_tokens).toBe(48_000)
    expect(translate("claude-sonnet-4-6-20251010").max_tokens).toBe(48_000)
  })

  test("uses exact Copilot metadata for namespaced model ids", () => {
    const model = createFallbackModel("org/family/model")
    model.capabilities.limits.max_output_tokens = 16_384
    state.models = { object: "list", data: [model] }

    expect(translate(model.id).max_tokens).toBe(16_384)
  })

  test("does not reuse model limits from a different provider", () => {
    providers.other = {
      models: { "deepseek-v4-pro": { maxOutputTokens: 8_192 } },
    }
    const model = createFallbackModel("deepseek-v4-pro")
    model.capabilities.limits.max_output_tokens = 4_096
    state.models = { object: "list", data: [model] }

    expect(translate("custom/deepseek-v4-pro").max_tokens).toBe(32_000)
  })

  test.each([undefined, 0, -1, 1.5, NaN, Infinity])(
    "falls back to 32000 for invalid Copilot limits %j",
    (maxOutputTokens) => {
      const model = createFallbackModel("claude-test")
      model.capabilities.limits.max_output_tokens = maxOutputTokens
      state.models = { object: "list", data: [model] }

      expect(translate(model.id).max_tokens).toBe(32_000)
    },
  )

  test.each([
    "unknown-model",
    "deepseek/unknown-model",
    "custom/unknown-model",
  ])("falls back to 32000 when %s has no matching output limit", (model) => {
    providers.custom = { models: { "other-model": { maxOutputTokens: 8_192 } } }

    expect(translate(model).max_tokens).toBe(32_000)
  })

  test.each([
    [1_024, 1_024],
    [128_000, 128_000],
    [0, 1],
  ])(
    "preserves explicit request limits %i and the minimum of one token",
    (maxOutputTokens, expectedMaxTokens) => {
      expect(
        translate("deepseek/deepseek-v4-pro", maxOutputTokens).max_tokens,
      ).toBe(expectedMaxTokens)
    },
  )

  test("keeps Grok Build output limit behavior after resolving model defaults", () => {
    const payload = translate("xai/grok-4.7")

    expect(payload.max_tokens).toBe(500_000)
    expect(
      translateAnthropicMessagesToResponsesPayload(payload),
    ).not.toHaveProperty("max_output_tokens")
  })
})
