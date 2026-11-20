import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  getConfig,
  invalidateConfigCache,
  type AppConfig,
} from "~/lib/config/config-store"
import { PATHS } from "~/lib/storage/paths"
import {
  applyProviderManagementUpdate,
  getProviderAgentModels,
  getProviderManagementConfig,
  isProviderAgentModelVisible,
  saveProviderManagementConfig,
} from "~/lib/config/provider-management"

const originalPath = PATHS.CONFIG_PATH
let tempDir: string | undefined
afterEach(() => {
  PATHS.CONFIG_PATH = originalPath
  invalidateConfigCache()
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
  tempDir = undefined
})
function fixture(): AppConfig {
  return {
    auth: {
      apiKeyConfigs: [{ id: "test-key", key: "secret" }],
      adminApiKey: "admin-secret",
    },
    modelMappings: { a: "b" },
    providers: {
      dashscope: {
        type: "openai-compatible",
        apiKey: "provider-secret",
        baseUrl: "https://example.test",
        models: { model: { temperature: 0.2 } },
      },
      codex: {
        enabled: false,
        authType: "oauth2",
        accountId: "account",
        apiKey: "codex-secret",
        agentsModels: ["gpt-6.1-sol"],
      },
    },
  }
}
describe("provider management", () => {
  test("returns safe summaries including disabled providers without a model count limit", () => {
    const summary = getProviderManagementConfig(fixture())
    expect(summary).not.toHaveProperty("maxModels")
    expect(summary.providers.map((p) => [p.name, p.enabled])).toEqual([
      ["github-copilot", true],
      ["dashscope", true],
      ["codex", false],
    ])
    expect(JSON.stringify(summary)).not.toContain("secret")
    expect(
      getProviderManagementConfig({ providers: { copilot: {} } }).providers,
    ).toEqual([
      {
        name: "github-copilot",
        type: "github-copilot",
        enabled: true,
        agentsModels: undefined,
      },
    ])
    expect(getProviderManagementConfig({}).providers[0]?.name).toBe(
      "github-copilot",
    )
  })
  test("controls builtin GitHub Copilot in legacy configurations without changing credentials", () => {
    const config = fixture()
    const disabled = applyProviderManagementUpdate(config, {
      providers: {
        "github-copilot": { enabled: false, agentsModels: ["gpt-5.4"] },
      },
    })
    expect(disabled.providers?.["github-copilot"]).toEqual({
      enabled: false,
      agentsModels: ["gpt-5.4"],
    })
    expect(disabled.providers?.dashscope).toEqual(config.providers?.dashscope)
    expect(disabled.auth).toEqual(config.auth)
    const enabled = applyProviderManagementUpdate(disabled, {
      providers: { "github-copilot": { enabled: true } },
    })
    expect(enabled.providers?.["github-copilot"]).toEqual({
      enabled: true,
      agentsModels: ["gpt-5.4"],
    })
    expect(getProviderManagementConfig(disabled).providers[0]?.enabled).toBe(
      false,
    )
  })
  test("supports automatic, empty, and explicit model lists", () => {
    expect(isProviderAgentModelVisible(undefined, "anything")).toBe(true)
    expect(isProviderAgentModelVisible({ enabled: false }, "anything")).toBe(
      false,
    )
    expect(isProviderAgentModelVisible({ agentsModels: [] }, "anything")).toBe(
      false,
    )
    expect(
      isProviderAgentModelVisible(
        { agentsModels: [" model ", "model"] },
        "model",
      ),
    ).toBe(true)
    expect(
      isProviderAgentModelVisible({ agentsModels: ["model"] }, "other"),
    ).toBe(false)
    expect(
      getProviderAgentModels({ agentsModels: [" model ", "", "model"] }),
    ).toEqual(["model"])
    expect(
      getProviderAgentModels({ agentsModels: [42] as unknown as string[] }),
    ).toBeUndefined()
  })
  test("updates only requested fields, deduplicates selections, and preserves credentials", () => {
    const original = fixture()
    const updated = applyProviderManagementUpdate(original, {
      providers: {
        dashscope: { enabled: false, agentsModels: [" model ", "model"] },
      },
    })
    expect(updated.providers?.dashscope).toEqual({
      ...original.providers?.dashscope,
      enabled: false,
      agentsModels: ["model"],
    })
    expect(updated.providers?.codex).toEqual(original.providers?.codex)
    expect(updated.auth).toEqual(original.auth)
    expect(updated.modelMappings).toEqual(original.modelMappings)
    expect(original.providers?.dashscope.enabled).toBeUndefined()
    expect(
      applyProviderManagementUpdate(updated, {
        providers: { dashscope: { agentsModels: null } },
      }).providers?.dashscope,
    ).not.toHaveProperty("agentsModels")
    expect(applyProviderManagementUpdate(original, {})).toEqual(original)
  })
  test.each([
    { maxModels: 20 },
    { maxModels: 0 },
    { maxModels: "20" },
    { providers: { missing: { enabled: true } } },
    { providers: { copilot: { enabled: false } } },
    { providers: { dashscope: { apiKey: "overwrite" } } },
    { providers: { dashscope: { agentsModels: [""] } } },
    { providers: { dashscope: { enabled: "false" } } },
  ])("rejects invalid updates %j", (input) => {
    expect(() => applyProviderManagementUpdate(fixture(), input)).toThrow()
  })
  test("patches the latest disk config and invalidates only the current process cache", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-management-"))
    PATHS.CONFIG_PATH = path.join(tempDir, "config.json")
    fs.writeFileSync(PATHS.CONFIG_PATH, JSON.stringify(fixture()))
    invalidateConfigCache()
    expect(getConfig().providers?.codex.enabled).toBe(false)
    const latest = { ...fixture(), extraPrompts: { new: "preserve" } }
    fs.writeFileSync(PATHS.CONFIG_PATH, JSON.stringify(latest))
    const summary = saveProviderManagementConfig({
      providers: { codex: { enabled: true } },
    })
    expect(summary.providers.find((p) => p.name === "codex")?.enabled).toBe(
      true,
    )
    expect(getConfig().providers?.codex.enabled).toBe(true)
    const stored = JSON.parse(
      fs.readFileSync(PATHS.CONFIG_PATH, "utf8"),
    ) as AppConfig
    expect(stored).toEqual({
      ...latest,
      providers: {
        ...latest.providers,
        codex: { ...latest.providers?.codex, enabled: true },
      },
    })
    const before = fs.readFileSync(PATHS.CONFIG_PATH, "utf8")
    expect(() =>
      saveProviderManagementConfig({
        providers: { missing: { enabled: true } },
      }),
    ).toThrow()
    expect(fs.readFileSync(PATHS.CONFIG_PATH, "utf8")).toBe(before)
    expect(getProviderManagementConfig().providers).toHaveLength(3)
  })
})
