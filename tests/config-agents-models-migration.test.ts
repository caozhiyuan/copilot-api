import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  defaultConfig,
  getConfig,
  invalidateConfigCache,
  mergeConfigWithDefaults,
  readEditableConfigFromDisk,
  writeConfigToDisk,
  type AppConfig,
  type ProviderConfig,
} from "~/lib/config/config-store"
import { PATHS } from "~/lib/storage/paths"
import {
  getProviderManagementConfig,
  saveProviderManagementConfig,
} from "~/lib/config/provider-management"

type LegacyProviderConfig = ProviderConfig & { codexModels?: Array<string> }
const originalConfigPath = PATHS.CONFIG_PATH
let tempDir: string | undefined

function seedConfig(provider: LegacyProviderConfig): AppConfig {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-models-migration-"))
  PATHS.CONFIG_PATH = path.join(tempDir, "config.json")
  const config = {
    ...defaultConfig,
    auth: {
      apiKeyConfigs: [{ id: "test-key", key: "gateway-test-key" }],
      adminApiKey: "existing-admin-key",
    },
    modelMappings: { ...defaultConfig.modelMappings, friendly: "custom/model" },
    providers: {
      custom: {
        apiKey: "provider-test-key",
        baseUrl: "https://provider.example",
        type: "openai-compatible",
        models: { model: { temperature: 0.2 } },
        ...provider,
      },
      untouched: { enabled: false },
    },
  } satisfies AppConfig
  fs.writeFileSync(PATHS.CONFIG_PATH, JSON.stringify(config, null, 2))
  invalidateConfigCache()
  return config
}

function readStoredConfig(): AppConfig {
  return JSON.parse(fs.readFileSync(PATHS.CONFIG_PATH, "utf8")) as AppConfig
}

afterEach(() => {
  PATHS.CONFIG_PATH = originalConfigPath
  invalidateConfigCache()
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

describe("agentsModels configuration migration", () => {
  test.each([{ codexModels: ["model", "other"] }, { codexModels: [] }])(
    "migrates legacy selections on startup: %j",
    ({ codexModels }) => {
      const original = seedConfig({ codexModels, enabled: false })
      const config = mergeConfigWithDefaults()
      expect(config.providers?.custom.agentsModels).toEqual(codexModels)
      expect(config.providers?.custom).not.toHaveProperty("codexModels")
      const stored = readStoredConfig()
      expect(stored.providers?.custom).toEqual({
        apiKey: "provider-test-key",
        baseUrl: "https://provider.example",
        type: "openai-compatible",
        models: { model: { temperature: 0.2 } },
        enabled: false,
        agentsModels: codexModels,
      })
      expect(stored.auth).toEqual(original.auth)
      expect(stored.modelMappings).toEqual(original.modelMappings)
      expect(stored.providers?.untouched).toEqual(original.providers?.untouched)

      const persisted = fs.readFileSync(PATHS.CONFIG_PATH, "utf8")
      mergeConfigWithDefaults()
      expect(fs.readFileSync(PATHS.CONFIG_PATH, "utf8")).toBe(persisted)
    },
  )

  test.each([{ agentsModels: ["new-model"] }, { agentsModels: [] }])(
    "prefers the new field when both keys exist: %j",
    ({ agentsModels }) => {
      seedConfig({ codexModels: ["old-model"], agentsModels })
      const config = mergeConfigWithDefaults()
      expect(config.providers?.custom.agentsModels).toEqual(agentsModels)
      expect(readStoredConfig().providers?.custom).not.toHaveProperty(
        "codexModels",
      )
    },
  )

  test("keeps automatic discovery when no selection field exists", () => {
    seedConfig({})
    const config = mergeConfigWithDefaults()
    expect(config.providers?.custom).not.toHaveProperty("agentsModels")
    expect(config.providers?.custom).not.toHaveProperty("codexModels")
  })

  test("migrates in-memory and editable reads without rewriting disk", () => {
    seedConfig({ codexModels: ["model"] })
    const raw = fs.readFileSync(PATHS.CONFIG_PATH, "utf8")
    expect(getConfig().providers?.custom.agentsModels).toEqual(["model"])
    const editable = readEditableConfigFromDisk()
    expect(editable.providers?.custom.agentsModels).toEqual(["model"])
    expect(editable.providers?.custom).not.toHaveProperty("codexModels")
    const summary = getProviderManagementConfig()
    expect(
      summary.providers.find((provider) => provider.name === "custom"),
    ).toMatchObject({
      agentsModels: ["model"],
    })
    expect(JSON.stringify(summary)).not.toContain("codexModels")
    expect(fs.readFileSync(PATHS.CONFIG_PATH, "utf8")).toBe(raw)
  })

  test("persists canonical fields when the desktop edits a legacy configuration", () => {
    seedConfig({ codexModels: ["model"] })
    saveProviderManagementConfig({ providers: { custom: { enabled: false } } })
    expect(readStoredConfig().providers?.custom.agentsModels).toEqual(["model"])
    expect(readStoredConfig().providers?.custom).not.toHaveProperty(
      "codexModels",
    )

    saveProviderManagementConfig({
      providers: { custom: { agentsModels: null } },
    })
    expect(readStoredConfig().providers?.custom).not.toHaveProperty(
      "agentsModels",
    )
    expect(readStoredConfig().providers?.custom).not.toHaveProperty(
      "codexModels",
    )
  })

  test("removes legacy keys on direct configuration writes", () => {
    const config = seedConfig({ codexModels: [] })
    writeConfigToDisk(config)
    expect(readStoredConfig().providers?.custom.agentsModels).toEqual([])
    expect(readStoredConfig().providers?.custom).not.toHaveProperty(
      "codexModels",
    )
  })
})
