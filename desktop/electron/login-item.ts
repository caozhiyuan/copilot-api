import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { DesktopSettings } from '../src/types/ipc'

export const LOGIN_ITEM_ARG = '--launch-at-login'
const WINDOWS_LOGIN_ITEM_NAME = 'com.copilot-api.desktop'

interface LoginItemController {
  readonly isPackaged: boolean
  setLoginItemSettings(settings: Electron.Settings): void
  getLoginItemSettings(): { wasOpenedAtLogin: boolean }
}

interface LoginItemRuntime {
  platform: NodeJS.Platform
  execPath: string
  argv: readonly string[]
  appImagePath?: string
  configHome?: string
}

function getCurrentRuntime(): LoginItemRuntime {
  const configHome = process.env.XDG_CONFIG_HOME

  return {
    platform: process.platform,
    execPath: process.execPath,
    argv: process.argv,
    appImagePath: process.env.APPIMAGE,
    configHome:
      configHome && path.isAbsolute(configHome) ?
        configHome
      : path.join(os.homedir(), '.config'),
  }
}

function supportsLaunchAtLogin(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin' || platform === 'linux'
}

function quoteDesktopExecArg(value: string): string {
  // GLib rejects percent signs in executable paths even when escaped as %%.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f%]/.test(value)) {
    throw new Error(
      'Linux launch-at-login path contains unsupported characters',
    )
  }

  return `"${value
    .replaceAll('\\', '\\\\\\\\')
    .replace(/["`$]/g, (character) => `\\\\${character}`)}"`
}

export async function applyLaunchAtLogin(
  controller: LoginItemController,
  settings: Pick<DesktopSettings, 'launchAtLogin' | 'minimizeToTray'>,
  runtime: LoginItemRuntime = getCurrentRuntime(),
): Promise<void> {
  if (!controller.isPackaged || !supportsLaunchAtLogin(runtime.platform)) {
    return
  }

  if (runtime.platform === 'linux') {
    const configHome = runtime.configHome ?? path.join(os.homedir(), '.config')
    const autostartPath = path.join(
      configHome,
      'autostart',
      'copilot-api.desktop',
    )

    if (!settings.launchAtLogin) {
      await fs.rm(autostartPath, { force: true })
      return
    }

    const executable = runtime.appImagePath || runtime.execPath
    const entry = `[Desktop Entry]
Type=Application
Name=Copilot API
Exec=${quoteDesktopExecArg(executable)} ${LOGIN_ITEM_ARG}
Terminal=false
`

    await fs.mkdir(path.dirname(autostartPath), { recursive: true })
    await fs.writeFile(autostartPath, entry, 'utf8')
    return
  }

  if (runtime.platform === 'win32') {
    controller.setLoginItemSettings({
      openAtLogin: settings.launchAtLogin,
      path: runtime.execPath,
      args: [LOGIN_ITEM_ARG],
      name: WINDOWS_LOGIN_ITEM_NAME,
    })
    return
  }

  controller.setLoginItemSettings({
    openAtLogin: settings.launchAtLogin,
    openAsHidden: settings.minimizeToTray,
  })
}

export function wasLaunchedAtLogin(
  controller: LoginItemController,
  runtime: LoginItemRuntime = getCurrentRuntime(),
): boolean {
  if (!supportsLaunchAtLogin(runtime.platform)) {
    return false
  }

  if (runtime.platform === 'win32' || runtime.platform === 'linux') {
    return runtime.argv.includes(LOGIN_ITEM_ARG)
  }

  return controller.getLoginItemSettings().wasOpenedAtLogin
}
