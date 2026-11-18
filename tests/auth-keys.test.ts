import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

interface ConfigFileShape {
  auth?: {
    apiKeys?: Array<string>
    apiKeyConfigs?: Array<{
      id: string
      key: string
      name?: string
      enabled?: boolean
      quota?: { period: "lifetime"; amount: number }
    }>
    adminApiKey?: string
  }
  providers?: Record<string, unknown>
  modelMappings?: Record<string, string>
}

const cwd = fileURLToPath(new URL("../", import.meta.url))
const decoder = new TextDecoder()
const requestAuthModuleUrl = pathToFileURL(
  path.join(cwd, "src", "lib", "request-auth.ts"),
).href
const tempDirs: Array<string> = []

function createTempConfigDir(): string {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-api-auth-keys-"),
  )
  tempDirs.push(tempDir)
  return tempDir
}

function configPathFor(tempDir: string): string {
  return path.join(tempDir, "config.json")
}

function writeConfigFile(tempDir: string, config: ConfigFileShape): void {
  fs.writeFileSync(
    configPathFor(tempDir),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  )
}

function readConfigFile(tempDir: string): ConfigFileShape {
  return JSON.parse(
    fs.readFileSync(configPathFor(tempDir), "utf8"),
  ) as ConfigFileShape
}

function runAuthKeys(
  tempDir: string,
  ...args: Array<string>
): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "run", "./src/main.ts", "auth", "keys", ...args],
    cwd,
    env: {
      ...process.env,
      COPILOT_API_HOME: tempDir,
      COPILOT_API_OAUTH_APP: "",
      COPILOT_API_ENTERPRISE_URL: "",
      NODE_ENV: "production",
    },
  })
  return {
    exitCode: result.exitCode ?? -1,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  }
}

