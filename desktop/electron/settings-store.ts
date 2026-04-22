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
  proxy: { http: '', https: '' },
  lastPort: 4141
}

export async function readSettings(): Promise<DesktopSettings> {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, 'utf8')
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } as DesktopSettings
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export async function writeSettings(settings: DesktopSettings): Promise<void> {
  await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true })
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8')
}
