import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  clearCodexCredentials,
  GITHUB_TOKEN_ENV,
  MAX_CODEX_ACCOUNTS,
  readCodexCredentialStore,
  readCodexCredentials,
  readGitHubTokenFromEnv,
  removeCodexCredentials,
  withCredentialFileLock,
  writeCodexCredentials,
  writeGitHubToken,
} from "~/lib/auth/credential-store"
import { PATHS } from "~/lib/storage/paths"

const originalGitHubTokenPath = PATHS.GITHUB_TOKEN_PATH
const originalCodexCredentialPath = PATHS.CODEX_CREDENTIAL_PATH
const originalFsyncSync = fs.fsyncSync
const repoRoot = fileURLToPath(new URL("../", import.meta.url))
const tempDirs: Array<string> = []

function useTempCredentialPaths(): {
  githubTokenPath: string
  codexCredentialPath: string
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "credential-store-"))
  tempDirs.push(tempDir)
  const githubTokenPath = path.join(tempDir, "github_token")
  const codexCredentialPath = path.join(tempDir, "codex_credentials.json")
  PATHS.GITHUB_TOKEN_PATH = githubTokenPath
  PATHS.CODEX_CREDENTIAL_PATH = codexCredentialPath
  return { githubTokenPath, codexCredentialPath }
}

function listTemporaryFiles(filePath: string): Array<string> {
  const basenamePrefix = `.${path.basename(filePath)}.`
  return fs
    .readdirSync(path.dirname(filePath))
    .filter(
      (entry) => entry.startsWith(basenamePrefix) && entry.endsWith(".tmp"),
    )
}

async function getRejectedError(operation: Promise<void>): Promise<Error> {
  try {
    await operation
  } catch (error) {
    if (error instanceof Error) {
      return error
    }
    throw error
  }

  throw new Error("Expected credential write to fail")
}

async function waitForFiles(filePaths: Array<string>): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!filePaths.every((filePath) => fs.existsSync(filePath))) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for credential writer processes")
    }
    await Bun.sleep(5)
  }
}

