import type { LangPreference } from '../locales'

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

export interface ServerAuthInfo {
  enabled: boolean
  headerName?: string
  headerValue?: string
}

export interface DesktopSettings {
  apiHome: string
  oauthApp: 'default' | 'opencode'
  enterpriseUrl: string
  lastPort: number
  minimizeToTray: boolean
  accountType: 'individual' | 'business' | 'enterprise'
  verbose: boolean
  showToken: boolean
  language: LangPreference
}

// Extend the global window type for the renderer process.
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
      getServerAuthInfo: () => Promise<ServerAuthInfo>
      getLogs: () => Promise<string[]>
      onAuthSuccess: (callback: (result: AuthResult) => void) => () => void
      onServerStatus: (callback: (status: ServerStatus) => void) => () => void
      onServerLog: (callback: (log: string) => void) => () => void
    }
  }
}
