import type { CodexReasoningEffort, ProviderConfig } from "~/lib/config"
import { getModelsDevModel } from "~/lib/models-dev-cache"
import {
  getProviderModelConfig,
  resolveProviderModelsDevId,
} from "~/lib/provider-model-catalog"
import {
  firstPositiveInteger,
  getRecordField,
  getStringField,
  getStringList,
} from "~/routes/models/model-discovery"

function normalizeMetadata(fields?: {
  contextWindow?: unknown
  maxOutputTokens?: unknown
  inputModalities?: unknown
  reasoningEfforts?: unknown
  defaultReasoningEffort?: CodexReasoningEffort
}) {
  const contextWindow = firstPositiveInteger(fields?.contextWindow)
  const maxOutputTokens = firstPositiveInteger(fields?.maxOutputTokens)
  const inputModalities = getStringList(fields?.inputModalities)
  const reasoningEfforts = getStringList(fields?.reasoningEfforts)
  return {
    ...(contextWindow && { contextWindow }),
    ...(maxOutputTokens && { maxOutputTokens }),
    ...(inputModalities && { inputModalities }),
    ...(reasoningEfforts && { reasoningEfforts }),
    ...(fields?.defaultReasoningEffort && {
      defaultReasoningEffort: fields.defaultReasoningEffort,
    }),
  }
}

export function getModelMetadata(
  provider: string,
  modelId: string,
  model: Record<string, unknown>,
  config: ProviderConfig | null,
) {
  const clientId = getStringField(model, "id") ?? modelId
  const modelConfig = config?.models?.[modelId] ?? config?.models?.[clientId]
  const catalogProvider = resolveProviderModelsDevId(provider, config)
  const catalog =
    getModelsDevModel(catalogProvider, modelId)
    ?? getModelsDevModel(catalogProvider, clientId)
  const defaults =
    getProviderModelConfig(provider, modelId, config)
    ?? getProviderModelConfig(provider, clientId, config)
  const capabilities = getRecordField(model, "capabilities")
  const supports = getRecordField(capabilities, "supports")
  const limits = getRecordField(capabilities, "limits")
  const metadata = {
    ...defaults,
    ...normalizeMetadata({
      contextWindow: model.context_window,
      maxOutputTokens: model.max_output_tokens,
      inputModalities: model.input_modalities,
      reasoningEfforts: model.reasoning_efforts,
    }),
    ...normalizeMetadata(modelConfig),
  }

  return {
    modelConfig,
    catalog,
    defaults,
    capabilities,
    supports,
    limits,
    ...metadata,
    inputLimit: firstPositiveInteger(model.input_limit, catalog?.limit?.input),
    inputModalities: metadata.inputModalities ?? ["text"],
    reasoningEfforts: metadata.reasoningEfforts ?? [],
  }
}
