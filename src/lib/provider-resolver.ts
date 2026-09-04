import { DefaultAzureCredential, getBearerTokenProvider } from "@azure/identity"

import {
  getRawProviderConfig,
  getProviderConfig,
  type ResolvedProviderConfig,
} from "~/lib/config"
import {
  parseProviderModelAlias,
  type ProviderModelAlias,
} from "~/lib/provider-model"
import { state } from "~/lib/state"
import { setupCodexToken } from "~/lib/token"

const getAzureOpenAIAccessToken = getBearerTokenProvider(
  new DefaultAzureCredential(),
  "https://cognitiveservices.azure.com/.default",
)

function isMissingCodexCredentialsError(error: unknown): boolean {
  return (
    error instanceof Error
    && error.message
      === "Codex credentials not found. Run `copilot-api auth login --provider codex` first."
  )
}

export async function resolveProviderConfig(
  providerName: string,
  getAzureAccessToken: () => Promise<string> = getAzureOpenAIAccessToken,
): Promise<ResolvedProviderConfig | null> {
  const normalizedProviderName = providerName.trim()
  if (!normalizedProviderName) {
    return null
  }

  if (normalizedProviderName === "codex") {
    const rawProviderConfig = getRawProviderConfig(normalizedProviderName)
    if (rawProviderConfig?.enabled === false) {
      return null
    }

    try {
      await setupCodexToken()
    } catch (error) {
      if (isMissingCodexCredentialsError(error)) {
        return null
      }
      throw error
    }

    const providerConfig = getProviderConfig(normalizedProviderName)
    if (!providerConfig) {
      return null
    }

    return {
      ...providerConfig,
      apiKey: state.codexAccessToken ?? providerConfig.apiKey,
    }
  }

  const providerConfig = getProviderConfig(normalizedProviderName)
  return providerConfig?.authType === "azure-entra" ?
      { ...providerConfig, apiKey: await getAzureAccessToken() }
    : providerConfig
}

export type ProviderConfigResolver = typeof resolveProviderConfig

/**
 * Returns the parsed "provider/model" alias only when that provider is
 * actually configured, otherwise null so the caller falls through to its
 * default flow. GitHub Copilot enterprise models can ship with namespaced ids
 * such as "org/family/model": without this check the first segment is
 * misrouted to a non-existent provider and surfaced as a 400/404.
 */
export async function ensureConfiguredProviderModelAlias(
  alias: ProviderModelAlias | null,
  resolveConfig: ProviderConfigResolver = resolveProviderConfig,
): Promise<ProviderModelAlias | null> {
  if (!alias) {
    return null
  }

  return (await resolveConfig(alias.provider)) ? alias : null
}

/** parseProviderModelAlias + ensureConfiguredProviderModelAlias. */
export async function resolveConfiguredProviderModelAlias(
  model: string,
  resolveConfig: ProviderConfigResolver = resolveProviderConfig,
): Promise<ProviderModelAlias | null> {
  return ensureConfiguredProviderModelAlias(
    parseProviderModelAlias(model),
    resolveConfig,
  )
}
