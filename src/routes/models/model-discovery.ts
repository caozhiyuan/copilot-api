import type { Context } from "hono"

import { getBuiltinProviderModelRecords } from "~/lib/builtin-provider-models"
import {
  getRawProviderConfig,
  listEnabledProviders,
  type ProviderConfig,
  type ResolvedProviderConfig,
} from "~/lib/config"
import {
  GITHUB_COPILOT_PROVIDER,
  isGitHubCopilotEnabled,
} from "~/lib/github-copilot-provider"
import { createHandlerLogger } from "~/lib/logger"
import { withModelDisplayName } from "~/lib/model-display-name"
import { toClientModelId } from "~/lib/models"
import {
  getLocalProviderModelRecords,
  isProviderModelVisible,
} from "~/lib/provider-model-catalog"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import { getProviderAgentModels } from "~/lib/provider-management"
import { state } from "~/lib/state"
import type { Model } from "~/lib/types/models"
import { getModels as getCodexModels } from "~/services/codex/get-models"
import { forwardProviderModels } from "~/services/providers/provider-proxy"

const logger = createHandlerLogger("models-handler")
const EPOCH_ISO = new Date(0).toISOString()

export type ClientModel = Record<string, unknown> & {
  id: string
  object: string
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function firstPositiveInteger(
  ...values: Array<unknown>
): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 1) {
      return Math.floor(value)
    }
  }
  return undefined
}

function normalizeModelCapabilities<T extends { capabilities?: unknown }>(
  model: T,
) {
  if (!isRecord(model.capabilities)) return model
  const limits = getRecordField(model.capabilities, "limits")
  const supports = getRecordField(model.capabilities, "supports")
  return {
    context_window: firstPositiveInteger(
      limits?.max_context_window_tokens,
      limits?.max_prompt_tokens,
    ),
    max_output_tokens: limits?.max_output_tokens,
    input_limit: limits?.max_prompt_tokens,
    input_modalities:
      typeof supports?.vision === "boolean" ?
        ["text", ...(supports.vision ? ["image"] : [])]
      : undefined,
    reasoning_efforts: supports?.reasoning_effort,
    ...model,
  }
}

export function normalizeCopilotModel(model: Model): ClientModel {
  const clientId = toClientModelId(model.id)
  return {
    claude_model_id: `${clientId}[1m]`,
    ...withModelDisplayName(
      normalizeModelCapabilities(model),
      GITHUB_COPILOT_PROVIDER,
    ),
    id: clientId,
    object: "model",
    type: "model",
    created: 0,
    created_at: EPOCH_ISO,
    owned_by: model.vendor,
  }
}

export function getStringField(
  model: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = model[field]
  return typeof value === "string" && value.trim() ? value : undefined
}

export function getRecordField(
  model: Record<string, unknown> | undefined,
  field: string,
): Record<string, unknown> | undefined {
  const value = model?.[field]
  return isRecord(value) ? value : undefined
}

export function getStringList(value: unknown): Array<string> | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = [
    ...new Set(
      value.filter((item): item is string => typeof item === "string"),
    ),
  ]
  return strings.length > 0 ? strings : undefined
}

type ProviderModelsFallbackReason = "error" | "invalid_body" | "non_ok"

function getFallbackProviderModelRecords(
  provider: string,
  reason: ProviderModelsFallbackReason,
  details: Record<string, unknown> = {},
): Array<Record<string, unknown>> {
  const fallbackModels =
    getLocalProviderModelRecords(provider, getRawProviderConfig(provider))
    ?? getBuiltinProviderModelRecords(provider)
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
  config?: ProviderConfig | null,
): ClientModel | null {
  if (!isRecord(model)) {
    return null
  }

  const rawId = getStringField(model, "id")
  if (!rawId || !isProviderModelVisible(provider, rawId, config)) {
    return null
  }

  const id = `${provider}/${rawId}`
  const ownedBy =
    getStringField(model, "owned_by")
    ?? getStringField(model, "vendor")
    ?? provider

  return {
    ...withModelDisplayName(model, provider),
    id,
    object: getStringField(model, "object") ?? "model",
    type: getStringField(model, "type") ?? "model",
    created: typeof model.created === "number" ? model.created : 0,
    created_at: getStringField(model, "created_at") ?? EPOCH_ISO,
    owned_by: ownedBy,
  }
}

function normalizeProviderModels(
  provider: string,
  models: Array<unknown>,
  config?: ProviderConfig | null,
): Array<ClientModel> {
  return models
    .map((model) => normalizeProviderModel(provider, model, config))
    .filter((model): model is ClientModel => model !== null)
}

