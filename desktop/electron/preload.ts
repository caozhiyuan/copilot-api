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

  fetchUsage: () => ipcRenderer.invoke('server:fetch-usage'),
  fetchModels: () => ipcRenderer.invoke('server:fetch-models'),
  getServerAuthInfo: () => ipcRenderer.invoke('server:get-auth-info'),
  getLogs: () => ipcRenderer.invoke('server:get-logs'),

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
