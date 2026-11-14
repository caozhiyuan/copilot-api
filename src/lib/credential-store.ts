import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import type { CodexCredentials } from "~/lib/oauth/codex"

import { writeFileAtomically } from "./atomic-file"
import { PATHS } from "./paths"

export const MAX_CODEX_ACCOUNTS = 3

const CODEX_CREDENTIAL_LOCK_RETRY_MS = 10
const CODEX_CREDENTIAL_LOCK_TIMEOUT_MS = 10_000
const CODEX_CREDENTIAL_LOCK_STALE_MS = 60_000

export interface CodexStoredAccount extends CodexCredentials {
  alias?: string
}

export interface CodexCredentialStoreV1 {
  version: 1
  accounts: Array<CodexStoredAccount>
}

export interface WriteCodexCredentialsOptions {
  alias?: string
  // Refresh paths pass false so that a removed account is never re-created.
  insertIfMissing?: boolean
  // A refresh must not overwrite credentials from a newer sign-in.
  expectedRefreshToken?: string
}

interface CodexCredentialLockMetadata {
  createdAt: number
  owner: string
  pid: number
}

interface CodexCredentialLock {
  content: string
  fileHandle: Awaited<ReturnType<typeof fs.open>>
  lockPath: string
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

function normalizeCodexAccountSelector(value: string): string {
  return value.trim().toLowerCase()
}

function parseCodexCredentialLockMetadata(
  value: string,
): CodexCredentialLockMetadata | null {
  try {
    const candidate = JSON.parse(value) as Partial<CodexCredentialLockMetadata>
    if (
      typeof candidate.createdAt !== "number"
      || !Number.isFinite(candidate.createdAt)
      || typeof candidate.owner !== "string"
      || typeof candidate.pid !== "number"
      || !Number.isSafeInteger(candidate.pid)
      || candidate.pid <= 0
    ) {
      return null
    }

    return {
      createdAt: candidate.createdAt,
      owner: candidate.owner,
      pid: candidate.pid,
    }
  } catch {
    return null
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(isNodeError(error) && error.code === "ESRCH")
  }
}

async function isCodexCredentialLockContention(
  error: unknown,
  lockPath: string,
): Promise<boolean> {
  if (isNodeError(error) && error.code === "EEXIST") {
    return true
  }
  if (
    process.platform !== "win32"
    || !isNodeError(error)
    || (error.code !== "EACCES" && error.code !== "EPERM")
  ) {
    return false
  }

  try {
    await fs.stat(lockPath)
    return true
  } catch (statError) {
    if (isNodeError(statError) && statError.code === "ENOENT") {
      // Windows can briefly report EPERM while another writer removes the lock.
      return true
    }
    return false
  }
}

async function removeStaleCodexCredentialLock(lockPath: string): Promise<void> {
  let content: string
  let modifiedAt: number
  try {
    const [lockContent, stats] = await Promise.all([
      fs.readFile(lockPath, "utf8"),
      fs.stat(lockPath),
    ])
    content = lockContent
    modifiedAt = stats.mtimeMs
  } catch (error) {
    if (
      (isNodeError(error) && error.code === "ENOENT")
      || (await isCodexCredentialLockContention(error, lockPath))
    ) {
      // A Windows lock can become temporarily unreadable while it is removed.
      return
    }
    throw error
  }

  const metadata = parseCodexCredentialLockMetadata(content)
  const lockAgeMs = Date.now() - (metadata?.createdAt ?? modifiedAt)
  if (
    lockAgeMs < CODEX_CREDENTIAL_LOCK_STALE_MS
    && (!metadata || isProcessAlive(metadata.pid))
  ) {
    return
  }

  try {
    if ((await fs.readFile(lockPath, "utf8")) !== content) {
      return
    }
    await fs.unlink(lockPath)
  } catch (error) {
    if (
      (isNodeError(error) && error.code === "ENOENT")
      || (await isCodexCredentialLockContention(error, lockPath))
    ) {
      return
    }
    throw error
  }
}

async function acquireCodexCredentialLock(
  lockPath: string = `${PATHS.CODEX_CREDENTIAL_PATH}.lock`,
): Promise<CodexCredentialLock> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true })

  const startedAt = Date.now()
  while (true) {
    const metadata: CodexCredentialLockMetadata = {
      createdAt: Date.now(),
      owner: `${process.pid}-${randomBytes(8).toString("hex")}`,
      pid: process.pid,
    }
    const content = `${JSON.stringify(metadata)}\n`

    try {
      const fileHandle = await fs.open(lockPath, "wx", 0o600)
      try {
        await fileHandle.writeFile(content, "utf8")
        await fileHandle.sync()
      } catch (error) {
        await fileHandle.close().catch(() => {})
        await fs.unlink(lockPath).catch(() => {})
        throw error
      }
      return { content, fileHandle, lockPath }
    } catch (error) {
      if (!(await isCodexCredentialLockContention(error, lockPath))) {
        throw error
      }
    }

    await removeStaleCodexCredentialLock(lockPath)
    if (Date.now() - startedAt >= CODEX_CREDENTIAL_LOCK_TIMEOUT_MS) {
      throw new Error(
        `Timed out waiting for Codex credential store lock: ${lockPath}`,
      )
    }
    await delay(CODEX_CREDENTIAL_LOCK_RETRY_MS)
  }
}

