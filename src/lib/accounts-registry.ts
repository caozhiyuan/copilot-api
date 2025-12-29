import fs from "node:fs/promises"
import { z } from "zod"

import type { AccountMeta, AccountRegistry } from "~/lib/types/account"

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

const accountRegistrySchema = z.object({
  version: z.literal(1),
  accounts: z.array(accountMetaSchema),
})

/**
 * Create an empty registry with the current schema version.
 */
function createEmptyRegistry(): AccountRegistry {
  return {
    version: 1,
    accounts: [],
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

    const result = accountRegistrySchema.safeParse(parsed)
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")

      throw new Error(
        `Invalid accounts registry at ${PATHS.ACCOUNTS_REGISTRY_PATH}: ${issues}`,
      )
    }

    const registry = result.data

    const seen = new Set<string>()
    for (const account of registry.accounts) {
      if (seen.has(account.id)) {
        throw new Error(
          `Invalid accounts registry at ${PATHS.ACCOUNTS_REGISTRY_PATH}: duplicate account id "${account.id}"`,
        )
      }
      seen.add(account.id)
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
