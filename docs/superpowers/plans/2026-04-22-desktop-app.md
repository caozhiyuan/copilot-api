# Desktop App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `desktop/` 目录新增 Electron + React + Tailwind 桌面应用，通过子进程启动 copilot-api 服务，与现有 `src/` 完全解耦。

**Architecture:** Electron 主进程负责 OAuth 授权、token 持久化、子进程管理；渲染进程（React）负责三个页面（授权/启动/看板）；IPC 桥接两者通信。子进程执行 `dist/main.js start --github-token <token> --port <port>`。

**Tech Stack:** Electron 35, electron-vite, React 18, Tailwind CSS 4, TypeScript, electron-builder

---

## 文件清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `desktop/package.json` | 创建 | 独立依赖管理 |
| `desktop/electron.vite.config.ts` | 创建 | electron-vite 配置 |
| `desktop/tsconfig.json` | 创建 | TypeScript 配置 |
| `desktop/electron-builder.config.ts` | 创建 | 打包配置 |
| `desktop/electron/main.ts` | 创建 | 主进程入口 |
| `desktop/electron/preload.ts` | 创建 | contextBridge IPC 桥接 |
| `desktop/electron/auth.ts` | 创建 | GitHub OAuth device flow |
| `desktop/electron/server-manager.ts` | 创建 | 子进程管理 |
| `desktop/electron/settings-store.ts` | 创建 | 桌面端配置读写 |
| `desktop/electron/ipc-handlers.ts` | 创建 | 所有 IPC handler 注册 |
| `desktop/src/main.tsx` | 创建 | 渲染进程入口 |
| `desktop/src/App.tsx` | 创建 | 页面路由 |
| `desktop/src/components/Header.tsx` | 创建 | 顶部导航 |
| `desktop/src/components/SettingsModal.tsx` | 创建 | 代理配置弹窗 |
| `desktop/src/pages/AuthPage.tsx` | 创建 | 授权页（OAuth + Token） |
| `desktop/src/pages/StartPage.tsx` | 创建 | 启动页 |
| `desktop/src/pages/DashboardPage.tsx` | 创建 | 服务看板 |
| `desktop/src/types/ipc.ts` | 创建 | IPC 类型定义 |
| `desktop/index.html` | 创建 | 渲染进程 HTML 入口 |

---

## Task 1: 项目初始化

**Files:**
- Create: `desktop/package.json`
- Create: `desktop/tsconfig.json`
- Create: `desktop/electron.vite.config.ts`
- Create: `desktop/index.html`

- [ ] **Step 1: 创建 desktop/package.json**

```json
{
  "name": "copilot-api-desktop",
  "version": "1.0.0",
  "description": "Copilot API Desktop App",
  "main": "out/main/index.js",
  "type": "module",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "preview": "electron-vite preview",
    "package": "electron-vite build && electron-builder",
    "package:mac": "electron-vite build && electron-builder --mac",
    "package:win": "electron-vite build && electron-builder --win",
    "package:linux": "electron-vite build && electron-builder --linux"
  },
  "dependencies": {
    "electron-updater": "^6.3.4"
  },
  "devDependencies": {
    "@types/react": "^18.3.18",
    "@types/react-dom": "^18.3.5",
    "@vitejs/plugin-react": "^4.3.4",
    "autoprefixer": "^10.4.20",
    "electron": "^35.2.1",
    "electron-builder": "^25.1.8",
    "electron-vite": "^3.1.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "tailwindcss": "^4.1.4",
    "@tailwindcss/vite": "^4.1.4",
    "typescript": "^5.7.3",
    "vite": "^6.3.3"
  },
  "build": {
    "extends": "./electron-builder.config.ts"
  }
}
```

- [ ] **Step 2: 安装依赖**

```bash
cd desktop && npm install
```

Expected: node_modules 生成，无报错

- [ ] **Step 3: 创建 desktop/tsconfig.json**

```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.node.json" },
    { "path": "./tsconfig.web.json" }
  ]
}
```

同时创建 `desktop/tsconfig.node.json`：

