import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = fileURLToPath(new URL("../", import.meta.url))
const tempDirs: Array<string> = []

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

// Isolate runtime globals, refresh loops, and module mocks from other suites.
function runScenario(scenario: string): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-reload-"))
  tempDirs.push(tempDir)
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "--eval",
      `
        import assert from "node:assert/strict"
        import fs from "node:fs"
        import { spyOn } from "bun:test"
        import { PATHS } from "./src/lib/storage/paths"
        import { reloadConfig, writeConfigToDisk } from "./src/lib/config/config-store"
        import { reloadServerConfig } from "./src/lib/config/config-reload"
        import * as credentialStore from "./src/lib/auth/credential-store"
        import { resolveProviderConfig } from "./src/lib/providers/provider-resolver"
        import { stopCodexRefreshLoop } from "./src/lib/auth/token"
        import { state } from "./src/lib/state"
        import { buildCodexRequestHeaders } from "./src/services/codex/create-responses"

        const credentials = (accountId, label, expired = false) => ({
          accountId,
          accessToken: label + "-access",
          refreshToken: label + "-refresh",
          expiresAt: Date.now() + (expired ? -3600000 : 3600000),
        })
        const accountA = credentials("account-a", "old-a", true)
        const accountB = credentials("account-b", "valid-b")
        const saveConfig = (accountId, enabled = true) => writeConfigToDisk({
          auth: { adminApiKey: "test-admin" },
          providers: {
            "github-copilot": { enabled: false },
            codex: { accountId, enabled, type: "openai-responses",
              authType: "oauth2", baseUrl: "https://chatgpt.com/backend-api" },
          },
        })
        const writeAccounts = (accounts) => fs.writeFileSync(
          PATHS.CODEX_CREDENTIAL_PATH,
          JSON.stringify({ version: 1, accounts }),
        )
        const tokenResponse = (accountId, label) => {
          const payload = Buffer.from(JSON.stringify({
            "https://api.openai.com/auth": { chatgpt_account_id: accountId },
          })).toString("base64url")
          return Response.json({
            access_token: "header." + payload + "." + label,
            refresh_token: label + "-refresh",
            expires_in: 3600,
          })
        }
        try {
          ${scenario}
        } finally {
          stopCodexRefreshLoop()
        }
      `,
    ],
    cwd: repoRoot,
    env: { ...process.env, COPILOT_API_HOME: tempDir },
    timeout: 10_000,
  })
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0)
}

test.each([false, true])(
  "loads newly saved same-account credentials instead of cached credentials (expired: %s)",
  (expired) => {
    runScenario(`
      saveConfig(accountA.accountId)
      writeAccounts([{ ...accountA, expiresAt: Date.now() + 3600000 }])
      reloadConfig()
      await resolveProviderConfig("codex")
      if (${expired}) state.codexExpiresAt = Date.now() - 3600000
      const fresh = credentials(accountA.accountId, "new-signin")
      writeAccounts([fresh])
      globalThis.fetch = () => { throw new Error("Must not refresh the old token") }
      await reloadServerConfig()
      assert.equal(state.codexAccessToken, undefined)
      const resolved = await resolveProviderConfig("codex")
      assert.equal(resolved.apiKey, fresh.accessToken)
      assert.equal(state.codexRefreshToken, fresh.refreshToken)
    `)
  },
)

test.each([200, 401])(
  "keeps account B after account A initialization finishes late (OAuth status: %s)",
  (status) => {
    runScenario(`
      saveConfig(accountA.accountId)
      writeAccounts([accountA, accountB])
      reloadConfig()
      const started = Promise.withResolvers()
      const refreshing = Promise.withResolvers()
      globalThis.fetch = () => { started.resolve(); return refreshing.promise }
      const oldRequest = resolveProviderConfig("codex")
      await started.promise
      saveConfig(accountB.accountId)
      await reloadServerConfig()
      await resolveProviderConfig("codex")
      refreshing.resolve(${status} === 200
        ? tokenResponse(accountA.accountId, "rotated-a")
        : Response.json({ error: "invalid_grant" }, { status: 401 }))
      const oldResult = await oldRequest
      assert.equal(oldResult.apiKey, accountB.accessToken)
      assert.equal(state.codexAccountId, accountB.accountId)
      assert.equal(state.codexRefreshToken, accountB.refreshToken)
      assert.equal(buildCodexRequestHeaders(new Headers()).get("chatgpt-account-id"), accountB.accountId)
    `)
  },
)

