import { isGitHubCopilotEnabled } from '../../src/lib/github-copilot-provider'
import {
  getRawProviderConfig,
  isSupportedProviderType,
  listEnabledProviders,
  normalizeProviderBaseUrl,
  setProviderConfig,
  type ProviderAuthType,
  type ProviderConfig,
  type ProviderType,
} from '../../src/lib/config'
import { loginCodex } from '../../src/lib/oauth/codex'
import { loginXai, type XaiAuthInfo } from '../../src/lib/oauth/xai'
import { persistXaiCredentials } from '../../src/lib/xai-token'
import { QUICK_PROVIDER_CONFIGS } from '../../src/lib/quick-providers'
import {
  getCodexAccounts,
  persistCodexCredentials,
  removeCodexAccount,
  selectCodexAccount,
} from '../../src/lib/token'
import type {
  AuthResult,
  AuthStatus,
  CodexAccountSummary,
  DesktopAuthMode,
  ProviderAuthInput,
} from '../src/types/ipc'
import { getGitHubUser, readToken } from './auth'

const CUSTOM_PROVIDER_AUTH_TYPES = [
  'x-api-key',
  'x-goog-api-key',
  'authorization',
] as const

interface AuthStatusDependencies {
  listEnabledProviders?: () => string[]
  isGitHubCopilotEnabled?: () => boolean
  readToken?: () => Promise<string | null>
  verifyGitHubToken?: (token: string) => Promise<void>
}

interface ProviderConfigDependencies {
  getEnabledProviders?: () => string[]
  getRawProviderConfig?: (name: string) => ProviderConfig | null
  setProviderConfig?: (name: string, provider: ProviderConfig) => ProviderConfig
}

export interface CodexDesktopLoginOptions {
  alias?: string
  callbackUrlOrCode?: string
  onAuthUrl?: (url: string) => void
  onSaving?: () => void
  signal?: AbortSignal
}

interface CodexDesktopLoginDependencies {
  getEnabledProviders?: () => string[]
  loginCodex?: typeof loginCodex
  persistCodexCredentials?: typeof persistCodexCredentials
}

interface CodexDesktopAccountDependencies {
  getCodexAccounts?: typeof getCodexAccounts
  getEnabledProviders?: () => string[]
  removeCodexAccount?: typeof removeCodexAccount
  selectCodexAccount?: typeof selectCodexAccount
}

function isCustomProviderAuthType(value: string): value is ProviderAuthType {
  return CUSTOM_PROVIDER_AUTH_TYPES.includes(
    value as (typeof CUSTOM_PROVIDER_AUTH_TYPES)[number],
  )
}

function assertCustomProviderName(providerName: string): void {
  if (!providerName) {
    throw new Error('Provider name must be a non-empty string')
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(providerName)) {
    throw new Error(
      'Provider name must start with a letter or number and contain only letters, numbers, underscores, or hyphens',
    )
  }

  if (
    providerName === 'copilot'
    || providerName === 'github-copilot'
    || providerName === 'codex'
  ) {
    throw new Error(
      `Provider name '${providerName}' is reserved for a builtin provider`,
    )
  }
}

function resolveInputAuthType(
  authType: string | undefined,
): ProviderAuthType | undefined {
  if (!authType || authType === '__default__') {
    return undefined
  }

  if (isCustomProviderAuthType(authType)) {
    return authType
  }

  throw new Error('No provider auth type selected')
}

function normalizeRequiredApiKey(apiKey: string): string {
  const normalizedApiKey = apiKey.trim()
  if (!normalizedApiKey) {
    throw new Error('apiKey must be a non-empty string')
  }
  return normalizedApiKey
}

function normalizeRequiredBaseUrl(baseUrl: string): string {
  const normalizedBaseUrl = normalizeProviderBaseUrl(baseUrl)
  if (!normalizedBaseUrl) {
    throw new Error('baseUrl must be a non-empty string')
  }
  return normalizedBaseUrl
}

function normalizeProviderType(type: string): ProviderType {
  if (!isSupportedProviderType(type)) {
    throw new Error('No provider type selected')
  }
  return type
}

