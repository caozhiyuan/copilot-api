/* eslint-disable max-lines */
import { Hono, type Context } from "hono"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"

import { accountsManager } from "~/lib/accounts-manager"
import { listAccountsFromRegistry } from "~/lib/accounts-registry"
import {
  getConfig,
  getModelAliases,
  getModelAliasesInfo,
  getModelRefreshIntervalMs,
  isAccountAffinityEnabled,
  mergeConfigWithDefaults,
  PROVIDER_TYPE_ANTHROPIC,
  type AppConfig,
  type ModelConfig,
  type ProviderConfig,
} from "~/lib/config"
import { PATHS } from "~/lib/paths"
import {
  getRequestHistoryStore,
  type AccountStatsRow,
} from "~/lib/request-history"

const ADMIN_TOKEN = process.env.ADMIN_TOKEN?.trim() || undefined

type AdminAccessDecision =
  | { ok: true }
  | {
      ok: false
      status: 401 | 403
      message: string
      errorType: "unauthorized" | "forbidden"
    }

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  )
}

function getBearerToken(value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed.toLowerCase().startsWith("bearer ")) return undefined
  const token = trimmed.slice("bearer ".length).trim()
  return token || undefined
}

function getRequestAdminToken(c: Context): string | undefined {
  const headerToken = c.req.header("x-admin-token")?.trim()
  if (headerToken) return headerToken

  const bearer = c.req.header("authorization")
  if (bearer) {
    return getBearerToken(bearer)
  }

  return undefined
}

function isSameOrigin(requestUrl: URL, originHeader: string): boolean {
  try {
    return new URL(originHeader).origin === requestUrl.origin
  } catch {
    return false
  }
}

function decideAdminAccess(c: Context): AdminAccessDecision {
  const url = new URL(c.req.url, "http://local")

  const token = getRequestAdminToken(c)
  const tokenOk = Boolean(ADMIN_TOKEN) && token === ADMIN_TOKEN

  const origin = c.req.header("origin")
  if (origin && !tokenOk && !isSameOrigin(url, origin)) {
    return {
      ok: false,
      status: 403,
      message: "Cross-origin access to admin API is forbidden.",
      errorType: "forbidden",
    }
  }

  if (isLoopbackHostname(url.hostname) || tokenOk) {
    return { ok: true }
  }

  if (ADMIN_TOKEN) {
    return {
      ok: false,
      status: 401,
      message:
        "Admin API requires x-admin-token or Authorization: Bearer <token>.",
      errorType: "unauthorized",
    }
  }

  return {
    ok: false,
    status: 403,
    message:
      "Admin API is only available on localhost. Set ADMIN_TOKEN to enable remote access.",
    errorType: "forbidden",
  }
}

type AccountItem = {
  account_id: string
  account_type?: string
  runtime: {
    entitlement?: number
    remaining?: number
    unlimited?: boolean
    failed?: boolean
    failureReason?: string
  }
  stats?: {
    since_ms: number
    request_count?: number
    error_count?: number
    tokens_total?: number
    avg_duration_ms?: number
    last_request_at_ms?: number
  }
}

function parseFiniteNumber(value: string | null): number | undefined {
  if (!value) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function parseTriStateBool(value: string | null): boolean | undefined {
  if (value === "1") return true
  if (value === "0") return false
  return undefined
}

type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh"

type ConfigErrorType = "bad_request" | "internal_error"

type ConfigErrorPayload = {
  message: string
  type: ConfigErrorType
}

const CONFIG_KEYS = new Set<keyof AppConfig>([
  "auth",
  "extraPrompts",
  "smallModel",
  "accountAffinity",
  "apiKey",
  "anthropicApiKey",
  "providers",
  "responsesApiContextManagementModels",
  "modelReasoningEfforts",
  "modelAliases",
  "allowOriginalModelNamesForAliases",
  "useFunctionApplyPatch",
  "forceAgent",
  "compactUseSmallModel",
  "messageStartInputTokensFallback",
  "modelRefreshIntervalHours",
  "useMessagesApi",
])

const REASONING_EFFORTS = new Set<ReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
])

const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"])

