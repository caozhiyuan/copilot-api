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
  minimizeToTray: boolean
  accountType: 'individual' | 'business' | 'enterprise'
  verbose: boolean
  showToken: boolean
}

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
      fetchUsage: () => Promise<unknown>
      fetchModels: () => Promise<unknown>
      getLogs: () => Promise<string[]>
      onAuthSuccess: (callback: (result: AuthResult) => void) => () => void
      onServerStatus: (callback: (status: ServerStatus) => void) => () => void
      onServerLog: (callback: (log: string) => void) => () => void
    }
  }
}