async function releaseCodexCredentialLock(
  lock: CodexCredentialLock,
): Promise<void> {
  await lock.fileHandle.close()

  try {
    if ((await fs.readFile(lock.lockPath, "utf8")) !== lock.content) {
      return
    }
    await fs.unlink(lock.lockPath)
  } catch (error) {
    if (!(isNodeError(error) && error.code === "ENOENT")) {
      throw error
    }
  }
}

async function withCodexCredentialLock<T>(
  operation: () => Promise<T>,
  lockPath?: string,
): Promise<T> {
  const lock = await acquireCodexCredentialLock(lockPath)
  let result: T
  try {
    result = await operation()
  } catch (error) {
    await releaseCodexCredentialLock(lock).catch(() => {})
    throw error
  }

  await releaseCodexCredentialLock(lock)
  return result
}

/**
 * Serializes operations that must keep Codex account selection in config.json
 * consistent with the credential store. Credential writes retain their own
 * narrower lock so refreshes can run without changing the selected account.
 */
export function withCodexAccountMutationLock<T>(
  operation: () => Promise<T>,
): Promise<T> {
  return withCodexCredentialLock(
    operation,
    `${PATHS.CODEX_CREDENTIAL_PATH}.accounts.lock`,
  )
}

// Use the same cross-process lock for OAuth refreshes and new sign-ins.
export function withCredentialFileLock<T>(
  credentialPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withCodexCredentialLock(operation, `${credentialPath}.lock`)
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8")
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null
    }
    throw error
  }
}

function writeProtectedFile(filePath: string, content: string): Promise<void> {
  return Promise.resolve().then(() => writeFileAtomically(filePath, content))
}

function normalizeCodexCredentials(
  credentials: unknown,
): CodexCredentials | null {
  if (!credentials || typeof credentials !== "object") {
    return null
  }

  const candidate = credentials as Partial<CodexCredentials>
  if (
    typeof candidate.accessToken !== "string"
    || !candidate.accessToken.trim()
    || typeof candidate.refreshToken !== "string"
    || !candidate.refreshToken.trim()
    || typeof candidate.expiresAt !== "number"
    || !Number.isFinite(candidate.expiresAt)
    || typeof candidate.accountId !== "string"
    || !candidate.accountId.trim()
  ) {
    return null
  }

  return {
    accessToken: candidate.accessToken,
    refreshToken: candidate.refreshToken,
    expiresAt: candidate.expiresAt,
    accountId: candidate.accountId,
  }
}

function normalizeCodexStoredAccount(
  account: unknown,
): CodexStoredAccount | null {
  const credentials = normalizeCodexCredentials(account)
  if (!credentials) {
    return null
  }

  const aliasValue = (account as { alias?: unknown }).alias
  if (aliasValue !== undefined && typeof aliasValue !== "string") {
    return null
  }

  const alias = aliasValue?.trim()
  return {
    ...credentials,
    ...(alias ? { alias } : {}),
  }
}

