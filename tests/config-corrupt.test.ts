import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

interface ConfigFileShape {
  auth?: {
    apiKeys?: Array<string>
    adminApiKey?: string
  }
}

interface ConfigScriptResult {
  exitCode: number
  stdout: string
  stderr: string
}

const cwd = fileURLToPath(new URL("../", import.meta.url))
const decoder = new TextDecoder()
const tempDirs: Array<string> = []

const corruptConfigContent = '{ "auth": { "apiKeys": ["regular-key"] },'

function createTempConfigDir(): string {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-api-corrupt-config-"),
  )
  tempDirs.push(tempDir)
  return tempDir
}

function writeCorruptConfigFile(tempDir: string): string {
  const configPath = path.join(tempDir, "config.json")
  fs.writeFileSync(configPath, corruptConfigContent, "utf8")
  return configPath
}

function runConfigScript(tempDir: string, script: string): ConfigScriptResult {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "--eval", script],
    cwd,
    env: {
      ...process.env,
      COPILOT_API_HOME: tempDir,
      COPILOT_API_OAUTH_APP: "",
      COPILOT_API_ENTERPRISE_URL: "",
    },
  })

  return {
    exitCode: result.exitCode,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop()!
    const configPath = path.join(tempDir, "config.json")
    try {
      fs.chmodSync(configPath, 0o600)
    } catch {
      // The config file may not exist for tests that only exercise creation.
    }
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

describe("corrupt config file", () => {
  test("refuses to merge defaults and preserves the corrupt config on disk", () => {
    const tempDir = createTempConfigDir()
    const configPath = writeCorruptConfigFile(tempDir)

    const result = runConfigScript(
      tempDir,
      'const { mergeConfigWithDefaults } = await import("./src/lib/config"); mergeConfigWithDefaults();',
    )

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("Config file is not valid JSON")
    expect(result.stderr).toContain(configPath)
    expect(fs.readFileSync(configPath, "utf8")).toBe(corruptConfigContent)
  })

  test("getConfig fails closed instead of falling back to the default config", () => {
    const tempDir = createTempConfigDir()
    const configPath = writeCorruptConfigFile(tempDir)

    const result = runConfigScript(
      tempDir,
      'const { getConfig } = await import("./src/lib/config"); console.log(JSON.stringify(getConfig()));',
    )

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain("Config file is not valid JSON")
    expect(fs.readFileSync(configPath, "utf8")).toBe(corruptConfigContent)
  })

  test.skipIf(process.platform === "win32")(
    "does not overwrite an unreadable config file",
    () => {
      const tempDir = createTempConfigDir()
      const configPath = path.join(tempDir, "config.json")
      const sentinelConfig = '{"auth":{"apiKeys":["preserve-me"]}}\n'
      fs.writeFileSync(configPath, sentinelConfig, "utf8")
      fs.chmodSync(configPath, 0o200)

      const result = runConfigScript(
        tempDir,
        'const { getConfig } = await import("./src/lib/config"); getConfig();',
      )

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("EACCES")
      fs.chmodSync(configPath, 0o600)
      expect(fs.readFileSync(configPath, "utf8")).toBe(sentinelConfig)
    },
  )

  test("still generates a fresh config when the file is missing", () => {
    const tempDir = createTempConfigDir()

    const result = runConfigScript(
      tempDir,
      'const { mergeConfigWithDefaults } = await import("./src/lib/config"); mergeConfigWithDefaults();',
    )

    expect(result.exitCode).toBe(0)
    const config = JSON.parse(
      fs.readFileSync(path.join(tempDir, "config.json"), "utf8"),
    ) as ConfigFileShape
    expect(typeof config.auth?.adminApiKey).toBe("string")
    expect(config.auth?.adminApiKey?.length).toBeGreaterThan(0)
  })

  test("still regenerates the default config when the file is empty", () => {
    const tempDir = createTempConfigDir()
    const configPath = path.join(tempDir, "config.json")
    fs.writeFileSync(configPath, "", "utf8")

    const result = runConfigScript(
      tempDir,
      'const { mergeConfigWithDefaults } = await import("./src/lib/config"); mergeConfigWithDefaults();',
    )

    expect(result.exitCode).toBe(0)
    const config = JSON.parse(
      fs.readFileSync(configPath, "utf8"),
    ) as ConfigFileShape
    expect(typeof config.auth?.adminApiKey).toBe("string")
  })
})