function jsonError(
  c: Context,
  status: 400 | 500,
  error: ConfigErrorPayload,
): Response {
  return c.json(
    {
      error,
    },
    status,
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

type ParseFieldResult<T> = { clear: true } | { value: T } | { error: string }

type AuthConfig = NonNullable<AppConfig["auth"]>

function parseOptionalString(
  value: unknown,
  field: string,
): ParseFieldResult<string> {
  if (value === null || value === undefined) return { clear: true }
  if (typeof value !== "string") return { error: `${field} must be a string` }

  const trimmed = value.trim()
  if (!trimmed) return { clear: true }

  return { value: trimmed }
}

function parseOptionalBoolean(
  value: unknown,
  field: string,
): ParseFieldResult<boolean> {
  if (value === null || value === undefined) return { clear: true }
  if (typeof value !== "boolean") return { error: `${field} must be a boolean` }
  return { value }
}

function parseOptionalNonNegativeNumber(
  value: unknown,
  field: string,
): ParseFieldResult<number> {
  if (value === null || value === undefined) return { clear: true }
  if (typeof value !== "number") return { error: `${field} must be a number` }
  if (!Number.isFinite(value) || value < 0) {
    return { error: `${field} must be a non-negative number` }
  }
  return { value }
}

function parseOptionalStringArray(
  value: unknown,
  field: string,
): ParseFieldResult<Array<string>> {
  if (value === null || value === undefined) return { clear: true }
  if (!Array.isArray(value)) {
    return { error: `${field} must be an array of strings` }
  }

  const out: Array<string> = []
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string") {
      return { error: `${field}[${index}] must be a string` }
    }
    const trimmed = entry.trim()
    if (!trimmed) {
      return { error: `${field}[${index}] must be a non-empty string` }
    }
    out.push(trimmed)
  }

  return { value: [...new Set(out)] }
}

function parseAuthConfig(value: unknown): ParseFieldResult<AuthConfig> {
  if (value === null || value === undefined) return { clear: true }
  if (!isPlainObject(value)) {
    return { error: "auth must be an object" }
  }

  for (const key of Object.keys(value)) {
    if (key !== "apiKeys") {
      return { error: `auth.${key} is not supported` }
    }
  }

  if (
    !("apiKeys" in value)
    || value.apiKeys === null
    || value.apiKeys === undefined
  ) {
    return { value: { apiKeys: [] } }
  }

  if (!Array.isArray(value.apiKeys)) {
    return { error: "auth.apiKeys must be an array of strings" }
  }

  const normalizedApiKeys = value.apiKeys
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)

  if (normalizedApiKeys.length !== value.apiKeys.length) {
    return { error: "auth.apiKeys must contain non-empty strings only" }
  }

  return { value: { apiKeys: [...new Set(normalizedApiKeys)] } }
}

function parseStringRecord(
  value: unknown,
  field: string,
): ParseFieldResult<Record<string, string>> {
  if (value === null || value === undefined) return { clear: true }
  if (!isPlainObject(value)) {
    return { error: `${field} must be an object with string values` }
  }

  const record = Object.create(null) as Record<string, string>
  for (const [key, entry] of Object.entries(value)) {
    if (BLOCKED_KEYS.has(key)) {
      return { error: `${field}.${key} is not allowed` }
    }
    if (typeof entry !== "string") {
      return { error: `${field}.${key} must be a string` }
    }
    record[key] = entry
  }

  return { value: record }
}

const PROVIDER_MODEL_CONFIG_FIELDS = ["temperature", "topP", "topK"] as const

type ProviderModelConfigField = (typeof PROVIDER_MODEL_CONFIG_FIELDS)[number]

const PROVIDER_MODEL_CONFIG_KEYS = new Set<ProviderModelConfigField>(
  PROVIDER_MODEL_CONFIG_FIELDS,
)

const PROVIDER_CONFIG_FIELDS = [
  "type",
  "enabled",
  "baseUrl",
  "apiKey",
  "models",
] as const

type ProviderConfigField = (typeof PROVIDER_CONFIG_FIELDS)[number]

const PROVIDER_CONFIG_KEYS = new Set<ProviderConfigField>(
  PROVIDER_CONFIG_FIELDS,
)

function validateAllowedObjectKeys(
  value: Record<string, unknown>,
  field: string,
  allowed: ReadonlySet<string>,
): string | undefined {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return `${field}.${key} is not supported`
    }
  }
  return undefined
}

function applyProviderModelTemperature(
  config: ModelConfig,
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  if (!Object.hasOwn(value, "temperature")) return undefined

  const parsed = parseOptionalNonNegativeNumber(
    value.temperature,
    `${field}.temperature`,
  )
  if ("error" in parsed) return parsed.error
  if ("value" in parsed) config.temperature = parsed.value
  return undefined
}

function applyProviderModelTopP(
  config: ModelConfig,
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  if (!Object.hasOwn(value, "topP")) return undefined

  const parsed = parseOptionalNonNegativeNumber(value.topP, `${field}.topP`)
  if ("error" in parsed) return parsed.error
  if ("value" in parsed) config.topP = parsed.value
  return undefined
}

