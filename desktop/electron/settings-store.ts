import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { DesktopSettings } from '../src/types/ipc'

const SETTINGS_PATH = path.join(
  os.homedir(),
  '.local',
  'share',
  'copilot-api',
  'desktop-config.json'
)

const DEFAULT_SETTINGS: DesktopSettings = {
  apiHome: '',
  oauthApp: 'default',
  enterpriseUrl: '',
  lastPort: 4141,
  minimizeToTray: false,
  accountType: 'individual',
  verbose: false,
  showToken: false,
  language: 'auto'
}

function normalizeSettings(settings: Partial<DesktopSettings> | null | undefined): DesktopSettings {
  return {
    apiHome: typeof settings?.apiHome === 'string' ? settings.apiHome : DEFAULT_SETTINGS.apiHome,
    oauthApp: settings?.oauthApp === 'opencode' ? 'opencode' : DEFAULT_SETTINGS.oauthApp,
    enterpriseUrl: typeof settings?.enterpriseUrl === 'string' ? settings.enterpriseUrl : DEFAULT_SETTINGS.enterpriseUrl,
    lastPort: typeof settings?.lastPort === 'number' ? settings.lastPort : DEFAULT_SETTINGS.lastPort,
    minimizeToTray: typeof settings?.minimizeToTray === 'boolean'
      ? settings.minimizeToTray
      : DEFAULT_SETTINGS.minimizeToTray,
    accountType: settings?.accountType === 'business' || settings?.accountType === 'enterprise'
      ? settings.accountType
      : DEFAULT_SETTINGS.accountType,
    verbose: typeof settings?.verbose === 'boolean' ? settings.verbose : DEFAULT_SETTINGS.verbose,
    showToken: typeof settings?.showToken === 'boolean' ? settings.showToken : DEFAULT_SETTINGS.showToken,
    language: settings?.language === 'en' || settings?.language === 'zh' || settings?.language === 'auto'
      ? settings.language
      : DEFAULT_SETTINGS.language
  }
}

export async function readSettings(): Promise<DesktopSettings> {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, 'utf8')
    return normalizeSettings(JSON.parse(raw) as Partial<DesktopSettings>)
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export async function writeSettings(settings: DesktopSettings): Promise<void> {
  await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true })
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(normalizeSettings(settings), null, 2), 'utf8')
}
