import type { LangPreference } from '../locales'
import type {
  SubscriptionProvider,
  SubscriptionUsage,
} from '../../../src/lib/types/subscription-usage'
export type { SubscriptionProvider, SubscriptionUsage }
import type {
  CreatedImage,
  ImageCreationInput,
  SaveMediaInput,
  VideoCreationInput,
  VideoCreationResult,
} from './media'
import type { ConfigEditorReply } from '../lib/config-editor-errors'
import type {
  XaiAuthInfo,
  OAuthAccountSummary,
} from '../../../src/lib/types/oauth'
export type { XaiAuthInfo }
import type {
  ProviderManagementConfig,
  ProviderManagementUpdate,
  ProviderModelOptions,
} from '../../../src/lib/types/provider-management'

export type {
  ProviderManagementConfig,
  ProviderManagementUpdate,
  ProviderModelOptions,
}

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
  cancelled?: boolean
}

export interface AuthStatus extends AuthResult {
  mode: DesktopAuthMode
}

export type CodexAccountSummary = OAuthAccountSummary

export interface CodexLoginInput {
  alias?: string
  callbackUrlOrCode?: string
}

export interface XaiLoginInput {
  alias?: string
}

export type ProviderType =
  'anthropic' | 'openai-compatible' | 'openai-responses' | 'google'
export type ProviderAuthType = 'authorization' | 'x-api-key' | 'x-goog-api-key'
export type ProviderAuthTypeInput = ProviderAuthType | '__default__'
export interface ModelsDevProviderOption {
  id: string
  name: string
  api: string
  type: ProviderType
}
export type QuickProviderName =
  'opencode-go' | 'kimi' | 'deepseek' | 'dashscope' | 'openrouter'

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
      modelsDevProviderId?: string
    }

export interface ServerStatus {
  running: boolean
  restarting?: boolean
  intentional?: boolean
  port?: number
  host?: string
  error?: string
}

export interface ServerAuthInfo {
  enabled: boolean
  headerName?: string
  headerValue?: string
}

export interface ServerKeysConfig {
  apiKeys: string[]
  adminApiKey: string
}

export interface ServerKeysConfigUpdate {
  apiKeys?: string[]
  // undefined = leave the field untouched, '' or null = remove the admin key
  adminApiKey?: string | null
}

export interface ModelMappingsConfig {
  configPath: string
  modelMappings: Record<string, string>
}

export interface AppConfigDocument {
  configPath: string
  content: string
  revision: string
  defaultContent: string
}

export interface AppConfigUpdate {
  content: string
  revision: string
}

export interface AppConfigSaveResult extends AppConfigDocument {
  saved: true
  applied: boolean
  refreshError?: string
}

export type TokenUsagePeriod =
  | 'today'
  | 'this_week'
  | 'last_7_days'
  | 'this_month'
  | 'last_30_days'
  | 'lifetime'

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
  average_first_token_ms: number | null
  output_tokens_per_second: number | null
  model: string
}