afterEach(() => {
  mock.restore()
  fs.fsyncSync = originalFsyncSync
  PATHS.GITHUB_TOKEN_PATH = originalGitHubTokenPath
  PATHS.CODEX_CREDENTIAL_PATH = originalCodexCredentialPath

  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe("credential store atomic writes", () => {
  if (process.platform === "win32") {
    test.each(["EPERM", "EACCES"])(
      "waits safely when inspecting a contended Windows lock fails with %s",
      async (code) => {
        const { codexCredentialPath } = useTempCredentialPaths()
        const held = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const inspected = Promise.withResolvers<void>()
        const holder = withCredentialFileLock(codexCredentialPath, async () => {
          held.resolve()
          await release.promise
        })
        await held.promise
        spyOn(fs.promises, "readFile").mockImplementationOnce(
          (): Promise<never> => {
            inspected.resolve()
            return Promise.reject(
              Object.assign(new Error("Lock contention"), { code }),
            )
          },
        )
        const credentials = {
          accountId: "account-id",
          accessToken: "access-token",
          refreshToken: "refresh-token",
          expiresAt: 123,
        }
        const writer = writeCodexCredentials(credentials)
        try {
          await inspected.promise
          expect(fs.existsSync(`${codexCredentialPath}.lock`)).toBe(true)
        } finally {
          release.resolve()
        }
        await Promise.all([holder, writer])
        expect(await readCodexCredentials()).toEqual(credentials)
        expect(fs.existsSync(`${codexCredentialPath}.lock`)).toBe(false)
      },
    )
  }

  test("does not overwrite a newer sign-in with an old refresh result", async () => {
    useTempCredentialPaths()
    const fresh = {
      accountId: "same-account",
      accessToken: "new-signin-access",
      refreshToken: "new-signin-refresh",
      expiresAt: 123,
    }
    await writeCodexCredentials(fresh)
    await writeCodexCredentials(
      {
        ...fresh,
        accessToken: "old-rotated-access",
        refreshToken: "old-rotated-refresh",
      },
      { insertIfMissing: false, expectedRefreshToken: "old-refresh" },
    )
    expect(await readCodexCredentials(fresh.accountId)).toEqual(fresh)
  })

  test("writes a matching refresh and allows retrying the same rotated result", async () => {
    useTempCredentialPaths()
    const old = {
      accountId: "same-account",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: 123,
    }
    const rotated = {
      ...old,
      accessToken: "rotated-access",
      refreshToken: "rotated-refresh",
    }
    await writeCodexCredentials(old)
    for (let attempt = 0; attempt < 2; attempt++) {
      await writeCodexCredentials(rotated, {
        insertIfMissing: false,
        expectedRefreshToken: old.refreshToken,
      })
      expect(await readCodexCredentials(old.accountId)).toEqual(rotated)
    }
  })

  test("writes GitHub and Codex credentials with protected permissions", async () => {
    const { githubTokenPath, codexCredentialPath } = useTempCredentialPaths()
    const credentials = {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: 123,
      accountId: "account-id",
    }

    await writeGitHubToken(" github-token ")
    await writeCodexCredentials(credentials)

    expect(fs.readFileSync(githubTokenPath, "utf8")).toBe("github-token")
    expect(JSON.parse(fs.readFileSync(codexCredentialPath, "utf8"))).toEqual({
      version: 1,
      accounts: [credentials],
    })
    expect(listTemporaryFiles(githubTokenPath)).toEqual([])
    expect(listTemporaryFiles(codexCredentialPath)).toEqual([])

    if (process.platform !== "win32") {
      expect(fs.statSync(githubTokenPath).mode & 0o777).toBe(0o600)
      expect(fs.statSync(codexCredentialPath).mode & 0o777).toBe(0o600)
    }
  })

  test("preserves Codex credentials when fsync fails", async () => {
    const { codexCredentialPath } = useTempCredentialPaths()
    const oldCredentials = {
      accessToken: "old-access-token",
      refreshToken: "old-refresh-token",
      expiresAt: 123,
      accountId: "old-account-id",
    }
    const oldContent = `${JSON.stringify(oldCredentials, null, 2)}\n`
    fs.writeFileSync(codexCredentialPath, oldContent, "utf8")
    fs.fsyncSync = (() => {
      throw new Error("forced credential fsync failure")
    }) as typeof fs.fsyncSync

    const error = await getRejectedError(
      writeCodexCredentials({
        accessToken: "new-access-token",
        refreshToken: "new-refresh-token",
        expiresAt: 456,
        accountId: "new-account-id",
      }),
    )

    expect(error.message).toBe("forced credential fsync failure")
    expect(fs.readFileSync(codexCredentialPath, "utf8")).toBe(oldContent)
    expect(listTemporaryFiles(codexCredentialPath)).toEqual([])
    expect(fs.existsSync(`${codexCredentialPath}.lock`)).toBe(false)
  })

  test("recovers an abandoned Codex credential lock", async () => {
    const { codexCredentialPath } = useTempCredentialPaths()
    const lockPath = `${codexCredentialPath}.lock`
    fs.writeFileSync(lockPath, "", "utf8")
    fs.utimesSync(lockPath, new Date(0), new Date(0))

    await writeCodexCredentials({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: 123,
      accountId: "account-id",
    })

    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({
        createdAt: Date.now(),
        owner: "exited-writer",
        pid: 2_147_483_647,
      })}\n`,
      "utf8",
    )
    await writeCodexCredentials({
      accessToken: "updated-access-token",
      refreshToken: "updated-refresh-token",
      expiresAt: 456,
      accountId: "account-id",
    })

    expect((await readCodexCredentialStore())?.accounts).toEqual([
      {
        accessToken: "updated-access-token",
        refreshToken: "updated-refresh-token",
        expiresAt: 456,
        accountId: "account-id",
      },
    ])
    expect(fs.existsSync(lockPath)).toBe(false)
  })
})

describe("Codex account store", () => {
  test("reads the legacy single-account credential shape", () => {
    const { codexCredentialPath } = useTempCredentialPaths()
    const credentials = {
      accessToken: "legacy-access-token",
      refreshToken: "legacy-refresh-token",
      expiresAt: 123,
      accountId: "legacy-account-id",
    }
    fs.writeFileSync(
      codexCredentialPath,
      `${JSON.stringify(credentials, null, 2)}\n`,
      "utf8",
    )

    expect(readCodexCredentialStore()).resolves.toEqual({
      version: 1,
      accounts: [credentials],
    })
    expect(readCodexCredentials()).resolves.toEqual(credentials)
  })

  test("stores at most three accounts and allows an existing account update", async () => {
    useTempCredentialPaths()

    for (let index = 1; index <= MAX_CODEX_ACCOUNTS; index += 1) {
      await writeCodexCredentials(
        {
          accessToken: `access-${index}`,
          refreshToken: `refresh-${index}`,
          expiresAt: index,
          accountId: `account-${index}`,
        },
        { alias: `Account ${index}` },
      )
    }

    await writeCodexCredentials({
      accessToken: "updated-access",
      refreshToken: "updated-refresh",
      expiresAt: 99,
      accountId: "account-2",
    })

    const store = await readCodexCredentialStore()
    expect(store?.accounts).toHaveLength(MAX_CODEX_ACCOUNTS)
    expect(store?.accounts[1]).toEqual({
      accessToken: "updated-access",
      refreshToken: "updated-refresh",
      expiresAt: 99,
      accountId: "account-2",
      alias: "Account 2",
    })

    expect(
      writeCodexCredentials({
        accessToken: "overflow-access",
        refreshToken: "overflow-refresh",
        expiresAt: 100,
        accountId: "account-4",
      }),
    ).rejects.toThrow(`Codex supports at most ${MAX_CODEX_ACCOUNTS} accounts`)
    expect((await readCodexCredentialStore())?.accounts).toHaveLength(
      MAX_CODEX_ACCOUNTS,
    )
  })

  test("rejects duplicate aliases without changing stored accounts", async () => {
    useTempCredentialPaths()
    await writeCodexCredentials(
      {
        accessToken: "access-1",
        refreshToken: "refresh-1",
        expiresAt: 1,
        accountId: "account-1",
      },
      { alias: "Work" },
    )

    expect(
      writeCodexCredentials(
        {
          accessToken: "access-2",
          refreshToken: "refresh-2",
          expiresAt: 2,
          accountId: "account-2",
        },
        { alias: "work" },
      ),
    ).rejects.toThrow("Codex account alias 'work' is already in use")
    expect((await readCodexCredentialStore())?.accounts).toHaveLength(1)
  })

  test("serializes concurrent account updates without losing credentials", async () => {
    const { codexCredentialPath } = useTempCredentialPaths()
    const updatedAccount = {
      accessToken: "updated-access-1",
      refreshToken: "updated-refresh-1",
      expiresAt: 2,
      accountId: "account-1",
    }
    const addedAccount = {
      accessToken: "access-2",
      refreshToken: "refresh-2",
      expiresAt: 2,
      accountId: "account-2",
    }

    for (let iteration = 0; iteration < 5; iteration += 1) {
      await clearCodexCredentials()
      await writeCodexCredentials({
        accessToken: "old-access-1",
        refreshToken: "old-refresh-1",
        expiresAt: 1,
        accountId: "account-1",
      })

      await Promise.all([
        writeCodexCredentials(updatedAccount),
        writeCodexCredentials(addedAccount),
      ])

      expect((await readCodexCredentialStore())?.accounts).toEqual([
        updatedAccount,
        addedAccount,
      ])
    }
    expect(fs.existsSync(`${codexCredentialPath}.lock`)).toBe(false)
  })

  test("serializes credential updates across processes", async () => {
    const { codexCredentialPath } = useTempCredentialPaths()
    const tempDir = path.dirname(codexCredentialPath)
    const goPath = path.join(tempDir, "writers-go")
    const readyPaths = [
      path.join(tempDir, "writer-a-ready"),
      path.join(tempDir, "writer-b-ready"),
    ]
    await writeCodexCredentials({
      accessToken: "old-access-1",
      refreshToken: "old-refresh-1",
      expiresAt: 1,
      accountId: "account-1",
    })

    const script = `
      const fs = await import("node:fs")
      const { writeCodexCredentials } = await import("./src/lib/auth/credential-store")
      fs.writeFileSync(process.env.READY_PATH, "ready", "utf8")
      while (!fs.existsSync(process.env.GO_PATH)) await Bun.sleep(5)
      await writeCodexCredentials(JSON.parse(process.env.ACCOUNT))
    `
    const accounts = [
      {
        accessToken: "updated-access-1",
        refreshToken: "updated-refresh-1",
        expiresAt: 2,
        accountId: "account-1",
      },
      {
        accessToken: "access-2",
        refreshToken: "refresh-2",
        expiresAt: 2,
        accountId: "account-2",
      },
    ]
    const writers = accounts.map((account, index) =>
      Bun.spawn([process.execPath, "--eval", script], {
        cwd: repoRoot,
        env: {
          ...process.env,
          ACCOUNT: JSON.stringify(account),
          COPILOT_API_HOME: tempDir,
          GO_PATH: goPath,
          READY_PATH: readyPaths[index],
        },
        stderr: "pipe",
        stdout: "ignore",
      }),
    )

    try {
      await waitForFiles(readyPaths)
      fs.writeFileSync(goPath, "go", "utf8")
      const results = await Promise.all(
        writers.map(async (writer) => ({
          exitCode: await writer.exited,
          stderr: await new Response(writer.stderr).text(),
        })),
      )
      expect(results).toEqual([
        { exitCode: 0, stderr: "" },
        { exitCode: 0, stderr: "" },
      ])
      expect((await readCodexCredentialStore())?.accounts).toEqual(accounts)
      expect(fs.existsSync(`${codexCredentialPath}.lock`)).toBe(false)
    } finally {
      for (const writer of writers) {
        if (writer.exitCode === null) writer.kill()
      }
      await Promise.allSettled(writers.map((writer) => writer.exited))
    }
  })

  test("rejects aliases and account ids that collide across accounts", async () => {
    useTempCredentialPaths()
    await writeCodexCredentials(
      {
        accessToken: "access-1",
        refreshToken: "refresh-1",
        expiresAt: 1,
        accountId: "account-1",
      },
      { alias: "Work" },
    )

    expect(
      writeCodexCredentials(
        {
          accessToken: "access-2",
          refreshToken: "refresh-2",
          expiresAt: 2,
          accountId: "account-2",
        },
        { alias: "ACCOUNT-1" },
      ),
    ).rejects.toThrow(
      "Codex account alias 'ACCOUNT-1' conflicts with another account id",
    )
    expect(
      writeCodexCredentials({
        accessToken: "access-2",
        refreshToken: "refresh-2",
        expiresAt: 2,
        accountId: "ACCOUNT-1",
      }),
    ).rejects.toThrow("Codex account id 'ACCOUNT-1' is already in use")
    expect(
      writeCodexCredentials({
        accessToken: "access-2",
        refreshToken: "refresh-2",
        expiresAt: 2,
        accountId: "work",
      }),
    ).rejects.toThrow(
      "Codex account id 'work' conflicts with another account alias",
    )
    expect((await readCodexCredentialStore())?.accounts).toHaveLength(1)
  })

  test("drops a legacy alias that conflicts with another account id", async () => {
    const { codexCredentialPath } = useTempCredentialPaths()
    const accounts = [
      {
        accessToken: "access-1",
        refreshToken: "refresh-1",
        expiresAt: 1,
        accountId: "account-1",
      },
      {
        accessToken: "access-2",
        refreshToken: "refresh-2",
        expiresAt: 2,
        accountId: "account-2",
        alias: "ACCOUNT-1",
      },
    ]
    fs.writeFileSync(
      codexCredentialPath,
      `${JSON.stringify({ version: 1, accounts }, null, 2)}\n`,
      "utf8",
    )

    expect((await readCodexCredentialStore())?.accounts).toEqual([
      accounts[0],
      {
        accessToken: "access-2",
        refreshToken: "refresh-2",
        expiresAt: 2,
        accountId: "account-2",
      },
    ])

    await writeCodexCredentials({
      accessToken: "updated-access-2",
      refreshToken: "updated-refresh-2",
      expiresAt: 3,
      accountId: "account-2",
    })
    expect(JSON.parse(fs.readFileSync(codexCredentialPath, "utf8"))).toEqual({
      version: 1,
      accounts: [
        accounts[0],
        {
          accessToken: "updated-access-2",
          refreshToken: "updated-refresh-2",
          expiresAt: 3,
          accountId: "account-2",
        },
      ],
    })
  })

  test("requires an account id when multiple accounts are stored", async () => {
    useTempCredentialPaths()
    await writeCodexCredentials({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: 1,
      accountId: "account-1",
    })
    await writeCodexCredentials({
      accessToken: "access-2",
      refreshToken: "refresh-2",
      expiresAt: 2,
      accountId: "account-2",
    })

    expect(readCodexCredentials()).rejects.toThrow(
      "Multiple Codex accounts found but no account is selected",
    )
    expect(readCodexCredentials("account-2")).resolves.toMatchObject({
      accessToken: "access-2",
      accountId: "account-2",
    })
  })

  test("removes a stored Codex account and keeps the others", async () => {
    const { codexCredentialPath } = useTempCredentialPaths()
    const removedAccount = {
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: 1,
      accountId: "account-1",
    }
    await writeCodexCredentials(removedAccount, { alias: "Work" })
    await writeCodexCredentials({
      accessToken: "access-2",
      refreshToken: "refresh-2",
      expiresAt: 2,
      accountId: "account-2",
    })

    expect(removeCodexCredentials("account-1")).resolves.toEqual({
      ...removedAccount,
      alias: "Work",
    })
    expect((await readCodexCredentialStore())?.accounts).toEqual([
      {
        accessToken: "access-2",
        refreshToken: "refresh-2",
        expiresAt: 2,
        accountId: "account-2",
      },
    ])
    expect(fs.existsSync(`${codexCredentialPath}.lock`)).toBe(false)
  })

  test("rejects removing an unknown Codex account id", async () => {
    useTempCredentialPaths()
    await writeCodexCredentials({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: 1,
      accountId: "account-1",
    })

    expect(removeCodexCredentials("missing")).rejects.toThrow(
      "Codex account 'missing' was not found",
    )
    expect(removeCodexCredentials(" ")).rejects.toThrow(
      "Codex account id must be a non-empty string",
    )
    expect((await readCodexCredentialStore())?.accounts).toHaveLength(1)
  })

  test("updates existing Codex accounts without inserting a removed one", async () => {
    useTempCredentialPaths()
    const removedAccount = {
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: 1,
      accountId: "account-1",
    }
    await writeCodexCredentials(removedAccount, { alias: "Work" })
    await writeCodexCredentials({
      accessToken: "access-2",
      refreshToken: "refresh-2",
      expiresAt: 2,
      accountId: "account-2",
    })
    await removeCodexCredentials("account-1")

    await writeCodexCredentials(
      { ...removedAccount, accessToken: "rotated-access-1" },
      { alias: "Work", insertIfMissing: false },
    )
    expect((await readCodexCredentialStore())?.accounts).toEqual([
      {
        accessToken: "access-2",
        refreshToken: "refresh-2",
        expiresAt: 2,
        accountId: "account-2",
      },
    ])

    await writeCodexCredentials(
      {
        accessToken: "rotated-access-2",
        refreshToken: "rotated-refresh-2",
        expiresAt: 3,
        accountId: "account-2",
      },
      { insertIfMissing: false },
    )
    expect((await readCodexCredentialStore())?.accounts).toEqual([
      {
        accessToken: "rotated-access-2",
        refreshToken: "rotated-refresh-2",
        expiresAt: 3,
        accountId: "account-2",
      },
    ])
  })
})

describe("GitHub token from the environment", () => {
  const originalEnvToken = process.env[GITHUB_TOKEN_ENV]

  afterEach(() => {
    if (originalEnvToken === undefined) {
      delete process.env[GITHUB_TOKEN_ENV]
    } else {
      process.env[GITHUB_TOKEN_ENV] = originalEnvToken
    }
  })

  test("returns the trimmed token", () => {
    process.env[GITHUB_TOKEN_ENV] = "  env-token  "

    expect(readGitHubTokenFromEnv()).toBe("env-token")
  })

  test("ignores a blank value", () => {
    process.env[GITHUB_TOKEN_ENV] = "   "

    expect(readGitHubTokenFromEnv()).toBeUndefined()
  })

  test("returns undefined when the variable is unset", () => {
    delete process.env[GITHUB_TOKEN_ENV]

    expect(readGitHubTokenFromEnv()).toBeUndefined()
  })
})