test.each([false, true])(
  "does not overwrite a new same-account sign-in with a late refresh (new credentials expired: %s)",
  (expired) => {
    runScenario(`
      saveConfig(accountA.accountId)
      writeAccounts([accountA])
      reloadConfig()
      const started = Promise.withResolvers()
      const refreshing = Promise.withResolvers()
      const fresh = credentials(accountA.accountId, "new-signin", ${expired})
      globalThis.fetch = (_input, options) => {
        const token = new URLSearchParams(options.body).get("refresh_token")
        if (token === accountA.refreshToken) {
          started.resolve()
          return refreshing.promise
        }
        assert.equal(token, fresh.refreshToken)
        return Promise.resolve(tokenResponse(accountA.accountId, "rotated-new-signin"))
      }
      const oldRequest = resolveProviderConfig("codex")
      await started.promise
      writeAccounts([fresh])
      await reloadServerConfig()
      const resolved = await resolveProviderConfig("codex")
      const expectedRefreshToken = ${expired} ? "rotated-new-signin-refresh" : fresh.refreshToken
      refreshing.resolve(tokenResponse(accountA.accountId, "rotated-old-signin"))
      const oldResult = await oldRequest
      const stored = await credentialStore.readCodexCredentials(accountA.accountId)
      assert.equal(oldResult.apiKey, resolved.apiKey)
      assert.equal(state.codexRefreshToken, expectedRefreshToken)
      assert.equal(stored.refreshToken, expectedRefreshToken)
      assert.equal(stored.accessToken, resolved.apiKey)
    `)
  },
)

test.each([200, 401])(
  "does not revive a disabled Codex provider after initialization (OAuth status: %s)",
  (status) => {
    runScenario(`
      saveConfig(accountA.accountId)
      writeAccounts([accountA])
      reloadConfig()
      const started = Promise.withResolvers()
      const refreshing = Promise.withResolvers()
      globalThis.fetch = () => { started.resolve(); return refreshing.promise }
      const oldRequest = resolveProviderConfig("codex")
      await started.promise
      saveConfig(accountA.accountId, false)
      await reloadServerConfig()
      refreshing.resolve(${status} === 200
        ? tokenResponse(accountA.accountId, "rotated-a")
        : Response.json({ error: "invalid_grant" }, { status: 401 }))
      assert.equal(await oldRequest, null)
      assert.equal(state.codexAccessToken, undefined)
      assert.equal(state.codexAccountId, undefined)
    `)
  },
)

test.each([false, true])(
  "ignores an old credential-store read after account selection changes (initial selection: %s)",
  (selected) => {
    runScenario(`
      saveConfig(${selected} ? accountA.accountId : undefined)
      writeAccounts([accountA, accountB])
      reloadConfig()
      const reading = Promise.withResolvers()
      const started = Promise.withResolvers()
      spyOn(credentialStore, "readCodexCredentialStore").mockImplementationOnce(() => {
        started.resolve()
        return reading.promise
      })
      const oldRequest = resolveProviderConfig("codex")
      await started.promise
      saveConfig(accountB.accountId)
      await reloadServerConfig()
      await resolveProviderConfig("codex")
      reading.resolve({ version: 1, accounts: [accountA] })
      assert.equal((await oldRequest).apiKey, accountB.accessToken)
      assert.equal(state.codexAccountId, accountB.accountId)
    `)
  },
)