function applyProviderModelTopK(
  config: ModelConfig,
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  if (!Object.hasOwn(value, "topK")) return undefined

  const parsed = parseOptionalNonNegativeNumber(value.topK, `${field}.topK`)
  if ("error" in parsed) return parsed.error
  if ("value" in parsed) config.topK = parsed.value
  return undefined
}

function parseProviderModelConfig(
  value: unknown,
  field: string,
): ParseFieldResult<ModelConfig> {
  if (value === null || value === undefined) {
    return { error: `${field} must be an object` }
  }
  if (!isPlainObject(value)) {
    return { error: `${field} must be an object` }
  }

  const keyError = validateAllowedObjectKeys(
    value,
    field,
    PROVIDER_MODEL_CONFIG_KEYS,
  )
  if (keyError) return { error: keyError }

  const config: ModelConfig = {}

  const temperatureError = applyProviderModelTemperature(config, value, field)
  if (temperatureError) return { error: temperatureError }

  const topPError = applyProviderModelTopP(config, value, field)
  if (topPError) return { error: topPError }

  const topKError = applyProviderModelTopK(config, value, field)
  if (topKError) return { error: topKError }

  return { value: config }
}

function parseProviderModelsRecord(
  value: unknown,
  field: string,
): ParseFieldResult<Record<string, ModelConfig>> {
  if (value === null || value === undefined) return { clear: true }
  if (!isPlainObject(value)) {
    return { error: `${field} must be an object` }
  }

  const record = Object.create(null) as Record<string, ModelConfig>

  for (const [rawModelId, rawModelConfig] of Object.entries(value)) {
    if (BLOCKED_KEYS.has(rawModelId)) {
      return { error: `${field}.${rawModelId} is not allowed` }
    }

    const modelId = rawModelId.trim()
    if (!modelId) {
      return { error: `${field} keys must be non-empty strings` }
    }
    if (rawModelId !== modelId) {
      return {
        error: `${field}.${rawModelId} must not include leading/trailing whitespace`,
      }
    }
    if (BLOCKED_KEYS.has(modelId)) {
      return { error: `${field}.${modelId} is not allowed` }
    }

    const parsed = parseProviderModelConfig(
      rawModelConfig,
      `${field}.${modelId}`,
    )
    if ("error" in parsed) return parsed
    if ("clear" in parsed) continue

    record[modelId] = parsed.value
  }

  return { value: record }
}

function applyProviderType(
  provider: ProviderConfig,
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  if (!Object.hasOwn(value, "type")) return undefined

  const parsed = parseOptionalString(value.type, `${field}.type`)
  if ("error" in parsed) return parsed.error
  if ("value" in parsed) {
    if (parsed.value !== PROVIDER_TYPE_ANTHROPIC) {
      return `${field}.type must be "${PROVIDER_TYPE_ANTHROPIC}"`
    }
    provider.type = PROVIDER_TYPE_ANTHROPIC
  }

  return undefined
}

function applyProviderEnabled(
  provider: ProviderConfig,
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  if (!Object.hasOwn(value, "enabled")) return undefined

  const parsed = parseOptionalBoolean(value.enabled, `${field}.enabled`)
  if ("error" in parsed) return parsed.error
  if ("value" in parsed) provider.enabled = parsed.value
  return undefined
}

function applyProviderBaseUrl(
  provider: ProviderConfig,
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  if (!Object.hasOwn(value, "baseUrl")) return undefined

  const parsed = parseOptionalString(value.baseUrl, `${field}.baseUrl`)
  if ("error" in parsed) return parsed.error
  if ("value" in parsed) provider.baseUrl = parsed.value
  return undefined
}

function applyProviderApiKey(
  provider: ProviderConfig,
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  if (!Object.hasOwn(value, "apiKey")) return undefined

  const parsed = parseOptionalString(value.apiKey, `${field}.apiKey`)
  if ("error" in parsed) return parsed.error
  if ("value" in parsed) provider.apiKey = parsed.value
  return undefined
}

function applyProviderModels(
  provider: ProviderConfig,
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  if (!Object.hasOwn(value, "models")) return undefined

  const parsed = parseProviderModelsRecord(value.models, `${field}.models`)
  if ("error" in parsed) return parsed.error
  if ("value" in parsed) provider.models = parsed.value
  return undefined
}

