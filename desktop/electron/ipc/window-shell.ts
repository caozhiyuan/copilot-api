import { ipcMain, shell } from 'electron'

import type { IpcHandlerContext } from './shared'

export function registerWindowAndShellIpcHandlers({
  mainWindow,
  options,
}: IpcHandlerContext): void {
  // Shell: Open the system browser
  ipcMain.handle('shell:open-url', async (_event, url: string) => {
    await shell.openExternal(url)
  })

  // Window controls (used by the custom title bar menu)
  ipcMain.on('window:reload', () => mainWindow.reload())
  ipcMain.on('window:minimize', () => mainWindow.minimize())
  ipcMain.on('window:maximize-toggle', () => {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow.maximize()
    }
  })
  ipcMain.on('window:close', () => mainWindow.close())
  ipcMain.on('window:quit', () => {
    void options.onQuit?.()
  })
  ipcMain.on('window:zoom-in', () => {
    const level = mainWindow.webContents.getZoomLevel()
    mainWindow.webContents.setZoomLevel(level + 0.5)
  })
  ipcMain.on('window:zoom-out', () => {
    const level = mainWindow.webContents.getZoomLevel()
    mainWindow.webContents.setZoomLevel(level - 0.5)
  })
  ipcMain.on('window:zoom-reset', () => mainWindow.webContents.setZoomLevel(0))

  ipcMain.handle('window:is-maximized', () => mainWindow.isMaximized())
}
