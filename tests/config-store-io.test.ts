import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  defaultConfig,
  getAlphaSearchModel,
  getClaudeAutoModel,
  getMessageApiWebSearchModel,
  getOpencodeModelContextWindow,
  invalidateConfigCache,
  reloadConfig,
  setConfiguredApiKeys,
  writeConfigToDisk,
  type AppConfig,
} from "~/lib/config-store"
import { getSmallModel, getSmallModelForProvider } from "~/lib/model-policy"
import { PATHS } from "~/lib/paths"
import { state } from "~/lib/state"

interface StoredConfig {
  auth: {
    apiKeys: Array<string>
    adminApiKey: string
  }
  providers: Record<string, { apiKey: string; baseUrl: string }>
  modelMappings: Record<string, string>
}

const originalAppDir = PATHS.APP_DIR
const originalConfigPath = PATHS.CONFIG_PATH
const originalAccessSync = fs.accessSync
const originalGitHubToken = state.githubToken
const originalCopilotToken = state.copilotToken
const tempDirs: Array<string> = []

function useTempConfigPath(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-store-io-"))
  tempDirs.push(tempDir)
  PATHS.APP_DIR = tempDir
  PATHS.CONFIG_PATH = path.join(tempDir, "config.json")
  return PATHS.CONFIG_PATH
}

beforeEach(() => {
  state.githubToken = undefined
  state.copilotToken = undefined
})

afterEach(() => {
  fs.accessSync = originalAccessSync
  PATHS.APP_DIR = originalAppDir
  PATHS.CONFIG_PATH = originalConfigPath
  invalidateConfigCache()
  state.githubToken = originalGitHubToken
  state.copilotToken = originalCopilotToken
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

test("writeConfigToDisk atomically replaces the editable config", () => {
  const configPath = useTempConfigPath()
  fs.writeFileSync(configPath, '{"auth":{"apiKeys":["old"]}}\n', "utf8")

  writeConfigToDisk({
    auth: {
      apiKeys: ["new"],
    },
    providers: {
      example: {
        apiKey: "provider-key",
        baseUrl: "https://provider.example",
      },
    },
  })

  expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({
    auth: {
      apiKeys: ["new"],
    },
    providers: {
      example: {
        apiKey: "provider-key",
        baseUrl: "https://provider.example",
      },
    },
  })
  expect(fs.readdirSync(path.dirname(configPath))).toEqual(["config.json"])
})

test("reloadConfig creates a default config when it is missing", () => {
  const configPath = useTempConfigPath()

  const config = reloadConfig()

  expect(config.auth?.apiKeys).toEqual([])
  expect(config.smallModels).toEqual({
    codex: "gpt-6-luna",
    copilot: "gpt-6-luna",
  })
  expect(config.alphaSearchModel).toBe("gpt-6-luna")
  expect(config.messageApiWebSearchModel).toBe("gpt-6-luna")
  expect(config.opencodeModelContextWindow).toBe(400_000)
  expect(getOpencodeModelContextWindow()).toBe(400_000)
  expect(config.extraPrompts).toBeUndefined()
  expect(config.modelReasoningEfforts).toBeUndefined()
  if (process.platform !== "win32") {
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600)
  }
})

test.each([
  { configured: undefined, expected: 400_000 },
  { configured: 150_000, expected: 150_000 },
  { configured: 300_000, expected: 300_000 },
  { configured: 600_000, expected: 600_000 },
  { configured: 150_000.9, expected: 150_000 },
  { configured: 1, expected: 1 },
  { configured: 0, expected: 400_000 },
  { configured: -1, expected: 400_000 },
  { configured: 0.5, expected: 400_000 },
  { configured: null, expected: 400_000 },
  { configured: "600000", expected: 400_000 },
  { configured: true, expected: 400_000 },
  { configured: {}, expected: 400_000 },
  { configured: [], expected: 400_000 },
])(
  "normalizes and persists the OpenCode context window setting %j",
  ({ configured, expected }) => {
    const configPath = useTempConfigPath()
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        ...defaultConfig,
        auth: { adminApiKey: "existing-admin-key" },
        opencodeModelContextWindow: configured,
      }),
      "utf8",
    )

    expect(reloadConfig().opencodeModelContextWindow).toBe(expected)
    expect(getOpencodeModelContextWindow()).toBe(expected)
    const storedConfig = fs.readFileSync(configPath, "utf8")
    expect(
      (JSON.parse(storedConfig) as AppConfig).opencodeModelContextWindow,
    ).toBe(expected)
    expect(reloadConfig().opencodeModelContextWindow).toBe(expected)
    expect(fs.readFileSync(configPath, "utf8")).toBe(storedConfig)
  },
)

