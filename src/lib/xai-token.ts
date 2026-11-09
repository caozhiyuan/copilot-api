import {
  getRawProviderConfig,
  readEditableConfigFromDisk,
  setProviderConfig,
  type ProviderConfig,
} from "~/lib/config"
import { withCredentialFileLock } from "~/lib/credential-store"
import { createOAuthAccountManager } from "~/lib/oauth-accounts"
import {
  isXaiCredentialsExpired,
  refreshXaiCredentials,
  XAI_API_BASE_URL,
  type XaiCredentials,
} from "~/lib/oauth/xai"
import { PATHS } from "~/lib/paths"
import { requestContext, type RequestContext } from "~/lib/request-context"

function syncXaiProviderConfig(accountId: string, enable = false): void {
  const {
    apiKey: _apiKey,
    modelsDevProviderId: _catalog,
    ...existing
  } = readEditableConfigFromDisk().providers?.xai ?? {}
  setProviderConfig("xai", {
    ...existing,
    type: "openai-responses",
    enabled: enable ? true : existing.enabled,
    baseUrl: XAI_API_BASE_URL,
    authType: "oauth2",
    accountId,
    pricingCurrency: "USD",
  })
}

const xaiAccounts = createOAuthAccountManager({
  provider: "xai",
  label: "xAI",
  credentialPath: () => PATHS.XAI_CREDENTIAL_PATH,
  selectAccount: (accountId) => syncXaiProviderConfig(accountId),
})
export const getXaiAccounts = xaiAccounts.list
export const selectXaiAccount = xaiAccounts.select
export const removeXaiAccount = xaiAccounts.remove

export async function readXaiCredentials(
  accountId = getRawProviderConfig("xai")?.accountId,
): Promise<XaiCredentials | null> {
  return await xaiAccounts.store.readCredentials(accountId)
}

export function persistXaiCredentials(
  credentials: XaiCredentials,
  options: { alias?: string } = {},
): Promise<void> {
  return xaiAccounts.withMutationLock(async () => {
    await xaiAccounts.store.writeCredentials(credentials, {
      alias: options.alias,
    })
    syncXaiProviderConfig(credentials.accountId, true)
  })
}

const refreshInFlight = new Map<string, Promise<string | null>>()
const pendingPersistence = new Map<string, XaiCredentials>()
const requestAccessTokens = new WeakMap<
  RequestContext,
  { config: ProviderConfig | null; accessToken: Promise<string | null> }
>()

export async function getXaiAccessToken(): Promise<string | null> {
  const request = requestContext.getStore()
  if (!request) return loadXaiAccessToken()

  const config = getRawProviderConfig("xai")
  const cached = requestAccessTokens.get(request)
  if (cached?.config === config) return cached.accessToken

  const accessToken = loadXaiAccessToken()
  requestAccessTokens.set(request, { config, accessToken })
  try {
    return await accessToken
  } catch (error) {
    if (requestAccessTokens.get(request)?.accessToken === accessToken)
      requestAccessTokens.delete(request)
    throw error
  }
}

async function loadXaiAccessToken(): Promise<string | null> {
  const credentials = await readXaiCredentials()
  if (!credentials || !isXaiCredentialsExpired(credentials))
    return credentials?.accessToken ?? null
  const key = `${credentials.accountId}:${credentials.refreshToken}`
  const inFlight = refreshInFlight.get(key)
  if (inFlight) return await inFlight

  const refresh = withCredentialFileLock(
    `${PATHS.XAI_CREDENTIAL_PATH}.refresh`,
    async () => {
      const current = await readXaiCredentials(credentials.accountId)
      if (!current) return null
      if (!isXaiCredentialsExpired(current)) return current.accessToken
      const currentKey = `${current.accountId}:${current.refreshToken}`
      const refreshed =
        pendingPersistence.get(currentKey)
        ?? (await refreshXaiCredentials(current))
      pendingPersistence.set(currentKey, refreshed)
      await xaiAccounts.store.writeCredentials(refreshed, {
        insertIfMissing: false,
        expectedRefreshToken: current.refreshToken,
      })
      pendingPersistence.delete(currentKey)
      return (
        (await readXaiCredentials(credentials.accountId))?.accessToken ?? null
      )
    },
  ).finally(() => {
    refreshInFlight.delete(key)
  })
  refreshInFlight.set(key, refresh)
  return await refresh
}
