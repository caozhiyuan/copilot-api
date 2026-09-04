import consola from "consola"
import { randomBytes } from "node:crypto"
import fs from "node:fs"

import type { TokenUsagePricingConfig } from "~/lib/token-usage/pricing"

import { writeFileAtomically } from "./atomic-file"
import { PATHS } from "./paths"

export interface AppConfig {
  auth?: {
    apiKeys?: Array<string>
    adminApiKey?: string
  }
  providers?: Record<string, ProviderConfig>
  modelMappings?: Record<string, string>
  extraPrompts?: Record<string, string>
  smallModel?: string
  contextManagement?: ContextManagementConfig
  modelResponsesApiCompactThresholds?: Record<string, number>
  modelReasoningEfforts?: Record<
    string,
    "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
  >
  useMessagesApi?: boolean
  useResponsesApiWebSocket?: boolean
  responsesTransport?: ResponsesTransportConfig
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
  // their current provider. Leave empty to disable (default).
  claudeAutoModel?: string
  claudeTokenMultiplier?: number
}

export interface ContextManagementConfig {
  messages?: boolean
  responses?: boolean
}

export interface ResponsesTransportConfig {
  headersTimeoutMsV2?: number
  streamInactivityTimeoutMs?: number
  websocketMaxBufferedBytes?: number
  websocketMaxBufferedMessages?: number
  websocketOpenTimeoutMs?: number
  websocketPoolIdleTimeoutMs?: number
}

export const defaultResponsesTransportConfig = {
  headersTimeoutMsV2: 5 * 60 * 1000,
  streamInactivityTimeoutMs: 5 * 60 * 1000,
  websocketMaxBufferedBytes: 8 * 1024 * 1024,
  websocketMaxBufferedMessages: 1024,
  websocketOpenTimeoutMs: 30_000,
  websocketPoolIdleTimeoutMs: 60_000,
} satisfies Required<ResponsesTransportConfig>

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
export const SUPPORTED_PROVIDER_TYPES = [
  "anthropic",
  "openai-compatible",
  "openai-responses",
] as const
export type ProviderType = (typeof SUPPORTED_PROVIDER_TYPES)[number]
export type ToolContentSupportType = "array" | "image" | "pdf"

export interface ProviderConfig {
  type?: string
  enabled?: boolean
  baseUrl?: string
  apiKey?: string
  authType?: ProviderAuthType
  pricingCurrency?: string
  models?: Record<string, ModelConfig>
}

const gpt5ExplorationPrompt = `## Exploration and reading files
- **Think first.** Before any tool call, decide ALL files/resources you will need.
- **Batch everything.** If you need multiple files (even from different places), read them together.
- **multi_tool_use.parallel** Use multi_tool_use.parallel to parallelize tool calls and only this.
- **Only make sequential calls if you truly cannot know the next file without seeing a result first.**
- **Workflow:** (a) plan all needed reads → (b) issue one parallel batch → (c) analyze results → (d) repeat if new, unpredictable reads arise.`

const modelResponsesApiCompactThresholds = {
  "gpt-5.4": 272_000 * 0.8,
  "gpt-5.5": 272_000 * 0.8,
}

export const defaultContextManagement = {
  messages: true,
  responses: false,
} satisfies Required<ContextManagementConfig>

export const defaultConfig: AppConfig = {
  auth: {
    apiKeys: [],
  },
  providers: {},
  modelMappings: {},
  extraPrompts: {
    "gpt-5-mini": gpt5ExplorationPrompt,
  },
  smallModel: "gpt-5-mini",
  contextManagement: defaultContextManagement,
  modelResponsesApiCompactThresholds,
  modelReasoningEfforts: {
    "gpt-5-mini": "low",
  },
  useMessagesApi: true,
  useResponsesApiWebSocket: true,
  responsesTransport: defaultResponsesTransportConfig,
  useResponsesApiWebSearch: true,
  alphaSearchCodexPriority: true,
  alphaSearchModel: "gpt-5-mini",
  messageApiWebSearchModel: "gpt-5-mini",
}