function parseProviderConfig(
  value: unknown,
  field: string,
): ParseFieldResult<ProviderConfig> {
  if (value === null || value === undefined) {
    return { error: `${field} must be an object` }
  }
  if (!isPlainObject(value)) {
    return { error: `${field} must be an object` }
  }

  const keyError = validateAllowedObjectKeys(value, field, PROVIDER_CONFIG_KEYS)
  if (keyError) return { error: keyError }

  const provider: ProviderConfig = {}

  const typeError = applyProviderType(provider, value, field)
  if (typeError) return { error: typeError }

  const enabledError = applyProviderEnabled(provider, value, field)
  if (enabledError) return { error: enabledError }

  const baseUrlError = applyProviderBaseUrl(provider, value, field)
  if (baseUrlError) return { error: baseUrlError }

  const apiKeyError = applyProviderApiKey(provider, value, field)
  if (apiKeyError) return { error: apiKeyError }

  const modelsError = applyProviderModels(provider, value, field)
  if (modelsError) return { error: modelsError }

  return { value: provider }
}

function parseProviders(
  value: unknown,
): ParseFieldResult<Record<string, ProviderConfig>> {
  if (value === null || value === undefined) return { clear: true }
  if (!isPlainObject(value)) {
    return { error: "providers must be an object" }
  }

  const record = Object.create(null) as Record<string, ProviderConfig>
  const seenProviderNames = new Set<string>()

  for (const [rawProviderName, rawProviderConfig] of Object.entries(value)) {
    if (BLOCKED_KEYS.has(rawProviderName)) {
      return { error: `providers.${rawProviderName} is not allowed` }
    }

    const providerName = rawProviderName.trim()
    if (!providerName) {
      return { error: "providers keys must be non-empty strings" }
    }
    if (rawProviderName !== providerName) {
      return {
        error: `providers.${rawProviderName} must not include leading/trailing whitespace`,
      }
    }
    if (BLOCKED_KEYS.has(providerName)) {
      return { error: `providers.${providerName} is not allowed` }
    }

    const normalizedProviderName = providerName.toLowerCase()
    if (seenProviderNames.has(normalizedProviderName)) {
      return {
        error: `providers.${rawProviderName} conflicts with another provider`,
      }
    }
    seenProviderNames.add(normalizedProviderName)

    const parsed = parseProviderConfig(
      rawProviderConfig,
      `providers.${providerName}`,
    )
    if ("error" in parsed) return parsed
    if ("clear" in parsed) continue

    record[providerName] = parsed.value
  }

  return { value: record }
}

function parseReasoningRecord(
  value: unknown,
): ParseFieldResult<Record<string, ReasoningEffort>> {
  if (value === null || value === undefined) return { clear: true }
  if (!isPlainObject(value)) {
    return { error: "modelReasoningEfforts must be an object" }
  }

  const record = Object.create(null) as Record<string, ReasoningEffort>
  for (const [model, effort] of Object.entries(value)) {
    if (BLOCKED_KEYS.has(model)) {
      return { error: `modelReasoningEfforts.${model} is not allowed` }
    }
    if (typeof effort !== "string") {
      return { error: `modelReasoningEfforts.${model} must be a string` }
    }
    if (!REASONING_EFFORTS.has(effort as ReasoningEffort)) {
      return {
        error: `modelReasoningEfforts.${model} must be one of ${[
          ...REASONING_EFFORTS,
        ].join(", ")}`,
      }
    }
    record[model] = effort as ReasoningEffort
  }

  return { value: record }
}

type ParsedModelAlias = {
  alias: string
  target: string
  allowOriginal?: boolean
}

function parseModelAliasEntry(
  rawAlias: string,
  rawTarget: unknown,
): ParseFieldResult<ParsedModelAlias> {
  if (BLOCKED_KEYS.has(rawAlias)) {
    return { error: `modelAliases.${rawAlias} is not allowed` }
  }

  const alias = rawAlias.trim().toLowerCase()
  if (!alias) {
    return { error: "modelAliases keys must be non-empty strings" }
  }
  if (BLOCKED_KEYS.has(alias)) {
    return { error: `modelAliases.${alias} is not allowed` }
  }

  let target: string | undefined
  let allowOriginal: boolean | undefined

  if (typeof rawTarget === "string") {
    target = rawTarget.trim()
  } else if (isPlainObject(rawTarget)) {
    const rawTargetValue = rawTarget.target
    if (typeof rawTargetValue !== "string") {
      return { error: `modelAliases.${rawAlias}.target must be a string` }
    }
    target = rawTargetValue.trim()

    if ("allowOriginal" in rawTarget) {
      if (typeof rawTarget.allowOriginal !== "boolean") {
        return {
          error: `modelAliases.${rawAlias}.allowOriginal must be a boolean`,
        }
      }
      allowOriginal = rawTarget.allowOriginal
    }
  } else {
    return { error: `modelAliases.${rawAlias} must be a string or object` }
  }

  if (!target) {
    return { error: `modelAliases.${rawAlias} must be a non-empty string` }
  }
  if (alias === target.toLowerCase()) {
    return { error: `modelAliases.${rawAlias} cannot map to itself` }
  }

  return { value: { alias, target, allowOriginal } }
}

