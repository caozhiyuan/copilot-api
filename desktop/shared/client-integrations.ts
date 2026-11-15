export type ClientId = 'claude' | 'opencode' | 'codex' | 'harness'
export type ClientAgent = ClientId
export type ClientPlugin = 'agent-inject' | 'tool-search'
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
}

export interface ClientSetupResult {
  status: ClientIntegrationStatus
  pluginError?: string
  pluginFailure?: ClientCommandFailure
}

export interface ClientCommandFailure {
  command: string
  exitCode?: string
}
