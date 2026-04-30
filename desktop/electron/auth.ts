import fs from 'node:fs/promises'
import { PATHS, ensurePaths } from '../../src/lib/paths'
import {
  getCopilotAccountType as fetchCopilotAccountType,
  type CopilotAccountType,
} from '../../src/services/github/get-copilot-usage'
import {
  getDeviceCode,
  type DeviceCodeResponse,
} from '../../src/services/github/get-device-code'
import { getGitHubUser as fetchGitHubUser } from '../../src/services/github/get-user'
import { pollAccessToken } from '../../src/services/github/poll-access-token'

export { getDeviceCode, pollAccessToken }
export type { DeviceCodeResponse }

async function ensureTokenDir(): Promise<void> {
  await ensurePaths()
}

export async function getGitHubUser(token: string): Promise<string> {
  const user = await fetchGitHubUser(token)
  return user.login
}

export async function saveToken(token: string): Promise<void> {
  await ensureTokenDir()
  await fs.writeFile(PATHS.GITHUB_TOKEN_PATH, token, 'utf8')
  await fs.chmod(PATHS.GITHUB_TOKEN_PATH, 0o600)
}

export async function readToken(): Promise<string | null> {
  try {
    const token = await fs.readFile(PATHS.GITHUB_TOKEN_PATH, 'utf8')
    return token.trim() || null
  } catch {
    return null
  }
}

export async function clearToken(): Promise<void> {
  try {
    await ensureTokenDir()
    await fs.writeFile(PATHS.GITHUB_TOKEN_PATH, '', 'utf8')
  } catch {
    // ignore
  }
}

export async function getCopilotAccountType(token: string): Promise<CopilotAccountType> {
  try {
    return await fetchCopilotAccountType(token)
  } catch {
    return 'individual'
  }
}
