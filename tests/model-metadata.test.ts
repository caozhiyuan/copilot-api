import { beforeEach, expect, test } from "bun:test"

import { installModelsDevCatalog } from "~/lib/models-dev-cache"
import { createFallbackModel } from "~/lib/provider-model"
import { normalizeCopilotModel } from "~/routes/models/model-discovery"
import { getModelMetadata } from "~/routes/models/model-metadata"

import { modelsDevProviderCatalogFixture } from "./fixtures/models-dev-catalog"

beforeEach(() => installModelsDevCatalog(modelsDevProviderCatalogFixture))

test("resolves overrides before discovered limits and cached defaults", () => {
  const model = { id: "k3", context_window: 400_000, max_output_tokens: 48_000 }
  const config = {
    models: { k3: { contextWindow: 200_000, maxOutputTokens: 24_000 } },
  }
  expect(getModelMetadata("kimi", "k3", model, config)).toMatchObject({
    contextWindow: 200_000,
    maxOutputTokens: 24_000,
  })
  expect(getModelMetadata("kimi", "k3", model, null)).toMatchObject({
    contextWindow: 400_000,
    maxOutputTokens: 48_000,
  })
  expect(getModelMetadata("kimi", "k3", {}, null)).toMatchObject({
    contextWindow: 1_048_576,
    maxOutputTokens: 64_000,
  })
})

test("normalizes Copilot capability limits and supports client-ID configuration", () => {
  const raw = createFallbackModel("claude-sonnet-4.6")
  raw.capabilities.limits = {
    max_context_window_tokens: 200_000,
    max_prompt_tokens: 180_000,
    max_output_tokens: 16_000,
  }
  raw.capabilities.supports.vision = true
  const model = normalizeCopilotModel(raw)
  expect(
    getModelMetadata("github-copilot", "claude-sonnet-4.6", model, null),
  ).toMatchObject({
    contextWindow: 200_000,
    inputLimit: 180_000,
    maxOutputTokens: 16_000,
    inputModalities: ["text", "image"],
  })
  expect(
    getModelMetadata("github-copilot", "claude-sonnet-4.6", model, {
      models: { "claude-sonnet-4-6": { maxOutputTokens: 8_000 } },
    }),
  ).toMatchObject({ maxOutputTokens: 8_000 })
})

test("uses catalog input limits and skips invalid overrides before built-in defaults", () => {
  installModelsDevCatalog({
    ...modelsDevProviderCatalogFixture,
    custom: {
      models: {
        model: {
          id: "model",
          limit: { context: 64_000, input: 48_000, output: 12_000 },
        },
      },
    },
  })
  expect(
    getModelMetadata(
      "custom",
      "model",
      {},
      { models: { model: { contextWindow: Infinity, maxOutputTokens: -1 } } },
    ),
  ).toMatchObject({
    contextWindow: 64_000,
    inputLimit: 48_000,
    maxOutputTokens: 12_000,
  })
  expect(getModelMetadata("dashscope", "qwen3.8-max", {}, null)).toMatchObject({
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
  })
  const unknown = getModelMetadata("custom", "unknown", {}, null)
  expect(unknown.contextWindow).toBeUndefined()
  expect(unknown.inputLimit).toBeUndefined()
  expect(unknown.maxOutputTokens).toBeUndefined()
})

test("reads the normalized context field and rounds token limits down", () => {
  expect(
    getModelMetadata("custom", "model", { context_window: 65_536.9 }, null)
      .contextWindow,
  ).toBe(65_536)
})

test("skips invalid discovery limits before using the cached catalog", () => {
  expect(
    getModelMetadata(
      "kimi",
      "k3",
      { context_window: 0.5, max_output_tokens: NaN },
      null,
    ),
  ).toMatchObject({ contextWindow: 1_048_576, maxOutputTokens: 64_000 })
  const raw = createFallbackModel("claude-sonnet-4.6")
  raw.capabilities.limits = {
    max_context_window_tokens: 0,
    max_prompt_tokens: 80_000,
    max_output_tokens: 16_000,
  }
  expect(
    getModelMetadata(
      "github-copilot",
      raw.id,
      normalizeCopilotModel(raw),
      null,
    ),
  ).toMatchObject({
    contextWindow: 80_000,
    inputLimit: 80_000,
    maxOutputTokens: 16_000,
  })
})

test("resolves input modalities from configuration, normalized discovery, or catalog", () => {
  const model = { input_modalities: ["text", "image"] }
  expect(
    getModelMetadata("kimi", "k3", model, {
      models: { k3: { inputModalities: ["text"] } },
    }).inputModalities,
  ).toEqual(["text"])
  expect(
    getModelMetadata("kimi", "k3-256k", model, null).inputModalities,
  ).toEqual(["text", "image"])
  expect(getModelMetadata("kimi", "k3", {}, null).inputModalities).toEqual([
    "text",
    "image",
  ])
  expect(
    getModelMetadata(
      "custom",
      "unknown",
      { input_modalities: [null, "text", "text"] },
      null,
    ).inputModalities,
  ).toEqual(["text"])
  expect(
    getModelMetadata("custom", "unknown", { input_modalities: [] }, null)
      .inputModalities,
  ).toEqual(["text"])
})

test("merges reasoning settings in the same order as limits and modalities", () => {
  const discovered = { reasoning_efforts: ["low", "high"] }
  expect(getModelMetadata("kimi", "k3", {}, null).reasoningEfforts).toEqual([
    "low",
    "high",
    "max",
  ])
  expect(
    getModelMetadata("kimi", "k3", discovered, null).reasoningEfforts,
  ).toEqual(["low", "high"])
  expect(
    getModelMetadata("kimi", "k3", discovered, {
      models: {
        k3: { reasoningEfforts: ["high"], defaultReasoningEffort: "high" },
      },
    }),
  ).toMatchObject({
    reasoningEfforts: ["high"],
    defaultReasoningEffort: "high",
  })
})
