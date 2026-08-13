import { Hono } from "hono"

import {
  listEnabledProviders,
  resolveEffectiveProviderType,
  type CodexReasoningEffort,
  type ModelConfig,
  type ProviderType,
  type ResolvedProviderConfig,
} from "~/lib/config"
import { builtinProviderModelRegistry } from "~/lib/builtin-provider-models"
import { forwardError } from "~/lib/error"
import { createHandlerLogger } from "~/lib/logger"
import { toClientModelId } from "~/lib/models"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import { state } from "~/lib/state"
import type { Model } from "~/lib/types/models"
import { getModels as getCodexModels } from "~/services/codex/get-models"
import { forwardProviderModels } from "~/services/providers/provider-proxy"

import { handleMergedCodexModels, isCodexUserAgent } from "./codex-models"
import type { SyntheticCodexModelCandidate } from "./codex-models-types"

export const modelRoutes = new Hono()

const logger = createHandlerLogger("models-handler")
const EPOCH_ISO = new Date(0).toISOString()
const RESPONSES_ENDPOINTS = new Set(["/responses", "ws:/responses"])
const MESSAGES_ENDPOINT = "/v1/messages"
const CHAT_COMPLETIONS_ENDPOINT = "/chat/completions"

type ClientModel = Record<string, unknown> & {
  id: string
  object: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeCopilotModel(model: Model): ClientModel {
  const capabilities = model.capabilities
  const contextWindow = capabilities?.limits?.max_context_window_tokens ?? 0
  const clientId = toClientModelId(model.id)
  const is1m = contextWindow >= 1_000_000

  return {
    claude_model_id: is1m ? `${clientId}[1m]` : clientId,
    ...model,
    id: clientId,
    object: "model",
    type: "model",
    created: 0,
    created_at: EPOCH_ISO,
    owned_by: model.vendor,
    display_name: model.name,
  }
}

function getStringField(
  model: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = model[field]
  return typeof value === "string" && value.trim() ? value : undefined
}

function getBuiltinProviderModelRecords(
  provider: string,
): Array<Record<string, unknown>> {
  return builtinProviderModelRegistry.getModelIds(provider).map((id) => ({
    id,
    name: id,
    object: "model",
  }))
}

type ProviderModelsFallbackReason = "error" | "invalid_body" | "non_ok"

function getFallbackProviderModelRecords(
  provider: string,
  reason: ProviderModelsFallbackReason,
  details: Record<string, unknown> = {},
): Array<Record<string, unknown>> {
  const fallbackModels = getBuiltinProviderModelRecords(provider)
  logger.warn(`models.provider.fallback_${reason}`, {
    provider,
    ...details,
    fallbackModelCount: fallbackModels.length,
  })
  return fallbackModels
}

function normalizeProviderModel(
  provider: string,
  model: unknown,
): ClientModel | null {
  if (!isRecord(model)) {
    return null
  }

  const rawId = getStringField(model, "id")
  if (!rawId) {
    return null
  }

  const id = `${provider}/${rawId}`
  const name =
    getStringField(model, "display_name")
    ?? getStringField(model, "name")
    ?? rawId
  const ownedBy =
    getStringField(model, "owned_by")
    ?? getStringField(model, "vendor")
    ?? provider

  return {
    ...model,
    id,
    object: getStringField(model, "object") ?? "model",
    type: getStringField(model, "type") ?? "model",
    created: typeof model.created === "number" ? model.created : 0,
    created_at: getStringField(model, "created_at") ?? EPOCH_ISO,
    owned_by: ownedBy,
    display_name: name,
  }
}

function normalizeProviderModels(
  provider: string,
  models: Array<unknown>,
): Array<ClientModel> {
  return models
    .map((model) => normalizeProviderModel(provider, model))
    .filter((model): model is ClientModel => model !== null)
}

async function getProviderModelRecords(
  providerConfig: ResolvedProviderConfig,
  requestHeaders: Headers,
): Promise<Array<Record<string, unknown>>> {
  try {
    const response = await forwardProviderModels(providerConfig, requestHeaders)
    if (!response.ok) {
      return getFallbackProviderModelRecords(providerConfig.name, "non_ok", {
        statusCode: response.status,
      })
    }

    const body = await response.json()
    if (!isRecord(body) || !Array.isArray(body.data)) {
      return getFallbackProviderModelRecords(
        providerConfig.name,
        "invalid_body",
      )
    }

    return body.data.filter(isRecord)
  } catch (error) {
    return getFallbackProviderModelRecords(providerConfig.name, "error", {
      error,
    })
  }
}

async function getProviderModels(
  provider: string,
  requestHeaders: Headers,
): Promise<Array<ClientModel>> {
  try {
    const providerConfig = await resolveProviderConfig(provider)
    if (!providerConfig) {
      return []
    }

    if (providerConfig.name === "codex") {
      return normalizeProviderModels(providerConfig.name, getCodexModels().data)
    }

    const models = await getProviderModelRecords(providerConfig, requestHeaders)
    return normalizeProviderModels(providerConfig.name, models)
  } catch (error) {
    if (provider === "codex") {
      logger.warn("models.provider.skip_error", {
        provider,
        error,
      })
      return []
    }

    const fallbackModels = getFallbackProviderModelRecords(provider, "error", {
      error,
    })
    return normalizeProviderModels(provider, fallbackModels)
  }
}

async function getAggregatedModels(
  requestHeaders: Headers,
): Promise<Array<ClientModel>> {
  const copilotModels = state.models?.data.map(normalizeCopilotModel) ?? []
  const providerModelsByProvider = await Promise.all(
    listEnabledProviders().map((provider) =>
      getProviderModels(provider, requestHeaders),
    ),
  )

  const models = [...copilotModels, ...providerModelsByProvider.flat()]

  const seenModelIds = new Set<string>()
  return models.filter((model) => {
    if (seenModelIds.has(model.id)) {
      return false
    }

    seenModelIds.add(model.id)
    return true
  })
}

const CODEX_REASONING_EFFORTS = new Set<CodexReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
])

