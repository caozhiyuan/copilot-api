import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const AUTH_APP = process.env.COPILOT_API_OAUTH_APP?.trim() || ""
const ENTERPRISE_PREFIX = process.env.COPILOT_API_ENTERPRISE_URL ? "ent_" : ""

const DEFAULT_DIR = path.join(os.homedir(), ".local", "share", "copilot-api")
const APP_DIR = process.env.COPILOT_API_HOME || DEFAULT_DIR

const GITHUB_TOKEN_PATH = path.join(
  APP_DIR,
  AUTH_APP,
  ENTERPRISE_PREFIX + "github_token",
)
const CODEX_CREDENTIAL_PATH = path.join(APP_DIR, "codex_credentials.json")
const CONFIG_PATH = path.join(APP_DIR, "config.json")
const ENV_FILE_PATH = path.join(APP_DIR, "copilot-api.env")
const ENV_SH_PATH = path.join(APP_DIR, "copilot-api.env.sh")

export const PATHS = {
  APP_DIR,
  GITHUB_TOKEN_PATH,
  CODEX_CREDENTIAL_PATH,
  CONFIG_PATH,
  ENV_FILE_PATH,
  ENV_SH_PATH,
}

export async function ensurePaths(): Promise<void> {
  await fs.mkdir(path.join(PATHS.APP_DIR, AUTH_APP), { recursive: true })
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
