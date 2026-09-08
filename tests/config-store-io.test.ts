import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  reloadConfig,
  setConfiguredApiKeys,
  writeConfigToDisk,
} from "~/lib/config-store"
import { PATHS } from "~/lib/paths"

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
const tempDirs: Array<string> = []

function useTempConfigPath(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-store-io-"))
  tempDirs.push(tempDir)
  PATHS.APP_DIR = tempDir
  PATHS.CONFIG_PATH = path.join(tempDir, "config.json")
  return PATHS.CONFIG_PATH
}

afterEach(() => {
  fs.accessSync = originalAccessSync
  PATHS.APP_DIR = originalAppDir
  PATHS.CONFIG_PATH = originalConfigPath
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
  if (process.platform !== "win32") {
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600)
  }
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
  expect(config.modelMappings).toEqual({ "claude-opus-4-7": "gpt-5-mini" })
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
