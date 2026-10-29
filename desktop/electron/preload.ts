import { contextBridge, ipcRenderer } from 'electron'
import type { AppUpdateStatus, XaiAuthInfo } from '../src/types/ipc'
import type {
  ImageCreationInput,
  SaveMediaInput,
  VideoCreationInput,
} from '../src/types/media'

contextBridge.exposeInMainWorld('electronAPI', {
  getAuthStatus: () => ipcRenderer.invoke('auth:get-status'),
  getDeviceCode: () => ipcRenderer.invoke('auth:get-device-code'),
  saveToken: (token: string) => ipcRenderer.invoke('auth:save-token', token),
  checkSavedToken: () => ipcRenderer.invoke('auth:check-saved'),
  configureProvider: (input: unknown) =>
    ipcRenderer.invoke('auth:configure-provider', input),
  getModelsDevProviders: () =>
    ipcRenderer.invoke('auth:get-models-dev-providers'),
  getCodexAccounts: () => ipcRenderer.invoke('auth:get-codex-accounts'),
  switchCodexAccount: (accountId: string) =>
    ipcRenderer.invoke('auth:switch-codex-account', accountId),
  removeCodexAccount: (accountId: string) =>
    ipcRenderer.invoke('auth:remove-codex-account', accountId),
  startCodexLogin: (input?: unknown) =>
    ipcRenderer.invoke('auth:start-codex-login', input),
  cancelCodexLogin: () => ipcRenderer.invoke('auth:cancel-codex-login'),
  onCodexAuthUrl: (callback: (url: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, url: string) =>
      callback(url)
    ipcRenderer.on('auth:codex-url', handler)
    return () => ipcRenderer.off('auth:codex-url', handler)
  },
  onCodexLoginSaving: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('auth:codex-saving', handler)
    return () => ipcRenderer.off('auth:codex-saving', handler)
  },
  getXaiAccounts: () => ipcRenderer.invoke('auth:get-xai-accounts'),
  switchXaiAccount: (accountId: string) =>
    ipcRenderer.invoke('auth:switch-xai-account', accountId),
  removeXaiAccount: (accountId: string) =>
    ipcRenderer.invoke('auth:remove-xai-account', accountId),
  startXaiLogin: (input?: unknown) =>
    ipcRenderer.invoke('auth:start-xai-login', input),
  cancelXaiLogin: () => ipcRenderer.invoke('auth:cancel-xai-login'),
  onXaiAuth: (callback: (info: XaiAuthInfo) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, info: XaiAuthInfo) =>
      callback(info)
    ipcRenderer.on('auth:xai-code', handler)
    return () => ipcRenderer.off('auth:xai-code', handler)
  },
  onXaiLoginSaving: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('auth:xai-saving', handler)
    return () => ipcRenderer.off('auth:xai-saving', handler)
  },
  logout: () => ipcRenderer.invoke('auth:logout'),

  startServer: (port: number, authMode?: string, host?: string) =>
    ipcRenderer.invoke('server:start', port, authMode, host),
  stopServer: () => ipcRenderer.invoke('server:stop'),
  getServerStatus: () => ipcRenderer.invoke('server:get-status'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  getBunRuntime: () => ipcRenderer.invoke('settings:get-bun-runtime'),
  getAppUpdateStatus: () => ipcRenderer.invoke('update:get-status'),
  checkAppUpdate: () => ipcRenderer.invoke('update:check'),
  installAppUpdate: () => ipcRenderer.invoke('update:install'),
  openAppUpdatePackage: (showInFolder = false) =>
    ipcRenderer.invoke('update:open-package', showInFolder),
  onAppUpdateStatus: (callback: (status: AppUpdateStatus) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      status: AppUpdateStatus,
    ) => callback(status)
    ipcRenderer.on('update:status', handler)
    return () => ipcRenderer.off('update:status', handler)
  },
  saveSettings: (settings: unknown) =>
    ipcRenderer.invoke('settings:save', settings),
  getModelMappingsConfig: () => ipcRenderer.invoke('config:get-model-mappings'),
  getAppConfig: () => ipcRenderer.invoke('config:get-document'),
  saveAppConfig: (input: unknown) =>
    ipcRenderer.invoke('config:save-document', input),
  applyAppConfig: (revision: string) =>
    ipcRenderer.invoke('config:apply-document', revision),
  getProviderManagementConfig: () =>
    ipcRenderer.invoke('config:get-provider-management'),
  getProviderModelOptions: () =>
    ipcRenderer.invoke('config:get-provider-model-options'),
  saveProviderManagementConfig: (input: unknown) =>
    ipcRenderer.invoke('config:save-provider-management', input),
  saveModelMappings: (modelMappings: Record<string, string>) =>
    ipcRenderer.invoke('config:save-model-mappings', modelMappings),

  openUrl: (url: string) => ipcRenderer.invoke('shell:open-url', url),

  fetchUsage: () => ipcRenderer.invoke('server:fetch-usage'),
  fetchSubscriptionUsage: (
    provider: 'github-copilot' | 'codex' | 'xai' | 'opencode-go',
  ) => ipcRenderer.invoke('server:fetch-subscription-usage', provider),
  fetchModels: () => ipcRenderer.invoke('server:fetch-models'),
  createImages: (id: string, input: ImageCreationInput) =>
    ipcRenderer.invoke('media:create-images', id, input),
  createVideo: (id: string, input: VideoCreationInput) =>
    ipcRenderer.invoke('media:create-video', id, input),
  getVideo: (id: string, requestId: string) =>
    ipcRenderer.invoke('media:get-video', id, requestId),
  cancelMediaRequest: (id: string) => ipcRenderer.invoke('media:cancel', id),
  saveMedia: (input: SaveMediaInput) => ipcRenderer.invoke('media:save', input),
  fetchTokenUsage: (period: string) =>
    ipcRenderer.invoke('server:fetch-token-usage', period),
  fetchTokenUsageDaily: (period: string) =>
    ipcRenderer.invoke('server:fetch-token-usage-daily', period),
  fetchTokenUsageEvents: (period: string, page: number, pageSize: number) =>
    ipcRenderer.invoke(
      'server:fetch-token-usage-events',
      period,
      page,
      pageSize,
    ),
  fetchTokenUsageSessions: (period: string, page: number, pageSize: number) =>
    ipcRenderer.invoke(
      'server:fetch-token-usage-sessions',
      period,
      page,
      pageSize,
    ),
  getServerAuthInfo: () => ipcRenderer.invoke('server:get-auth-info'),
  getServerKeys: () => ipcRenderer.invoke('auth:get-server-keys'),
  saveServerKeys: (keys: unknown) =>
    ipcRenderer.invoke('auth:save-server-keys', keys),
  getLogs: () => ipcRenderer.invoke('server:get-logs'),

  onAuthSuccess: (callback: (result: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, result: unknown) =>
      callback(result)
    ipcRenderer.on('auth:success', handler)
    return () => ipcRenderer.off('auth:success', handler)
  },

  onServerStatus: (callback: (status: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: unknown) =>
      callback(status)
    ipcRenderer.on('server:status', handler)
    return () => ipcRenderer.off('server:status', handler)
  },

  onServerLog: (callback: (log: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, log: string) =>
      callback(log)
    ipcRenderer.on('server:log', handler)
    return () => ipcRenderer.off('server:log', handler)
  },

  platform: process.platform,
  windowReload: () => ipcRenderer.send('window:reload'),
  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowMaximizeToggle: () => ipcRenderer.send('window:maximize-toggle'),
  windowClose: () => ipcRenderer.send('window:close'),
  windowQuit: () => ipcRenderer.send('window:quit'),
  windowZoomIn: () => ipcRenderer.send('window:zoom-in'),
  windowZoomOut: () => ipcRenderer.send('window:zoom-out'),
  windowZoomReset: () => ipcRenderer.send('window:zoom-reset'),
  windowIsMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  onWindowMaximizeChange: (callback: (maximized: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, maximized: boolean) =>
      callback(maximized)
    ipcRenderer.on('window:maximize-changed', handler)
    return () => ipcRenderer.off('window:maximize-changed', handler)
  },
})
