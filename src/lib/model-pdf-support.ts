import type { ResolvedProviderConfig } from "~/lib/config"
import type { Model } from "~/lib/types/models"

import { builtinProviderModelRegistry } from "~/lib/builtin-provider-models"
import { GITHUB_COPILOT_PROVIDER } from "~/lib/github-copilot-provider"
import { getModelsDevModel } from "~/lib/models-dev-cache"
import { resolveProviderModelsDevId } from "~/lib/provider-model-catalog"

interface PdfSupportOptions {
  supportPdf?: boolean
  catalogInputModalities?: unknown
  supportedMediaTypes?: unknown
  builtinSupportPdf?: boolean
}

export function resolveModelPdfSupport(
  provider: string,
  options: PdfSupportOptions,
): boolean {
  if (options.supportPdf !== undefined) return options.supportPdf

  return (
    options.builtinSupportPdf === true
    || (provider === GITHUB_COPILOT_PROVIDER
      && Array.isArray(options.supportedMediaTypes)
      && options.supportedMediaTypes.includes("application/pdf"))
    || (Array.isArray(options.catalogInputModalities)
      && options.catalogInputModalities.includes("pdf"))
  )
}

export function getProviderModelPdfSupport(
  modelId: string,
  provider: Pick<
    ResolvedProviderConfig,
    "name" | "modelsDevProviderId" | "models"
  >
    & Partial<Pick<ResolvedProviderConfig, "baseUrl">>,
  selectedModel?: Model,
): boolean {
  const rawId = selectedModel?.id ?? modelId
  const modelConfig = provider.models?.[rawId] ?? provider.models?.[modelId]
  const catalogProvider = resolveProviderModelsDevId(provider.name, provider)
  const catalog =
    getModelsDevModel(catalogProvider, rawId)
    ?? getModelsDevModel(catalogProvider, modelId)
  const builtin = builtinProviderModelRegistry.getModelConfig(
    provider.name,
    rawId,
  )

  return resolveModelPdfSupport(provider.name, {
    supportPdf: modelConfig?.supportPdf,
    catalogInputModalities: catalog?.modalities?.input,
    supportedMediaTypes:
      selectedModel?.capabilities.limits.vision?.supported_media_types,
    builtinSupportPdf:
      builtin?.supportPdf
      ?? builtinProviderModelRegistry.getProviderDefaults(provider.name)
        ?.supportPdf,
  })
}
