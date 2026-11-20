import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type { ProviderConfig, ResolvedProviderConfig } from "~/lib/config"
import {
  ensureConfiguredProviderModelAlias,
  resolveConfiguredProviderModelAlias,
} from "~/lib/providers/provider-resolver"

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

function writeCodexAccountStore(
  tempDir: string,
  accounts: Array<CodexCredentialsShape & { alias?: string }>,
): void {
  fs.writeFileSync(
    path.join(tempDir, "codex_credentials.json"),
    `${JSON.stringify({ version: 1, accounts }, null, 2)}\n`,
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
  test("provider enablement controls all routing independently of Codex catalog visibility", () => {
    const tempDir = createTempDir()
    writeConfigFile(tempDir, {
      providers: {
        dashscope: {
          type: "openai-compatible",
          baseUrl: "https://provider.example/v1",
          apiKey: "provider-key",
        },
      },
    })
    const output = runScript(
      tempDir,
      `
      const { getProviderConfig, listEnabledProviders } = await import("./src/lib/config/provider-config");
      const { saveProviderManagementConfig, isProviderAgentModelVisible } = await import("./src/lib/config/provider-management");
      const { getConfig } = await import("./src/lib/config/config-store");
      const before = getProviderConfig("dashscope") !== null;
      saveProviderManagementConfig({ providers: { dashscope: { enabled: false } } });
      const disabled = getProviderConfig("dashscope") === null && !listEnabledProviders().includes("dashscope");
      saveProviderManagementConfig({ providers: { dashscope: { enabled: true, agentsModels: [] } } });
      console.log(JSON.stringify({ before, disabled, reenabled: getProviderConfig("dashscope") !== null,
        credentialsPreserved: getProviderConfig("dashscope")?.apiKey === "provider-key",
        codexVisible: isProviderAgentModelVisible(getConfig().providers?.dashscope, "model") }));
    `,
    )
    expect(JSON.parse(output)).toEqual({
      before: true,
      disabled: true,
      reenabled: true,
      credentialsPreserved: true,
      codexVisible: false,
    })
  })
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
      'const { resolveProviderConfig } = await import("./src/lib/providers/provider-resolver"); const { stopCodexRefreshLoop } = await import("./src/lib/auth/token"); console.log(JSON.stringify(await resolveProviderConfig("codex"))); stopCodexRefreshLoop();',
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
      'const { resolveProviderConfig } = await import("./src/lib/providers/provider-resolver"); console.log(JSON.stringify(await resolveProviderConfig("codex")));',
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
      'const { resolveProviderConfig } = await import("./src/lib/providers/provider-resolver"); const { stopCodexRefreshLoop } = await import("./src/lib/auth/token"); console.log(JSON.stringify(await resolveProviderConfig("codex"))); stopCodexRefreshLoop();',
    )

    expect(JSON.parse(output)).toMatchObject({
      apiKey: "codex-access-token",
      authType: "oauth2",
      baseUrl: "https://chatgpt.com/backend-api",
      name: "codex",
      type: "openai-responses",
    })
    expect(readConfigFile(tempDir).providers?.codex).toMatchObject({
      accountId: "acct_test",
      type: "openai-responses",
      authType: "oauth2",
      baseUrl: "https://chatgpt.com/backend-api",
    })
  })

  test("loads the Codex account selected in provider config", () => {
    const tempDir = createTempDir()
    writeConfigFile(tempDir, {
      providers: {
        codex: {
          accountId: "acct_two",
          type: "openai-responses",
          enabled: true,
          authType: "oauth2",
          baseUrl: "https://chatgpt.com/backend-api",
        },
      },
    })
    writeCodexAccountStore(tempDir, [
      {
        accessToken: "first-access-token",
        accountId: "acct_one",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "first-refresh-token",
      },
      {
        accessToken: "second-access-token",
        accountId: "acct_two",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "second-refresh-token",
      },
    ])

    const output = runScript(
      tempDir,
      'const { resolveProviderConfig } = await import("./src/lib/providers/provider-resolver"); const { state } = await import("./src/lib/state"); const { stopCodexRefreshLoop } = await import("./src/lib/auth/token"); const config = await resolveProviderConfig("codex"); console.log(JSON.stringify({ apiKey: config?.apiKey, accountId: state.codexAccountId })); stopCodexRefreshLoop();',
    )

    expect(JSON.parse(output)).toEqual({
      apiKey: "second-access-token",
      accountId: "acct_two",
    })
  })

  test("requires an explicit selection when multiple Codex accounts exist", () => {
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
    writeCodexAccountStore(tempDir, [
      {
        accessToken: "first-access-token",
        accountId: "acct_one",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "first-refresh-token",
      },
      {
        accessToken: "second-access-token",
        accountId: "acct_two",
        expiresAt: Date.now() + 60 * 60 * 1000,
        refreshToken: "second-refresh-token",
      },
    ])

    const output = runScript(
      tempDir,
      'const { resolveProviderConfig } = await import("./src/lib/providers/provider-resolver"); try { await resolveProviderConfig("codex"); } catch (error) { console.log(error instanceof Error ? error.message : String(error)); }',
    )

    expect(output).toContain(
      "Multiple Codex accounts found but no account is selected",
    )
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
      'const { getRawProviderConfig } = await import("./src/lib/config"); const { persistCodexCredentials } = await import("./src/lib/auth/token"); await persistCodexCredentials({ accessToken: "codex-access-token", accountId: "acct_test", expiresAt: Date.now() + 60 * 60 * 1000, refreshToken: "codex-refresh-token" }); console.log(JSON.stringify(getRawProviderConfig("codex")));',
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
      'const { resolveProviderConfig } = await import("./src/lib/providers/provider-resolver"); console.log(JSON.stringify(await resolveProviderConfig("foundry", async () => "entra-access-token")));',
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