function buildProviderConfig(
  existingProviderConfig: ProviderConfig,
  options: {
    apiKey: string
    authType?: ProviderAuthType
    baseUrl: string
    pricingCurrency?: string
    type: ProviderType
    modelsDevProviderId?: string
  },
): ProviderConfig {
  return {
    type: options.type,
    enabled: true,
    baseUrl: options.baseUrl,
    ...(options.modelsDevProviderId ?
      { modelsDevProviderId: options.modelsDevProviderId }
    : {}),
    apiKey: options.apiKey,
    ...(options.authType ? { authType: options.authType } : {}),
    pricingCurrency:
      options.pricingCurrency ?? existingProviderConfig.pricingCurrency,
    ...(existingProviderConfig.agentsModels !== undefined ?
      { agentsModels: existingProviderConfig.agentsModels }
    : {}),
    ...(existingProviderConfig.models ?
      { models: existingProviderConfig.models }
    : {}),
  }
}

function getStatusForEnabledProviders(providers: string[]): AuthStatus {
  if (providers.length > 0) {
    return {
      success: true,
      mode: 'provider',
      providers,
    }
  }

  return {
    success: false,
    mode: 'none',
    providers: [],
  }
}

export function getEnabledDesktopProviders(): string[] {
  return listEnabledProviders()
}

export async function getDesktopAuthStatus(
  dependencies: AuthStatusDependencies = {},
): Promise<AuthStatus> {
  const readSavedToken = dependencies.readToken ?? readToken
  const verifyGitHubToken =
    dependencies.verifyGitHubToken
    ?? (async (token: string) => {
      await getGitHubUser(token)
    })
  const getEnabledProviders =
    dependencies.listEnabledProviders ?? getEnabledDesktopProviders

  const token = await readSavedToken()
  if (
    token
    && (dependencies.isGitHubCopilotEnabled ?? isGitHubCopilotEnabled)()
  ) {
    try {
      await verifyGitHubToken(token)
      return {
        success: true,
        mode: 'copilot',
      }
    } catch {
      // Fall through to provider-only status when a saved GitHub token is stale.
    }
  }

  return getStatusForEnabledProviders(getEnabledProviders())
}

export function configureDesktopProvider(
  input: ProviderAuthInput,
  dependencies: ProviderConfigDependencies = {},
): AuthResult {
  const readProviderConfig =
    dependencies.getRawProviderConfig ?? getRawProviderConfig
  const writeProviderConfig =
    dependencies.setProviderConfig ?? setProviderConfig
  const getEnabledProviders =
    dependencies.getEnabledProviders ?? getEnabledDesktopProviders

  if (input.provider === 'custom') {
    const providerName = input.name.trim()
    assertCustomProviderName(providerName)

    const type = normalizeProviderType(input.type)
    const authType = resolveInputAuthType(input.authType)
    const existingProviderConfig = readProviderConfig(providerName) ?? {}

    writeProviderConfig(
      providerName,
      buildProviderConfig(existingProviderConfig, {
        apiKey: normalizeRequiredApiKey(input.apiKey),
        authType,
        baseUrl: normalizeRequiredBaseUrl(input.baseUrl),
        modelsDevProviderId: input.modelsDevProviderId,
        type,
      }),
    )

    return {
      success: true,
      mode: 'provider',
      providers: getEnabledProviders(),
    }
  }

  const quickProviderConfig = QUICK_PROVIDER_CONFIGS[input.provider]
  const type =
    quickProviderConfig.editableType ?
      normalizeProviderType(input.type ?? quickProviderConfig.type)
    : quickProviderConfig.type
  const baseUrl = normalizeRequiredBaseUrl(
    input.baseUrl?.trim() || quickProviderConfig.baseUrl,
  )
  const existingProviderConfig = readProviderConfig(input.provider) ?? {}

  writeProviderConfig(
    input.provider,
    buildProviderConfig(existingProviderConfig, {
      apiKey: normalizeRequiredApiKey(input.apiKey),
      baseUrl,
      pricingCurrency: quickProviderConfig.pricingCurrency,
      type,
    }),
  )

  return {
    success: true,
    mode: 'provider',
    providers: getEnabledProviders(),
  }
}

