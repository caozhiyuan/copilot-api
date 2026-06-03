import { beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { ModelMetadataOverride } from "../src/lib/config"
import type { Model } from "../src/services/copilot/get-models"

const actualConfigModule = await import("../src/lib/config")

let modelOverrides: Record<string, ModelMetadataOverride> = {}

await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  getModelOverrides: () => modelOverrides,
}))

const { state } = await import("../src/lib/state")
const { modelRoutes } = await import("../src/routes/models/route")

const createModel = (overrides: Partial<Model> = {}): Model => ({
  capabilities: {
    family: "gpt",
    limits: {
      max_context_window_tokens: 200_000,
      max_output_tokens: 16_000,
      max_prompt_tokens: 128_000,
    },
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

const createApp = () => {
  const app = new Hono()
  app.route("/models", modelRoutes)
  return app
}

interface ModelsListResponse {
  data: Array<Model & { display_name: string; owned_by: string }>
}

beforeEach(() => {
  modelOverrides = {}
  state.models = { object: "list", data: [createModel()] }
})

describe("models route with overrides", () => {
  test("advertises overridden metadata", async () => {
    modelOverrides = {
      "gpt-5.4": {
        capabilities: { limits: { max_output_tokens: 32_000 } },
        supported_endpoints: ["/responses"],
      },
    }

    const response = await createApp().request("/models")
    expect(response.status).toBe(200)

    const json = (await response.json()) as ModelsListResponse
    const model = json.data[0]
    expect(model.capabilities.limits.max_output_tokens).toBe(32_000)
    expect(model.supported_endpoints).toEqual(["/responses"])
  })

  test("computes the [1m] suffix from the overridden context window", async () => {
    modelOverrides = {
      "gpt-5.4": {
        capabilities: { limits: { max_context_window_tokens: 1_000_000 } },
      },
    }

    const response = await createApp().request("/models")
    const json = (await response.json()) as ModelsListResponse
    expect(json.data[0].id).toBe("gpt-5.4[1m]")
  })

  test("leaves metadata untouched when there is no override", async () => {
    const response = await createApp().request("/models")
    const json = (await response.json()) as ModelsListResponse
    expect(json.data[0].id).toBe("gpt-5.4")
    expect(json.data[0].capabilities.limits.max_output_tokens).toBe(16_000)
  })
})
