import { beforeEach, describe, expect, test } from "bun:test"

import {
  getModelsDevProviderModelRecords,
  getOpencodeGoModelConfig,
  getOpencodeGoModelProviderType,
  installModelsDevCatalog,
} from "~/lib/models-dev-cache"
import {
  getLocalProviderModelRecords,
  getProviderModelConfig,
  isProviderModelVisible,
} from "~/lib/provider-model-catalog"

import { modelsDevCatalogFixture } from "./fixtures/models-dev-catalog"

const routes = [
  ["minimax", "MiniMax-M3.1-Flash", "MiniMax-M3", "MiniMax-M2.7"],
  ["minimax-cn", "MiniMax-M3.1-Flash", "MiniMax-M3", "MiniMax-M2.7"],
  ["minimax-coding-plan", "MiniMax-M3.1-Flash", "MiniMax-M3", "MiniMax-M2.7"],
  [
    "minimax-cn-coding-plan",
    "MiniMax-M3.1-Flash",
    "MiniMax-M3",
    "MiniMax-M2.7",
  ],
  [
    "openrouter",
    "minimax/minimax-m3.1-flash:free",
    "minimax/minimax-m3",
    "minimax/minimax-m2.7",
  ],
  ["opencode-go", "minimax-m3.1-flash-free", "minimax-m3", "minimax-m2.7"],
] as const

function catalog(provider: string, ids: readonly string[]) {
  return {
    ...modelsDevCatalogFixture,
    [provider]: {
      api: "https://api.minimax.io/anthropic/v1",
      npm: "@ai-sdk/anthropic",
      models: Object.fromEntries(
        ids.map((id) => [
          id,
          {
            id,
            limit: { context: 123_456, output: 4_096 },
            modalities: { input: ["text", "image"], output: ["text"] },
            provider: { npm: "@ai-sdk/anthropic" },
          },
        ]),
      ),
    },
  }
}

beforeEach(() => installModelsDevCatalog(modelsDevCatalogFixture))

describe("MiniMax model discovery", () => {
  test.each(routes)(
    "prefers advertised Flash then M3 for %s",
    (provider, flash, m3, legacy) => {
      const source = catalog(provider, [
        legacy,
        m3,
        flash,
        "a-other",
        "z-other",
      ])
      const original = structuredClone(source)
      installModelsDevCatalog(source)
      const ids = getModelsDevProviderModelRecords(provider).map(
        (model) => model.id,
      )
      expect(ids.filter((id) => id.toLowerCase().includes("minimax"))).toEqual([
        flash,
        m3,
      ])
      expect(ids.filter((id) => !id.toLowerCase().includes("minimax"))).toEqual(
        ["a-other", "z-other"],
      )
      expect(isProviderModelVisible(provider, legacy)).toBe(true)
      expect(getProviderModelConfig(provider, legacy)).toMatchObject({
        contextWindow: 123_456,
        maxOutputTokens: 4_096,
      })
      expect(source).toEqual(original)
      if (provider === "opencode-go") {
        expect(getOpencodeGoModelConfig(legacy)).toBeDefined()
        expect(getOpencodeGoModelProviderType(legacy)).toBe("anthropic")
      }
    },
  )

  test("does not invent Flash or remove the only available legacy option", () => {
    installModelsDevCatalog(catalog("minimax", ["MiniMax-M2.7", "MiniMax-M3"]))
    expect(
      getModelsDevProviderModelRecords("minimax").map((model) => model.id),
    ).toEqual(["MiniMax-M3"])
    installModelsDevCatalog(catalog("minimax", ["MiniMax-M2.7"]))
    expect(
      getModelsDevProviderModelRecords("minimax").map((model) => model.id),
    ).toEqual(["MiniMax-M2.7"])
  })

  test("retains media and custom identifiers and ignores malformed Flash entries", () => {
    const source = {
      ...modelsDevCatalogFixture,
      minimax: {
        models: {
          "MiniMax-M3": { id: "MiniMax-M3" },
          "MiniMax-M2.7": { id: "MiniMax-M2.7" },
          "MiniMax-Custom": { id: "MiniMax-Custom" },
          "speech-2.8-hd": { id: "speech-2.8-hd" },
          "MiniMax-M3-audio": {
            id: "MiniMax-M3-audio",
            modalities: { output: ["audio"] },
          },
          "MiniMax-M3.1-Flash": { id: "mismatch" },
        },
      },
    }
    installModelsDevCatalog(source)
    expect(
      getModelsDevProviderModelRecords("minimax").map((model) => model.id),
    ).toEqual([
      "MiniMax-Custom",
      "MiniMax-M3",
      "MiniMax-M3-audio",
      "speech-2.8-hd",
    ])
  })

  test("leaves unrecognized providers and their MiniMax model IDs unchanged", () => {
    installModelsDevCatalog(
      catalog("custom", ["MiniMax-M2.7", "MiniMax-M3", "MiniMax-M3.1-Flash"]),
    )
    expect(
      getModelsDevProviderModelRecords("custom").map((model) => model.id),
    ).toEqual(["MiniMax-M2.7", "MiniMax-M3", "MiniMax-M3.1-Flash"])
    expect(getLocalProviderModelRecords("custom")).toBeUndefined()
  })

  test("uses direct discovery only for an explicit catalog and its original URL", () => {
    installModelsDevCatalog(
      catalog("minimax", ["MiniMax-M2.7", "MiniMax-M3", "MiniMax-M3.1-Flash"]),
    )
    const config = {
      modelsDevProviderId: "minimax",
      baseUrl: "https://api.minimax.io/anthropic/v1",
    }
    expect(
      getLocalProviderModelRecords("my-minimax", config)?.map(
        (model) => model.id,
      ),
    ).toEqual(["MiniMax-M3.1-Flash", "MiniMax-M3"])
    expect(getLocalProviderModelRecords("minimax")).toBeUndefined()
    expect(
      getLocalProviderModelRecords("my-minimax", {
        ...config,
        baseUrl: "https://custom.example/v1",
      }),
    ).toBeUndefined()
    expect(config).toEqual({
      modelsDevProviderId: "minimax",
      baseUrl: "https://api.minimax.io/anthropic/v1",
    })
  })
})
