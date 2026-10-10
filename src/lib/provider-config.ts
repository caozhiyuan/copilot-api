import consola from "consola"

import {
  SUPPORTED_PROVIDER_TYPES,
  getConfig,
  readEditableConfigFromDisk,
  reloadConfig,
  writeConfigToDisk,
  type ModelConfig,
  type ProviderAuthType,
  type ProviderConfig,
  type ProviderType,
} from "./config-store"
import {
  getModelsDevModelApi,
  getModelsDevModelPricing,
  getModelsDevModelProviderType,
  getModelsDevProviderApi,
  getOpencodeGoModelProviderType,
} from "./models-dev-cache"
import {
  resolveProviderModelsDevId,
  usesModelsDevModelCatalog,
} from "./provider-model-catalog"

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

export function normalizeProviderBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/u, "")
}

export function isSupportedProviderType(value: string): value is ProviderType {
  return SUPPORTED_PROVIDER_TYPES.includes(value as ProviderType)
}

function getDefaultProviderAuthType(
  providerType: ProviderType,
): ProviderAuthType {
  return providerType === "anthropic" ? "x-api-key" : "authorization"
}

export function resolveProviderAuthType(
  providerName: string,
  authType: string | undefined,
  providerType: ProviderType,
): ProviderAuthType {
  const defaultAuthType = getDefaultProviderAuthType(providerType)
  if (authType === undefined) {
    return defaultAuthType
  }

  if (authType === "x-api-key") {
    return "x-api-key"
  }

  if (authType === "oauth2") {
    if (providerName === "codex" || providerName === "xai") {
      return authType
    }

    consola.warn(
      `Provider ${providerName} has authType 'oauth2', which is only supported by the builtin codex and xai providers, falling back to ${defaultAuthType}`,
    )
    return defaultAuthType
  }

  if (authType === "authorization" || authType === "azure-entra") {
    return authType
  }

  consola.warn(
    `Provider ${providerName} has invalid authType '${authType}', falling back to ${defaultAuthType}`,
  )
  return defaultAuthType
}

function isProviderApiKeyRequired(
  providerName: string,
  authType: ProviderAuthType,
): boolean {
  return (
    authType !== "azure-entra"
    && !(
      (providerName === "codex" || providerName === "xai")
      && authType === "oauth2"
    )
  )
}

export function getRawProviderConfig(name: string): ProviderConfig | null {
  const providerName = name.trim()
  if (!providerName) {
    return null
  }

  const config = getConfig()
  return config.providers?.[providerName] ?? null
}

export function setProviderConfig(
  name: string,
  provider: ProviderConfig,
): ProviderConfig {
  const providerName = name.trim()
  if (!providerName) {
    throw new Error("Provider name must be a non-empty string")
  }

  if (isReservedProviderName(providerName)) {
    throw new Error(
      `Provider ${providerName} is reserved and cannot be configured in config.providers`,
    )
  }

  const editableConfig = readEditableConfigFromDisk()
  const nextConfig = {
    ...editableConfig,
    providers: {
      ...editableConfig.providers,
      [providerName]: provider,
    },
  }

  writeConfigToDisk(nextConfig)
  reloadConfig()
  return getRawProviderConfig(providerName) ?? provider
}

