import type { GatewayApiKeyConfig } from "./api-key"
import type { TokenUsagePricingConfig } from "./pricing"

export type ModelReasoningField = "reasoning" | "reasoning_content"

export type CodexReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra"

export type ProviderAuthType =
  | "authorization"
  | "azure-entra"
  | "oauth2"
  | "x-api-key"
  | "x-goog-api-key"

export type ProviderType =
  | "anthropic"
  | "openai-compatible"
  | "openai-responses"
  | "google"

export type ToolContentSupportType = "array" | "image" | "pdf"

export interface SmallModelsConfig {
  codex?: string
  copilot?: string
  [providerName: string]: string | undefined
}

export interface ContextManagementConfig {
  messages?: boolean
  responses?: boolean
}

export interface UpstreamTransportConfig {
  headersTimeoutMs?: number
  streamInactivityTimeoutMs?: number
  websocketMaxBufferedBytes?: number
  websocketMaxBufferedMessages?: number
  websocketOpenTimeoutMs?: number
  websocketPoolIdleTimeoutMs?: number
}

export interface ModelConfig {
  temperature?: number
  topP?: number
  topK?: number
  extraBody?: Record<string, unknown>
  contextCache?: boolean
  contextWindow?: number
  maxOutputTokens?: number
  inputModalities?: Array<"text" | "image">
  reasoningEfforts?: Array<CodexReasoningEffort>
  defaultReasoningEffort?: CodexReasoningEffort
  pricing?: TokenUsagePricingConfig
  supportPdf?: boolean
  toolContentSupportType?: Array<ToolContentSupportType>
  type?: ProviderType
  // Message field used to carry assistant thinking text when forwarding
  // requests upstream; defaults to "reasoning_content"
  reasoningField?: ModelReasoningField
}

export interface ProviderConfig {
  type?: string
  enabled?: boolean
  baseUrl?: string
  modelsDevProviderId?: string
  apiKey?: string
  authType?: ProviderAuthType
  accountId?: string
  pricingCurrency?: string
  models?: Record<string, ModelConfig>
  agentsModels?: Array<string>
}

export interface ResolvedProviderConfig {
  name: string
  type: ProviderType
  baseUrl: string
  modelsDevProviderId?: string
  apiKey: string
  authType: ProviderAuthType
  authTypeExplicit?: boolean
  pricingCurrency?: string
  models?: Record<string, ModelConfig>
  agentsModels?: Array<string>
}

export type BuiltinProviderInputModality = "text" | "image"

export interface BuiltinProviderModelConfig {
  contextWindow?: number
  defaultReasoningEffort?: CodexReasoningEffort
  inputModalities?: Array<BuiltinProviderInputModality>
  maxOutputTokens?: number
  pricing?: TokenUsagePricingConfig
  reasoningEfforts?: Array<CodexReasoningEffort>
  supportPdf?: boolean
  // Message field carrying assistant thinking text in upstream requests,
  // for models that do not follow the default "reasoning_content"
  // convention (e.g. opencode-go hy3/hy4 use the OpenRouter-style
  // "reasoning" field)
  reasoningField?: ModelReasoningField
}

export interface AppConfig {
  auth?: {
    /** Legacy migration source; ignored after apiKeyConfigs is present. */
    apiKeys?: Array<string>
    apiKeyConfigs?: Array<GatewayApiKeyConfig>
    isolateApiKeyUsage?: boolean
    adminApiKey?: string
  }
  providers?: Record<string, ProviderConfig>
  modelMappings?: Record<string, string>
  extraPrompts?: Record<string, string>
  smallModels?: SmallModelsConfig
  contextManagement?: ContextManagementConfig
  opencodeModelContextWindow?: number
  modelResponsesApiCompactThresholds?: Record<string, number>
  modelReasoningEfforts?: Record<
    string,
    "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
  >
  useMessagesApi?: boolean
  useResponsesApiWebSocket?: boolean
  codexMultiAgentV1?: boolean
  // Copilot model IDs that must not request output.encrypted_content.
  noEncryptedOutputModels?: Array<string>
  upstreamTransport?: UpstreamTransportConfig
  anthropicApiKey?: string
  useResponsesApiWebSearch?: boolean
  alphaSearchCodexPriority?: boolean
  alphaSearchModel?: string
  // Copilot rejects Anthropic's web_search server tool on /v1/messages, so a
  // Claude request that only asks for web search is switched to this model.
  // A `provider/model` alias is passed straight through to that provider's
  // (websearch-capable) message API, while a plain GPT model runs the search
  // via /responses. Leave unset to disable (the tool is then stripped).
  // Mixing web_search with other tools is not supported.
  messageApiWebSearchModel?: string
  // Model used for Claude Code background security-monitor requests on
  // /v1/messages and provider message APIs: requests without tools, with
  // `stop_sequences: ["</block>"]` and a system block starting with
  // "You are a security monitor for autonomous AI coding agents.".
  // A `provider/model` alias is forwarded to that provider's message API on
  // the top-level route. Provider message routes use the configured value on
  // their current provider. Defaults to codex-auto-review when Codex is
  // enabled, otherwise gpt-6-luna when GitHub Copilot is enabled and both its
  // GitHub and Copilot tokens are loaded. An explicit empty value disables
  // the override.
  claudeAutoModel?: string
  claudeTokenMultiplier?: number
  // Days of token_usage_events to keep. Unset means keep every row.
  tokenUsageRetentionDays?: number
}
