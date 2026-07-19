import { describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  applyLaunchAtLogin,
  LOGIN_ITEM_ARG,
  wasLaunchedAtLogin,
} from '../electron/login-item'

function createController(
  options: {
    isPackaged?: boolean
    wasOpenedAtLogin?: boolean
  } = {},
) {
  const calls: Electron.Settings[] = []
  return {
    calls,
    isPackaged: options.isPackaged ?? true,
    setLoginItemSettings: (settings: Electron.Settings) => {
      calls.push(settings)
    },
    getLoginItemSettings: () => ({
      wasOpenedAtLogin: options.wasOpenedAtLogin ?? false,
    }),
  }
}

describe('desktop login item', () => {
  test('configures the packaged Windows login item with a launch marker', async () => {
    const controller = createController()
    const runtime = {
      platform: 'win32' as const,
      execPath: 'C:\\Program Files\\Copilot API\\Copilot API.exe',
      argv: [],
    }

    await applyLaunchAtLogin(
      controller,
      { launchAtLogin: true, minimizeToTray: true },
      runtime,
    )
    await applyLaunchAtLogin(
      controller,
      { launchAtLogin: false, minimizeToTray: false },
      runtime,
    )

    expect(controller.calls).toEqual([
      {
        openAtLogin: true,
        path: runtime.execPath,
        args: [LOGIN_ITEM_ARG],
        name: 'com.copilot-api.desktop',
      },
      {
        openAtLogin: false,
        path: runtime.execPath,
        args: [LOGIN_ITEM_ARG],
        name: 'com.copilot-api.desktop',
      },
    ])
  })

  test('configures macOS to open hidden with minimize-to-tray', async () => {
    const controller = createController()
    const runtime = {
      platform: 'darwin' as const,
      execPath: '/Applications/Copilot API.app/Contents/MacOS/Copilot API',
      argv: [],
    }

    await applyLaunchAtLogin(
      controller,
      { launchAtLogin: true, minimizeToTray: true },
      runtime,
    )

    expect(controller.calls).toEqual([
      { openAtLogin: true, openAsHidden: true },
    ])
  })

  test('manages the packaged Linux XDG autostart entry', async () => {
    const configHome = await fs.mkdtemp(
      path.join(os.tmpdir(), 'copilot-api-login-'),
    )
    const autostartPath = path.join(
      configHome,
      'autostart',
      'copilot-api.desktop',
    )
    const runtime = {
      platform: 'linux' as const,
      execPath: '/tmp/.mount-copilot/copilot-api',
      configHome,
      argv: [],
    }
    const controller = createController()
    const enabled = { launchAtLogin: true, minimizeToTray: false }

    try {
      await applyLaunchAtLogin(controller, enabled, {
        ...runtime,
        appImagePath: '/home/jay/Copilot API.AppImage',
      })

      expect(await fs.readFile(autostartPath, 'utf8')).toBe(`[Desktop Entry]
Type=Application
Name=Copilot API
Exec="/home/jay/Copilot API.AppImage" ${LOGIN_ITEM_ARG}
Terminal=false
`)
      expect(controller.calls).toEqual([])

      await applyLaunchAtLogin(controller, enabled, {
        ...runtime,
        appImagePath: '',
      })
      expect(await fs.readFile(autostartPath, 'utf8')).toContain(
        'Exec="/tmp/.mount-copilot/copilot-api"',
      )

      await applyLaunchAtLogin(controller, enabled, {
        ...runtime,
        appImagePath: '/home/jay/Copilot =`$"\\ AppImage',
      })

      expect(await fs.readFile(autostartPath, 'utf8')).toContain(
        'Exec="/home/jay/Copilot =\\\\`\\\\$\\\\"\\\\\\\\ AppImage" --launch-at-login',
      )

      for (const appImagePath of [
        '/home/jay/Copilot 100%.AppImage',
        '/tmp/a\tb',
      ]) {
        await expect(
          applyLaunchAtLogin(controller, enabled, { ...runtime, appImagePath }),
        ).rejects.toThrow('contains unsupported characters')
      }

      await applyLaunchAtLogin(
        controller,
        { launchAtLogin: false, minimizeToTray: false },
        runtime,
      )
      expect(await Bun.file(autostartPath).exists()).toBe(false)
    } finally {
      await fs.rm(configHome, { recursive: true, force: true })
    }
  })

  test('skips unsupported or unpackaged apps', async () => {
    const settings = { launchAtLogin: true, minimizeToTray: false }
    const unsupported = createController()
    await applyLaunchAtLogin(unsupported, settings, {
      platform: 'freebsd',
      execPath: '/opt/copilot-api',
      argv: [],
    })

    const unpackaged = createController({ isPackaged: false })
    await applyLaunchAtLogin(unpackaged, settings)

    expect(unsupported.calls).toEqual([])
    expect(unpackaged.calls).toEqual([])
  })

  test('detects login launches by platform', () => {
    const launched = (platform: NodeJS.Platform, argv: string[] = []) =>
      wasLaunchedAtLogin(createController(), {
        platform,
        execPath: 'copilot-api',
        argv,
      })

    const mac = createController({ wasOpenedAtLogin: true })
    expect(
      wasLaunchedAtLogin(mac, {
        platform: 'darwin',
        execPath: 'copilot-api',
        argv: [],
      }),
    ).toBe(true)
    expect(launched('win32', [LOGIN_ITEM_ARG])).toBe(true)
    expect(launched('win32')).toBe(false)
    expect(launched('linux', [LOGIN_ITEM_ARG])).toBe(true)
    expect(launched('freebsd')).toBe(false)
  })
})