function parseModelAliases(
  value: unknown,
): ParseFieldResult<
  Record<string, { target: string; allowOriginal?: boolean }>
> {
  if (value === null || value === undefined) return { clear: true }
  if (!isPlainObject(value)) {
    return { error: "modelAliases must be an object" }
  }

  const record = Object.create(null) as Record<
    string,
    { target: string; allowOriginal?: boolean }
  >

  for (const [rawAlias, rawTarget] of Object.entries(value)) {
    const parsed = parseModelAliasEntry(rawAlias, rawTarget)
    if ("error" in parsed) return parsed
    if ("clear" in parsed) continue

    const { alias, target, allowOriginal } = parsed.value
    const existing = Object.hasOwn(record, alias) ? record[alias] : undefined
    if (
      existing
      && (existing.target !== target
        || existing.allowOriginal !== allowOriginal)
    ) {
      return { error: `modelAliases.${rawAlias} conflicts with ${alias}` }
    }

    record[alias] =
      allowOriginal === undefined ? { target } : { target, allowOriginal }
  }

  return { value: record }
}

function applyOptionalString(
  next: AppConfig,
  key: "smallModel" | "apiKey" | "anthropicApiKey",
  value: unknown,
): string | undefined {
  const parsed = parseOptionalString(value, key)
  if ("error" in parsed) return parsed.error
  if ("clear" in parsed) {
    next[key] = undefined
    return undefined
  }
  next[key] = parsed.value
  return undefined
}

function applyAuthConfig(next: AppConfig, value: unknown): string | undefined {
  const parsed = parseAuthConfig(value)
  if ("error" in parsed) return parsed.error
  if ("clear" in parsed) {
    delete next.auth
    return undefined
  }

  next.auth = parsed.value
  return undefined
}

function applyOptionalBoolean(
  next: AppConfig,
  key:
    | "accountAffinity"
    | "useFunctionApplyPatch"
    | "forceAgent"
    | "useMessagesApi"
    | "compactUseSmallModel"
    | "messageStartInputTokensFallback"
    | "allowOriginalModelNamesForAliases",
  value: unknown,
): string | undefined {
  const parsed = parseOptionalBoolean(value, key)
  if ("error" in parsed) return parsed.error
  if ("clear" in parsed) {
    next[key] = undefined
    return undefined
  }
  next[key] = parsed.value
  return undefined
}

function applyOptionalNumber(
  next: AppConfig,
  key: "modelRefreshIntervalHours",
  value: unknown,
): string | undefined {
  const parsed = parseOptionalNonNegativeNumber(value, key)
  if ("error" in parsed) return parsed.error
  if ("clear" in parsed) {
    next[key] = undefined
    return undefined
  }
  next[key] = parsed.value
  return undefined
}

function applyExtraPrompts(
  next: AppConfig,
  value: unknown,
): string | undefined {
  const parsed = parseStringRecord(value, "extraPrompts")
  if ("error" in parsed) return parsed.error
  if ("clear" in parsed) {
    delete next.extraPrompts
    return undefined
  }
  next.extraPrompts = parsed.value
  return undefined
}

function applyReasoningEfforts(
  next: AppConfig,
  value: unknown,
): string | undefined {
  const parsed = parseReasoningRecord(value)
  if ("error" in parsed) return parsed.error
  if ("clear" in parsed) {
    delete next.modelReasoningEfforts
    return undefined
  }
  next.modelReasoningEfforts = parsed.value
  return undefined
}

function applyModelAliases(
  next: AppConfig,
  value: unknown,
): string | undefined {
  const parsed = parseModelAliases(value)
  if ("error" in parsed) return parsed.error
  if ("clear" in parsed) {
    delete next.modelAliases
    return undefined
  }
  next.modelAliases = parsed.value
  return undefined
}