function runWarningCheck(tempDir: string): boolean {
  const script =
    `import { getMissingApiKeysMessage } from ${JSON.stringify(requestAuthModuleUrl)}\n`
    + "process.stdout.write(String(getMissingApiKeysMessage() !== null))"
  const result = Bun.spawnSync({
    cmd: [process.execPath, "--eval", script],
    env: {
      ...process.env,
      COPILOT_API_HOME: tempDir,
      COPILOT_API_OAUTH_APP: "",
      COPILOT_API_ENTERPRISE_URL: "",
    },
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `Warning check failed with exit code ${result.exitCode}\nstdout: ${decoder.decode(result.stdout)}\nstderr: ${decoder.decode(result.stderr)}`,
    )
  }
  return decoder.decode(result.stdout).trim() === "true"
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe("auth keys CLI", () => {
  test("adds an API key and preserves other config fields", () => {
    const tempDir = createTempConfigDir()
    writeConfigFile(tempDir, {
      auth: { adminApiKey: "existing-admin-key" },
      providers: { example: { apiKey: "provider-key" } },
      modelMappings: { old: "new" },
    })

    const result = runAuthKeys(tempDir, "--add", " key-1 ")

    expect(result.exitCode).toBe(0)
    const config = readConfigFile(tempDir)
    expect(config.auth?.apiKeyConfigs?.map((key) => key.key)).toEqual(["key-1"])
    expect(config.auth?.adminApiKey).toBe("existing-admin-key")
    expect(config.providers).toEqual({ example: { apiKey: "provider-key" } })
    expect(config.modelMappings).toEqual({
      "codex-auto-review": "codex/codex-auto-review",
      "gpt-reserve": "codex/gpt-reserve",
      old: "new",
    })
  })

  test("does not duplicate an existing key", () => {
    const tempDir = createTempConfigDir()
    writeConfigFile(tempDir, { auth: { apiKeys: ["key-1"] } })

    const result = runAuthKeys(tempDir, "--add", "key-1")

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("already configured")
    expect(
      readConfigFile(tempDir).auth?.apiKeyConfigs?.map((key) => key.key),
    ).toEqual(["key-1"])
  })

  test("removes an API key", () => {
    const tempDir = createTempConfigDir()
    writeConfigFile(tempDir, { auth: { apiKeys: ["key-1", "key-2"] } })

    const result = runAuthKeys(tempDir, "--remove", "key-1")

    expect(result.exitCode).toBe(0)
    expect(
      readConfigFile(tempDir).auth?.apiKeyConfigs?.map((key) => key.key),
    ).toEqual(["key-2"])
  })

  test("lists configured API keys", () => {
    const tempDir = createTempConfigDir()
    writeConfigFile(tempDir, { auth: { apiKeys: ["key-1", "key-2"] } })

    const result = runAuthKeys(tempDir, "--list")

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("key-1")
    expect(result.stdout).toContain("key-2")
  })

  test("lists a hint when no keys are configured", () => {
    const tempDir = createTempConfigDir()
    writeConfigFile(tempDir, {})

    const result = runAuthKeys(tempDir)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("No API keys configured")
  })

  test("clears all keys", () => {
    const tempDir = createTempConfigDir()
    writeConfigFile(tempDir, { auth: { apiKeys: ["key-1", "key-2"] } })

    const result = runAuthKeys(tempDir, "--clear")

    expect(result.exitCode).toBe(0)
    expect(
      readConfigFile(tempDir).auth?.apiKeyConfigs?.map((key) => key.key),
    ).toEqual([])
  })

  test("rejects combining multiple operations", () => {
    const tempDir = createTempConfigDir()
    writeConfigFile(tempDir, {})

    const result = runAuthKeys(tempDir, "--add", "key-1", "--clear")

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("only one")
  })

  test("rejects adding an empty key", () => {
    const tempDir = createTempConfigDir()
    writeConfigFile(tempDir, {})

    const result = runAuthKeys(tempDir, "--add", "  ")

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("non-empty")
  })
})

describe("missing API keys startup warning", () => {
  test("returns a message when no API keys are configured", () => {
    const tempDir = createTempConfigDir()
    writeConfigFile(tempDir, {})
    expect(runWarningCheck(tempDir)).toBe(true)
  })

  test("returns no message when API keys are configured", () => {
    const tempDir = createTempConfigDir()
    writeConfigFile(tempDir, { auth: { apiKeys: ["key-1"] } })
    expect(runWarningCheck(tempDir)).toBe(false)
  })
})

describe("API key migration and legacy CLI", () => {
  test("keeps policies when adding and removing keys and leaves old JSON untouched", () => {
    const tempDir = createTempConfigDir()
    const policy = {
      id: "existing",
      key: "managed",
      name: "Named",
      enabled: false,
      quota: { period: "lifetime" as const, amount: 100 },
    }
    writeConfigFile(tempDir, {
      auth: { apiKeys: ["ignored-old"], apiKeyConfigs: [policy] },
    })
    expect(runAuthKeys(tempDir, "--add", "new").exitCode).toBe(0)
    const added = readConfigFile(tempDir)
    expect(added.auth?.apiKeys).toEqual(["ignored-old"])
    expect(
      added.auth?.apiKeyConfigs?.find((key) => key.id === "existing"),
    ).toEqual(policy)
    expect(runAuthKeys(tempDir, "--list").stdout).not.toContain("ignored-old")
    expect(runAuthKeys(tempDir, "--remove", "new").exitCode).toBe(0)
    expect(readConfigFile(tempDir).auth?.apiKeyConfigs).toEqual([policy])
    expect(runAuthKeys(tempDir, "--clear").exitCode).toBe(0)
    expect(readConfigFile(tempDir).auth?.apiKeyConfigs).toEqual([])
    expect(readConfigFile(tempDir).auth?.apiKeys).toEqual(["ignored-old"])
    expect(runAuthKeys(tempDir, "--list").stdout).not.toContain("ignored-old")
  })
})