async function getSyntheticCodexModels(
  requestHeaders: Headers,
  providers: Array<string>,
): Promise<Array<SyntheticCodexModelCandidate>> {
  const copilotModels = getCopilotCodexCandidates()
  const providerResults = await Promise.allSettled(
    providers.map((provider) =>
      getProviderCodexCandidates(provider, requestHeaders),
    ),
  )
  const providerModels = providerResults.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  )

  const seen = new Set<string>()
  return [...copilotModels, ...providerModels.flat()].filter((candidate) => {
    if (seen.has(candidate.slug)) return false
    seen.add(candidate.slug)
    return true
  })
}

function getCopilotCodexCandidates(): Array<SyntheticCodexModelCandidate> {
  const candidates: Array<SyntheticCodexModelCandidate> = []
  for (const model of state.models?.data ?? []) {
    try {
      if (isCopilotCodexCandidate(model)) {
        candidates.push(createCopilotCodexCandidate(model))
      }
    } catch (error) {
      logger.warn("models.codex.copilot_skip_error", {
        modelId: model.id,
        error,
      })
    }
  }
  return candidates
}

function isCopilotCodexCandidate(model: Model): boolean {
  const endpoints = model.supported_endpoints ?? []
  return (
    endpoints.some(
      (endpoint) =>
        endpoint === MESSAGES_ENDPOINT
        || endpoint === CHAT_COMPLETIONS_ENDPOINT
        || RESPONSES_ENDPOINTS.has(endpoint),
    ) && model.capabilities.supports.tool_calls !== false
  )
}

