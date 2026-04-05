import fs from "node:fs/promises"
import { z } from "zod"

import type {
  AccountClientIdentity,
  AccountMeta,
  AccountRegistry,
} from "~/lib/types/account"

import {
  buildIdentityKey,
  createAccountDeviceId,
  createAccountMachineId,
  getCurrentIdentityEnvironment,
} from "./account-client-identity"
import { accountTokenPath, PATHS } from "./paths"

/**
 * Validate account ID (GitHub login).
 * Rules:
 * - Only alphanumeric characters or single hyphens
 * - 1-39 chars
 * - Cannot begin or end with a hyphen
 * - No consecutive hyphens
 */
export function validateAccountId(id: string): boolean {
  if (id.length === 0 || id.length > 39) return false
  if (!/^[a-z0-9-]+$/i.test(id)) return false
  if (id.startsWith("-") || id.endsWith("-")) return false
  if (id.includes("--")) return false
  return true
}

const accountMetaSchema = z.object({
  id: z.string().refine(validateAccountId, {
    message:
      "Invalid account id. Expected a GitHub login (1-39 chars, alphanumeric or single hyphens, no leading/trailing hyphen, no consecutive hyphens).",
  }),
  accountType: z.enum(["individual", "business", "enterprise"]),
  addedAt: z.number(),
})

const accountClientIdentitySchema = z.object({
  login: z.string().refine(validateAccountId, {
    message:
      "Invalid client identity login. Expected a GitHub login (1-39 chars, alphanumeric or single hyphens, no leading/trailing hyphen, no consecutive hyphens).",
  }),
  oauthApp: z.string().min(1),
  enterpriseDomain: z.string().min(1),
  deviceId: z
    .string()
    .regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
      "Invalid device ID format. Expected a lowercase UUID.",
    ),
  machineId: z
    .string()
    .regex(
      /^[0-9a-f]{64}$/u,
      "Invalid machine ID format. Expected 64 lowercase hexadecimal characters.",
    ),
  createdAt: z.number(),
})

const accountRegistryV1Schema = z.object({
  version: z.literal(1),
  accounts: z.array(accountMetaSchema),
})

const accountRegistryV2Schema = z.object({
  version: z.literal(2),
  accounts: z.array(accountMetaSchema),
  clientIdentities: z.record(z.string(), accountClientIdentitySchema),
})

const identityLocks = new Map<string, Promise<AccountClientIdentity>>()

/**
 * Create an empty registry with the current schema version.
 */
function createEmptyRegistry(): AccountRegistry {
  return {
    version: 2,
    accounts: [],
    clientIdentities: {},
  }
}

const createClientIdentity = ({
  login,
  oauthApp,
  enterpriseDomain,
}: {
  login: string
  oauthApp: string
  enterpriseDomain: string
}): AccountClientIdentity => ({
  login,
  oauthApp,
  enterpriseDomain,
  deviceId: createAccountDeviceId(),
  machineId: createAccountMachineId(),
  createdAt: Date.now(),
})

const ensureRegistryIdentity = (
  registry: AccountRegistry,
  {
    login,
    oauthApp,
    enterpriseDomain,
  }: {
    login: string
    oauthApp: string
    enterpriseDomain: string
  },
): AccountClientIdentity => {
  const identityKey = buildIdentityKey({ login, oauthApp, enterpriseDomain })
  const existing = registry.clientIdentities[identityKey]
  if (existing) {
    return existing
  }

  const created = createClientIdentity({
    login,
    oauthApp,
    enterpriseDomain,
  })
  registry.clientIdentities[identityKey] = created
  return created
}

const ensureClientIdentitiesForAccounts = (
  registry: AccountRegistry,
): boolean => {
  const { oauthApp, enterpriseDomain } = getCurrentIdentityEnvironment()
  const countBefore = Object.keys(registry.clientIdentities).length

  for (const account of registry.accounts) {
    ensureRegistryIdentity(registry, {
      login: account.id,
      oauthApp,
      enterpriseDomain,
    })
  }

  return Object.keys(registry.clientIdentities).length !== countBefore
}

const assertNoDuplicateAccounts = (registry: {
  accounts: Array<AccountMeta>
}) => {
  const seen = new Set<string>()
  for (const account of registry.accounts) {
    if (seen.has(account.id)) {
      throw new Error(
        `Invalid accounts registry at ${PATHS.ACCOUNTS_REGISTRY_PATH}: duplicate account id "${account.id}"`,
      )
    }
    seen.add(account.id)
  }
}

/**
 * Load the accounts registry from disk.
 * Returns an empty registry if the file doesn't exist.
 */