```json
{
  "extends": "@electron-toolkit/tsconfig/tsconfig.node.json",
  "include": ["electron.vite.config.*", "electron/**/*"],
  "compilerOptions": {
    "composite": true,
    "types": ["electron-vite/node"]
  }
}
```

同时创建 `desktop/tsconfig.web.json`：

```json
{
  "extends": "@electron-toolkit/tsconfig/tsconfig.web.json",
  "include": ["src/**/*"],
  "compilerOptions": {
    "composite": true
  }
}
```

- [ ] **Step 4: 安装 @electron-toolkit/tsconfig**

```bash
cd desktop && npm install -D @electron-toolkit/tsconfig
```

- [ ] **Step 5: 创建 desktop/electron.vite.config.ts**

```typescript
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [
      react(),
      tailwindcss()
    ]
  }
})
```

- [ ] **Step 6: 创建 desktop/index.html**

```html
<!DOCTYPE html>
<html lang="zh">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Copilot API</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 7: 创建 desktop/electron-builder.config.ts**

```typescript
import type { Configuration } from 'electron-builder'

const config: Configuration = {
  appId: 'com.copilot-api.desktop',
  productName: 'Copilot API',
  directories: {
    buildResources: 'build',
    output: 'release'
  },
  files: [
    'out/**/*',
    'resources/**/*'
  ],
  extraResources: [
    {
      from: '../dist/main.js',
      to: 'server/main.js'
    }
  ],
  mac: {
    target: 'dmg',
    category: 'public.app-category.developer-tools'
  },
  win: {
    target: 'nsis'
  },
  linux: {
    target: 'AppImage'
  }
}

export default config
```

- [ ] **Step 8: Commit**

```bash
git add desktop/
git commit -m "feat(desktop): initialize electron-vite project structure"
```

---

## Task 2: IPC 类型定义

**Files:**
- Create: `desktop/src/types/ipc.ts`

- [ ] **Step 1: 创建 desktop/src/types/ipc.ts**

```typescript
export interface DeviceCodeInfo {
  user_code: string
  verification_uri: string
  device_code: string
  interval: number
  expires_in: number
}

export interface AuthResult {
  success: boolean
  username?: string
  error?: string
}

export interface ServerStatus {
  running: boolean
  port?: number
  error?: string
}

export interface DesktopSettings {
  proxy: {
    http: string
    https: string
  }
  lastPort: number
}

export interface Window {
  electronAPI: {
    // Auth
    getDeviceCode: () => Promise<DeviceCodeInfo>
    saveToken: (token: string) => Promise<AuthResult>
    checkSavedToken: () => Promise<AuthResult>
    logout: () => Promise<void>

    // Server
    startServer: (port: number) => Promise<ServerStatus>
    stopServer: () => Promise<void>

    // Settings
    getSettings: () => Promise<DesktopSettings>
    saveSettings: (settings: DesktopSettings) => Promise<void>

    // Shell
    openUrl: (url: string) => Promise<void>

    // Events
    onAuthSuccess: (callback: (result: AuthResult) => void) => () => void
    onServerStatus: (callback: (status: ServerStatus) => void) => () => void
    onServerLog: (callback: (log: string) => void) => () => void
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add desktop/src/types/
git commit -m "feat(desktop): add IPC type definitions"
```

---

## Task 3: 主进程 auth 模块

**Files:**
- Create: `desktop/electron/auth.ts`

- [ ] **Step 1: 创建 desktop/electron/auth.ts**

```typescript
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

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

export async function getDeviceCode(): Promise<DeviceCodeResponse> {
  const res = await fetch(GITHUB_DEVICE_CODE_URL, {
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
  })

  if (!res.ok) throw new Error(`getDeviceCode failed: ${res.status}`)
  return res.json() as Promise<DeviceCodeResponse>
}

export async function pollAccessToken(deviceCode: DeviceCodeResponse): Promise<string> {
  const intervalMs = (deviceCode.interval + 1) * 1000

  while (true) {
    await new Promise(resolve => setTimeout(resolve, intervalMs))

    const res = await fetch(GITHUB_ACCESS_TOKEN_URL, {
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
    })

    if (!res.ok) continue

    const json = await res.json() as { access_token?: string }
    if (json.access_token) return json.access_token
  }
}

export async function getGitHubUser(token: string): Promise<string> {
  const res = await fetch(GITHUB_USER_API, {
    headers: {
      authorization: `token ${token}`,
      'user-agent': USER_AGENT,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28'
    }
  })

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
```

- [ ] **Step 2: Commit**

```bash
git add desktop/electron/auth.ts
git commit -m "feat(desktop): add GitHub OAuth auth module"
```

---

## Task 4: settings-store 模块

**Files:**
- Create: `desktop/electron/settings-store.ts`

- [ ] **Step 1: 创建 desktop/electron/settings-store.ts**

```typescript
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
```

- [ ] **Step 2: Commit**

```bash
git add desktop/electron/settings-store.ts
git commit -m "feat(desktop): add settings store for proxy config"
```

---

## Task 5: server-manager 模块

**Files:**
- Create: `desktop/electron/server-manager.ts`

- [ ] **Step 1: 创建 desktop/electron/server-manager.ts**

```typescript
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { app } from 'electron'

import type { ServerStatus } from '../src/types/ipc'

let serverProcess: ChildProcess | null = null
let currentPort = 4141
let statusCallback: ((status: ServerStatus) => void) | null = null
let logCallback: ((log: string) => void) | null = null

export function onStatusChange(cb: (status: ServerStatus) => void): void {
  statusCallback = cb
}

export function onLog(cb: (log: string) => void): void {
  logCallback = cb
}

function getServerPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'server', 'main.js')
  }
  // 开发模式下使用项目根目录的 dist/main.js
  return path.join(app.getAppPath(), '..', 'dist', 'main.js')
}

