import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { DesktopSettings } from '../src/types/ipc'

export const LOGIN_ITEM_ARG = '--launch-at-login'
const WINDOWS_LOGIN_ITEM_NAME = 'com.copilot-api.desktop'

interface LoginItemController {
  readonly isPackaged: boolean
  setLoginItemSettings(settings: Electron.Settings): void
  getLoginItemSettings(): Pick<
    Electron.LoginItemSettings,
    'openAtLogin' | 'wasOpenedAtLogin' | 'launchItems'
  >
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

function getLinuxAutostartPath(runtime: LoginItemRuntime): string {
  const configHome = runtime.configHome ?? path.join(os.homedir(), '.config')
  return path.join(configHome, 'autostart', 'copilot-api.desktop')
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
    const autostartPath = getLinuxAutostartPath(runtime)

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

export async function initializeLaunchAtLogin(
  controller: LoginItemController,
  runtime: LoginItemRuntime = getCurrentRuntime(),
): Promise<boolean> {
  if (!controller.isPackaged || !supportsLaunchAtLogin(runtime.platform)) {
    return false
  }

  if (runtime.platform === 'linux') {
    try {
      const entry = await fs.readFile(getLinuxAutostartPath(runtime), 'utf8')
      return !/^\s*(?:Hidden\s*=\s*true|X-GNOME-Autostart-enabled\s*=\s*false)\s*$/im.test(
        entry,
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  const current = controller.getLoginItemSettings()
  if (runtime.platform === 'win32') {
    const item =
      current.launchItems.find(
        ({ name, scope }) =>
          name === WINDOWS_LOGIN_ITEM_NAME && scope === 'user',
      )
      ?? current.launchItems.find(
        ({ name }) => name === WINDOWS_LOGIN_ITEM_NAME,
      )

    if (!item) return false

    if (
      item.path !== runtime.execPath
      || item.args.length !== 1
      || item.args[0] !== LOGIN_ITEM_ARG
    ) {
      controller.setLoginItemSettings({
        openAtLogin: true,
        path: runtime.execPath,
        args: [LOGIN_ITEM_ARG],
        enabled: item.enabled,
        name: WINDOWS_LOGIN_ITEM_NAME,
      })
    }

    return item.enabled
  }

  return current.openAtLogin
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