export async function loadRegistry(): Promise<AccountRegistry> {
  try {
    const content = await fs.readFile(PATHS.ACCOUNTS_REGISTRY_PATH, "utf8")
    if (!content.trim()) {
      return createEmptyRegistry()
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(content) as unknown
    } catch (error) {
      throw new Error(
        `Invalid accounts registry JSON at ${PATHS.ACCOUNTS_REGISTRY_PATH}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }

    const isVersion2Record =
      typeof parsed === "object"
      && parsed !== null
      && "version" in parsed
      && parsed.version === 2
    const result =
      isVersion2Record ?
        accountRegistryV2Schema.safeParse(parsed)
      : accountRegistryV1Schema.safeParse(parsed)
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")

      throw new Error(
        `Invalid accounts registry at ${PATHS.ACCOUNTS_REGISTRY_PATH}: ${issues}`,
      )
    }

    const parsedRegistry = result.data
    const registry: AccountRegistry =
      parsedRegistry.version === 2 ?
        parsedRegistry
      : {
          version: 2,
          accounts: parsedRegistry.accounts,
          clientIdentities: {},
        }

    assertNoDuplicateAccounts(registry)

    const identitiesBackfilled = ensureClientIdentitiesForAccounts(registry)
    const shouldPersist = parsedRegistry.version !== 2 || identitiesBackfilled
    if (shouldPersist) {
      await saveRegistry(registry)
    }

    return registry
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return createEmptyRegistry()
    }
    throw error
  }
}

/**
 * Save the accounts registry to disk with secure permissions.
 */
export async function saveRegistry(registry: AccountRegistry): Promise<void> {
  const content = JSON.stringify(registry, null, 2)
  await fs.writeFile(PATHS.ACCOUNTS_REGISTRY_PATH, content, { mode: 0o600 })
}

export async function getAccountClientIdentity(
  identityKey: string,
): Promise<AccountClientIdentity | null> {
  const registry = await loadRegistry()
  return registry.clientIdentities[identityKey] ?? null
}

export async function ensureAccountClientIdentity({
  identityKey,
  login,
  oauthApp,
  enterpriseDomain,
}: {
  identityKey: string
  login: string
  oauthApp: string
  enterpriseDomain: string
}): Promise<AccountClientIdentity> {
  if (!validateAccountId(login)) {
    throw new Error(`Invalid account ID: ${login}`)
  }

  const existingLock = identityLocks.get(identityKey)
  if (existingLock) {
    return existingLock
  }

  const identityPromise = (async (): Promise<AccountClientIdentity> => {
    const registry = await loadRegistry()
    const existing = registry.clientIdentities[identityKey]
    if (existing) {
      return existing
    }

    const created = createClientIdentity({
      login,
      oauthApp,
      enterpriseDomain,
    })
    registry.clientIdentities[identityKey] = created
    await saveRegistry(registry)
    return created
  })()

  identityLocks.set(identityKey, identityPromise)

  try {
    return await identityPromise
  } finally {
    if (identityLocks.get(identityKey) === identityPromise) {
      identityLocks.delete(identityKey)
    }
  }
}

/**
 * Add an account to the registry.
 * The account is appended to the end of the list (lowest priority).
 */
export async function addAccountToRegistry(meta: AccountMeta): Promise<void> {
  if (!validateAccountId(meta.id)) {
    throw new Error(`Invalid account ID: ${meta.id}`)
  }

  const registry = await loadRegistry()

  // Check for duplicate
  if (registry.accounts.some((a) => a.id === meta.id)) {
    throw new Error(`Account already exists: ${meta.id}`)
  }

  registry.accounts.push(meta)
  const { oauthApp, enterpriseDomain } = getCurrentIdentityEnvironment()
  ensureRegistryIdentity(registry, {
    login: meta.id,
    oauthApp,
    enterpriseDomain,
  })
  await saveRegistry(registry)
}

/**
 * Remove an account from the registry by ID or index (1-based).
 * Returns the removed account metadata.
 */
export async function removeAccountFromRegistry(
  idOrIndex: string | number,
): Promise<AccountMeta> {
  const registry = await loadRegistry()
  let index: number

  if (typeof idOrIndex === "number") {
    // 1-based index
    index = idOrIndex - 1
    if (index < 0 || index >= registry.accounts.length) {
      throw new Error(`Invalid account index: ${idOrIndex}`)
    }
  } else {
    index = registry.accounts.findIndex((a) => a.id === idOrIndex)
    if (index === -1) {
      throw new Error(`Account not found: ${idOrIndex}`)
    }
  }

  const [removed] = registry.accounts.splice(index, 1)
  await saveRegistry(registry)
  return removed
}

/**
 * List all accounts from the registry.
 */
export async function listAccountsFromRegistry(): Promise<Array<AccountMeta>> {
  const registry = await loadRegistry()
  return registry.accounts
}

/**
 * Load the GitHub token for a specific account.
 * Returns null if the token file doesn't exist.
 */
export async function loadAccountToken(id: string): Promise<string | null> {
  if (!validateAccountId(id)) {
    throw new Error(`Invalid account ID: ${id}`)
  }

  try {
    const tokenPath = accountTokenPath(id)
    const token = await fs.readFile(tokenPath, "utf8")
    return token.trim() || null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null
    }
    throw error
  }
}

/**
 * Save the GitHub token for a specific account with secure permissions.
 */
export async function saveAccountToken(
  id: string,
  token: string,
): Promise<void> {
  if (!validateAccountId(id)) {
    throw new Error(`Invalid account ID: ${id}`)
  }

  const tokenPath = accountTokenPath(id)
  await fs.writeFile(tokenPath, token, { mode: 0o600 })
}

/**
 * Remove the GitHub token file for a specific account.
 */
export async function removeAccountToken(id: string): Promise<void> {
  if (!validateAccountId(id)) {
    throw new Error(`Invalid account ID: ${id}`)
  }

  const tokenPath = accountTokenPath(id)
  try {
    await fs.unlink(tokenPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error
    }
    // File doesn't exist, nothing to remove
  }
}

/**
 * Check if the legacy github_token file exists.
 */
export async function hasLegacyToken(): Promise<boolean> {
  try {
    const content = await fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")
    return content.trim().length > 0
  } catch {
    return false
  }
}

/**
 * Read the legacy github_token file.
 * Returns null if the file doesn't exist or is empty.
 */
export async function readLegacyToken(): Promise<string | null> {
  try {
    const content = await fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")
    return content.trim() || null
  } catch {
    return null
  }
}

/**
 * Check if the registry file exists and has accounts.
 */
export async function hasRegistry(): Promise<boolean> {
  const registry = await loadRegistry()
  return registry.accounts.length > 0
}