function normalizeCodexCredentialStore(
  value: unknown,
): CodexCredentialStoreV1 | null {
  const legacyCredentials = normalizeCodexCredentials(value)
  if (legacyCredentials) {
    return {
      version: 1,
      accounts: [legacyCredentials],
    }
  }

  if (!value || typeof value !== "object") {
    return null
  }

  const candidate = value as {
    version?: unknown
    accounts?: unknown
  }
  if (candidate.version !== 1 || !Array.isArray(candidate.accounts)) {
    return null
  }

  if (candidate.accounts.length > MAX_CODEX_ACCOUNTS) {
    return null
  }

  const accounts: Array<CodexStoredAccount> = []
  const accountIds = new Set<string>()
  const aliases = new Set<string>()
  for (const value of candidate.accounts) {
    const account = normalizeCodexStoredAccount(value)
    if (!account || accountIds.has(account.accountId)) {
      return null
    }

    const normalizedAlias =
      account.alias ? normalizeCodexAccountSelector(account.alias) : undefined
    if (normalizedAlias && aliases.has(normalizedAlias)) {
      return null
    }

    accounts.push(account)
    accountIds.add(account.accountId)
    if (normalizedAlias) {
      aliases.add(normalizedAlias)
    }
  }

  // Versions before selector namespace validation allowed an alias to equal a
  // different account id. Drop only that ambiguous alias so existing tokens
  // remain usable and the next credential write repairs the persisted store.
  const normalizedAccounts = accounts.map((account, index) => {
    const alias = account.alias
    if (
      !alias
      || !accounts.some(
        (candidate, candidateIndex) =>
          candidateIndex !== index
          && normalizeCodexAccountSelector(candidate.accountId)
            === normalizeCodexAccountSelector(alias),
      )
    ) {
      return account
    }

    const { alias: _alias, ...credentials } = account
    return credentials
  })

  return { version: 1, accounts: normalizedAccounts }
}

async function writeCodexCredentialStoreUnlocked(
  store: CodexCredentialStoreV1,
  credentialPath: string = PATHS.CODEX_CREDENTIAL_PATH,
): Promise<void> {
  await writeProtectedFile(
    credentialPath,
    `${JSON.stringify(store, null, 2)}\n`,
  )
}

export async function readGitHubToken(): Promise<string | null> {
  const token = await readOptionalFile(PATHS.GITHUB_TOKEN_PATH)
  const normalizedToken = token?.trim()
  return normalizedToken || null
}

// Command line arguments are readable by every local user through the process
// list, so the environment is the preferred way to hand the server a token.
export const GITHUB_TOKEN_ENV = "COPILOT_API_GITHUB_TOKEN"

export function readGitHubTokenFromEnv(): string | undefined {
  return process.env[GITHUB_TOKEN_ENV]?.trim() || undefined
}

export async function writeGitHubToken(token: string): Promise<void> {
  await writeProtectedFile(PATHS.GITHUB_TOKEN_PATH, token.trim())
}

