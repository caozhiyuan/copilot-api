import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { net, session } from 'electron'

const GITHUB_CLIENT_ID = 'Iv1.b507a08c87ecfe98'
const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code'
const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const GITHUB_USER_API = 'https://api.github.com/user'
const GITHUB_TOKEN_PATH = path.join(
  os.homedir(),
  '.local',
  'share',
  'copilot-api',
  'github_token'
)

const USER_AGENT = 'GitHubCopilotChat/0.42.3'

export interface AuthProxySettings {
  http?: string
  https?: string
}

export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

async function ensureTokenDir(): Promise<void> {
  await fs.mkdir(path.dirname(GITHUB_TOKEN_PATH), { recursive: true })
}

function normalizeProxyUrl(value?: string): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null

  if (/^[a-z][a-z\d+\-.]*:\/\//i.test(trimmed)) {
    return trimmed
  }

  return `http://${trimmed}`
}

function buildProxyRules(proxy?: AuthProxySettings): string | undefined {
  const httpProxy = normalizeProxyUrl(proxy?.http)
  const httpsProxy = normalizeProxyUrl(proxy?.https) ?? httpProxy
  const rules: string[] = []

  if (httpProxy) rules.push(`http=${httpProxy}`)
  if (httpsProxy) rules.push(`https=${httpsProxy}`)

  return rules.length > 0 ? rules.join(';') : undefined
}

async function applyNetworkProxy(proxy?: AuthProxySettings): Promise<void> {
  const proxyRules = buildProxyRules(proxy)

  // Electron 的 net.fetch 走 Chromium 网络栈；这里同步桌面设置里的代理，
  // 让 OAuth 请求与后端服务启动时使用的代理配置保持一致。
  await session.defaultSession.setProxy(
    proxyRules ? { proxyRules } : { mode: 'system' }
  )
}

async function fetchGitHub(
  url: string,
  init: RequestInit,
  proxy?: AuthProxySettings
): Promise<Response> {
  await applyNetworkProxy(proxy)

  try {
    return await net.fetch(url, init)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`GitHub 网络请求失败：${message}`)
  }
}

export async function getDeviceCode(proxy?: AuthProxySettings): Promise<DeviceCodeResponse> {
  const res = await fetchGitHub(GITHUB_DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': USER_AGENT
    },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      scope: 'read:user'
    })
  }, proxy)

  if (!res.ok) throw new Error(`getDeviceCode failed: ${res.status}`)
  return res.json() as Promise<DeviceCodeResponse>
}

export async function pollAccessToken(
  deviceCode: DeviceCodeResponse,
  proxy?: AuthProxySettings
): Promise<string> {
  const intervalMs = (deviceCode.interval + 1) * 1000

  while (true) {
    await new Promise(resolve => setTimeout(resolve, intervalMs))

    const res = await fetchGitHub(GITHUB_ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': USER_AGENT
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: deviceCode.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      })
    }, proxy)

    if (!res.ok) continue

    const json = await res.json() as { access_token?: string }
    if (json.access_token) return json.access_token
  }
}

export async function getGitHubUser(token: string, proxy?: AuthProxySettings): Promise<string> {
  const res = await fetchGitHub(GITHUB_USER_API, {
    headers: {
      authorization: `token ${token}`,
      'user-agent': USER_AGENT,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28'
    }
  }, proxy)

  if (!res.ok) throw new Error(`getGitHubUser failed: ${res.status}`)
  const json = await res.json() as { login: string }
  return json.login
}

export async function saveToken(token: string): Promise<void> {
  await ensureTokenDir()
  await fs.writeFile(GITHUB_TOKEN_PATH, token, 'utf8')
  await fs.chmod(GITHUB_TOKEN_PATH, 0o600)
}

export async function readToken(): Promise<string | null> {
  try {
    const token = await fs.readFile(GITHUB_TOKEN_PATH, 'utf8')
    return token.trim() || null
  } catch {
    return null
  }
}

export async function clearToken(): Promise<void> {
  try {
    await fs.writeFile(GITHUB_TOKEN_PATH, '', 'utf8')
  } catch {
    // ignore
  }
}

// 从 GitHub Copilot 用户信息接口获取套餐类型，映射为 accountType
export async function getCopilotAccountType(
  token: string,
  proxy?: AuthProxySettings
): Promise<'individual' | 'business' | 'enterprise'> {
  try {
    const res = await fetchGitHub('https://api.github.com/copilot_internal/user', {
      headers: {
        authorization: `token ${token}`,
        'user-agent': USER_AGENT,
        'x-github-api-version': '2022-11-28'
      },
      signal: AbortSignal.timeout(5000)
    }, proxy)
    if (!res.ok) return 'individual'
    const json = await res.json() as { copilot_plan?: string }
    const plan = json.copilot_plan ?? ''
    if (plan.includes('enterprise')) return 'enterprise'
    if (plan.includes('business')) return 'business'
    return 'individual'
  } catch {
    return 'individual'
  }
}
