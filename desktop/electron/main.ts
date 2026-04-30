import { app, BrowserWindow, Tray, Menu, nativeImage } from 'electron'
import path from 'node:path'

import { bindElectronFetch } from '../../src/lib/electron-fetch'
import type { DesktopSettings } from '../src/types/ipc'
import { tMain } from './i18n'

const CLI_ENV_FLAGS = {
  '--api-home': 'COPILOT_API_HOME',
  '--oauth-app': 'COPILOT_API_OAUTH_APP',
  '--enterprise-url': 'COPILOT_API_ENTERPRISE_URL'
} as const

function applyCliEnvOverrides(argv: string[]): void {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue

    for (const [flag, envName] of Object.entries(CLI_ENV_FLAGS)) {
      if (arg === flag) {
        const nextArg = argv[index + 1]?.trim()
        const value = nextArg?.startsWith('--') ? undefined : nextArg
        if (value) process.env[envName] = value
        break
      }

      const prefix = `${flag}=`
      if (!arg.startsWith(prefix)) continue

      const value = arg.slice(prefix.length).trim()
      if (value) process.env[envName] = value
      break
    }
  }
}

applyCliEnvOverrides(process.argv)
bindElectronFetch()

interface RuntimeDependencies {
  registerIpcHandlers: typeof import('./ipc-handlers').registerIpcHandlers
  stopServer: typeof import('./server-manager').stopServer
  onStatusChange: typeof import('./server-manager').onStatusChange
  onLog: typeof import('./server-manager').onLog
  clearCallbacks: typeof import('./server-manager').clearCallbacks
  readSettings: typeof import('./settings-store').readSettings
}

let runtimeDependenciesPromise: Promise<RuntimeDependencies> | null = null

function applySettingsEnvOverrides(settings: DesktopSettings): void {
  const apiHome = settings.apiHome.trim()
  if (!process.env.COPILOT_API_HOME && apiHome) {
    process.env.COPILOT_API_HOME = apiHome
  }

  if (!process.env.COPILOT_API_OAUTH_APP && settings.oauthApp === 'opencode') {
    process.env.COPILOT_API_OAUTH_APP = 'opencode'
  }

  const enterpriseUrl = settings.enterpriseUrl.trim()
  if (!process.env.COPILOT_API_ENTERPRISE_URL && enterpriseUrl) {
    process.env.COPILOT_API_ENTERPRISE_URL = enterpriseUrl
  }
}

function getRuntimeDependencies(): Promise<RuntimeDependencies> {
  runtimeDependenciesPromise ??= (async () => {
    const { readSettings } = await import('./settings-store')

    applySettingsEnvOverrides(await readSettings())

    const { initOpencodeVersion } = await import('../../src/lib/opencode')

    await initOpencodeVersion()

    const [
      { registerIpcHandlers },
      { stopServer, onStatusChange, onLog, clearCallbacks },
      settingsStore
    ] = await Promise.all([
      import('./ipc-handlers'),
      import('./server-manager'),
      import('./settings-store')
    ])

    return {
      registerIpcHandlers,
      stopServer,
      onStatusChange,
      onLog,
      clearCallbacks,
      readSettings: settingsStore.readSettings
    }
  })()

  return runtimeDependenciesPromise
}

let tray: Tray | null = null
let mainWindow: BrowserWindow | null = null
// Track exits triggered by menu or system actions instead of the close button
let isQuitting = false

function createTrayNativeImage(): Electron.NativeImage {
  // macOS uses a template image so the system adapts it for light and dark mode.
  // Windows and Linux use the colored icon variant.
  const isMac = process.platform === 'darwin'
  const baseName = isMac ? 'tray-iconTemplate.png' : 'tray-icon.png'
  const iconDir = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'assets')
  const iconPath = path.join(iconDir, baseName)

  const image = nativeImage.createFromPath(iconPath)
  if (isMac) {
    image.setTemplateImage(true)
  }
  return image
}

function showWindow(win: BrowserWindow): void {
  // Restore the Dock icon before showing the window on macOS.
  if (process.platform === 'darwin') {
    app.dock?.show()
  }
  win.show()
  win.focus()
}

async function refreshTrayContextMenu(win: BrowserWindow): Promise<void> {
  if (!tray) return

  const [showWindowLabel, quitLabel] = await Promise.all([
    tMain('tray.showWindow'),
    tMain('tray.quit')
  ])

  const contextMenu = Menu.buildFromTemplate([
    {
      label: showWindowLabel,
      click: () => showWindow(win)
    },
    { type: 'separator' },
    {
      label: quitLabel,
      click: async () => {
        isQuitting = true
        const { stopServer } = await getRuntimeDependencies()
        await stopServer()
        app.quit()
      }
    }
  ])

  tray.setContextMenu(contextMenu)
}

async function createTray(win: BrowserWindow): Promise<void> {
  if (tray) return

  const icon = createTrayNativeImage()
  tray = new Tray(icon)
  tray.setToolTip('Copilot API')
  await refreshTrayContextMenu(win)
  tray.on('double-click', () => showWindow(win))
  // On macOS, a single tray click should also show the window.
  if (process.platform === 'darwin') {
    tray.on('click', () => showWindow(win))
  }
}

function destroyTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
  }
  // Restore the Dock icon when destroying the tray on macOS.
  if (process.platform === 'darwin') {
    app.dock?.show()
  }
}

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

  win.removeMenu()

  mainWindow = win

  win.once('ready-to-show', () => win.show())

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null
    }
  })

  win.on('close', async (e) => {
    // Allow the close event to proceed when quitting from the menu or system.
    if (isQuitting) return

    e.preventDefault()
    const { readSettings } = await getRuntimeDependencies()
    const settings = await readSettings()
    if (settings.minimizeToTray) {
      win.hide()
      // Hide the Dock icon on macOS so the app runs from the tray only.
      if (process.platform === 'darwin') {
        app.dock?.hide()
      }
    } else {
      isQuitting = true
      const { clearCallbacks, stopServer } = await getRuntimeDependencies()
      clearCallbacks()
      await stopServer()
      app.quit()
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(async () => {
  const { registerIpcHandlers, readSettings, onStatusChange, onLog } = await getRuntimeDependencies()
  const win = createWindow()

  registerIpcHandlers(win, async (settings, prevSettings) => {
    if (settings.minimizeToTray) {
      await createTray(win)
      await refreshTrayContextMenu(win)
      return
    }

    if (prevSettings.minimizeToTray) {
      destroyTray()
      // Restore the window if it was hidden when this setting is turned off.
      if (!win.isVisible()) {
        showWindow(win)
      }
    }
  })

  // Only create the tray when minimize-to-tray is enabled.
  const settings = await readSettings()
  if (settings.minimizeToTray) {
    await createTray(win)
  }

  onStatusChange((status) => {
    if (!win.isDestroyed()) {
      win.webContents.send('server:status', status)
    }
  })

  onLog((log) => {
    if (!win.isDestroyed()) {
      win.webContents.send('server:log', log)
    }
  })

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow()
    } else {
      showWindow(mainWindow)
    }
  })
})

app.on('before-quit', async () => {
  isQuitting = true
  const { stopServer } = await getRuntimeDependencies()
  await stopServer()
})

// This will not fire in the macOS tray flow because the close event is intercepted.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
