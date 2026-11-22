import { ipcMain, shell } from 'electron'

import type { IpcHandlerContext } from './shared'

export function registerWindowAndShellIpcHandlers({
  getMainWindow,
  options,
}: IpcHandlerContext): void {
  // Shell: Open the system browser
  ipcMain.handle('shell:open-url', async (_event, url: string) => {
    await shell.openExternal(url)
  })

  // Window controls (used by the custom title bar menu)
  ipcMain.on('window:reload', () => getMainWindow()?.reload())
  ipcMain.on('window:minimize', () => getMainWindow()?.minimize())
  ipcMain.on('window:maximize-toggle', () => {
    const win = getMainWindow()
    if (!win) return
    if (win.isMaximized()) {
      win.unmaximize()
    } else {
      win.maximize()
    }
  })
  ipcMain.on('window:close', () => getMainWindow()?.close())
  ipcMain.on('window:quit', () => {
    void options.onQuit?.()
  })
  ipcMain.on('window:zoom-in', () => {
    const win = getMainWindow()
    if (!win) return
    const level = win.webContents.getZoomLevel()
    win.webContents.setZoomLevel(level + 0.5)
  })
  ipcMain.on('window:zoom-out', () => {
    const win = getMainWindow()
    if (!win) return
    const level = win.webContents.getZoomLevel()
    win.webContents.setZoomLevel(level - 0.5)
  })
  ipcMain.on('window:zoom-reset', () =>
    getMainWindow()?.webContents.setZoomLevel(0),
  )

  ipcMain.handle(
    'window:is-maximized',
    () => getMainWindow()?.isMaximized() ?? false,
  )
}
