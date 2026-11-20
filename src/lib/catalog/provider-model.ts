import type { Model } from "~/lib/types/models"

export interface ProviderModelAlias {
  model: string
  provider: string
}

export const parseProviderModelAlias = (
  model: string,
): ProviderModelAlias | null => {
  const separatorIndex = model.indexOf("/")
  if (separatorIndex <= 0 || separatorIndex === model.length - 1) {
    return null
  }

  const provider = model.slice(0, separatorIndex).trim()
  const providerModel = model.slice(separatorIndex + 1).trim()
  if (!provider || !providerModel) {
    return null
  }

  return {
    model: providerModel,
    provider,
  }
}

export const createFallbackModel = (modelId: string): Model => ({
  capabilities: {
    family: "provider",
    limits: {},
    object: "model_capabilities",
    supports: {},
    tokenizer: "o200k_base",
    type: "chat",
  },
  id: modelId,
  model_picker_enabled: false,
  name: modelId,
  object: "model",
  preview: false,
  vendor: "provider",
  version: "unknown",
})