export function createOAuthCredentialStore(
  providerLabel: string,
  credentialPath: () => string,
) {
  async function readStore(): Promise<CodexCredentialStoreV1 | null> {
    const raw = await readOptionalFile(credentialPath())
    if (!raw?.trim()) {
      return null
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw) as unknown
    } catch (error) {
      throw new Error(
        `${providerLabel} credentials file is not valid JSON: ${credentialPath()}`,
        {
          cause: error,
        },
      )
    }

    const store = normalizeCodexCredentialStore(parsed)
    if (!store) {
      throw new Error(
        `${providerLabel} credentials file is missing required fields: ${credentialPath()}`,
      )
    }

    return store
  }

  async function readCredentials(
    accountId?: string,
  ): Promise<CodexCredentials | null> {
    const store = await readStore()
    if (!store || store.accounts.length === 0) {
      return null
    }

    const normalizedAccountId = accountId?.trim()
    if (normalizedAccountId) {
      return (
        store.accounts.find(
          (account) => account.accountId === normalizedAccountId,
        ) ?? null
      )
    }

    if (store.accounts.length > 1) {
      throw new Error(
        `Multiple ${providerLabel} accounts found but no account is selected`,
      )
    }

    return store.accounts[0]
  }

  async function writeCredentials(
    credentials: CodexCredentials,
    options: WriteCodexCredentialsOptions = {},
  ): Promise<void> {
    const normalizedCredentials = normalizeCodexCredentials(credentials)
    if (!normalizedCredentials) {
      throw new Error(
        `${providerLabel} credentials are missing required fields`,
      )
    }

    await withCredentialFileLock(credentialPath(), async () => {
      const store = (await readStore()) ?? {
        version: 1 as const,
        accounts: [],
      }
      const accountIdSelector = normalizeCodexAccountSelector(
        normalizedCredentials.accountId,
      )
      const existingIndex = store.accounts.findIndex(
        (account) => account.accountId === normalizedCredentials.accountId,
      )
      if (existingIndex < 0 && options.insertIfMissing === false) {
        // Update-only writes come from credential refreshes. A missing row means
        // the account was removed while this process still held its credentials
        // in memory (for example a server that was not restarted after switching
        // accounts), so inserting it again would silently undo the removal.
        return
      }

      const existingRefreshToken = store.accounts[existingIndex]?.refreshToken
      if (
        options.expectedRefreshToken !== undefined
        && existingRefreshToken !== options.expectedRefreshToken
        && existingRefreshToken !== normalizedCredentials.refreshToken
      ) {
        return
      }

      if (
        existingIndex < 0
        && store.accounts.some(
          (account) =>
            normalizeCodexAccountSelector(account.accountId)
            === accountIdSelector,
        )
      ) {
        throw new Error(
          `${providerLabel} account id '${normalizedCredentials.accountId}' is already in use`,
        )
      }
      if (existingIndex < 0 && store.accounts.length >= MAX_CODEX_ACCOUNTS) {
        throw new Error(
          `${providerLabel} supports at most ${MAX_CODEX_ACCOUNTS} accounts`,
        )
      }
      if (
        store.accounts.some(
          (account, index) =>
            index !== existingIndex
            && account.alias
            && normalizeCodexAccountSelector(account.alias)
              === accountIdSelector,
        )
      ) {
        throw new Error(
          `${providerLabel} account id '${normalizedCredentials.accountId}' conflicts with another account alias`,
        )
      }

      const alias = options.alias?.trim()
      if (alias) {
        const aliasSelector = normalizeCodexAccountSelector(alias)
        if (
          store.accounts.some(
            (account, index) =>
              index !== existingIndex
              && account.alias
              && normalizeCodexAccountSelector(account.alias) === aliasSelector,
          )
        ) {
          throw new Error(
            `${providerLabel} account alias '${alias}' is already in use`,
          )
        }
        if (
          store.accounts.some(
            (account, index) =>
              index !== existingIndex
              && normalizeCodexAccountSelector(account.accountId)
                === aliasSelector,
          )
        ) {
          throw new Error(
            `${providerLabel} account alias '${alias}' conflicts with another account id`,
          )
        }
      }

      const existingAccount =
        existingIndex >= 0 ? store.accounts[existingIndex] : undefined
      const nextAccount: CodexStoredAccount = {
        ...normalizedCredentials,
        ...(alias ? { alias }
        : existingAccount?.alias ? { alias: existingAccount.alias }
        : {}),
      }
      const accounts = [...store.accounts]
      if (existingIndex >= 0) {
        accounts[existingIndex] = nextAccount
      } else {
        accounts.push(nextAccount)
      }

      await writeCodexCredentialStoreUnlocked(
        { version: 1, accounts },
        credentialPath(),
      )
    })
  }

  async function removeCredentials(
    accountId: string,
  ): Promise<CodexStoredAccount> {
    const normalizedAccountId = accountId.trim()
    if (!normalizedAccountId) {
      throw new Error(`${providerLabel} account id must be a non-empty string`)
    }

    return await withCredentialFileLock(credentialPath(), async () => {
      const store = await readStore()
      const index =
        store?.accounts.findIndex(
          (account) => account.accountId === normalizedAccountId,
        ) ?? -1
      if (!store || index < 0) {
        throw new Error(
          `${providerLabel} account '${normalizedAccountId}' was not found`,
        )
      }

      const removedAccount = store.accounts[index]
      const accounts = store.accounts.filter(
        (_account, accountIndex) => accountIndex !== index,
      )
      await writeCodexCredentialStoreUnlocked(
        { version: 1, accounts },
        credentialPath(),
      )

      return removedAccount
    })
  }

  return { readStore, readCredentials, writeCredentials, removeCredentials }
}

const codexCredentialStore = createOAuthCredentialStore(
  "Codex",
  () => PATHS.CODEX_CREDENTIAL_PATH,
)
export const readCodexCredentialStore = codexCredentialStore.readStore
export const readCodexCredentials = codexCredentialStore.readCredentials
export const writeCodexCredentials = codexCredentialStore.writeCredentials
export const removeCodexCredentials = codexCredentialStore.removeCredentials

export async function clearCodexCredentials(): Promise<void> {
  await withCodexCredentialLock(() =>
    writeProtectedFile(PATHS.CODEX_CREDENTIAL_PATH, ""),
  )
}
