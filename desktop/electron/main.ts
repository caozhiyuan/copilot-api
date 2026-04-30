import { app, BrowserWindow, Tray, Menu, nativeImage } from 'electron'
import path from 'node:path'
import { registerIpcHandlers } from './ipc-handlers'
import { stopServer, onStatusChange, onLog, clearCallbacks } from './server-manager'
import { readSettings } from './settings-store'

let tray: Tray | null = null
let mainWindow: BrowserWindow | null = null
// 标记是通过菜单/系统退出，而非点击关闭按钮
let isQuitting = false

function createTrayNativeImage(): Electron.NativeImage {
  // macOS 使用 Template Image（白色透明底），系统自动适配深/浅色模式
  // Windows/Linux 使用彩色版（深色背景 + 蓝色图标）
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
  // macOS：恢复 Dock 图标后再显示窗口
  if (process.platform === 'darwin') {
    app.dock?.show()
  }
  win.show()
  win.focus()
}

export function createTray(win: BrowserWindow): void {
  if (tray) return

  const icon = createTrayNativeImage()
  tray = new Tray(icon)
  tray.setToolTip('Copilot API')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => showWindow(win)
    },
    { type: 'separator' },
    {
      label: '退出',
      click: async () => {
        isQuitting = true
        await stopServer()
        app.quit()
      }
    }
  ])

  tray.setContextMenu(contextMenu)
  tray.on('double-click', () => showWindow(win))
  // macOS 单击托盘图标也显示窗口
  if (process.platform === 'darwin') {
    tray.on('click', () => showWindow(win))
  }
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
  }
  // macOS：销毁托盘时恢复 Dock 图标（窗口应当可见）
  if (process.platform === 'darwin') {
    app.dock?.show()
  }
}

function createWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin'
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
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const } : {}),
    autoHideMenuBar: !isMac,
    show: false
  })

  if (!isMac) {
    // Windows/Linux 不展示 Electron 默认菜单栏，避免占用窗口顶部空间。
    win.removeMenu()
  }

  win.once('ready-to-show', () => win.show())

  win.on('close', async (e) => {
    // isQuitting 为 true 时（菜单退出），直接放行
    if (isQuitting) return

    e.preventDefault()
    const settings = await readSettings()
    if (settings.minimizeToTray) {
      win.hide()
      // macOS：隐藏 Dock 图标，应用仅在托盘中运行
      if (process.platform === 'darwin') {
        app.dock?.hide()
      }
    } else {
      isQuitting = true
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
  const win = createWindow()
  mainWindow = win

  registerIpcHandlers(win, async (minimizeToTray: boolean) => {
    if (minimizeToTray) {
      createTray(win)
    } else {
      destroyTray()
      // 设置关闭时若窗口是隐藏状态，恢复显示
      if (!win.isVisible()) {
        showWindow(win)
      }
    }
  })

  // 仅在开启最小化到托盘时才创建托盘
  const settings = await readSettings()
  if (settings.minimizeToTray) {
    createTray(win)
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
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    } else {
      showWindow(win)
    }
  })
})

app.on('before-quit', async () => {
  isQuitting = true
  await stopServer()
})

// 关闭所有窗口时（macOS 托盘场景下不会触发，因为 close 被拦截）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
