import { beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"

const actualConfigModule = await import("~/lib/config")
const actualPathsModule = await import("~/lib/storage/paths")

let modelMappings: Record<string, string> = {
  "claude-opus-4-7": "gpt-5-mini",
}

const getModelMappings = mock(() => modelMappings)
const setModelMappings = mock((nextModelMappings: Record<string, string>) => {
  modelMappings = nextModelMappings
  return modelMappings
})

await mock.module("~/lib/config", () => ({
  ...actualConfigModule,
  getModelMappings,
  setModelMappings,
}))

const { configRoutes } = await import("~/routes/admin/config/route")

const createApp = () => {
  const app = new Hono()
  app.route("/admin/config", configRoutes)
  return app
}

beforeEach(() => {
  modelMappings = {
    "claude-opus-4-7": "gpt-5-mini",
  }

  getModelMappings.mockClear()
  setModelMappings.mockClear()
})

describe("config model mappings route", () => {
  test("exposes the alpha search Codex priority setting", () => {
    expect(typeof actualConfigModule.isAlphaSearchCodexPriorityEnabled()).toBe(
      "boolean",
    )
  })

  test("returns the current model mappings snapshot", async () => {
    const app = createApp()
    const response = await app.request("/admin/config/model-mappings")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      configPath: actualPathsModule.PATHS.CONFIG_PATH,
      modelMappings: {
        "claude-opus-4-7": "gpt-5-mini",
      },
    })
    expect(getModelMappings).toHaveBeenCalledTimes(1)
  })

  test("updates model mappings through the config API", async () => {
    const app = createApp()
    const response = await app.request("/admin/config/model-mappings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        modelMappings: {
          "claude-opus-4-7": "dash/qwen-plus",
          "claude-sonnet-4": "gpt-5.4",
        },
      }),
    })

    expect(response.status).toBe(200)
    expect(setModelMappings).toHaveBeenCalledWith({
      "claude-opus-4-7": "dash/qwen-plus",
      "claude-sonnet-4": "gpt-5.4",
    })
    expect(await response.json()).toEqual({
      configPath: actualPathsModule.PATHS.CONFIG_PATH,
      modelMappings: {
        "claude-opus-4-7": "dash/qwen-plus",
        "claude-sonnet-4": "gpt-5.4",
      },
    })
  })

  test("rejects invalid request bodies", async () => {
    const app = createApp()
    const response = await app.request("/admin/config/model-mappings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        modelMappings: "claude-opus-4-7",
      }),
    })

    expect(response.status).toBe(400)
    const json = (await response.json()) as {
      error: {
        message: string
        type: string
      }
    }
    expect(json.error.type).toBe("invalid_request_error")
    expect(json.error.message.length).toBeGreaterThan(0)
    expect(setModelMappings).not.toHaveBeenCalled()
  })

  test("does not expose the old public config path", async () => {
    const app = createApp()
    const response = await app.request("/config/model-mappings")

    expect(response.status).toBe(404)
  })
})