function createCopilotCodexCandidate(
  model: Model,
): SyntheticCodexModelCandidate {
  const reasoningEfforts = normalizeReasoningEfforts(
    model.capabilities.supports.reasoning_effort,
  )
  const usesNativeResponses = model.supported_endpoints?.some((endpoint) =>
    RESPONSES_ENDPOINTS.has(endpoint),
  )
  const usesNativeMessages =
    model.supported_endpoints?.includes(MESSAGES_ENDPOINT)
  return {
    slug: toClientModelId(model.id),
    displayName: model.name,
    description:
      usesNativeResponses ? `${model.name} through the Copilot Responses API.`
      : usesNativeMessages ?
        `${model.name} through the Copilot Messages adapter.`
      : `${model.name} through the Copilot Messages-to-Chat adapter.`,
    contextWindow: positiveNumber(
      model.capabilities.limits.max_context_window_tokens,
      256_000,
    ),
    maxPromptTokens: optionalPositiveNumber(
      model.capabilities.limits.max_prompt_tokens,
    ),
    maxOutputTokens: positiveNumber(
      model.capabilities.limits.max_output_tokens,
      32_000,
    ),
    inputModalities:
      model.capabilities.supports.vision ? ["text", "image"] : ["text"],
    reasoningEfforts,
    defaultReasoningEffort: selectDefaultReasoningEffort(reasoningEfforts),
  }
}

async function getProviderCodexCandidates(
  provider: string,
  requestHeaders: Headers,
): Promise<Array<SyntheticCodexModelCandidate>> {
  if (provider === "codex") return []

  try {
    const providerConfig = await resolveProviderConfig(provider)
    if (!providerConfig || providerConfig.name === "codex") return []

    const remoteModels = await getProviderModelRecords(
      providerConfig,
      requestHeaders,
    )
    const remoteById = new Map(
      remoteModels.flatMap((model) => {
        const id = getStringField(model, "id")
        return id ? [[id, model] as const] : []
      }),
    )
    const modelIds = new Set([
      ...remoteById.keys(),
      ...Object.keys(providerConfig.models ?? {}),
    ])

    const candidates: Array<SyntheticCodexModelCandidate> = []
    for (const modelId of modelIds) {
      const effectiveType = resolveEffectiveProviderType(
        providerConfig,
        modelId,
      )
      const usesMessagesFallback = isMessagesFallbackProviderType(effectiveType)
      if (!usesMessagesFallback && effectiveType !== "openai-responses") {
        continue
      }
      const modelConfig = providerConfig.models?.[modelId]
      candidates.push(
        createProviderCodexCandidate(
          providerConfig,
          modelId,
          remoteById.get(modelId),
          modelConfig,
          effectiveType,
        ),
      )
    }
    return candidates
  } catch (error) {
    logger.warn("models.codex.provider_skip_error", { provider, error })
    return []
  }
}

function isMessagesFallbackProviderType(type: ProviderType): boolean {
  return type === "anthropic" || type === "openai-compatible"
}

function createProviderCodexCandidate(
  providerConfig: ResolvedProviderConfig,
  modelId: string,
  remoteModel: Record<string, unknown> | undefined,
  modelConfig: ModelConfig | undefined,
  effectiveType: ProviderType,
): SyntheticCodexModelCandidate {
  const builtinModelConfig = builtinProviderModelRegistry.getModelConfig(
    providerConfig.name,
    modelId,
  )
  const configuredReasoningEfforts = normalizeReasoningEfforts(
    modelConfig?.reasoningEfforts,
  )
  const reasoningEfforts =
    configuredReasoningEfforts.length > 0 ?
      configuredReasoningEfforts
    : normalizeRemoteReasoningEfforts(remoteModel)
  const configuredModalities = normalizeInputModalities(
    modelConfig?.inputModalities,
  )
  const remoteModalities = normalizeInputModalities(
    remoteModel?.input_modalities ?? remoteModel?.modalities,
  )
  const builtinModalities = normalizeInputModalities(
    builtinModelConfig?.inputModalities,
  )
  const displayName =
    getStringField(remoteModel ?? {}, "display_name")
    ?? getStringField(remoteModel ?? {}, "name")
    ?? modelId
  const adapterName =
    effectiveType === "anthropic" ? "Messages" : "Messages-to-Chat"

  return {
    slug: `${providerConfig.name}/${modelId}`,
    catalogSlug: modelId,
    catalogMatchRequired: effectiveType === "openai-responses",
    providerName: providerConfig.name,
    displayName: `${displayName} (${providerConfig.name})`,
    description: `${displayName} through the ${providerConfig.name} ${adapterName} adapter.`,
    contextWindow: positiveNumber(
      modelConfig?.contextWindow
        ?? getFirstPositiveNumber(remoteModel, [
          "context_window",
          "context_length",
          "max_context_length",
          "max_model_len",
        ])
        ?? builtinModelConfig?.contextWindow,
      256_000,
    ),
    maxOutputTokens: positiveNumber(
      modelConfig?.maxOutputTokens
        ?? getFirstPositiveNumber(remoteModel, ["max_output_tokens"])
        ?? builtinModelConfig?.maxOutputTokens,
      32_000,
    ),
    inputModalities: resolveInputModalities(
      providerConfig.name,
      configuredModalities,
      remoteModalities,
      builtinModalities,
    ),
    reasoningEfforts,
    defaultReasoningEffort: selectDefaultReasoningEffort(
      reasoningEfforts,
      modelConfig?.defaultReasoningEffort,
    ),
  }
}