export async function getProviderModelRecords(
  providerConfig: ResolvedProviderConfig,
  requestHeaders: Headers,
): Promise<Array<Record<string, unknown>>> {
  const localModels = getLocalProviderModelRecords(
    providerConfig.name,
    providerConfig,
  )
  if (localModels !== undefined) return localModels

  try {
    const response = await forwardProviderModels(providerConfig, requestHeaders)
    if (!response.ok) {
      return getFallbackProviderModelRecords(providerConfig.name, "non_ok", {
        statusCode: response.status,
      })
    }

    const body: unknown = await response.json()
    if (!isRecord(body) || !Array.isArray(body.data)) {
      return getFallbackProviderModelRecords(
        providerConfig.name,
        "invalid_body",
      )
    }

    return body.data.filter(isRecord).map(normalizeModelCapabilities)
  } catch (error) {
    return getFallbackProviderModelRecords(providerConfig.name, "error", {
      error,
    })
  }
}

type ProviderModelSelector = (
  providerConfig: ProviderConfig | null,
  models: Array<unknown>,
) => Array<unknown>

interface ModelSelectors {
  selectCopilotModels?: (models: Array<Model>) => Array<Model>
  selectProviderModels?: ProviderModelSelector
}

export function getCopilotModelRecords(): Array<Model> {
  return isGitHubCopilotEnabled() ? (state.models?.data ?? []) : []
}

export function getModelsById(
  models: Array<unknown>,
): Map<string, Record<string, unknown>> {
  return new Map(
    models.flatMap((model) => {
      if (!isRecord(model)) return []
      const id = getStringField(model, "id")
      return id ? [[id, model] as const] : []
    }),
  )
}

export function deduplicateModels<T>(
  models: Array<T>,
  getId: (model: T) => string,
): Array<T> {
  const seen = new Set<string>()
  return models.filter((model) => {
    const id = getId(model)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

async function getProviderModels(
  provider: string,
  requestHeaders: Headers,
  selectModels?: ProviderModelSelector,
): Promise<Array<ClientModel>> {
  try {
    const providerConfig = await resolveProviderConfig(provider)
    if (!providerConfig) return []

    const models =
      providerConfig.name === "codex" ?
        getCodexModels().data.map(normalizeModelCapabilities)
      : await getProviderModelRecords(providerConfig, requestHeaders)
    return normalizeProviderModels(
      providerConfig.name,
      selectModels?.(providerConfig, models) ?? models,
      providerConfig,
    )
  } catch (error) {
    if (provider === "codex") {
      logger.warn("models.provider.skip_error", { provider, error })
      return []
    }

    const fallbackModels = getFallbackProviderModelRecords(provider, "error", {
      error,
    })
    const providerConfig = getRawProviderConfig(provider)
    return normalizeProviderModels(
      provider,
      selectModels?.(providerConfig, fallbackModels) ?? fallbackModels,
      providerConfig,
    )
  }
}

export async function getAggregatedModels(
  requestHeaders: Headers,
  selectors: ModelSelectors = {},
): Promise<Array<ClientModel>> {
  const rawCopilotModels = getCopilotModelRecords()
  const copilotModels = (
    selectors.selectCopilotModels?.(rawCopilotModels) ?? rawCopilotModels
  ).map(normalizeCopilotModel)
  const providerModelsByProvider = await Promise.all(
    listEnabledProviders().map((provider) =>
      getProviderModels(
        provider,
        requestHeaders,
        selectors.selectProviderModels,
      ),
    ),
  )

  return deduplicateModels(
    [...copilotModels, ...providerModelsByProvider.flat()],
    (model) => model.id,
  )
}

function selectAgentCopilotModels(models: Array<Model>): Array<Model> {
  const selection = getProviderAgentModels(
    getRawProviderConfig(GITHUB_COPILOT_PROVIDER),
  )
  if (selection === undefined) return models
  return models.filter(
    (model) =>
      selection.includes(model.id)
      || selection.includes(toClientModelId(model.id)),
  )
}

function selectAgentProviderModels(
  providerConfig: ProviderConfig | null,
  models: Array<unknown>,
): Array<unknown> {
  const selection = getProviderAgentModels(providerConfig)
  if (selection === undefined) return models
  const modelsById = getModelsById(models)
  return selection.map((id) => modelsById.get(id) ?? { id })
}

export async function getAgentModels(
  requestHeaders: Headers,
): Promise<Array<ClientModel>> {
  return getAggregatedModels(requestHeaders, {
    selectCopilotModels: selectAgentCopilotModels,
    selectProviderModels: selectAgentProviderModels,
  })
}

export function createModelListResponse(
  c: Context,
  models: Array<{ id: string }>,
): Response {
  return c.json({
    object: "list",
    data: models,
    has_more: false,
  })
}
