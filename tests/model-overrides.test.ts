import { beforeEach, describe, expect, mock, test } from "bun:test"

import type { ModelMetadataOverride } from "../src/lib/config"
import type { Model } from "../src/services/copilot/get-models"

const actualConfigModule = await import("../src/lib/config")

let modelOverrides: Record<string, ModelMetadataOverride> = {}

await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  getModelOverrides: () => modelOverrides,
}))

const { state } = await import("../src/lib/state")
const { applyModelOverride, applyModelOverrides } = await import(
  "../src/lib/models"
)

const createModel = (overrides: Partial<Model> = {}): Model => ({
  capabilities: {
    family: "gpt",
    limits: { max_output_tokens: 16_000, max_prompt_tokens: 128_000 },
    object: "model_capabilities",
    supports: {},
    tokenizer: "o200k_base",
    type: "chat",
  },
  id: "gpt-5.4",
  model_picker_enabled: true,
  name: "GPT-5.4",
  object: "model",
  preview: false,
  vendor: "openai",
  version: "v1",
  supported_endpoints: ["/v1/messages", "/responses"],
  ...overrides,
})

beforeEach(() => {
  modelOverrides = {}
  state.models = { object: "list", data: [createModel()] }
})

describe("applyModelOverride", () => {
  test("returns the model unchanged when there is no override", () => {
    const model = createModel()
    expect(applyModelOverride(model)).toBe(model)
  })

  test("deep-merges nested override fields", () => {
    modelOverrides = {
      "gpt-5.4": {
        capabilities: { limits: { max_output_tokens: 32_000 } },
      },
    }

    const result = applyModelOverride(createModel())

    expect(result.capabilities.limits.max_output_tokens).toBe(32_000)
    // unrelated nested field is preserved
    expect(result.capabilities.limits.max_prompt_tokens).toBe(128_000)
  })

  test("replaces array fields entirely", () => {
    modelOverrides = {
      "gpt-5.4": { supported_endpoints: ["/responses"] },
    }

    expect(applyModelOverride(createModel()).supported_endpoints).toEqual([
      "/responses",
    ])
  })

  test("ignores attempts to override the id", () => {
    modelOverrides = {
      "gpt-5.4": { id: "something-else" } as ModelMetadataOverride,
    }

    expect(applyModelOverride(createModel()).id).toBe("gpt-5.4")
  })

  test("does not mutate the original model", () => {
    modelOverrides = {
      "gpt-5.4": { capabilities: { limits: { max_output_tokens: 1 } } },
    }
    const model = createModel()

    applyModelOverride(model)

    expect(model.capabilities.limits.max_output_tokens).toBe(16_000)
  })
})

describe("applyModelOverrides", () => {
  test("applies overrides to each model in a list", () => {
    modelOverrides = {
      "gpt-5.4": { name: "Overridden" },
    }

    const [result] = applyModelOverrides([createModel()])
    expect(result.name).toBe("Overridden")
  })
})