function applyResponsesApiContextManagementModels(
  next: AppConfig,
  value: unknown,
): string | undefined {
  const parsed = parseOptionalStringArray(
    value,
    "responsesApiContextManagementModels",
  )
  if ("error" in parsed) return parsed.error
  if ("clear" in parsed) {
    delete next.responsesApiContextManagementModels
    return undefined
  }
  next.responsesApiContextManagementModels = parsed.value
  return undefined
}

function applyProvidersConfig(
  next: AppConfig,
  value: unknown,
): string | undefined {
  const parsed = parseProviders(value)
  if ("error" in parsed) return parsed.error
  if ("clear" in parsed) {
    delete next.providers
    return undefined
  }
  next.providers = parsed.value
  return undefined
}

type ConfigPatchHandler = (
  next: AppConfig,
  value: unknown,
) => string | undefined

const CONFIG_PATCH_HANDLERS: Partial<Record<string, ConfigPatchHandler>> = {
  auth: applyAuthConfig,
  extraPrompts: applyExtraPrompts,
  smallModel: (next, value) => applyOptionalString(next, "smallModel", value),
  accountAffinity: (next, value) =>
    applyOptionalBoolean(next, "accountAffinity", value),
  apiKey: (next, value) => applyOptionalString(next, "apiKey", value),
  anthropicApiKey: (next, value) =>
    applyOptionalString(next, "anthropicApiKey", value),
  providers: applyProvidersConfig,
  responsesApiContextManagementModels: applyResponsesApiContextManagementModels,
  modelReasoningEfforts: applyReasoningEfforts,
  modelAliases: applyModelAliases,
  allowOriginalModelNamesForAliases: (next, value) =>
    applyOptionalBoolean(next, "allowOriginalModelNamesForAliases", value),
  useFunctionApplyPatch: (next, value) =>
    applyOptionalBoolean(next, "useFunctionApplyPatch", value),
  forceAgent: (next, value) => applyOptionalBoolean(next, "forceAgent", value),
  compactUseSmallModel: (next, value) =>
    applyOptionalBoolean(next, "compactUseSmallModel", value),
  messageStartInputTokensFallback: (next, value) =>
    applyOptionalBoolean(next, "messageStartInputTokensFallback", value),
  modelRefreshIntervalHours: (next, value) =>
    applyOptionalNumber(next, "modelRefreshIntervalHours", value),
  useMessagesApi: (next, value) =>
    applyOptionalBoolean(next, "useMessagesApi", value),
}

function applyConfigPatch(
  base: AppConfig,
  input: Record<string, unknown>,
): { config?: AppConfig; error?: string } {
  const next: AppConfig = { ...base }

  for (const [rawKey, value] of Object.entries(input)) {
    const key = rawKey as keyof AppConfig
    if (!CONFIG_KEYS.has(key)) {
      return { error: `Unknown config key: ${rawKey}` }
    }

    const handler = CONFIG_PATCH_HANDLERS[rawKey]
    if (!handler) {
      return { error: `Unsupported config key: ${rawKey}` }
    }

    const error = handler(next, value)
    if (error) return { error }
  }

  return { config: next }
}

async function writeConfigFile(config: AppConfig): Promise<void> {
  await fs.mkdir(PATHS.APP_DIR, { recursive: true })

  const content = `${JSON.stringify(config, null, 2)}\n`
  const tmpPath = `${PATHS.CONFIG_PATH}.tmp-${randomUUID()}`

  try {
    await fs.writeFile(tmpPath, content, "utf8")
    try {
      await fs.chmod(tmpPath, 0o600)
    } catch {
      // Ignore chmod errors (e.g. unsupported filesystem).
    }
    await fs.rename(tmpPath, PATHS.CONFIG_PATH)
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => {})
    throw error
  }
}

export const adminApiRoutes = new Hono()

adminApiRoutes.use("*", async (c, next) => {
  const decision = decideAdminAccess(c)
  if (!decision.ok) {
    return c.json(
      {
        error: {
          message: decision.message,
          type: decision.errorType,
        },
      },
      decision.status,
    )
  }

  await next()
})

adminApiRoutes.get("/meta", (c) => {
  const store = getRequestHistoryStore()
  return c.json(store.meta())
})

adminApiRoutes.get("/config", (c) => {
  try {
    const config = mergeConfigWithDefaults()
    return c.json({ ...config, _configPath: PATHS.CONFIG_PATH })
  } catch {
    return jsonError(c, 500, {
      message: "Failed to load config.",
      type: "internal_error",
    })
  }
})