test("uses the default OpenCode context ceiling on a lazy read without rewriting legacy config", () => {
  const configPath = useTempConfigPath()
  const legacyConfig = JSON.stringify({
    ...defaultConfig,
    auth: { adminApiKey: "existing-admin-key" },
    opencodeModelContextWindow: undefined,
  })
  fs.writeFileSync(configPath, legacyConfig, "utf8")
  invalidateConfigCache()

  expect(getOpencodeModelContextWindow()).toBe(400_000)
  expect(fs.readFileSync(configPath, "utf8")).toBe(legacyConfig)
  reloadConfig()
  expect(
    (JSON.parse(fs.readFileSync(configPath, "utf8")) as AppConfig)
      .opencodeModelContextWindow,
  ).toBe(400_000)
})

test("reloadConfig refreshes an explicitly configured OpenCode context ceiling", () => {
  useTempConfigPath()
  for (const ceiling of [150_000, 600_000]) {
    writeConfigToDisk({
      auth: { adminApiKey: "existing-admin-key" },
      opencodeModelContextWindow: ceiling,
    })
    reloadConfig()
    expect(getOpencodeModelContextWindow()).toBe(ceiling)
  }
})

test("small and search model getters use gpt-6-luna when config fields are absent", () => {
  const configPath = useTempConfigPath()
  fs.writeFileSync(
    configPath,
    '{"auth":{"adminApiKey":"existing-admin-key"}}\n',
    "utf8",
  )

  reloadConfig()

  expect(getSmallModel()).toBe("gpt-6-luna")
  expect(getSmallModelForProvider("codex")).toBe("gpt-6-luna")
  expect(getSmallModelForProvider("copilot")).toBe("gpt-6-luna")
  expect(getSmallModelForProvider("other-provider")).toBeUndefined()
  expect(getAlphaSearchModel()).toBe("gpt-6-luna")
  expect(getMessageApiWebSearchModel()).toBe("gpt-6-luna")
  expect(getClaudeAutoModel()).toBeUndefined()
})

