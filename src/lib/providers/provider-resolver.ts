import {
  getRawProviderConfig,
  getProviderConfig,
  type ResolvedProviderConfig,
} from "~/lib/config"
import {
  parseProviderModelAlias,
  type ProviderModelAlias,
} from "~/lib/catalog/provider-model"
import { state } from "~/lib/state"
import { setupCodexToken } from "~/lib/auth/token"
import { getXaiAccessToken } from "~/lib/auth/xai-token"
import { XAI_API_BASE_URL } from "~/lib/auth/oauth/xai"

const AZURE_OPENAI_SCOPE = "https://cognitiveservices.azure.com/.default"

type AzureAccessTokenProvider = () => Promise<string>

let cachedAzureAccessTokenProvider: Promise<AzureAccessTokenProvider> | null =
  null

/**
 * Lazily creates the Entra token provider on first use and reuses it
 * afterwards. Importing @azure/identity eagerly adds ~0.5s to every process
 * startup, and constructing a new DefaultAzureCredential per call would drop
 * the token cache, so both the import and the credential are singletons.
 */
async function getAzureAccessTokenProvider(): Promise<AzureAccessTokenProvider> {
  cachedAzureAccessTokenProvider ??= (async () => {
    try {
      const { DefaultAzureCredential, getBearerTokenProvider } = await import(
        "@azure/identity"
      )
      return getBearerTokenProvider(
        new DefaultAzureCredential(),
        AZURE_OPENAI_SCOPE,
      )
    } catch (error) {
      cachedAzureAccessTokenProvider = null
      throw error
    }
  })()
  return cachedAzureAccessTokenProvider
}

async function getDefaultAzureAccessToken(): Promise<string> {
  return (await getAzureAccessTokenProvider())()
}

function isMissingCodexCredentialsError(error: unknown): boolean {
  return (
    error instanceof Error
    && error.message
      === "Codex credentials not found. Run `copilot-api auth login --provider codex` first."
  )
}

export async function resolveProviderConfig(
  providerName: string,
  getAzureAccessToken: () => Promise<string> = getDefaultAzureAccessToken,
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
  if (providerConfig?.name === "xai" && providerConfig.authType === "oauth2") {
    const accessToken = await getXaiAccessToken()
    return accessToken ?
        {
          ...providerConfig,
          baseUrl:
            providerConfig.baseUrl === "https://api.x.ai" ?
              XAI_API_BASE_URL
            : providerConfig.baseUrl,
          apiKey: accessToken,
        }
      : null
  }
  if (providerConfig?.authType !== "azure-entra") {
    return providerConfig
  }

  try {
    return { ...providerConfig, apiKey: await getAzureAccessToken() }
  } catch (error) {
    throw new Error(
      `Failed to acquire Azure Entra token for provider '${normalizedProviderName}': ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    )
  }
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
