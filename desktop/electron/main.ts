import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { registerIpcHandlers } from './ipc-handlers'
import { stopServer, onStatusChange, onLog, clearCallbacks } from './server-manager'

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

  // 窗口关闭时清理回调，防止子进程事件触发后操作已销毁的 webContents
  win.on('closed', () => {
    clearCallbacks()
  })

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