test.each<{
  name: string
  providers: AppConfig["providers"]
  githubToken?: string
  copilotToken?: string
  expected: string | undefined
}>([
  {
    name: "missing providers without authorization",
    providers: undefined,
    expected: undefined,
  },
  {
    name: "missing providers with authorized Copilot",
    providers: undefined,
    githubToken: "test-github-token",
    copilotToken: "test-copilot-token",
    expected: "gpt-6-luna",
  },
  {
    name: "enabled Copilot without authorization",
    providers: { "github-copilot": { enabled: true } },
    expected: undefined,
  },
  {
    name: "custom provider without Copilot authorization",
    providers: { custom: { enabled: true } },
    expected: undefined,
  },
  {
    name: "enabled Copilot with only a GitHub token",
    providers: { "github-copilot": { enabled: true } },
    githubToken: "test-github-token",
    expected: undefined,
  },
  {
    name: "enabled Copilot with only a Copilot token",
    providers: { "github-copilot": { enabled: true } },
    copilotToken: "test-copilot-token",
    expected: undefined,
  },
  {
    name: "enabled and authorized Copilot",
    providers: { "github-copilot": { enabled: true } },
    githubToken: "test-github-token",
    copilotToken: "test-copilot-token",
    expected: "gpt-6-luna",
  },
  {
    name: "enabled Codex without Copilot",
    providers: {
      codex: { enabled: true },
      "github-copilot": { enabled: false },
    },
    expected: "codex-auto-review",
  },
  {
    name: "both providers enabled",
    providers: {
      codex: { enabled: true },
      "github-copilot": { enabled: true },
    },
    githubToken: "test-github-token",
    copilotToken: "test-copilot-token",
    expected: "codex-auto-review",
  },
  {
    name: "Codex with no enabled flag",
    providers: { codex: {} },
    expected: "codex-auto-review",
  },
  {
    name: "disabled Codex with authorized default Copilot",
    providers: { codex: { enabled: false } },
    githubToken: "test-github-token",
    copilotToken: "test-copilot-token",
    expected: "gpt-6-luna",
  },
  {
    name: "disabled Codex without Copilot authorization",
    providers: { codex: { enabled: false } },
    expected: undefined,
  },
  {
    name: "disabled Copilot with missing Codex",
    providers: {
      "github-copilot": { enabled: false },
      custom: { enabled: true },
    },
    githubToken: "test-github-token",
    copilotToken: "test-copilot-token",
    expected: undefined,
  },
  {
    name: "both providers disabled",
    providers: {
      codex: { enabled: false },
      "github-copilot": { enabled: false },
    },
    expected: undefined,
  },
])(
  "Claude auto model defaults for $name",
  ({ providers, githubToken, copilotToken, expected }) => {
    useTempConfigPath()
    writeConfigToDisk({
      auth: { adminApiKey: "existing-admin-key" },
      providers,
    })
    reloadConfig()
    state.githubToken = githubToken
    state.copilotToken = copilotToken

    expect(getClaudeAutoModel()).toBeUndefined()
    expect(getClaudeAutoModel(false)).toBeUndefined()
    expect(getClaudeAutoModel(true)).toBe(expected)
  },
)

test.each([
  { model: "custom-model", expected: "custom-model" },
  { model: " custom/model ", expected: "custom/model" },
  { model: "", expected: undefined },
  { model: " \t\n", expected: undefined },
])(
  "Claude auto model preserves user configuration %j",
  ({ model, expected }) => {
    useTempConfigPath()
    writeConfigToDisk({
      auth: { adminApiKey: "existing-admin-key" },
      providers: {
        codex: { enabled: true },
        "github-copilot": { enabled: true },
      },
      claudeAutoModel: model,
    })
    reloadConfig()

    expect(getClaudeAutoModel()).toBe(expected)
    expect(getClaudeAutoModel(true)).toBe(expected)
  },
)

test("Claude auto model defaults follow provider changes without persisting a user override", () => {
  const configPath = useTempConfigPath()
  state.githubToken = "test-github-token"
  state.copilotToken = "test-copilot-token"
  for (const [enabled, expected] of [
    [true, "codex-auto-review"],
    [false, "gpt-6-luna"],
  ] as const) {
    writeConfigToDisk({
      auth: { adminApiKey: "existing-admin-key" },
      providers: { codex: { enabled } },
    })
    expect(reloadConfig().claudeAutoModel).toBeUndefined()
    expect(getClaudeAutoModel(true)).toBe(expected)
    const storedConfig = JSON.parse(
      fs.readFileSync(configPath, "utf8"),
    ) as AppConfig
    expect(storedConfig.claudeAutoModel).toBeUndefined()
  }
})

test("Claude auto model follows Copilot token readiness without reloading config", () => {
  useTempConfigPath()
  writeConfigToDisk({ auth: { adminApiKey: "existing-admin-key" } })
  reloadConfig()

  expect(getClaudeAutoModel(true)).toBeUndefined()
  state.githubToken = "test-github-token"
  expect(getClaudeAutoModel(true)).toBeUndefined()
  state.copilotToken = "test-copilot-token"
  expect(getClaudeAutoModel(true)).toBe("gpt-6-luna")
  state.copilotToken = undefined
  expect(getClaudeAutoModel(true)).toBeUndefined()
})