export function getProviderConfig(name: string): ResolvedProviderConfig | null {
  const providerName = name.trim()
  if (!providerName) {
    return null
  }

  if (isReservedProviderName(providerName)) {
    consola.warn(
      `Provider ${providerName} is reserved and cannot be configured in config.providers`,
    )
    return null
  }

  const provider = getRawProviderConfig(providerName)
  if (!provider) {
    return null
  }

  if (provider.enabled === false) {
    return null
  }

  const type = provider.type ?? "anthropic"
  if (!isSupportedProviderType(type)) {
    consola.warn(
      `Provider ${providerName} is ignored because type '${type}' is not supported`,
    )
    return null
  }

  const baseUrl = normalizeProviderBaseUrl(provider.baseUrl ?? "")
  const authType = resolveProviderAuthType(
    providerName,
    provider.authType,
    type,
  )
  const apiKey = (provider.apiKey ?? "").trim()
  const missingFields = [
    ...(baseUrl ? [] : ["baseUrl"]),
    ...(isProviderApiKeyRequired(providerName, authType) && !apiKey ?
      ["apiKey"]
    : []),
  ]

  if (missingFields.length > 0) {
    consola.warn(
      `Provider ${providerName} is enabled but missing ${missingFields.join(" or ")}`,
    )
    return null
  }

  return {
    name: providerName,
    type,
    baseUrl,
    modelsDevProviderId: provider.modelsDevProviderId,
    apiKey,
    authType,
    authTypeExplicit: provider.authType !== undefined,
    pricingCurrency: normalizePricingCurrency(provider.pricingCurrency),
    models: provider.models,
    agentsModels: provider.agentsModels,
  }
}

export function resolveEffectiveProviderType(
  providerConfig: ResolvedProviderConfig,
  model: string,
): ProviderType {
  const modelConfig = providerConfig.models?.[model]
  if (modelConfig?.type && isSupportedProviderType(modelConfig.type)) {
    return modelConfig.type
  }

  if (providerConfig.name === "opencode-go") {
    return getOpencodeGoModelProviderType(model)
  }

  if (providerConfig.modelsDevProviderId) {
    const catalogType = getModelsDevModelProviderType(
      providerConfig.modelsDevProviderId,
      model,
    )
    if (catalogType) return catalogType
  }

  if (providerConfig.name === "openrouter") {
    if (model.includes("gpt-")) {
      return "openai-responses"
    }
  }

  return providerConfig.type
}

export function resolveProviderConfigForModel(
  providerConfig: ResolvedProviderConfig,
  model: string,
): ResolvedProviderConfig {
  const type = resolveEffectiveProviderType(providerConfig, model)
  const modelApi =
    (
      providerConfig.modelsDevProviderId
      && providerConfig.baseUrl
        === getModelsDevProviderApi(providerConfig.modelsDevProviderId)
    ) ?
      getModelsDevModelApi(providerConfig.modelsDevProviderId, model)
    : undefined
  const configuredModel = providerConfig.models?.[model]
  const catalogPricing =
    (
      providerConfig.modelsDevProviderId
      || usesModelsDevModelCatalog(providerConfig.name)
    ) ?
      getModelsDevModelPricing(
        resolveProviderModelsDevId(providerConfig.name, providerConfig),
        model,
      )
    : undefined
  const useCatalogPricing =
    catalogPricing !== undefined && configuredModel?.pricing === undefined
  if (type === providerConfig.type && !modelApi && !useCatalogPricing) {
    return providerConfig
  }

  return {
    ...providerConfig,
    type,
    baseUrl: modelApi ?? providerConfig.baseUrl,
    models:
      useCatalogPricing ?
        {
          ...providerConfig.models,
          [model]: { ...configuredModel, pricing: catalogPricing },
        }
      : providerConfig.models,
    pricingCurrency: useCatalogPricing ? "USD" : providerConfig.pricingCurrency,
    authType:
      (
        type !== providerConfig.type
        && !providerConfig.authTypeExplicit
        && providerConfig.authType !== "azure-entra"
        && providerConfig.authType !== "oauth2"
      ) ?
        resolveProviderAuthType(providerConfig.name, undefined, type)
      : providerConfig.authType,
  }
}

function normalizePricingCurrency(
  value: string | undefined,
): string | undefined {
  const currency = value?.trim().toUpperCase()
  return currency || undefined
}

export function listEnabledProviders(): Array<string> {
  const config = getConfig()
  const providerNames = Object.keys(config.providers ?? {})
  return providerNames.filter(
    (name) => !isReservedProviderName(name) && getProviderConfig(name) !== null,
  )
}

export function isReservedProviderName(name: string): boolean {
  return name.trim() === "copilot" || name.trim() === "github-copilot"
}