let cachedConfig: AppConfig | null = null

function normalizeAdminApiKey(adminApiKey: unknown): string | null {
  if (typeof adminApiKey !== "string") {
    if (adminApiKey !== undefined) {
      consola.warn(
        "Invalid auth.adminApiKey config. Expected a non-empty string.",
      )
    }
    return null
  }

  const normalizedAdminApiKey = adminApiKey.trim()
  if (!normalizedAdminApiKey) {
    consola.warn(
      "Invalid auth.adminApiKey config. Expected a non-empty string.",
    )
    return null
  }

  return normalizedAdminApiKey
}

function generateAdminApiKey(): string {
  return randomBytes(32).toString("hex")
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

function ensureConfigFile(): void {
  try {
    fs.accessSync(PATHS.CONFIG_PATH, fs.constants.R_OK | fs.constants.W_OK)
  } catch {
    writeFileAtomically(
      PATHS.CONFIG_PATH,
      `${JSON.stringify(defaultConfig, null, 2)}\n`,
    )
    try {
      fs.chmodSync(PATHS.CONFIG_PATH, 0o600)
    } catch {
      return
    }
  }
}

function readConfigFromDisk(): AppConfig {
  ensureConfigFile()
  const raw = fs.readFileSync(PATHS.CONFIG_PATH, "utf8")
  if (!raw.trim()) {
    writeFileAtomically(
      PATHS.CONFIG_PATH,
      `${JSON.stringify(defaultConfig, null, 2)}\n`,
    )
    return defaultConfig
  }

  try {
    return JSON.parse(raw) as AppConfig
  } catch (error) {
    // Fail closed: falling back to the default config here would let the
    // startup merge overwrite the corrupt file (discarding providers, API
    // keys, and model mappings) and, because the default has no apiKeys,
    // silently disable API key authentication on normal routes.
    const message = `Config file is not valid JSON: ${PATHS.CONFIG_PATH}. Refusing to start with the default config. Fix the JSON syntax or delete the file to regenerate a fresh config.`
    consola.error(message, error)
    throw new Error(message, { cause: error })
  }
}

export function readEditableConfigFromDisk(): AppConfig {
  try {
    const raw = fs.readFileSync(PATHS.CONFIG_PATH, "utf8")
    if (!raw.trim()) {
      return {}
    }
    return JSON.parse(raw) as AppConfig
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {}
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Config file is not valid JSON: ${PATHS.CONFIG_PATH}`)
    }
    throw error
  }
}

export function writeConfigToDisk(config: AppConfig): void {
  writeFileAtomically(PATHS.CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`)
}

export function setConfiguredApiKeys(apiKeys: Array<string>): Array<string> {
  const normalizedKeys = apiKeys
    .map((key) => key.trim())
    .filter((key) => key.length > 0)
  const uniqueKeys = [...new Set(normalizedKeys)]

  const editableConfig = readEditableConfigFromDisk()
  writeConfigToDisk({
    ...editableConfig,
    auth: {
      ...editableConfig.auth,
      apiKeys: uniqueKeys,
    },
  })
  reloadConfig()
  return [...uniqueKeys]
}

function mergeDefaultConfig(config: AppConfig): {
  mergedConfig: AppConfig
  changed: boolean
} {
  const extraPrompts = config.extraPrompts ?? {}
  const defaultExtraPrompts = defaultConfig.extraPrompts ?? {}
  const responsesApiCompactThresholds =
    config.modelResponsesApiCompactThresholds ?? {}
  const defaultResponsesApiCompactThresholds =
    defaultConfig.modelResponsesApiCompactThresholds ?? {}
  const modelReasoningEfforts = config.modelReasoningEfforts ?? {}
  const defaultModelReasoningEfforts = defaultConfig.modelReasoningEfforts ?? {}
  const contextManagement = normalizeContextManagementConfig(
    config.contextManagement,
  )
  const responsesTransport = normalizeResponsesTransportConfig(
    config.responsesTransport,
  )
  const defaultContextManagementConfig = defaultConfig.contextManagement ?? {}

  const missingExtraPromptModels = Object.keys(defaultExtraPrompts).filter(
    (model) => !Object.hasOwn(extraPrompts, model),
  )

  const missingReasoningEffortModels = Object.keys(
    defaultModelReasoningEfforts,
  ).filter((model) => !Object.hasOwn(modelReasoningEfforts, model))
  const missingResponsesApiCompactThresholdModels = Object.keys(
    defaultResponsesApiCompactThresholds,
  ).filter((model) => !Object.hasOwn(responsesApiCompactThresholds, model))
  const missingContextManagementKeys = Object.keys(
    defaultContextManagementConfig,
  ).filter((key) => !Object.hasOwn(contextManagement, key))

  const hasExtraPromptChanges = missingExtraPromptModels.length > 0
  const hasReasoningEffortChanges = missingReasoningEffortModels.length > 0
  const hasResponsesApiCompactThresholdChanges =
    missingResponsesApiCompactThresholdModels.length > 0
  const hasContextManagementChanges = missingContextManagementKeys.length > 0
  const hasResponsesTransportChanges = Object.entries(responsesTransport).some(
    ([key, value]) =>
      config.responsesTransport?.[key as keyof ResponsesTransportConfig]
      !== value,
  )

  if (
    !hasExtraPromptChanges
    && !hasReasoningEffortChanges
    && !hasResponsesApiCompactThresholdChanges
    && !hasContextManagementChanges
    && !hasResponsesTransportChanges
  ) {
    return { mergedConfig: config, changed: false }
  }

  return {
    mergedConfig: {
      ...config,
      contextManagement: {
        ...defaultContextManagementConfig,
        ...contextManagement,
      },
      extraPrompts: {
        ...defaultExtraPrompts,
        ...extraPrompts,
      },
      modelResponsesApiCompactThresholds: {
        ...defaultResponsesApiCompactThresholds,
        ...responsesApiCompactThresholds,
      },
      modelReasoningEfforts: {
        ...defaultModelReasoningEfforts,
        ...modelReasoningEfforts,
      },
      responsesTransport,
    },
    changed: true,
  }
}

function normalizeContextManagementConfig(
  value: ContextManagementConfig | undefined,
): ContextManagementConfig {
  if (!value || typeof value !== "object") {
    return {}
  }

  return {
    ...(typeof value.messages === "boolean" ?
      { messages: value.messages }
    : {}),
    ...(typeof value.responses === "boolean" ?
      { responses: value.responses }
    : {}),
  }
}

function ensureAdminApiKey(config: AppConfig): {
  mergedConfig: AppConfig
  changed: boolean
} {
  const normalizedAdminApiKey = normalizeAdminApiKey(config.auth?.adminApiKey)
  if (normalizedAdminApiKey) {
    if (config.auth?.adminApiKey === normalizedAdminApiKey) {
      return { mergedConfig: config, changed: false }
    }

    return {
      mergedConfig: {
        ...config,
        auth: {
          ...config.auth,
          adminApiKey: normalizedAdminApiKey,
        },
      },
      changed: true,
    }
  }

  const editableConfig = readEditableConfigFromDisk()
  const { mergedConfig } = mergeDefaultConfig({
    ...editableConfig,
    auth: {
      ...editableConfig.auth,
      adminApiKey: generateAdminApiKey(),
    },
  })

  return { mergedConfig, changed: true }
}

export function mergeConfigWithDefaults(): AppConfig {
  const config = readConfigFromDisk()
  const { mergedConfig, changed } = mergeDefaultConfig(config)
  const {
    mergedConfig: mergedConfigWithAdminApiKey,
    changed: adminApiKeyChanged,
  } = ensureAdminApiKey(mergedConfig)
  const shouldPersistConfig = changed || adminApiKeyChanged

  if (shouldPersistConfig) {
    try {
      writeConfigToDisk(mergedConfigWithAdminApiKey)
    } catch (writeError) {
      if (adminApiKeyChanged) {
        throw writeError
      }

      consola.warn(
        "Failed to write merged default config to config file",
        writeError,
      )
    }
  }

  cachedConfig = mergedConfigWithAdminApiKey
  return mergedConfigWithAdminApiKey
}

export function getConfig(): AppConfig {
  cachedConfig ??= mergeDefaultConfig(readConfigFromDisk()).mergedConfig
  return cachedConfig
}

export function reloadConfig(): AppConfig {
  return mergeConfigWithDefaults()
}

export function isMessagesApiEnabled(): boolean {
  const config = getConfig()
  return config.useMessagesApi ?? true
}

export function isResponsesApiWebSocketEnabled(): boolean {
  const config = getConfig()
  return config.useResponsesApiWebSocket ?? true
}

export function getResponsesTransportConfig() {
  const { headersTimeoutMsV2, ...config } = normalizeResponsesTransportConfig(
    getConfig().responsesTransport,
  )
  return { headersTimeoutMs: headersTimeoutMsV2, ...config }
}

export const normalizeResponsesTransportConfig = (
  configured: ResponsesTransportConfig | undefined,
): Required<ResponsesTransportConfig> => ({
  headersTimeoutMsV2: positiveIntegerOrDefault(
    configured?.headersTimeoutMsV2,
    defaultResponsesTransportConfig.headersTimeoutMsV2,
  ),
  streamInactivityTimeoutMs: positiveIntegerOrDefault(
    configured?.streamInactivityTimeoutMs,
    defaultResponsesTransportConfig.streamInactivityTimeoutMs,
  ),
  websocketMaxBufferedBytes: positiveIntegerOrDefault(
    configured?.websocketMaxBufferedBytes,
    defaultResponsesTransportConfig.websocketMaxBufferedBytes,
  ),
  websocketMaxBufferedMessages: positiveIntegerOrDefault(
    configured?.websocketMaxBufferedMessages,
    defaultResponsesTransportConfig.websocketMaxBufferedMessages,
  ),
  websocketOpenTimeoutMs: positiveIntegerOrDefault(
    configured?.websocketOpenTimeoutMs,
    defaultResponsesTransportConfig.websocketOpenTimeoutMs,
  ),
  websocketPoolIdleTimeoutMs: positiveIntegerOrDefault(
    configured?.websocketPoolIdleTimeoutMs,
    defaultResponsesTransportConfig.websocketPoolIdleTimeoutMs,
  ),
})

const positiveIntegerOrDefault = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback

  const normalized = Math.floor(value)
  return normalized > 0 ? normalized : fallback
}

export function getAnthropicApiKey(): string | undefined {
  const config = getConfig()
  return config.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? undefined
}

export function isResponsesApiWebSearchEnabled(): boolean {
  const config = getConfig()
  return config.useResponsesApiWebSearch ?? true
}

export function isAlphaSearchCodexPriorityEnabled(): boolean {
  const config = getConfig()
  return config.alphaSearchCodexPriority ?? true
}

export function getAlphaSearchModel(): string | undefined {
  const model = getConfig().alphaSearchModel ?? "gpt-5-mini"
  return model.trim() || undefined
}

export function getMessageApiWebSearchModel(): string | undefined {
  const config = getConfig()
  const model = config.messageApiWebSearchModel ?? "gpt-5-mini"
  return model && model.trim().length > 0 ? model : undefined
}

export function getClaudeAutoModel(): string | undefined {
  const config = getConfig()
  const model = config.claudeAutoModel
  return model && model.trim().length > 0 ? model.trim() : undefined
}

export function getClaudeTokenMultiplier(): number {
  const config = getConfig()
  return config.claudeTokenMultiplier ?? 1.15
}