test("smallModels selects provider models and allows an empty value to disable switching", () => {
  const configPath = useTempConfigPath()
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      auth: { adminApiKey: "existing-admin-key" },
      smallModels: {
        codex: "",
        copilot: "gpt-copilot-small",
        openai: "gpt-openai-small",
      },
    }),
    "utf8",
  )

  reloadConfig()

  expect(getSmallModelForProvider("codex")).toBeUndefined()
  expect(getSmallModelForProvider("copilot")).toBe("gpt-copilot-small")
  expect(getSmallModelForProvider("openai")).toBe("gpt-openai-small")
  expect(getSmallModelForProvider("dashscope")).toBeUndefined()
  expect(getSmallModel()).toBe("gpt-copilot-small")
})

test("reloadConfig preserves an unreadable config file", () => {
  const configPath = useTempConfigPath()
  const sentinelConfig = '{"auth":{"apiKeys":["preserve-me"]}}\n'
  fs.writeFileSync(configPath, sentinelConfig, "utf8")
  fs.accessSync = (() => {
    throw Object.assign(new Error("access denied"), { code: "EACCES" })
  }) as typeof fs.accessSync

  expect(() => reloadConfig()).toThrow("access denied")

  expect(fs.readFileSync(configPath, "utf8")).toBe(sentinelConfig)
})

test("reloadConfig propagates nonmissing filesystem errors", () => {
  useTempConfigPath()
  fs.accessSync = (() => {
    throw Object.assign(new Error("operation not permitted"), {
      code: "EPERM",
    })
  }) as typeof fs.accessSync

  expect(() => reloadConfig()).toThrow("operation not permitted")
})

test("setConfiguredApiKeys normalizes keys and preserves other config fields", () => {
  const configPath = useTempConfigPath()
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      auth: { adminApiKey: "existing-admin-key" },
      providers: {
        example: {
          apiKey: "provider-key",
          baseUrl: "https://provider.example",
        },
      },
      modelMappings: { "claude-opus-4-7": "gpt-5-mini" },
    }),
    "utf8",
  )

  const storedKeys = setConfiguredApiKeys([" key-1 ", "key-1", " key-2 "])

  expect(storedKeys).toEqual(["key-1", "key-2"])
  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as StoredConfig
  expect(config.auth.apiKeys).toEqual(["key-1", "key-2"])
  expect(config.auth.adminApiKey).toBe("existing-admin-key")
  expect(config.providers).toEqual({
    example: {
      apiKey: "provider-key",
      baseUrl: "https://provider.example",
    },
  })
  expect(config.modelMappings).toEqual({
    "codex-auto-review": "codex/codex-auto-review",
    "gpt-reserve": "codex/gpt-reserve",
    "claude-opus-4-7": "gpt-5-mini",
  })
})

test("setConfiguredApiKeys can clear all keys", () => {
  const configPath = useTempConfigPath()
  fs.writeFileSync(
    configPath,
    JSON.stringify({ auth: { apiKeys: ["key-1"], adminApiKey: "admin-key" } }),
    "utf8",
  )

  const storedKeys = setConfiguredApiKeys([])
  expect(storedKeys).toEqual([])
  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as StoredConfig
  expect(config.auth.apiKeys).toEqual([])
  expect(config.auth.adminApiKey).toBe("admin-key")
})

test("reloadConfig preserves extension fields when persisting normalized defaults", () => {
  const configPath = useTempConfigPath()
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      auth: { adminApiKey: "test-admin" },
      futureRoot: { keep: true },
      contextManagement: { messages: false, futureContext: { keep: true } },
      upstreamTransport: {
        headersTimeoutMs: 1234,
        futureTransport: { keep: true },
      },
    }),
  )
  reloadConfig()
  const persisted = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
    futureRoot: { keep: boolean }
    contextManagement: {
      messages: boolean
      responses: boolean
      futureContext: { keep: boolean }
    }
    upstreamTransport: {
      headersTimeoutMs: number
      futureTransport: { keep: boolean }
    }
  }
  expect(persisted.futureRoot).toEqual({ keep: true })
  expect(persisted.contextManagement).toEqual({
    messages: false,
    responses: false,
    futureContext: { keep: true },
  })
  expect(persisted.upstreamTransport.headersTimeoutMs).toBe(1234)
  expect(persisted.upstreamTransport.futureTransport).toEqual({ keep: true })
})
