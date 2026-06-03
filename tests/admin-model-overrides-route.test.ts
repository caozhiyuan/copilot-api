import { beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

import type { ModelMetadataOverride } from "../src/lib/config"

const actualConfigModule = await import("../src/lib/config")
const actualPathsModule = await import("../src/lib/paths")

let modelOverrides: Record<string, ModelMetadataOverride> = {
  "gpt-5.4": { capabilities: { limits: { max_output_tokens: 32_000 } } },
}

const getModelOverrides = mock(() => modelOverrides)
const setModelOverrides = mock(
  (next: Record<string, ModelMetadataOverride>) => {
    modelOverrides = next
    return modelOverrides
  },
)

await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  getModelOverrides,
  setModelOverrides,
}))

const { configRoutes } = await import("../src/routes/admin/config/route")

const createApp = () => {
  const app = new Hono()
  app.route("/admin/config", configRoutes)
  return app
}

beforeEach(() => {
  modelOverrides = {
    "gpt-5.4": { capabilities: { limits: { max_output_tokens: 32_000 } } },
  }
  getModelOverrides.mockClear()
  setModelOverrides.mockClear()
})

describe("config model overrides route", () => {
  test("returns the current model overrides snapshot", async () => {
    const app = createApp()
    const response = await app.request("/admin/config/model-overrides")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      configPath: actualPathsModule.PATHS.CONFIG_PATH,
      modelOverrides: {
        "gpt-5.4": { capabilities: { limits: { max_output_tokens: 32_000 } } },
      },
    })
    expect(getModelOverrides).toHaveBeenCalledTimes(1)
  })

  test("updates model overrides through the config API", async () => {
    const app = createApp()
    const next = {
      "gpt-5.4": { supported_endpoints: ["/responses"] },
    }
    const response = await app.request("/admin/config/model-overrides", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelOverrides: next }),
    })

    expect(response.status).toBe(200)
    expect(setModelOverrides).toHaveBeenCalledWith(next)
    expect(await response.json()).toEqual({
      configPath: actualPathsModule.PATHS.CONFIG_PATH,
      modelOverrides: next,
    })
  })

  test("rejects non-object override values", async () => {
    const app = createApp()
    const response = await app.request("/admin/config/model-overrides", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelOverrides: { "gpt-5.4": "nope" } }),
    })

    expect(response.status).toBe(400)
    const json = (await response.json()) as { error: { type: string } }
    expect(json.error.type).toBe("invalid_request_error")
    expect(setModelOverrides).not.toHaveBeenCalled()
  })

  test("rejects empty model ids", async () => {
    const app = createApp()
    const response = await app.request("/admin/config/model-overrides", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ modelOverrides: { "": { name: "x" } } }),
    })

    expect(response.status).toBe(400)
    const json = (await response.json()) as { error: { type: string } }
    expect(json.error.type).toBe("invalid_request_error")
    expect(setModelOverrides).not.toHaveBeenCalled()
  })
})
