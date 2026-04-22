import { ipcMain, shell, BrowserWindow } from 'electron'
import { getDeviceCode, pollAccessToken, getGitHubUser, saveToken, readToken, clearToken } from './auth'
import { startServer, stopServer, getPort, getLogs } from './server-manager'
import { readSettings, writeSettings } from './settings-store'
import type { DesktopSettings } from '../src/types/ipc'

export function registerIpcHandlers(mainWindow: BrowserWindow): void {
  // Auth: 触发 OAuth device flow
  ipcMain.handle('auth:get-device-code', async () => {
    const deviceCode = await getDeviceCode()
    // 后台轮询，拿到 token 后推送给渲染进程
    pollAccessToken(deviceCode).then(async (token) => {
      await saveToken(token)
      const username = await getGitHubUser(token)
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

  // Auth: 直接保存 token
  ipcMain.handle('auth:save-token', async (_event, token: string) => {
    try {
      const username = await getGitHubUser(token)
      await saveToken(token)
      return { success: true, username }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  // Auth: 检查已保存的 token
  ipcMain.handle('auth:check-saved', async () => {
    const token = await readToken()
    if (!token) return { success: false }
    try {
      const username = await getGitHubUser(token)
      return { success: true, username }
    } catch {
      return { success: false }
    }
  })

  // Auth: 注销
  ipcMain.handle('auth:logout', async () => {
    await clearToken()
  })

  // Server: 启动
  ipcMain.handle('server:start', async (_event, port: number) => {
    const token = await readToken()
    if (!token) return { running: false, error: '未找到 token' }

    const settings = await readSettings()
    const proxy = settings.proxy.http || settings.proxy.https
      ? { http: settings.proxy.http, https: settings.proxy.https }
      : undefined

    // 保存最后使用的端口
    await writeSettings({ ...settings, lastPort: port })

    return startServer(port, token, proxy)
  })

  // Server: 停止
  ipcMain.handle('server:stop', async () => {
    await stopServer()
  })

  // Settings
  ipcMain.handle('settings:get', async () => readSettings())
  ipcMain.handle('settings:save', async (_event, settings: DesktopSettings) => {
    await writeSettings(settings)
  })

  // Shell: 打开系统浏览器
  ipcMain.handle('shell:open-url', async (_event, url: string) => {
    await shell.openExternal(url)
  })

  // Server: 通过主进程代理 HTTP 请求，绕过渲染进程 file:// origin 的 CORS 限制
  ipcMain.handle('server:fetch-usage', async () => {
    const port = getPort()
    try {
      const res = await fetch(`http://localhost:${port}/usage`, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) return null
      return res.json()
    } catch {
      return null
    }
  })

  ipcMain.handle('server:fetch-models', async () => {
    const port = getPort()
    try {
      const res = await fetch(`http://localhost:${port}/models`, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) return null
      return res.json()
    } catch {
      return null
    }
  })

  // Server: 返回内存中的日志缓冲
  ipcMain.handle('server:get-logs', () => getLogs())
}