export interface TokenUsageSessionSummary extends TokenUsageTotals {
  session_id: string
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
  request_id: string | null
  first_token_ms: number | null
  duration_ms: number | null
  request_outcome: 'completed' | 'cancelled' | 'error' | null
  output_tokens_per_second: number | null
  id: number
  created_at_ms: number
  created_at_utc: string
  trace_id: string
  user_agent: string
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

export interface TokenUsageSessionsPage {
  items: TokenUsageSessionSummary[]
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

export interface AppUpdateStatus {
  phase:
    | 'idle'
    | 'checking'
    | 'not-available'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'installing'
    | 'error'
    | 'disabled'
  currentVersion: string
  manualInstall: boolean
  packageReady?: boolean
  releaseUrl: string
  version?: string
  percent?: number
  error?: string
}

export type DesktopProxyMode = 'system' | 'custom' | 'direct'

export type ServerRuntime = 'bun' | 'node'

export interface BunRuntimeStatus {
  available: boolean
  version?: string
  path?: string
}

export interface DesktopProxySettings {
  mode: DesktopProxyMode
  http_proxy: string
  https_proxy: string
  no_proxy: string
}

export interface DesktopSettings {
  serverRuntime: ServerRuntime
  apiHome: string
  sqliteDbPath: string
  oauthApp: 'default' | 'opencode'
  enterpriseUrl: string
  host: string
  lastPort: number
  launchAtLogin: boolean
  autoStartServer: boolean
  minimizeToTray: boolean
  accountType: 'individual' | 'business' | 'enterprise'
  verbose: boolean
  showToken: boolean
  showCreate: boolean
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
      getModelsDevProviders: () => Promise<Array<ModelsDevProviderOption>>
      getCodexAccounts: () => Promise<Array<CodexAccountSummary>>
      switchCodexAccount: (accountId: string) => Promise<AuthResult>
      removeCodexAccount: (accountId: string) => Promise<AuthResult>
      startCodexLogin: (input?: CodexLoginInput) => Promise<AuthResult>
      cancelCodexLogin: () => Promise<boolean>
      onCodexAuthUrl: (callback: (url: string) => void) => () => void
      onCodexLoginSaving: (callback: () => void) => () => void
      getXaiAccounts: () => Promise<Array<CodexAccountSummary>>
      switchXaiAccount: (accountId: string) => Promise<AuthResult>
      removeXaiAccount: (accountId: string) => Promise<AuthResult>
      startXaiLogin: (input?: XaiLoginInput) => Promise<AuthResult>
      cancelXaiLogin: () => Promise<boolean>
      onXaiAuth: (callback: (info: XaiAuthInfo) => void) => () => void
      onXaiLoginSaving: (callback: () => void) => () => void
      logout: () => Promise<void>
      startServer: (
        port: number,
        authMode?: DesktopAuthMode,
        host?: string,
      ) => Promise<ServerStatus>
      stopServer: () => Promise<void>
      getServerStatus: () => Promise<ServerStatus>
      getSettings: () => Promise<DesktopSettings>
      getBunRuntime: () => Promise<BunRuntimeStatus>
      getAppUpdateStatus: () => Promise<AppUpdateStatus>
      checkAppUpdate: () => Promise<AppUpdateStatus>
      installAppUpdate: () => Promise<AppUpdateStatus>
      openAppUpdatePackage: (showInFolder?: boolean) => Promise<void>
      onAppUpdateStatus: (
        callback: (status: AppUpdateStatus) => void,
      ) => () => void
      saveSettings: (settings: DesktopSettings) => Promise<void>
      getModelMappingsConfig: () => Promise<ModelMappingsConfig>
      getAppConfig: () => Promise<ConfigEditorReply<AppConfigDocument>>
      saveAppConfig: (
        input: AppConfigUpdate,
      ) => Promise<ConfigEditorReply<AppConfigSaveResult>>
      applyAppConfig: (
        revision: string,
      ) => Promise<ConfigEditorReply<AppConfigSaveResult>>
      getProviderManagementConfig: () => Promise<ProviderManagementConfig>
      saveProviderManagementConfig: (
        input: ProviderManagementUpdate,
      ) => Promise<ProviderManagementConfig>
      saveModelMappings: (
        modelMappings: Record<string, string>,
      ) => Promise<void>
      openUrl: (url: string) => Promise<void>
      fetchUsage: () => Promise<unknown>
      fetchSubscriptionUsage: (
        provider: SubscriptionProvider,
      ) => Promise<SubscriptionUsage | null>
      fetchModels: () => Promise<unknown>
      createImages: (
        id: string,
        input: ImageCreationInput,
      ) => Promise<CreatedImage[]>
      createVideo: (
        id: string,
        input: VideoCreationInput,
      ) => Promise<VideoCreationResult>
      getVideo: (id: string, requestId: string) => Promise<VideoCreationResult>
      cancelMediaRequest: (id: string) => Promise<void>
      saveMedia: (input: SaveMediaInput) => Promise<boolean>
      getProviderModelOptions: () => Promise<ProviderModelOptions>
      fetchTokenUsage: (period: TokenUsagePeriod) => Promise<unknown>
      fetchTokenUsageDaily: (period: TokenUsagePeriod) => Promise<unknown>
      fetchTokenUsageEvents: (
        period: TokenUsagePeriod,
        page: number,
        pageSize: number,
      ) => Promise<unknown>
      fetchTokenUsageSessions: (
        period: TokenUsagePeriod,
        page: number,
        pageSize: number,
      ) => Promise<unknown>
      getServerAuthInfo: () => Promise<ServerAuthInfo>
      getServerKeys: () => Promise<ServerKeysConfig>
      saveServerKeys: (
        keys: ServerKeysConfigUpdate,
      ) => Promise<ServerKeysConfig>
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