export async function startServer(
  port: number,
  token: string,
  proxy?: { http?: string; https?: string }
): Promise<ServerStatus> {
  if (serverProcess) {
    await stopServer()
  }

  currentPort = port

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production'
  }

  if (proxy?.http) env.HTTP_PROXY = proxy.http
  if (proxy?.https) env.HTTPS_PROXY = proxy.https

  const serverPath = getServerPath()

  serverProcess = spawn(process.execPath, [serverPath, 'start', '--github-token', token, '--port', String(port)], {
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  serverProcess.stdout?.on('data', (data: Buffer) => {
    logCallback?.(data.toString())
  })

  serverProcess.stderr?.on('data', (data: Buffer) => {
    logCallback?.(data.toString())
  })

  serverProcess.on('exit', (code) => {
    serverProcess = null
    statusCallback?.({
      running: false,
      error: code !== 0 ? `进程退出，代码 ${code}` : undefined
    })
  })

  serverProcess.on('error', (err) => {
    serverProcess = null
    statusCallback?.({ running: false, error: err.message })
  })

  // 等待服务启动（轮询 /health 或等待固定时间）
  await waitForServer(port)

  return { running: true, port }
}

async function waitForServer(port: number): Promise<void> {
  const url = `http://localhost:${port}/`
  for (let i = 0; i < 20; i++) {
    await new Promise(resolve => setTimeout(resolve, 500))
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) })
      if (res.ok || res.status === 404) return
    } catch {
      // 继续等待
    }
  }
}

export async function stopServer(): Promise<void> {
  if (!serverProcess) return
  serverProcess.kill()
  serverProcess = null
}

export function isRunning(): boolean {
  return serverProcess !== null
}

