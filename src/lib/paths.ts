import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const APP_DIR = path.join(os.homedir(), ".local", "share", "copilot-api")

const GITHUB_TOKEN_PATH = path.join(APP_DIR, "github_token")
const CONFIG_PATH = path.join(APP_DIR, "config.json")
const MODELS_PATH = path.join(APP_DIR, "models.json")

// Multi-account paths
const TOKENS_DIR = path.join(APP_DIR, "tokens")
const ACCOUNTS_REGISTRY_PATH = path.join(APP_DIR, "accounts-registry.json")

export const PATHS = {
  APP_DIR,
  GITHUB_TOKEN_PATH,
  CONFIG_PATH,
  MODELS_PATH,
  TOKENS_DIR,
  ACCOUNTS_REGISTRY_PATH,
}

/**
 * Get the token file path for a specific account.
 * @param id - The account ID (GitHub login)
 * @returns The absolute path to the account's token file
 */
export function accountTokenPath(id: string): string {
  return path.join(TOKENS_DIR, `github_${id}`)
}

export async function ensurePaths(): Promise<void> {
  await fs.mkdir(PATHS.APP_DIR, { recursive: true })
  await fs.mkdir(PATHS.TOKENS_DIR, { recursive: true })
  await ensureFile(PATHS.GITHUB_TOKEN_PATH)
  await ensureFile(PATHS.CONFIG_PATH)
}

async function ensureFile(filePath: string): Promise<void> {
  try {
    await fs.access(filePath, fs.constants.W_OK)
  } catch {
    await fs.writeFile(filePath, "")
    await fs.chmod(filePath, 0o600)
  }
}