adminApiRoutes.post("/config", async (c) => {
  let payload: unknown
  try {
    payload = await c.req.json()
  } catch {
    return jsonError(c, 400, {
      message: "Config payload must be valid JSON.",
      type: "bad_request",
    })
  }

  if (!isPlainObject(payload)) {
    return jsonError(c, 400, {
      message: "Config payload must be an object.",
      type: "bad_request",
    })
  }

  const result = applyConfigPatch(getConfig(), payload)
  if (!result.config) {
    return jsonError(c, 400, {
      message: result.error ?? "Invalid config payload.",
      type: "bad_request",
    })
  }

  try {
    await writeConfigFile(result.config)
    const merged = mergeConfigWithDefaults()
    accountsManager.setAccountAffinityEnabled(isAccountAffinityEnabled())
    accountsManager.setModelsRefreshIntervalMs(getModelRefreshIntervalMs())
    return c.json({ ...merged, _configPath: PATHS.CONFIG_PATH })
  } catch {
    return jsonError(c, 500, {
      message: "Failed to write config.",
      type: "internal_error",
    })
  }
})

adminApiRoutes.get("/models", (c) => {
  try {
    const accountModels = accountsManager.getFirstAccountModels()
    const items =
      accountModels?.data
        .map((model) => model.id)
        .filter(
          (id): id is string => typeof id === "string" && id.trim().length > 0,
        ) ?? []
    const aliasItems = Object.keys(getModelAliases())
    const uniqueItems = Array.from(new Set([...items, ...aliasItems])).sort()
    return c.json({ items: uniqueItems })
  } catch {
    return jsonError(c, 500, {
      message: "Failed to load models.",
      type: "internal_error",
    })
  }
})

type AdminModelDetailsItem = {
  id: string
  name: string
  preview: boolean
  billing?: {
    is_premium?: boolean
    multiplier?: number
  }
  supported_endpoints?: Array<string>
  capabilities: {
    limits: {
      max_context_window_tokens?: number
      max_prompt_tokens?: number
      max_output_tokens?: number
    }
    supports: {
      tool_calls?: boolean
      parallel_tool_calls?: boolean
      structured_outputs?: boolean
      streaming?: boolean
      vision?: boolean
    }
  }
  aliases: Array<string>
}

function parseNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function parseOptionalFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined
  return Number.isFinite(value) ? value : undefined
}

function toBooleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function parseStringArray(value: unknown): Array<string> | undefined {
  if (!Array.isArray(value)) return undefined

  const out = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)

  return out.length > 0 ? out : undefined
}

function parseBilling(value: unknown): AdminModelDetailsItem["billing"] {
  if (!isPlainObject(value)) return undefined

  const multiplier = parseOptionalFiniteNumber(value.multiplier)
  const is_premium = toBooleanOrUndefined(value.is_premium)

  if (multiplier === undefined && is_premium === undefined) return undefined
  return { multiplier, is_premium }
}

function parseCapabilities(
  value: unknown,
): AdminModelDetailsItem["capabilities"] {
  if (!isPlainObject(value)) {
    return {
      limits: {},
      supports: {},
    }
  }

  const limitsRaw = isPlainObject(value.limits) ? value.limits : undefined
  const supportsRaw = isPlainObject(value.supports) ? value.supports : undefined

  return {
    limits: {
      max_context_window_tokens: parseOptionalFiniteNumber(
        limitsRaw?.max_context_window_tokens,
      ),
      max_prompt_tokens: parseOptionalFiniteNumber(
        limitsRaw?.max_prompt_tokens,
      ),
      max_output_tokens: parseOptionalFiniteNumber(
        limitsRaw?.max_output_tokens,
      ),
    },
    supports: {
      tool_calls: toBooleanOrUndefined(supportsRaw?.tool_calls),
      parallel_tool_calls: toBooleanOrUndefined(
        supportsRaw?.parallel_tool_calls,
      ),
      structured_outputs: toBooleanOrUndefined(supportsRaw?.structured_outputs),
      streaming: toBooleanOrUndefined(supportsRaw?.streaming),
      vision: toBooleanOrUndefined(supportsRaw?.vision),
    },
  }
}

function parseAdminModelDetailsItem(
  raw: unknown,
  aliasesByTarget: Map<string, Array<string>>,
): AdminModelDetailsItem | null {
  if (!isPlainObject(raw)) return null

  const id = parseNonEmptyString(raw.id)
  if (!id) return null

  const name = parseNonEmptyString(raw.name) ?? id
  const preview = toBooleanOrUndefined(raw.preview) ?? false

  return {
    id,
    name,
    preview,
    billing: parseBilling(raw.billing),
    supported_endpoints: parseStringArray(raw.supported_endpoints),
    capabilities: parseCapabilities(raw.capabilities),
    aliases: aliasesByTarget.get(id.toLowerCase()) ?? [],
  }
}

