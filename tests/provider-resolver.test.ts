import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type { ProviderConfig, ResolvedProviderConfig } from "~/lib/config"
import {
  ensureConfiguredProviderModelAlias,
  resolveConfiguredProviderModelAlias,
} from "~/lib/provider-resolver"

interface CodexCredentialsShape {
  accessToken: string
  accountId: string
  expiresAt: number
  refreshToken: string
}

interface ConfigFileShape {
  providers?: Record<string, ProviderConfig>
}

const cwd = fileURLToPath(new URL("../", import.meta.url))
const decoder = new TextDecoder()
const tempDirs: Array<string> = []

function createTempDir(): string {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "copilot-api-resolver-"),
  )
  tempDirs.push(tempDir)
  return tempDir
}

function writeConfigFile(tempDir: string, config: ConfigFileShape): void {
  fs.writeFileSync(
    path.join(tempDir, "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  )
}

function readConfigFile(tempDir: string): ConfigFileShape {
  return JSON.parse(
    fs.readFileSync(path.join(tempDir, "config.json"), "utf8"),
  ) as ConfigFileShape
}

function writeCodexCredentials(
  tempDir: string,
  credentials: CodexCredentialsShape,
): void {
  fs.writeFileSync(
    path.join(tempDir, "codex_credentials.json"),
    `${JSON.stringify(credentials, null, 2)}\n`,
    "utf8",
  )
}

function runScript(tempDir: string, script: string): string {
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

  if (result.exitCode !== 0) {
    throw new Error(
      `Script failed with exit code ${result.exitCode}\nstdout:\n${decoder.decode(result.stdout)}\nstderr:\n${decoder.decode(result.stderr)}`,
    )
  }

  return decoder.decode(result.stdout).trim()
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop()
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

describe("provider resolver", () => {
  test("resolves codex from config.providers to the ChatGPT Codex backend", () => {
    const tempDir = createTempDir()
    writeConfigFile(tempDir, {
      providers: {
        codex: {
          type: "openai-responses",
          enabled: true,
          authType: "oauth2",
          baseUrl: "https://chatgpt.com/backend-api",
        },
      },
    })
    writeCodexCredentials(tempDir, {
      accessToken: "codex-access-token",
      accountId: "acct_test",
      expiresAt: Date.now() + 60 * 60 * 1000,
      refreshToken: "codex-refresh-token",
    })

    const output = runScript(
      tempDir,
      'const { resolveProviderConfig } = await import("./src/lib/provider-resolver"); const { stopCodexRefreshLoop } = await import("./src/lib/token"); console.log(JSON.stringify(await resolveProviderConfig("codex"))); stopCodexRefreshLoop();',
    )

    expect(JSON.parse(output)).toMatchObject({
      apiKey: "codex-access-token",
      authType: "oauth2",
      baseUrl: "https://chatgpt.com/backend-api",
      name: "codex",
      type: "openai-responses",
    })
  })

  test("returns null when codex provider is disabled", () => {
    const tempDir = createTempDir()
    writeConfigFile(tempDir, {
      providers: {
        codex: { enabled: false },
      },
    })

    const output = runScript(
      tempDir,
      'const { resolveProviderConfig } = await import("./src/lib/provider-resolver"); console.log(JSON.stringify(await resolveProviderConfig("codex")));',
    )

    expect(JSON.parse(output)).toBeNull()
  })

  test("migrates legacy codex credentials into config.providers", () => {
    const tempDir = createTempDir()
    writeConfigFile(tempDir, {})
    writeCodexCredentials(tempDir, {
      accessToken: "codex-access-token",
      accountId: "acct_test",
      expiresAt: Date.now() + 60 * 60 * 1000,
      refreshToken: "codex-refresh-token",
    })

    const output = runScript(
      tempDir,
      'const { resolveProviderConfig } = await import("./src/lib/provider-resolver"); const { stopCodexRefreshLoop } = await import("./src/lib/token"); console.log(JSON.stringify(await resolveProviderConfig("codex"))); stopCodexRefreshLoop();',
    )

    expect(JSON.parse(output)).toMatchObject({
      apiKey: "codex-access-token",
      authType: "oauth2",
      baseUrl: "https://chatgpt.com/backend-api",
      name: "codex",
      type: "openai-responses",
    })
    expect(readConfigFile(tempDir).providers?.codex).toMatchObject({
      type: "openai-responses",
      authType: "oauth2",
      baseUrl: "https://chatgpt.com/backend-api",
    })
  })

  test("preserves a disabled codex provider when credentials are persisted", () => {
    const tempDir = createTempDir()
    writeConfigFile(tempDir, {
      providers: {
        codex: {
          type: "openai-responses",
          enabled: false,
          authType: "oauth2",
          baseUrl: "https://chatgpt.com/backend-api",
        },
      },
    })

    const output = runScript(
      tempDir,
      'const { getRawProviderConfig } = await import("./src/lib/config"); const { persistCodexCredentials } = await import("./src/lib/token"); await persistCodexCredentials({ accessToken: "codex-access-token", accountId: "acct_test", expiresAt: Date.now() + 60 * 60 * 1000, refreshToken: "codex-refresh-token" }); console.log(JSON.stringify(getRawProviderConfig("codex")));',
    )

    expect(JSON.parse(output)).toMatchObject({
      type: "openai-responses",
      enabled: false,
      authType: "oauth2",
      baseUrl: "https://chatgpt.com/backend-api",
    })
  })

  test("resolves azure-entra providers with an Azure access token", () => {
    const tempDir = createTempDir()
    writeConfigFile(tempDir, {
      providers: {
        foundry: {
          type: "openai-compatible",
          authType: "azure-entra",
          baseUrl: "https://example.openai.azure.com/openai",
        },
      },
    })

    const output = runScript(
      tempDir,
      'const { resolveProviderConfig } = await import("./src/lib/provider-resolver"); console.log(JSON.stringify(await resolveProviderConfig("foundry", async () => "entra-access-token")));',
    )

    expect(JSON.parse(output)).toMatchObject({
      apiKey: "entra-access-token",
      authType: "azure-entra",
      baseUrl: "https://example.openai.azure.com/openai",
      name: "foundry",
      type: "openai-compatible",
    })
  })
})

describe("configured provider/model alias helpers", () => {
  const configuredResolver = () => Promise.resolve({} as ResolvedProviderConfig)
  const missingResolver = () => Promise.resolve(null)

  test("returns null without calling the resolver for plain model ids", async () => {
    let calls = 0
    const countingResolver = (_providerName: string) => {
      calls += 1
      return Promise.resolve(null)
    }

    expect(
      await resolveConfiguredProviderModelAlias("gpt-5-mini", countingResolver),
    ).toBeNull()
    expect(
      await ensureConfiguredProviderModelAlias(null, countingResolver),
    ).toBeNull()
    expect(calls).toBe(0)
  })

  test("returns the alias when the provider is configured", async () => {
    expect(
      await resolveConfiguredProviderModelAlias(
        "dash/qwen-plus",
        configuredResolver,
      ),
    ).toEqual({ provider: "dash", model: "qwen-plus" })
  })

  test("returns null when the provider is not configured", async () => {
    expect(
      await resolveConfiguredProviderModelAlias(
        "contoso/glm-5.2",
        missingResolver,
      ),
    ).toBeNull()
    expect(
      await ensureConfiguredProviderModelAlias(
        { provider: "contoso", model: "family/glm-5.2" },
        missingResolver,
      ),
    ).toBeNull()
  })
})