function normalizeRemoteReasoningEfforts(
  model: Record<string, unknown> | undefined,
): Array<CodexReasoningEffort> {
  if (!model) return []
  const value = model.reasoning_efforts ?? model.supported_reasoning_levels
  if (!Array.isArray(value)) return []
  return normalizeReasoningEfforts(
    value.map((entry: unknown) =>
      isRecord(entry) && typeof entry.effort === "string" ?
        entry.effort
      : entry,
    ),
  )
}

function normalizeReasoningEfforts(
  value: unknown,
): Array<CodexReasoningEffort> {
  if (!Array.isArray(value)) return []
  return [
    ...new Set(
      value.filter(
        (effort): effort is CodexReasoningEffort =>
          typeof effort === "string"
          && CODEX_REASONING_EFFORTS.has(effort as CodexReasoningEffort),
      ),
    ),
  ]
}

function normalizeInputModalities(value: unknown): Array<"text" | "image"> {
  if (!Array.isArray(value)) return []
  return [
    ...new Set(
      value.filter(
        (modality): modality is "text" | "image" =>
          modality === "text" || modality === "image",
      ),
    ),
  ]
}

function resolveInputModalities(
  providerName: string,
  configuredModalities: Array<"text" | "image">,
  remoteModalities: Array<"text" | "image">,
  builtinModalities: Array<"text" | "image">,
): Array<"text" | "image"> {
  if (configuredModalities.length > 0) return configuredModalities
  if (providerName === "kimi") {
    const modalities: Array<"text" | "image"> =
      remoteModalities.length > 0 ? remoteModalities
      : builtinModalities.length > 0 ? builtinModalities
      : ["text"]
    return [...new Set<"text" | "image">([...modalities, "image"])]
  }
  if (remoteModalities.length > 0) return remoteModalities
  return builtinModalities.length > 0 ? builtinModalities : ["text"]
}

function selectDefaultReasoningEffort(
  efforts: Array<CodexReasoningEffort>,
  configured?: CodexReasoningEffort,
): CodexReasoningEffort {
  if (configured && efforts.includes(configured)) return configured
  if (efforts.includes("max")) return "max"
  return efforts[0] ?? "max"
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ?
      Math.floor(value)
    : fallback
}

function optionalPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ?
      Math.floor(value)
    : undefined
}

function getFirstPositiveNumber(
  model: Record<string, unknown> | undefined,
  fields: Array<string>,
): number | undefined {
  if (!model) return undefined
  for (const field of fields) {
    const value = model[field]
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value
    }
  }
  return undefined
}

modelRoutes.get("/", async (c) => {
  try {
    if (isCodexUserAgent(c.req.header("user-agent"))) {
      const enabledProviders = listEnabledProviders()
      const codexProviderName = enabledProviders.find(
        (provider) => provider === "codex",
      )
      return await handleMergedCodexModels(
        c,
        getSyntheticCodexModels(c.req.raw.headers, enabledProviders),
        {
          includeCodexProviderAliases: codexProviderName !== undefined,
          codexProviderName,
        },
      )
    }

    const models = await getAggregatedModels(c.req.raw.headers)

    return c.json({
      object: "list",
      data: models,
      has_more: false,
    })
  } catch (error) {
    return await forwardError(c, error)
  }
})