adminApiRoutes.get("/models/details", (c) => {
  try {
    const accountModels = accountsManager.getFirstAccountModels()
    const aliasInfo = getModelAliasesInfo()

    const aliasesByTarget = new Map<string, Array<string>>()
    for (const [alias, spec] of Object.entries(aliasInfo)) {
      const targetKey = spec.target.toLowerCase()
      const current = aliasesByTarget.get(targetKey)
      if (current) {
        current.push(alias)
      } else {
        aliasesByTarget.set(targetKey, [alias])
      }
    }

    for (const aliases of aliasesByTarget.values()) {
      aliases.sort()
    }

    const rawModels: Array<unknown> = []
    if (Array.isArray(accountModels?.data)) {
      rawModels.push(...(accountModels.data as Array<unknown>))
    }

    const itemsById = new Map<string, AdminModelDetailsItem>()
    for (const raw of rawModels) {
      const item = parseAdminModelDetailsItem(raw, aliasesByTarget)
      if (!item) continue
      if (itemsById.has(item.id)) continue
      itemsById.set(item.id, item)
    }

    const items = Array.from(itemsById.values()).sort((a, b) =>
      a.id.localeCompare(b.id),
    )

    return c.json({ items })
  } catch (error) {
    console.error("Failed to load model details.", error)
    return jsonError(c, 500, {
      message: "Failed to load model details.",
      type: "internal_error",
    })
  }
})

adminApiRoutes.get("/accounts", async (c) => {
  const url = new URL(c.req.url, "http://local")
  const sinceMs = Number(url.searchParams.get("since_ms") ?? "")
  const includeStats = url.searchParams.get("include_stats") !== "0"

  let since = Date.now() - 24 * 60 * 60 * 1000
  if (Number.isFinite(sinceMs) && sinceMs > 0) {
    since = sinceMs
  }

  const registry = await listAccountsFromRegistry().catch(() => [])
  const registryTypeById = new Map(registry.map((a) => [a.id, a.accountType]))

  const statuses = accountsManager.getAccountStatus()

  const store = getRequestHistoryStore()
  const statsByAccount: Record<string, AccountStatsRow | undefined> =
    includeStats ? store.getAccountStatsSince(since) : {}

  const items: Array<AccountItem> = statuses.map((s) => {
    const accountType = registryTypeById.get(s.id)
    const statsRow = includeStats ? statsByAccount[s.id] : undefined

    const stats =
      includeStats ?
        {
          since_ms: since,
          request_count: statsRow?.request_count,
          error_count: statsRow?.error_count,
          tokens_total: statsRow?.tokens_total,
          avg_duration_ms: statsRow?.avg_duration_ms,
          last_request_at_ms: statsRow?.last_request_at_ms,
        }
      : undefined

    return {
      account_id: s.id,
      account_type: accountType,
      runtime: {
        entitlement: s.entitlement,
        remaining: s.remaining,
        unlimited: s.unlimited,
        failed: s.failed,
        failureReason: s.failureReason,
      },
      stats,
    }
  })

  return c.json({ items })
})

adminApiRoutes.get("/requests", (c) => {
  const url = new URL(c.req.url, "http://local")
  const p = url.searchParams

  const limit = parseFiniteNumber(p.get("limit")) ?? 50
  const cursorId = parseFiniteNumber(p.get("cursor_id"))

  const status = parseFiniteNumber(p.get("status"))
  const hasError = parseTriStateBool(p.get("has_error"))

  const fromMs = parseFiniteNumber(p.get("from_ms"))
  const toMs = parseFiniteNumber(p.get("to_ms"))

  const store = getRequestHistoryStore()
  const result = store.query({
    limit,
    cursorId,

    accountId: p.get("account_id") || undefined,
    upstreamModel: p.get("upstream_model") || undefined,
    clientModel: p.get("client_model") || undefined,
    upstreamEndpoint: p.get("upstream_endpoint") || undefined,
    path: p.get("path") || undefined,

    status,
    hasError,
    fromMs,
    toMs,
  })

  return c.json({
    items: result.items,
    next_cursor_id: result.nextCursorId,
    has_more: result.hasMore,
  })
})

adminApiRoutes.get("/requests/:requestId", (c) => {
  const requestId = c.req.param("requestId")
  const store = getRequestHistoryStore()
  const item = store.getByRequestId(requestId)
  return c.json({ item })
})
