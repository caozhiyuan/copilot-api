import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { DesktopProxySettings, DesktopSettings } from '../src/types/ipc'

const SETTINGS_PATH = path.join(
  os.homedir(),
  '.local',
  'share',
  'copilot-api',
  'desktop-config.json',
)

const DEFAULT_SETTINGS: DesktopSettings = {
  apiHome: '',
  oauthApp: 'default',
  enterpriseUrl: '',
  lastPort: 4141,
  launchAtLogin: false,
  minimizeToTray: false,
  accountType: 'individual',
  verbose: false,
  showToken: false,
  language: 'auto',
  theme: 'auto',
  proxy: {
    mode: 'system',
    http_proxy: 'http://127.0.0.1:8888',
    https_proxy: 'http://127.0.0.1:8888',
    no_proxy: 'localhost,127.0.0.1',
  },
}

let launchAtLoginFallback = DEFAULT_SETTINGS.launchAtLogin

export function setLaunchAtLoginFallback(enabled: boolean): void {
  launchAtLoginFallback = enabled
}

function isDesktopProxyMode(
  value: unknown,
): value is DesktopProxySettings['mode'] {
  return value === 'system' || value === 'custom' || value === 'direct'
}

export function normalizeProxySettings(
  proxy: Partial<DesktopProxySettings> | null | undefined,
): DesktopProxySettings {
  return {
    mode:
      isDesktopProxyMode(proxy?.mode) ?
        proxy.mode
      : DEFAULT_SETTINGS.proxy.mode,
    http_proxy:
      typeof proxy?.http_proxy === 'string' ?
        proxy.http_proxy
      : DEFAULT_SETTINGS.proxy.http_proxy,
    https_proxy:
      typeof proxy?.https_proxy === 'string' ?
        proxy.https_proxy
      : DEFAULT_SETTINGS.proxy.https_proxy,
    no_proxy:
      typeof proxy?.no_proxy === 'string' ?
        proxy.no_proxy
      : DEFAULT_SETTINGS.proxy.no_proxy,
  }
}

export function normalizeSettings(
  settings: Partial<DesktopSettings> | null | undefined,
): DesktopSettings {
  return {
    apiHome:
      typeof settings?.apiHome === 'string' ?
        settings.apiHome
      : DEFAULT_SETTINGS.apiHome,
    oauthApp:
      settings?.oauthApp === 'opencode' ?
        'opencode'
      : DEFAULT_SETTINGS.oauthApp,
    enterpriseUrl:
      typeof settings?.enterpriseUrl === 'string' ?
        settings.enterpriseUrl
      : DEFAULT_SETTINGS.enterpriseUrl,
    lastPort:
      typeof settings?.lastPort === 'number' ?
        settings.lastPort
      : DEFAULT_SETTINGS.lastPort,
    launchAtLogin:
      typeof settings?.launchAtLogin === 'boolean' ?
        settings.launchAtLogin
      : launchAtLoginFallback,
    minimizeToTray:
      typeof settings?.minimizeToTray === 'boolean' ?
        settings.minimizeToTray
      : DEFAULT_SETTINGS.minimizeToTray,
    accountType:
      (
        settings?.accountType === 'business'
        || settings?.accountType === 'enterprise'
      ) ?
        settings.accountType
      : DEFAULT_SETTINGS.accountType,
    verbose:
      typeof settings?.verbose === 'boolean' ?
        settings.verbose
      : DEFAULT_SETTINGS.verbose,
    showToken:
      typeof settings?.showToken === 'boolean' ?
        settings.showToken
      : DEFAULT_SETTINGS.showToken,
    language:
      (
        settings?.language === 'en'
        || settings?.language === 'zh'
        || settings?.language === 'auto'
      ) ?
        settings.language
      : DEFAULT_SETTINGS.language,
    theme:
      (
        settings?.theme === 'light'
        || settings?.theme === 'dark'
        || settings?.theme === 'auto'
      ) ?
        settings.theme
      : DEFAULT_SETTINGS.theme,
    proxy: normalizeProxySettings(settings?.proxy),
  }
}

export function readSettingsSync(): DesktopSettings {
  try {
    const raw = fsSync.readFileSync(SETTINGS_PATH, 'utf8')
    return normalizeSettings(JSON.parse(raw) as Partial<DesktopSettings>)
  } catch {
    return normalizeSettings(null)
  }
}

export async function readSettings(): Promise<DesktopSettings> {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, 'utf8')
    return normalizeSettings(JSON.parse(raw) as Partial<DesktopSettings>)
  } catch {
    return normalizeSettings(null)
  }
}

export async function writeSettings(settings: DesktopSettings): Promise<void> {
  await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true })
  await fs.writeFile(
    SETTINGS_PATH,
    JSON.stringify(normalizeSettings(settings), null, 2),
    'utf8',
  )
}
