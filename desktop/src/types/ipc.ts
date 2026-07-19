import type { LangPreference } from '../locales'

export interface DeviceCodeInfo {
  user_code: string
  verification_uri: string
  device_code: string
  interval: number
  expires_in: number
}

export type DesktopAuthMode = 'copilot' | 'provider' | 'none'

export interface AuthResult {
  success: boolean
  mode?: DesktopAuthMode
  providers?: string[]
  error?: string
}

export interface AuthStatus extends AuthResult {
  mode: DesktopAuthMode
}

export type ProviderType =
  'anthropic' | 'openai-compatible' | 'openai-responses'
export type ProviderAuthType = 'authorization' | 'x-api-key'
export type ProviderAuthTypeInput = ProviderAuthType | '__default__'
export type QuickProviderName =
  'opencode-go' | 'deepseek' | 'dashscope' | 'openrouter'

export type ProviderAuthInput =
  | {
      apiKey: string
      baseUrl?: string
      provider: QuickProviderName
      type?: ProviderType
    }
  | {
      apiKey: string
      authType?: ProviderAuthTypeInput
      baseUrl: string
      name: string
      provider: 'custom'
      type: ProviderType
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

export interface ModelMappingsConfig {
  configPath: string
  modelMappings: Record<string, string>
}

export type TokenUsagePeriod = 'day' | 'week' | 'month'

export interface TokenUsageCost {
  amount: number
  currency: string
  total_cost_nanos: number
}

export interface TokenUsageEventCost extends TokenUsageCost {
  source: string
}

export interface TokenUsageTotals {
  request_count: number
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  costs: TokenUsageCost[]
  total_tokens: number
}

export interface TokenUsageModelSummary extends TokenUsageTotals {
  model: string
}

export interface TokenUsageSummary {
  period: TokenUsagePeriod
  range: {
    start_ms: number
    end_ms: number
    start_utc: string
    end_utc: string
  }
  totals: TokenUsageTotals
  byModel: TokenUsageModelSummary[]
}

export interface TokenUsageDailyBucket {
  date: string
  start_ms: number
  end_ms: number
  totals: TokenUsageTotals
  byModel: TokenUsageModelSummary[]
}

export interface TokenUsageDailySummary {
  period: TokenUsagePeriod
  range: {
    start_ms: number
    end_ms: number
    start_utc: string
    end_utc: string
  }
  totals: TokenUsageTotals
  byModel: TokenUsageModelSummary[]
  days: TokenUsageDailyBucket[]
}

export interface TokenUsageEventRecord {
  id: number
  created_at_ms: number
  created_at_utc: string
  trace_id: string
  session_id: string
  user_id: string
  source: 'copilot' | 'provider'
  endpoint: string
  provider_name: string | null
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  cost: TokenUsageEventCost | null
  total_tokens: number
}

export interface TokenUsageEventsPage {
  items: TokenUsageEventRecord[]
  page: number
  page_size: number
  period: TokenUsagePeriod
  range: {
    start_ms: number
    end_ms: number
    start_utc: string
    end_utc: string
  }
  total: number
  total_pages: number
}

export type ThemePreference = 'light' | 'dark' | 'auto'

export type DesktopProxyMode = 'system' | 'custom' | 'direct'

export interface DesktopProxySettings {
  mode: DesktopProxyMode
  http_proxy: string
  https_proxy: string
  no_proxy: string
}

export interface DesktopSettings {
  apiHome: string
  oauthApp: 'default' | 'opencode'
  enterpriseUrl: string
  lastPort: number
  launchAtLogin: boolean
  minimizeToTray: boolean
  accountType: 'individual' | 'business' | 'enterprise'
  verbose: boolean
  showToken: boolean
  language: LangPreference
  theme: ThemePreference
  proxy: DesktopProxySettings
}

// Extend the global window type for the renderer process.
declare global {
  interface Window {
    electronAPI: {
      getAuthStatus: () => Promise<AuthStatus>
      getDeviceCode: () => Promise<DeviceCodeInfo>
      saveToken: (token: string) => Promise<AuthResult>
      checkSavedToken: () => Promise<AuthResult>
      configureProvider: (input: ProviderAuthInput) => Promise<AuthResult>
      startCodexLogin: (callbackUrlOrCode?: string) => Promise<AuthResult>
      logout: () => Promise<void>
      startServer: (
        port: number,
        authMode?: DesktopAuthMode,
      ) => Promise<ServerStatus>
      stopServer: () => Promise<void>
      getServerStatus: () => Promise<ServerStatus>
      getSettings: () => Promise<DesktopSettings>
      saveSettings: (settings: DesktopSettings) => Promise<void>
      getModelMappingsConfig: () => Promise<ModelMappingsConfig>
      saveModelMappings: (
        modelMappings: Record<string, string>,
      ) => Promise<void>
      openUrl: (url: string) => Promise<void>
      fetchUsage: () => Promise<unknown>
      fetchModels: () => Promise<unknown>
      fetchTokenUsage: (period: TokenUsagePeriod) => Promise<unknown>
      fetchTokenUsageDaily: (period: TokenUsagePeriod) => Promise<unknown>
      fetchTokenUsageEvents: (
        period: TokenUsagePeriod,
        page: number,
        pageSize: number,
      ) => Promise<unknown>
      getServerAuthInfo: () => Promise<ServerAuthInfo>
      getLogs: () => Promise<string[]>
      onAuthSuccess: (callback: (result: AuthResult) => void) => () => void
      onServerStatus: (callback: (status: ServerStatus) => void) => () => void
      onServerLog: (callback: (log: string) => void) => () => void
      platform: NodeJS.Platform
      windowReload: () => void
      windowMinimize: () => void
      windowMaximizeToggle: () => void
      windowClose: () => void
      windowQuit: () => void
      windowZoomIn: () => void
      windowZoomOut: () => void
      windowZoomReset: () => void
      windowIsMaximized: () => Promise<boolean>
      onWindowMaximizeChange: (
        callback: (maximized: boolean) => void,
      ) => () => void
    }
  }
}
