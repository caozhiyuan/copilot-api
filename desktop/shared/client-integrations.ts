export type ClientId = 'claude' | 'opencode' | 'codex' | 'harness'
export type ClientAgent = ClientId
export type ClientPlugin = 'agent-inject' | 'tool-search'
export const CODEX_SANDBOX_MODES = [
  'danger-full-access',
  'workspace-write',
  'read-only',
] as const
export const CODEX_APPROVAL_REVIEWERS = ['auto_review', 'user'] as const
export const CODEX_WEB_SEARCH_MODES = [
  'live',
  'indexed',
  'cached',
  'disabled',
] as const
export const CODEX_REASONING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const
export interface CodexClientSettings {
  sandboxMode: string
  approvalsReviewer: string
  webSearch: string
  reasoningEffort: string
  daemonAutoStart: boolean
  defaultModeRequestUserInput: boolean
  preventIdleSleep: boolean
}
export interface CodexClientOptions extends CodexClientSettings {
  sandboxMode: (typeof CODEX_SANDBOX_MODES)[number]
  approvalsReviewer: (typeof CODEX_APPROVAL_REVIEWERS)[number]
  webSearch: (typeof CODEX_WEB_SEARCH_MODES)[number]
}
export const CODEX_CLIENT_DEFAULTS = {
  sandboxMode: 'danger-full-access',
  approvalsReviewer: 'auto_review',
  webSearch: 'live',
  reasoningEffort: 'max',
  daemonAutoStart: false,
  defaultModeRequestUserInput: true,
  preventIdleSleep: true,
} satisfies CodexClientOptions

export const CLIENT_ERROR_CODES = [
  'invalidConfig',
  'symlinkConfig',
  'invalidInput',
  'conflict',
  'invalidKey',
  'noBackup',
  'commandMissing',
  'commandFailed',
  'environmentFailed',
  'modelsFailed',
  'operationFailed',
] as const
export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number]

export interface ClientSetupInput {
  client: ClientId
  revision: string
  apiKey: string
  profile?: string
  model: string
  fableModel: string
  opusModel: string
  sonnetModel: string
  smallModel: string
  reviewModel: string
  nativeToolSearch: boolean
  agentContext: boolean
  plugins: ClientPlugin[]
  codex?: Partial<CodexClientOptions>
}

export interface ClientIntegrationStatus {
  client: ClientId
  configPath: string
  revision: string
  state: 'unconfigured' | 'configured' | 'outdated' | 'error'
  canRestore: boolean
  model: string
  fableModel: string
  opusModel: string
  sonnetModel: string
  smallModel: string
  reviewModel: string
  nativeToolSearch: boolean
  agentContext: boolean
  plugins: ClientPlugin[]
  codex?: CodexClientSettings
  error?: string
}

export interface ClientIntegrationsState {
  baseUrl: string
  apiKeys: string[]
  clients: ClientIntegrationStatus[]
  harnessProfiles: string[]
}

export interface ClientModelOption {
  id: string
  name: string
  reasoningEfforts?: string[]
}

export interface ClientSetupResult {
  status: ClientIntegrationStatus
  pluginError?: string
  pluginFailure?: ClientCommandFailure
}

export interface ClientRestoreResult extends ClientIntegrationStatus {
  pluginError?: string
  pluginFailure?: ClientCommandFailure
}

export interface ClientCommandFailure {
  command: string
  exitCode?: string
}