export function getPort(): number {
  return currentPort
}
```

- [ ] **Step 2: Commit**

```bash
git add desktop/electron/server-manager.ts
git commit -m "feat(desktop): add server subprocess manager"
```

---

## Task 6: 主进程入口 + preload + IPC handlers

**Files:**
- Create: `desktop/electron/main.ts`
- Create: `desktop/electron/preload.ts`
- Create: `desktop/electron/ipc-handlers.ts`

- [ ] **Step 1: 创建 desktop/electron/preload.ts**

```typescript
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  getDeviceCode: () => ipcRenderer.invoke('auth:get-device-code'),
  saveToken: (token: string) => ipcRenderer.invoke('auth:save-token', token),
  checkSavedToken: () => ipcRenderer.invoke('auth:check-saved'),
  logout: () => ipcRenderer.invoke('auth:logout'),

  startServer: (port: number) => ipcRenderer.invoke('server:start', port),
  stopServer: () => ipcRenderer.invoke('server:stop'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: unknown) => ipcRenderer.invoke('settings:save', settings),

  openUrl: (url: string) => ipcRenderer.invoke('shell:open-url', url),

  onAuthSuccess: (callback: (result: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, result: unknown) => callback(result)
    ipcRenderer.on('auth:success', handler)
    return () => ipcRenderer.off('auth:success', handler)
  },

  onServerStatus: (callback: (status: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status)
    ipcRenderer.on('server:status', handler)
    return () => ipcRenderer.off('server:status', handler)
  },

  onServerLog: (callback: (log: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, log: string) => callback(log)
    ipcRenderer.on('server:log', handler)
    return () => ipcRenderer.off('server:log', handler)
  }
})
```

- [ ] **Step 2: 创建 desktop/electron/ipc-handlers.ts**

```typescript
import { ipcMain, shell, BrowserWindow } from 'electron'
import { getDeviceCode, pollAccessToken, getGitHubUser, saveToken, readToken, clearToken } from './auth'
import { startServer, stopServer } from './server-manager'
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
      mainWindow.webContents.send('auth:success', { success: true, username })
    }).catch((err: Error) => {
      mainWindow.webContents.send('auth:success', { success: false, error: err.message })
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
}
```

- [ ] **Step 3: 创建 desktop/electron/main.ts**

```typescript
import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { registerIpcHandlers } from './ipc-handlers'
import { stopServer, onStatusChange, onLog } from './server-manager'

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1000,
    height: 650,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    titleBarStyle: 'hiddenInset',
    show: false
  })

  win.once('ready-to-show', () => win.show())

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(() => {
  const win = createWindow()

  registerIpcHandlers(win)

  onStatusChange((status) => {
    win.webContents.send('server:status', status)
  })

  onLog((log) => {
    win.webContents.send('server:log', log)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', async () => {
  await stopServer()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  await stopServer()
})
```

- [ ] **Step 4: Commit**

```bash
git add desktop/electron/
git commit -m "feat(desktop): add main process, preload, and IPC handlers"
```

---

## Task 7: React 应用入口 + Header 组件

**Files:**
- Create: `desktop/src/main.tsx`
- Create: `desktop/src/App.tsx`
- Create: `desktop/src/index.css`
- Create: `desktop/src/components/Header.tsx`

- [ ] **Step 1: 创建 desktop/src/index.css**

```css
@import "tailwindcss";
```

- [ ] **Step 2: 创建 desktop/src/main.tsx**

```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
```

- [ ] **Step 3: 创建 desktop/src/App.tsx**

```tsx
import { useState, useEffect } from 'react'
import AuthPage from './pages/AuthPage'
import StartPage from './pages/StartPage'
import DashboardPage from './pages/DashboardPage'

export type Page = 'auth' | 'start' | 'dashboard'

export default function App() {
  const [page, setPage] = useState<Page>('auth')
  const [username, setUsername] = useState<string>('')
  const [port, setPort] = useState<number>(4141)

  useEffect(() => {
    // 启动时检查本地是否有已保存的 token
    window.electronAPI.checkSavedToken().then((result) => {
      if (result.success && result.username) {
        setUsername(result.username)
        setPage('start')
      }
    })
  }, [])

  useEffect(() => {
    window.electronAPI.getSettings().then((settings) => {
      setPort(settings.lastPort)
    })
  }, [])

  const handleAuthSuccess = (user: string) => {
    setUsername(user)
    setPage('start')
  }

  const handleServerStart = (serverPort: number) => {
    setPort(serverPort)
    setPage('dashboard')
  }

  const handleLogout = async () => {
    await window.electronAPI.logout()
    setUsername('')
    setPage('auth')
  }

  return (
    <div className="min-h-screen bg-white flex flex-col">
      {page === 'auth' && <AuthPage onSuccess={handleAuthSuccess} />}
      {page === 'start' && (
        <StartPage
          username={username}
          defaultPort={port}
          onStart={handleServerStart}
          onLogout={handleLogout}
        />
      )}
      {page === 'dashboard' && (
        <DashboardPage
          username={username}
          port={port}
          onLogout={handleLogout}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 4: 创建 desktop/src/components/Header.tsx**

```tsx
import { useState } from 'react'
import SettingsModal from './SettingsModal'

interface HeaderProps {
  username?: string
  onLogout?: () => void
}

export default function Header({ username, onLogout }: HeaderProps) {
  const [showSettings, setShowSettings] = useState(false)
  const [showLogout, setShowLogout] = useState(false)

  return (
    <>
      <div className="flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-700">🤖 Copilot API</span>
        </div>
        <div className="flex items-center gap-2">
          {username && (
            <div className="relative">
              <button
                onClick={() => setShowLogout(v => !v)}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                {username}
              </button>
              {showLogout && (
                <div className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-10">
                  <button
                    onClick={() => { setShowLogout(false); onLogout?.() }}
                    className="block w-full px-4 py-2 text-sm text-red-600 hover:bg-red-50 rounded-lg"
                  >
                    注销
                  </button>
                </div>
              )}
            </div>
          )}
          <button
            onClick={() => setShowSettings(true)}
            className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            设置
          </button>
        </div>
      </div>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </>
  )
}
```

- [ ] **Step 5: Commit**

```bash
git add desktop/src/
git commit -m "feat(desktop): add React app scaffold and Header component"
```

---

## Task 8: SettingsModal 组件

**Files:**
- Create: `desktop/src/components/SettingsModal.tsx`

- [ ] **Step 1: 创建 desktop/src/components/SettingsModal.tsx**

```tsx
import { useState, useEffect } from 'react'
import type { DesktopSettings } from '../types/ipc'

interface SettingsModalProps {
  onClose: () => void
}

export default function SettingsModal({ onClose }: SettingsModalProps) {
  const [settings, setSettings] = useState<DesktopSettings>({
    proxy: { http: '', https: '' },
    lastPort: 4141
  })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    window.electronAPI.getSettings().then(setSettings)
  }, [])

  const handleSave = async () => {
    setSaving(true)
    await window.electronAPI.saveSettings(settings)
    setSaving(false)
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-xl w-[480px] p-6">
        <h2 className="text-lg font-semibold mb-4">代理设置</h2>
        <p className="text-sm text-gray-500 mb-4">
          配置后，授权和服务的所有网络请求将通过代理发送
        </p>

        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              HTTP 代理
            </label>
            <input
              type="text"
              placeholder="http://127.0.0.1:7890"
              value={settings.proxy.http}
              onChange={e => setSettings(s => ({ ...s, proxy: { ...s.proxy, http: e.target.value } }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              HTTPS 代理
            </label>
            <input
              type="text"
              placeholder="http://127.0.0.1:7890"
              value={settings.proxy.https}
              onChange={e => setSettings(s => ({ ...s, proxy: { ...s.proxy, https: e.target.value } }))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        <div className="flex gap-2 mt-6 justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add desktop/src/components/SettingsModal.tsx
git commit -m "feat(desktop): add settings modal with proxy configuration"
```

---

## Task 9: AuthPage 组件

**Files:**
- Create: `desktop/src/pages/AuthPage.tsx`

- [ ] **Step 1: 创建 desktop/src/pages/AuthPage.tsx**

```tsx
import { useState } from 'react'
import Header from '../components/Header'
import type { DeviceCodeInfo } from '../types/ipc'

interface AuthPageProps {
  onSuccess: (username: string) => void
}

type Tab = 'oauth' | 'token'

export default function AuthPage({ onSuccess }: AuthPageProps) {
  const [tab, setTab] = useState<Tab>('oauth')
  const [deviceCode, setDeviceCode] = useState<DeviceCodeInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [tokenInput, setTokenInput] = useState('')
  const [error, setError] = useState('')
  const [polling, setPolling] = useState(false)

  const handleOAuth = async () => {
    setLoading(true)
    setError('')
    try {
      const code = await window.electronAPI.getDeviceCode()
      setDeviceCode(code)
      setPolling(true)

      // 监听主进程推送的授权结果
      const unsubscribe = window.electronAPI.onAuthSuccess((result) => {
        unsubscribe()
        setPolling(false)
        if (result.success && result.username) {
          onSuccess(result.username)
        } else {
          setError(result.error ?? '授权失败，请重试')
        }
      })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const handleOpenDeviceUrl = () => {
    if (deviceCode) {
      window.electronAPI.openUrl(deviceCode.verification_uri)
    }
  }

  const handleSaveToken = async () => {
    if (!tokenInput.trim()) return
    setLoading(true)
    setError('')
    try {
      const result = await window.electronAPI.saveToken(tokenInput.trim())
      if (result.success && result.username) {
        onSuccess(result.username)
      } else {
        setError(result.error ?? 'Token 无效，请重试')
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col h-screen">
      <Header />

      <div className="flex-1 flex flex-col items-center justify-center px-8">
        {/* Tab 切换 */}
        <div className="flex gap-2 mb-10">
          <button
            onClick={() => { setTab('oauth'); setDeviceCode(null); setError('') }}
            className={`px-6 py-2 rounded-xl text-sm font-medium border transition-colors ${
              tab === 'oauth'
                ? 'bg-blue-100 border-blue-300 text-blue-700'
                : 'border-gray-300 text-gray-600 hover:bg-gray-50'
            }`}
          >
            OAuth 授权
          </button>
          <button
            onClick={() => { setTab('token'); setDeviceCode(null); setError('') }}
            className={`px-6 py-2 rounded-xl text-sm font-medium border transition-colors ${
              tab === 'token'
                ? 'bg-blue-100 border-blue-300 text-blue-700'
                : 'border-gray-300 text-gray-600 hover:bg-gray-50'
            }`}
          >
            直接填写 Token
          </button>
        </div>

        {/* OAuth 内容区 */}
        {tab === 'oauth' && (
          <div className="flex flex-col items-center gap-6 w-full max-w-lg">
            {deviceCode ? (
              <>
                <p className="text-center text-gray-700 text-base">
                  Please enter the code{' '}
                  <span className="font-mono font-bold text-gray-900">
                    "{deviceCode.user_code}"
                  </span>{' '}
                  in{' '}
                  <button
                    onClick={handleOpenDeviceUrl}
                    className="text-blue-600 underline hover:text-blue-800"
                  >
                    {deviceCode.verification_uri}
                  </button>
                </p>
                {polling && (
                  <p className="text-sm text-gray-400 animate-pulse">
                    等待 GitHub 授权中…
                  </p>
                )}
              </>
            ) : (
              <button
                onClick={handleOAuth}
                disabled={loading}
                className="px-8 py-3 border-2 border-gray-300 rounded-2xl text-sm font-medium hover:bg-gray-50 disabled:opacity-50 transition-colors"
              >
                {loading ? '请稍候…' : '开始 OAuth 授权'}
              </button>
            )}
          </div>
        )}

        {/* Token 内容区 */}
        {tab === 'token' && (
          <div className="flex flex-col items-center gap-4 w-full max-w-lg">
            <textarea
              value={tokenInput}
              onChange={e => setTokenInput(e.target.value)}
              placeholder="粘贴 GitHub Token（gho_xxxxxxxx）"
              rows={4}
              className="w-full px-4 py-3 border border-gray-300 rounded-2xl text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              onClick={handleSaveToken}
              disabled={loading || !tokenInput.trim()}
              className="px-8 py-2.5 border border-gray-300 rounded-2xl text-sm font-medium hover:bg-gray-50 disabled:opacity-50 transition-colors"
            >
              {loading ? '验证中…' : '确认添加'}
            </button>
          </div>
        )}

        {error && (
          <p className="mt-4 text-sm text-red-500">{error}</p>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add desktop/src/pages/AuthPage.tsx
git commit -m "feat(desktop): add auth page with OAuth and token flows"
```

---

## Task 10: StartPage 组件

**Files:**
- Create: `desktop/src/pages/StartPage.tsx`

- [ ] **Step 1: 创建 desktop/src/pages/StartPage.tsx**

```tsx
import { useState } from 'react'
import Header from '../components/Header'

interface StartPageProps {
  username: string
  defaultPort: number
  onStart: (port: number) => void
  onLogout: () => void
}

export default function StartPage({ username, defaultPort, onStart, onLogout }: StartPageProps) {
  const [port, setPort] = useState<string>(String(defaultPort))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleStart = async () => {
    const portNum = parseInt(port, 10)
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      setError('请输入有效的端口号（1-65535）')
      return
    }

    setLoading(true)
    setError('')

    try {
      const status = await window.electronAPI.startServer(portNum)
      if (status.running) {
        onStart(portNum)
      } else {
        setError(status.error ?? '服务启动失败')
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col h-screen">
      <Header username={username} onLogout={onLogout} />

      <div className="flex-1 flex flex-col items-center justify-center gap-6">
        <div className="flex items-center gap-3">
          <input
            type="number"
            value={port}
            onChange={e => setPort(e.target.value)}
            min={1}
            max={65535}
            className="w-40 px-4 py-2.5 border border-gray-300 rounded-xl text-sm text-center focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <span className="text-sm text-gray-500">服务端口</span>
        </div>

        <button
          onClick={handleStart}
          disabled={loading}
          className="px-10 py-3 border-2 border-gray-300 rounded-2xl text-sm font-medium hover:bg-gray-50 disabled:opacity-50 transition-colors"
        >
          {loading ? '启动中…' : '启动服务'}
        </button>

        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add desktop/src/pages/StartPage.tsx
git commit -m "feat(desktop): add start page with port input and server launch"
```

---

## Task 11: DashboardPage 组件

**Files:**
- Create: `desktop/src/pages/DashboardPage.tsx`

- [ ] **Step 1: 创建 desktop/src/pages/DashboardPage.tsx**

```tsx
import { useState, useEffect } from 'react'
import Header from '../components/Header'

interface DashboardPageProps {
  username: string
  port: number
  onLogout: () => void
}

interface UsageInfo {
  copilot_plan?: string
  assigned_date?: string
  quota_reset_date?: string
  chat_quotas?: { used: number; total: number }
  completions_quotas?: { used: number; total: number }
  [key: string]: unknown
}

interface Model {
  id: string
  [key: string]: unknown
}

export default function DashboardPage({ username, port, onLogout }: DashboardPageProps) {
  const [usage, setUsage] = useState<UsageInfo | null>(null)
  const [models, setModels] = useState<Model[]>([])
  const [serverError, setServerError] = useState('')
  const [loading, setLoading] = useState(true)

  const baseUrl = `http://localhost:${port}`

  useEffect(() => {
    const unsubscribe = window.electronAPI.onServerStatus((status) => {
      if (!status.running) {
        setServerError(status.error ?? '服务已停止')
      }
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 30_000)
    return () => clearInterval(interval)
  }, [port])

  const fetchData = async () => {
    setLoading(true)
    try {
      const [usageRes, modelsRes] = await Promise.all([
        fetch(`${baseUrl}/usage`),
        fetch(`${baseUrl}/models`)
      ])

      if (usageRes.ok) {
        setUsage(await usageRes.json() as UsageInfo)
      }
      if (modelsRes.ok) {
        const modelsData = await modelsRes.json() as { data: Model[] }
        setModels(modelsData.data ?? [])
      }
    } catch {
      // 服务可能还在启动
    } finally {
      setLoading(false)
    }
  }

  const handleLogout = async () => {
    await window.electronAPI.stopServer()
    onLogout()
  }

  return (
    <div className="flex flex-col h-screen">
      <Header username={username} onLogout={handleLogout} />

      {serverError && (
        <div className="mx-6 mb-2 px-4 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600">
          ⚠️ {serverError}
        </div>
      )}

      <div className="flex-1 overflow-auto px-6 pb-6">
        <div className="border border-gray-200 rounded-2xl p-5">
          {/* 订阅信息 */}
          <div className="grid grid-cols-3 gap-3 mb-4">
            <InfoCard label="Copilot Plan" value={usage?.copilot_plan ?? '—'} loading={loading} />
            <InfoCard label="Assigned Date" value={usage?.assigned_date ?? '—'} loading={loading} />
            <InfoCard label="Quota Reset Date" value={usage?.quota_reset_date ?? '—'} loading={loading} />
            <InfoCard
              label="Chat Quotas"
              value={usage?.chat_quotas ? `${usage.chat_quotas.used} / ${usage.chat_quotas.total}` : '—'}
              loading={loading}
            />
            <InfoCard
              label="Completions Quotas"
              value={usage?.completions_quotas ? `${usage.completions_quotas.used} / ${usage.completions_quotas.total}` : '—'}
              loading={loading}
            />
            <InfoCard label="服务地址" value={`localhost:${port}`} loading={false} />
          </div>

          {/* 模型列表 */}
          <div className="border border-gray-200 rounded-xl p-4">
            <h3 className="text-sm font-medium text-gray-600 mb-3">模型列表</h3>
            {loading ? (
              <p className="text-sm text-gray-400 animate-pulse">加载中…</p>
            ) : models.length > 0 ? (
              <div className="grid grid-cols-2 gap-1.5 max-h-48 overflow-y-auto">
                {models.map(m => (
                  <div
                    key={m.id}
                    className="px-3 py-1.5 bg-gray-50 rounded-lg text-xs text-gray-700 truncate"
                    title={m.id}
                  >
                    {m.id}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-400">暂无模型数据</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function InfoCard({ label, value, loading }: { label: string; value: string; loading: boolean }) {
  return (
    <div className="flex items-center gap-2 px-4 py-2.5 border border-gray-200 rounded-xl">
      <div>
        <div className="text-xs text-gray-400">{label}</div>
        <div className={`text-sm font-medium text-gray-800 ${loading ? 'animate-pulse' : ''}`}>
          {loading ? '…' : value}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 在 desktop/src/types/ipc.ts 末尾添加全局类型声明**

在 `desktop/src/types/ipc.ts` 文件末尾追加：

```typescript
// 全局 window 类型扩展（渲染进程使用）
declare global {
  interface Window {
    electronAPI: {
      getDeviceCode: () => Promise<DeviceCodeInfo>
      saveToken: (token: string) => Promise<AuthResult>
      checkSavedToken: () => Promise<AuthResult>
      logout: () => Promise<void>
      startServer: (port: number) => Promise<ServerStatus>
      stopServer: () => Promise<void>
      getSettings: () => Promise<DesktopSettings>
      saveSettings: (settings: DesktopSettings) => Promise<void>
      openUrl: (url: string) => Promise<void>
      onAuthSuccess: (callback: (result: AuthResult) => void) => () => void
      onServerStatus: (callback: (status: ServerStatus) => void) => () => void
      onServerLog: (callback: (log: string) => void) => () => void
    }
  }
}
```

并删除文件顶部的 `export interface Window { ... }` 块（已被全局声明替代）。

- [ ] **Step 3: Commit**

```bash
git add desktop/src/pages/DashboardPage.tsx desktop/src/types/ipc.ts
git commit -m "feat(desktop): add dashboard page with usage info and model list"
```

---

## Task 12: 开发模式验证

- [ ] **Step 1: 先构建服务端产物**

```bash
cd /path/to/copilot-api1 && bun run build
```

Expected: `dist/main.js` 存在

- [ ] **Step 2: 启动桌面应用开发模式**

```bash
cd desktop && npm run dev
```

Expected: Electron 窗口打开，显示授权页，无控制台报错

- [ ] **Step 3: 验证 OAuth 流程**

1. 点击「开始 OAuth 授权」
2. 确认显示 `user_code` 和 verification_uri
3. 确认点击链接能打开系统浏览器

- [ ] **Step 4: 验证 Token 流程**

1. 切换到「直接填写 Token」tab
2. 输入有效 token → 点击确认
3. 确认跳转到启动页，右上角显示用户名

- [ ] **Step 5: 验证服务启动**

1. 在启动页填写端口 4141 → 点击启动服务
2. 等待约 3s → 确认跳转到看板页
3. 确认订阅信息和模型列表加载成功

- [ ] **Step 6: 验证设置页**

1. 点击右上角「设置」
2. 填写代理地址 → 保存
3. 重新打开设置确认已保存

- [ ] **Step 7: Commit 最终验证**

```bash
git add .
git commit -m "feat(desktop): complete desktop app MVP"
```
