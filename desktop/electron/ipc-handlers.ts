import fs from 'node:fs/promises'

import { ipcMain, shell, BrowserWindow } from 'electron'

import { normalizeApiKeys } from '../../src/lib/request-auth'
import { PATHS } from '../../src/lib/paths'
import { getDeviceCode, pollAccessToken, getGitHubUser, saveToken, readToken, clearToken, getCopilotAccountType } from './auth'
import { tMain } from './i18n'
import { startServer, stopServer, getPort, getLogs } from './server-manager'
import { readSettings, writeSettings } from './settings-store'
import type { DesktopSettings, ServerAuthInfo } from '../src/types/ipc'

async function getServerAuthInfo(): Promise<ServerAuthInfo> {
  try {
    const raw = await fs.readFile(PATHS.CONFIG_PATH, 'utf8')
    const parsed = raw.trim()
      ? JSON.parse(raw) as { auth?: { apiKeys?: unknown } }
      : {}
    const apiKey = normalizeApiKeys(parsed.auth?.apiKeys)[0]

    if (!apiKey) {
      return { enabled: false }
    }

    return {
      enabled: true,
      headerName: 'x-api-key',
      headerValue: apiKey,
    }
  } catch {
    return { enabled: false }
  }
}

async function getServerRequestHeaders(): Promise<Record<string, string> | undefined> {
  const authInfo = await getServerAuthInfo()
  if (!authInfo.enabled || !authInfo.headerName || !authInfo.headerValue) {
    return undefined
  }

  return {
    [authInfo.headerName]: authInfo.headerValue,
  }
}

export function registerIpcHandlers(
  mainWindow: BrowserWindow,
  onSettingsChange?: (settings: DesktopSettings, prevSettings: DesktopSettings) => void | Promise<void>
): void {
  // Auth: Start the OAuth device flow
  ipcMain.handle('auth:get-device-code', async () => {
    const deviceCode = await getDeviceCode()
    // Poll in the background and notify the renderer when the token arrives
    pollAccessToken(deviceCode).then(async (token) => {
      await saveToken(token)
      const [username, accountType] = await Promise.all([
        getGitHubUser(token),
        getCopilotAccountType(token)
      ])
      // Detect and persist the account type automatically after sign-in
      const settings = await readSettings()
      await writeSettings({ ...settings, accountType })
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('auth:success', { success: true, username })
      }
    }).catch((err: Error) => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('auth:success', { success: false, error: err.message })
      }
    })
    return deviceCode
  })

  // Auth: Save token directly
  ipcMain.handle('auth:save-token', async (_event, token: string) => {
    try {
      const [username, accountType] = await Promise.all([
        getGitHubUser(token),
        getCopilotAccountType(token)
      ])
      await saveToken(token)
      // Detect and persist the account type automatically
      const settings = await readSettings()
      await writeSettings({ ...settings, accountType })
      return { success: true, username }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  // Auth: Check the saved token
  ipcMain.handle('auth:check-saved', async () => {
    const token = await readToken()
    if (!token) return { success: false }
    try {
      const [username, accountType] = await Promise.all([
        getGitHubUser(token),
        getCopilotAccountType(token)
      ])
      // Refresh the persisted account type on startup in case the plan changed
      const settings = await readSettings()
      await writeSettings({ ...settings, accountType })
      return { success: true, username }
    } catch {
      return { success: false }
    }
  })

  // Auth: Log out
  ipcMain.handle('auth:logout', async () => {
    await clearToken()
  })

  // Server: Start
  ipcMain.handle('server:start', async (_event, port: number) => {
    const token = await readToken()
    if (!token) {
      return {
        running: false,
        error: await tMain('server.tokenNotFound')
      }
    }

    const settings = await readSettings()
    const serverOptions = {
      accountType: settings.accountType,
      verbose: settings.verbose,
      showToken: settings.showToken
    }

    // Persist the last used port
    await writeSettings({ ...settings, lastPort: port })

    return startServer(port, token, serverOptions)
  })

  // Server: Stop
  ipcMain.handle('server:stop', async () => {
    await stopServer()
  })

  // Settings
  ipcMain.handle('settings:get', async () => readSettings())
  ipcMain.handle('settings:save', async (_event, settings: DesktopSettings) => {
    const prev = await readSettings()
    await writeSettings(settings)
    // Notify the main process after settings are saved so tray state and labels stay in sync.
    if (onSettingsChange) {
      await onSettingsChange(settings, prev)
    }
  })

  // Shell: Open the system browser
  ipcMain.handle('shell:open-url', async (_event, url: string) => {
    await shell.openExternal(url)
  })

  // Server: Proxy HTTP requests through the main process to bypass file:// origin CORS in the renderer
  ipcMain.handle('server:fetch-usage', async () => {
    const port = getPort()
    try {
      const headers = await getServerRequestHeaders()
      const res = await fetch(`http://localhost:${port}/usage`, {
        headers,
        signal: AbortSignal.timeout(5000)
      })
      if (!res.ok) return null
      return res.json()
    } catch {
      return null
    }
  })

  ipcMain.handle('server:fetch-models', async () => {
    const port = getPort()
    try {
      const headers = await getServerRequestHeaders()
      const res = await fetch(`http://localhost:${port}/models`, {
        headers,
        signal: AbortSignal.timeout(5000)
      })
      if (!res.ok) return null
      return res.json()
    } catch {
      return null
    }
  })

  ipcMain.handle('server:get-auth-info', async () => getServerAuthInfo())

  // Server: Return the in-memory log buffer
  ipcMain.handle('server:get-logs', () => getLogs())
}