export interface ConfigureProviderStatusDependencies
  extends ProviderConfigDependencies, AuthStatusDependencies {}

export async function configureProviderWithAuthStatus(
  input: ProviderAuthInput,
  dependencies: ConfigureProviderStatusDependencies = {},
): Promise<AuthStatus> {
  configureDesktopProvider(input, dependencies)
  return getDesktopAuthStatus(dependencies)
}

export async function loginCodexForDesktop(
  options: CodexDesktopLoginOptions,
  dependencies: CodexDesktopLoginDependencies = {},
): Promise<AuthResult> {
  options.signal?.throwIfAborted()
  const login = dependencies.loginCodex ?? loginCodex
  const persistCredentials =
    dependencies.persistCodexCredentials ?? persistCodexCredentials
  const getEnabledProviders =
    dependencies.getEnabledProviders ?? getEnabledDesktopProviders

  const credentials = await login({
    signal: options.signal,
    onAuth(info) {
      options.onAuthUrl?.(info.url)
    },
    onPrompt() {
      return Promise.resolve(options.callbackUrlOrCode?.trim() ?? '')
    },
  })

  options.signal?.throwIfAborted()
  options.onSaving?.()
  await persistCredentials(credentials, {
    activateAccount: true,
    alias: options.alias?.trim() || undefined,
    enableProvider: true,
  })

  return {
    success: true,
    mode: 'provider',
    providers: getEnabledProviders(),
  }
}

export async function getDesktopCodexAccounts(
  dependencies: Pick<CodexDesktopAccountDependencies, 'getCodexAccounts'> = {},
): Promise<Array<CodexAccountSummary>> {
  const listAccounts = dependencies.getCodexAccounts ?? getCodexAccounts
  return await listAccounts()
}

export interface XaiDesktopLoginOptions {
  alias?: string
  onAuth?: (info: XaiAuthInfo) => void
  onSaving?: () => void
  signal?: AbortSignal
}

export async function loginXaiForDesktop(
  options: XaiDesktopLoginOptions,
  dependencies: {
    loginXai?: typeof loginXai
    persistXaiCredentials?: typeof persistXaiCredentials
    getEnabledProviders?: () => string[]
  } = {},
): Promise<AuthResult> {
  options.signal?.throwIfAborted()
  const credentials = await (dependencies.loginXai ?? loginXai)({
    onAuth: (info) => options.onAuth?.(info),
    signal: options.signal,
  })
  options.signal?.throwIfAborted()
  options.onSaving?.()
  await (dependencies.persistXaiCredentials ?? persistXaiCredentials)(
    credentials,
    { alias: options.alias?.trim() || undefined },
  )
  return {
    success: true,
    mode: 'provider',
    providers: (
      dependencies.getEnabledProviders ?? getEnabledDesktopProviders
    )(),
  }
}

export async function selectCodexAccountForDesktop(
  accountId: string,
  dependencies: CodexDesktopAccountDependencies = {},
): Promise<AuthResult> {
  const selectAccount = dependencies.selectCodexAccount ?? selectCodexAccount
  const getEnabledProviders =
    dependencies.getEnabledProviders ?? getEnabledDesktopProviders

  return await updateDesktopAccount(
    () => selectAccount(accountId),
    getEnabledProviders,
  )
}

export async function removeCodexAccountForDesktop(
  accountId: string,
  dependencies: CodexDesktopAccountDependencies = {},
): Promise<AuthResult> {
  const removeAccount = dependencies.removeCodexAccount ?? removeCodexAccount
  const getEnabledProviders =
    dependencies.getEnabledProviders ?? getEnabledDesktopProviders

  return await updateDesktopAccount(
    () => removeAccount(accountId),
    getEnabledProviders,
  )
}

export async function updateDesktopAccount(
  operation: () => Promise<CodexAccountSummary>,
  getEnabledProviders = getEnabledDesktopProviders,
): Promise<AuthResult> {
  await operation()
  return {
    success: true,
    mode: 'provider',
    providers: getEnabledProviders(),
  }
}

export function shouldStartInProviderMode(
  mode: DesktopAuthMode | undefined,
): boolean {
  return mode === 'provider'
}
