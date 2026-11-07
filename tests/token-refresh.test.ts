import { afterEach, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type { CodexCredentials } from "~/lib/oauth/codex"
import {
  getRefreshDeadlineMs,
  getRefreshPollDelayMs,
  refreshCodexCredentialsOnce,
  scheduleRefreshRetry,
  type CodexRefreshDependencies,
} from "~/lib/token"

const repoRoot = fileURLToPath(new URL("../", import.meta.url))
const decoder = new TextDecoder()
const tempDirs: Array<string> = []

const expiredCredentials: CodexCredentials = {
  accessToken: "expired-access-token",
  accountId: "acct_old",
  expiresAt: 0,
  refreshToken: "old-refresh-token",
}

const rotatedCredentials: CodexCredentials = {
  accessToken: "rotated-access-token",
  accountId: expiredCredentials.accountId,
  expiresAt: Date.now() + 60 * 60 * 1000,
  refreshToken: "rotated-refresh-token",
}

function createTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-api-refresh-"))
  tempDirs.push(tempDir)
  return tempDir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop()
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test("builds refresh deadline from refresh_in and local time", () => {
  const nowMs = 1_000_000

  expect(getRefreshDeadlineMs(1_800, nowMs)).toBe(nowMs + 1_740_000)
})

test("clamps refresh deadline to avoid a hot loop", () => {
  const nowMs = 1_000_000

  expect(getRefreshDeadlineMs(30, nowMs)).toBe(nowMs + 1_000)
})

test("caps poll delay at 15 seconds while waiting", () => {
  const nowMs = 1_000_000

  expect(getRefreshPollDelayMs(nowMs + 120_000, nowMs)).toBe(15_000)
})

test("uses remaining delay when refresh is close", () => {
  const nowMs = 1_000_000

  expect(getRefreshPollDelayMs(nowMs + 8_000, nowMs)).toBe(8_000)
})

test("returns zero when refresh is already due", () => {
  const nowMs = 1_000_000

  expect(getRefreshPollDelayMs(nowMs - 1, nowMs)).toBe(0)
})

test("Codex and Copilot refresh failures share exponential backoff with jitter", () => {
  const nowMs = 1_000_000
  const first = scheduleRefreshRetry(15_000, nowMs, 0)
  expect(first).toEqual({
    delayMs: 15_000,
    nextRetryDelayMs: 30_000,
    refreshAtMs: nowMs + 15_000,
  })

  const jittered = scheduleRefreshRetry(first.nextRetryDelayMs, nowMs, 0.5)
  expect(jittered.delayMs).toBe(30_000 + 7_500)
  expect(jittered.nextRetryDelayMs).toBe(60_000)
  expect(jittered.refreshAtMs).toBe(nowMs + jittered.delayMs)

  const capped = scheduleRefreshRetry(600_000, nowMs, 0.9)
  expect(capped.delayMs).toBe(600_000)
  expect(capped.nextRetryDelayMs).toBe(600_000)
  expect(capped.refreshAtMs).toBe(nowMs + 600_000)
})

test("shares one in-flight Codex refresh between concurrent callers", async () => {
  let completeRefresh: ((credentials: CodexCredentials) => void) | undefined
  const refreshCalls: Array<CodexCredentials> = []
  const persisted: Array<CodexCredentials> = []
  const dependencies: CodexRefreshDependencies = {
    getCurrentCredentials: () => null,
    persistCodexCredentials: (credentials) => {
      persisted.push(credentials)
      return Promise.resolve()
    },
    refreshCodexCredentials: (credentials) => {
      refreshCalls.push(credentials)
      return new Promise<CodexCredentials>((resolve) => {
        completeRefresh = resolve
      })
    },
  }

  const first = refreshCodexCredentialsOnce(expiredCredentials, dependencies)
  const second = refreshCodexCredentialsOnce(expiredCredentials, dependencies)

  expect(second).toBe(first)
  expect(refreshCalls).toEqual([expiredCredentials])

  completeRefresh?.(rotatedCredentials)

  expect(await first).toBe(rotatedCredentials)
  expect(await second).toBe(rotatedCredentials)
  expect(refreshCalls).toHaveLength(1)
  expect(persisted).toEqual([rotatedCredentials])
})

test("reuses credentials rotated by another refresh instead of the stale token", async () => {
  let refreshCalls = 0

  const credentials = await refreshCodexCredentialsOnce(expiredCredentials, {
    getCurrentCredentials: () => rotatedCredentials,
    persistCodexCredentials: () => Promise.resolve(),
    refreshCodexCredentials: () => {
      refreshCalls += 1
      return Promise.resolve(rotatedCredentials)
    },
  })

  expect(credentials).toBe(rotatedCredentials)
  expect(refreshCalls).toBe(0)
})

test("shares a rotated token refresh between callers with old and current snapshots", async () => {
  const current = {
    ...expiredCredentials,
    accountId: "rotated-single-flight",
    refreshToken: "current-refresh",
  }
  const old = { ...current, refreshToken: "old-refresh" }
  const rotated = { ...rotatedCredentials, accountId: current.accountId }
  const refreshing = Promise.withResolvers<CodexCredentials>()
  let refreshCalls = 0
  const dependencies: CodexRefreshDependencies = {
    getCurrentCredentials: () => current,
    persistCodexCredentials: () => Promise.resolve(),
    refreshCodexCredentials: (base) => {
      expect(base).toBe(current)
      refreshCalls++
      return refreshing.promise
    },
  }
  const first = refreshCodexCredentialsOnce(old, dependencies)
  const second = refreshCodexCredentialsOnce(current, dependencies)
  expect(second).toBe(first)
  refreshing.resolve(rotated)
  expect(await first).toBe(rotated)
  expect(refreshCalls).toBe(1)
})

test("refreshes when the caller's snapshot is still the current credentials", async () => {
  const snapshot: CodexCredentials = {
    ...expiredCredentials,
    expiresAt: Date.now() + 60 * 60 * 1000,
  }
  let refreshCalls = 0

  const credentials = await refreshCodexCredentialsOnce(snapshot, {
    getCurrentCredentials: () => snapshot,
    persistCodexCredentials: () => Promise.resolve(),
    refreshCodexCredentials: () => {
      refreshCalls += 1
      return Promise.resolve(rotatedCredentials)
    },
  })

  expect(credentials).toBe(rotatedCredentials)
  expect(refreshCalls).toBe(1)
})

test("does not cache a failed Codex refresh", async () => {
  let refreshCalls = 0
  const dependencies: CodexRefreshDependencies = {
    getCurrentCredentials: () => null,
    persistCodexCredentials: () => Promise.resolve(),
    refreshCodexCredentials: () => {
      refreshCalls += 1
      return refreshCalls === 1 ?
          Promise.reject(new Error("temporary failure"))
        : Promise.resolve(rotatedCredentials)
    },
  }

  const failure = await refreshCodexCredentialsOnce(
    expiredCredentials,
    dependencies,
  ).then(
    () => null,
    (error: unknown) => error,
  )

  expect(failure).toBeInstanceOf(Error)
  expect((failure as Error).message).toBe("temporary failure")

  const retry = await refreshCodexCredentialsOnce(
    expiredCredentials,
    dependencies,
  )

  expect(retry).toBe(rotatedCredentials)
  expect(refreshCalls).toBe(2)
})

test("retries persistence without refreshing rotated credentials again", async () => {
  let persistCalls = 0
  let refreshCalls = 0
  const dependencies: CodexRefreshDependencies = {
    getCurrentCredentials: () => expiredCredentials,
    persistCodexCredentials: () => {
      persistCalls += 1
      return persistCalls === 1 ?
          Promise.reject(new Error("temporary persistence failure"))
        : Promise.resolve()
    },
    refreshCodexCredentials: () => {
      refreshCalls += 1
      return Promise.resolve(rotatedCredentials)
    },
  }

  const failure = await refreshCodexCredentialsOnce(
    expiredCredentials,
    dependencies,
  ).then(
    () => null,
    (error: unknown) => error,
  )

  expect(failure).toBeInstanceOf(Error)
  expect((failure as Error).message).toBe("temporary persistence failure")

  const retry = await refreshCodexCredentialsOnce(
    expiredCredentials,
    dependencies,
  )

  expect(retry).toBe(rotatedCredentials)
  expect(refreshCalls).toBe(1)
  expect(persistCalls).toBe(2)
})

test("keeps a failed persistence retry separate from a new same-account sign-in", async () => {
  const old = { ...expiredCredentials, accountId: "reauth-persistence" }
  const fresh = { ...old, refreshToken: "new-signin-refresh" }
  const oldRotated = { ...rotatedCredentials, accountId: old.accountId }
  const newRotated = { ...oldRotated, refreshToken: "new-rotated-refresh" }
  let oldPersistCalls = 0
  let oldRefreshCalls = 0
  const dependencies: CodexRefreshDependencies = {
    getCurrentCredentials: () => null,
    persistCodexCredentials: () => {
      if (++oldPersistCalls === 1)
        return Promise.reject(new Error("disk unavailable"))
      return Promise.resolve()
    },
    refreshCodexCredentials: () => {
      oldRefreshCalls++
      return Promise.resolve(oldRotated)
    },
  }
  const failure = await refreshCodexCredentialsOnce(old, dependencies).catch(
    (error: unknown) => error,
  )
  expect(failure).toHaveProperty("message", "disk unavailable")
  let freshRefreshCalls = 0
  const result = await refreshCodexCredentialsOnce(fresh, {
    getCurrentCredentials: () => null,
    persistCodexCredentials: () => Promise.resolve(),
    refreshCodexCredentials: (base) => {
      expect(base.refreshToken).toBe(fresh.refreshToken)
      freshRefreshCalls++
      return Promise.resolve(newRotated)
    },
  })
  expect(result).toBe(newRotated)
  expect(freshRefreshCalls).toBe(1)
  expect(await refreshCodexCredentialsOnce(old, dependencies)).toBe(oldRotated)
  expect(oldRefreshCalls).toBe(1)
  expect(oldPersistCalls).toBe(2)
})

test("refreshes expired Codex credentials once for concurrent Codex requests", () => {
  const tempDir = createTempDir()
  fs.writeFileSync(path.join(tempDir, "config.json"), "{}\n", "utf8")
  fs.writeFileSync(
    path.join(tempDir, "codex_credentials.json"),
    `${JSON.stringify(expiredCredentials, null, 2)}\n`,
    "utf8",
  )

  const script = `
    const payload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct_old" },
      }),
    ).toString("base64url")
    const accessToken = "header." + payload + ".signature"

    let refreshCalls = 0
    globalThis.fetch = () => {
      refreshCalls += 1
      return Promise.resolve(
        Response.json({
          access_token: accessToken,
          refresh_token: "rotated-refresh-token",
          expires_in: 3600,
        }),
      )
    }

    const { resolveProviderConfig } = await import("./src/lib/provider-resolver")
    const resolved = await Promise.all(
      [0, 1, 2].map(() => resolveProviderConfig("codex")),
    )
    const { stopCodexRefreshLoop } = await import("./src/lib/token")

    console.log(
      JSON.stringify({
        apiKeys: resolved.map((config) => config?.apiKey),
        refreshCalls,
      }),
    )
    stopCodexRefreshLoop()
  `

  const result = Bun.spawnSync({
    cmd: [process.execPath, "--eval", script],
    cwd: repoRoot,
    env: {
      ...process.env,
      COPILOT_API_HOME: tempDir,
      COPILOT_API_OAUTH_APP: "",
      COPILOT_API_ENTERPRISE_URL: "",
    },
  })

  if (result.exitCode !== 0) {
    throw new Error(
      `Refresh script failed with exit code ${result.exitCode}\nstderr:\n${decoder.decode(result.stderr)}`,
    )
  }

  const output = JSON.parse(decoder.decode(result.stdout).trim()) as {
    apiKeys: Array<string>
    refreshCalls: number
  }
  const [firstApiKey, ...otherApiKeys] = output.apiKeys

  expect(output.refreshCalls).toBe(1)
  expect(firstApiKey).toStartWith("header.")
  expect(firstApiKey).not.toBe(expiredCredentials.accessToken)
  expect(otherApiKeys).toEqual([firstApiKey, firstApiKey])
})

test("refreshes only the selected Codex account and preserves the selection", () => {
  const tempDir = createTempDir()
  const activeCredentials = {
    accessToken: "expired-active-access",
    accountId: "acct_active",
    expiresAt: 0,
    refreshToken: "expired-active-refresh",
    alias: "Work",
  }
  const inactiveCredentials = {
    accessToken: "inactive-access",
    accountId: "acct_inactive",
    expiresAt: Date.now() + 60 * 60 * 1000,
    refreshToken: "inactive-refresh",
    alias: "Personal",
  }
  fs.writeFileSync(
    path.join(tempDir, "config.json"),
    `${JSON.stringify({ providers: { codex: { accountId: "acct_active", enabled: true } } })}\n`,
    "utf8",
  )
  fs.writeFileSync(
    path.join(tempDir, "codex_credentials.json"),
    `${JSON.stringify({ version: 1, accounts: [activeCredentials, inactiveCredentials] }, null, 2)}\n`,
    "utf8",
  )

  const script = `
    const payload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct_active" },
      }),
    ).toString("base64url")
    globalThis.fetch = () => Promise.resolve(
      Response.json({
        access_token: "header." + payload + ".signature",
        refresh_token: "rotated-active-refresh",
        expires_in: 3600,
      }),
    )

    const { resolveProviderConfig } = await import("./src/lib/provider-resolver")
    await resolveProviderConfig("codex")
    const { readCodexCredentialStore } = await import("./src/lib/credential-store")
    const { getRawProviderConfig } = await import("./src/lib/config")
    const { stopCodexRefreshLoop } = await import("./src/lib/token")
    console.log(JSON.stringify({
      accountId: getRawProviderConfig("codex")?.accountId,
      store: await readCodexCredentialStore(),
    }))
    stopCodexRefreshLoop()
  `

  const result = Bun.spawnSync({
    cmd: [process.execPath, "--eval", script],
    cwd: repoRoot,
    env: {
      ...process.env,
      COPILOT_API_HOME: tempDir,
      COPILOT_API_OAUTH_APP: "",
      COPILOT_API_ENTERPRISE_URL: "",
    },
  })

  if (result.exitCode !== 0) {
    throw new Error(decoder.decode(result.stderr))
  }

  const output = JSON.parse(decoder.decode(result.stdout).trim()) as {
    accountId: string
    store: {
      accounts: Array<CodexCredentials & { alias?: string }>
      version: number
    }
  }
  expect(output.accountId).toBe("acct_active")
  expect(output.store.accounts).toHaveLength(2)
  expect(output.store.accounts[0]).toMatchObject({
    accountId: "acct_active",
    alias: "Work",
    refreshToken: "rotated-active-refresh",
  })
  expect(output.store.accounts[1]).toEqual(inactiveCredentials)
})

test("does not write a removed Codex account back when refreshing it", () => {
  const tempDir = createTempDir()
  const survivingCredentials = {
    accessToken: "surviving-access",
    accountId: "acct_surviving",
    expiresAt: Date.now() + 60 * 60 * 1000,
    refreshToken: "surviving-refresh",
  }
  fs.writeFileSync(
    path.join(tempDir, "codex_credentials.json"),
    `${JSON.stringify({ version: 1, accounts: [survivingCredentials] }, null, 2)}\n`,
    "utf8",
  )

  const script = `
    const payload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct_removed" },
      }),
    ).toString("base64url")
    globalThis.fetch = () => Promise.resolve(
      Response.json({
        access_token: "header." + payload + ".signature",
        refresh_token: "rotated-removed-refresh",
        expires_in: 3600,
      }),
    )

    const { readCodexCredentialStore } = await import("./src/lib/credential-store")
    const { refreshCodexCredentialsOnce, stopCodexRefreshLoop } = await import("./src/lib/token")
    const refreshed = await refreshCodexCredentialsOnce({
      accessToken: "removed-access",
      refreshToken: "removed-refresh",
      expiresAt: 0,
      accountId: "acct_removed",
    })
    console.log(JSON.stringify({
      refreshed,
      store: await readCodexCredentialStore(),
    }))
    stopCodexRefreshLoop()
  `

  const result = Bun.spawnSync({
    cmd: [process.execPath, "--eval", script],
    cwd: repoRoot,
    env: {
      ...process.env,
      COPILOT_API_HOME: tempDir,
      COPILOT_API_OAUTH_APP: "",
      COPILOT_API_ENTERPRISE_URL: "",
    },
  })

  if (result.exitCode !== 0) {
    throw new Error(decoder.decode(result.stderr))
  }

  const output = JSON.parse(decoder.decode(result.stdout).trim()) as {
    refreshed: CodexCredentials
    store: { accounts: Array<CodexCredentials>; version: number }
  }
  expect(output.refreshed).toMatchObject({
    accountId: "acct_removed",
    refreshToken: "rotated-removed-refresh",
  })
  expect(output.store.accounts).toEqual([survivingCredentials])
})
