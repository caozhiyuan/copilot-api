import fs from 'node:fs/promises'

import { ipcMain, shell, BrowserWindow, dialog, nativeImage } from 'electron'

import {
  createMediaStudioClient,
  mediaFileExtension,
  saveMediaFile,
  validateMediaUrl,
} from './media-studio'
import { compressVideoImage } from './compress-video-image'
import type {
  ImageCreationInput,
  SaveMediaInput,
  VideoCreationInput,
} from '../src/types/media'

import { normalizeApiKeys } from '../../src/lib/request-auth'
import { CodexOAuthError } from '../../src/lib/oauth/codex'
import { XaiOAuthError, type XaiAuthInfo } from '../../src/lib/oauth/xai'
import { createOAuthLoginFlow } from './oauth-login'
import {
  getXaiAccounts,
  selectXaiAccount,
  removeXaiAccount,
} from '../../src/lib/xai-token'
import { loadModelsDevProviderOptions } from '../../src/lib/models-dev-cache'
import { PATHS } from '../../src/lib/paths'
import { invalidateConfigCache } from '../../src/lib/config-store'
import { loadProviderModelOptions } from './provider-model-options'
import {
  getProviderManagementConfig,
  saveProviderManagementConfig,
} from '../../src/lib/provider-management'
import {
  isValidServerHost,
  resolveEffectiveServerHost,
} from '../src/lib/server-url'
import {
  getDeviceCode,
  pollAccessToken,
  getGitHubUser,
  saveToken,
  readToken,
  clearToken,
  getCopilotAccountType,
} from './auth'
import {
  createDeviceFlowStarter,
  createDeviceFlowTokenHandler,
} from './device-flow'
import { tMain } from './i18n'
import {
  configureProviderWithAuthStatus,
  getDesktopCodexAccounts,
  getDesktopAuthStatus,
  getEnabledDesktopProviders,
  loginCodexForDesktop,
  loginXaiForDesktop,
  updateDesktopAccount,
  removeCodexAccountForDesktop,
  selectCodexAccountForDesktop,
  shouldStartInProviderMode,
} from './provider-auth'
import {
  startServer,
  stopServer,
  getPort,
  getHost,
  getServerBaseUrl,
  getLogs,
  isRunning,
} from './server-manager'
import { readSettings, writeSettings } from './settings-store'
import { runSettingsTransaction } from './settings-transaction'
import { createConfigRefresher } from './config-refresh'
import { configEditorReply, createAppConfigEditor } from './config-editor'
import { shouldRestartServerForSettings } from './settings-runtime'
import { detectBunRuntime } from './bun-runtime'
import {
  readServerKeysConfig,
  writeServerKeysConfig,
} from './server-auth-config'
import type {
  AuthResult,
  CodexLoginInput,
  XaiLoginInput,
  DesktopAuthMode,
  DesktopProxySettings,
  DesktopSettings,
  ModelMappingsConfig,
  ProviderAuthInput,
  ServerAuthInfo,
  ServerKeysConfigUpdate,
  SubscriptionProvider,
  SubscriptionUsage,
} from '../src/types/ipc'

interface ConfigApiErrorResponse {
  error?: {
    message?: string
  }
}

type ServerAuthScope = 'default' | 'admin'

interface IpcHandlersOptions {
  getEffectiveProxySettings?: (
    settings: DesktopSettings,
  ) => DesktopProxySettings
  onSettingsChange?: (
    settings: DesktopSettings,
    prevSettings: DesktopSettings,
  ) => void | Promise<void>
  onBeforeSettingsSave?: (
    settings: DesktopSettings,
    prevSettings: DesktopSettings,
  ) => void | Promise<void>
  onQuit?: () => void | Promise<void>
}

function normalizeApiKey(apiKey: unknown): string | null {
  if (typeof apiKey !== 'string') {
    return null
  }

  const normalizedApiKey = apiKey.trim()
  return normalizedApiKey || null
}

async function getServerAuthInfo(
  scope: ServerAuthScope = 'default',
): Promise<ServerAuthInfo> {
  try {
    const raw = await fs.readFile(PATHS.CONFIG_PATH, 'utf8')
    const parsed =
      raw.trim() ?
        (JSON.parse(raw) as {
          auth?: { apiKeys?: unknown; adminApiKey?: unknown }
        })
      : {}
    const apiKey =
      scope === 'admin' ?
        normalizeApiKey(parsed.auth?.adminApiKey)
      : (normalizeApiKeys(parsed.auth?.apiKeys)[0] ?? null)

    if (!apiKey) {
      return { enabled: false }
    }

    return {
      enabled: true,
      headerName: 'x-api-key',
      headerValue: apiKey,
    }
  } catch {
    return { enabled: false }
  }
}

async function getServerRequestHeaders(
  scope: ServerAuthScope = 'default',
): Promise<Record<string, string> | undefined> {
  const authInfo = await getServerAuthInfo(scope)
  if (!authInfo.enabled || !authInfo.headerName || !authInfo.headerValue) {
    return undefined
  }

  return {
    [authInfo.headerName]: authInfo.headerValue,
  }
}

function getConfigApiBaseUrl(): string {
  if (!isRunning()) {
    throw new Error(
      'Server is not running. Start the service before editing advanced config.',
    )
  }

  return `${getServerBaseUrl()}/admin/config/model-mappings`
}

async function readConfigApiError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as ConfigApiErrorResponse
    return payload.error?.message ?? response.statusText
  } catch {
    return response.statusText
  }
}

async function fetchModelMappingsConfig(): Promise<ModelMappingsConfig> {
  const headers = await getServerRequestHeaders('admin')
  const response = await fetch(getConfigApiBaseUrl(), {
    headers,
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) {
    throw new Error(await readConfigApiError(response))
  }

  return (await response.json()) as ModelMappingsConfig
}

async function saveModelMappingsViaApi(
  modelMappings: Record<string, string>,
): Promise<void> {
  const headers = await getServerRequestHeaders('admin')
  const response = await fetch(getConfigApiBaseUrl(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({ modelMappings }),
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) {
    throw new Error(await readConfigApiError(response))
  }
}

const { saveAndRefresh: saveAndRefreshConfig, setActiveAdminApiKey } =
  createConfigRefresher({
    isRunning,
    readAdminApiKey: async () => (await readServerKeysConfig()).adminApiKey,
    invalidateConfigCache,
    reloadConfig: async (adminApiKeys) => {
      try {
        let response: Response | undefined
        for (const adminApiKey of adminApiKeys) {
          response = await fetch(`${getServerBaseUrl()}/admin/config/reload`, {
            method: 'POST',
            headers: { 'x-api-key': adminApiKey },
            signal: AbortSignal.timeout(60_000),
          })
          if (response.status !== 401) break
        }
        if (!response?.ok) {
          throw new Error(
            response ?
              await readConfigApiError(response)
            : 'Admin API key is missing',
          )
        }
      } catch (error) {
        throw new Error(
          `Configuration saved, but refresh failed: ${(error as Error).message}`,
        )
      }
    },
  })

// A failed refresh leaves the running service on the previous configuration,
// but the credentials are already persisted. Sign-in must still finish, so the
// stale server is reported as a warning instead of failing the whole call.
function saveCredentialsAndRefresh(save: () => Promise<void>): Promise<void> {
  return saveAndRefreshConfig(save, {
    ignoreRefreshFailure: true,
    onRefreshError: (error) => {
      console.warn(
        'Credentials saved, but the running server did not refresh:',
        error,
      )
    },
  })
}

const appConfigEditor = createAppConfigEditor({
  saveAndRefresh: saveAndRefreshConfig,
})

export function registerIpcHandlers(
  mainWindow: BrowserWindow,
  options: IpcHandlersOptions = {},
): void {
  const mediaClient = createMediaStudioClient({
    getBaseUrl: () => {
      if (!isRunning())
        throw new Error('Start the server before creating media')
      return getServerBaseUrl()
    },
    getHeaders: () => getServerRequestHeaders(),
  })
  mainWindow.once?.('closed', () => mediaClient.cancelAll())
  ipcMain.handle(
    'media:create-images',
    (_event, id: string, input: ImageCreationInput) =>
      mediaClient.createImages(id, input),
  )
  ipcMain.handle(
    'media:create-video',
    (_event, id: string, input: VideoCreationInput) =>
      mediaClient.createVideo(
        id,
        input.image ?
          {
            ...input,
            image: compressVideoImage(input.image, (bytes) =>
              nativeImage.createFromBuffer(Buffer.from(bytes)),
            ),
          }
        : input,
      ),
  )
  ipcMain.handle('media:get-video', (_event, id: string, requestId: string) =>
    mediaClient.getVideo(id, requestId),
  )
  ipcMain.handle('media:cancel', (_event, id: string) => mediaClient.cancel(id))
  ipcMain.handle('media:save', async (_event, input: SaveMediaInput) => {
    validateMediaUrl(input.url, input.kind)
    const extension = mediaFileExtension(input)
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: `copilot-${Date.now()}.${extension}`,
      filters: [
        {
          name: input.kind === 'video' ? 'Video' : 'Image',
          extensions:
            input.kind === 'video' ?
              ['mp4']
            : ['png', 'jpg', 'jpeg', 'webp', 'gif'],
        },
      ],
    })
    if (result.canceled || !result.filePath) return false
    await saveMediaFile(input, result.filePath)
    return true
  })
  ipcMain.handle('auth:get-status', async () => getDesktopAuthStatus())

  // Auth: Start the OAuth device flow. The token is polled in the background
  // and the renderer is notified when it arrives; starting a new flow aborts
  // polling and finalization so a superseded flow cannot report a late result.
  const startDeviceFlow = createDeviceFlowStarter({
    getDeviceCode,
    pollAccessToken: (deviceCode, signal) =>
      pollAccessToken(deviceCode, undefined, { signal }),
    onToken: createDeviceFlowTokenHandler({
      getGitHubUser,
      getCopilotAccountType,
      readSettings,
      saveToken: (token, signal) =>
        saveCredentialsAndRefresh(() => {
          signal.throwIfAborted()
          return saveToken(token)
        }),
      writeSettings,
      onSuccess: () => {
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send('auth:success', {
            success: true,
            mode: 'copilot',
          })
        }
      },
    }),
    onError: (err) => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('auth:success', {
          success: false,
          error: err.message,
        })
      }
    },
  })
  ipcMain.handle('auth:get-device-code', () => startDeviceFlow())

  // Auth: Save token directly
  ipcMain.handle('auth:save-token', async (_event, token: string) => {
    try {
      const [, accountType] = await Promise.all([
        getGitHubUser(token),
        getCopilotAccountType(token),
      ])
      await saveCredentialsAndRefresh(() => saveToken(token))
      // Detect and persist the account type automatically
      const settings = await readSettings()
      await writeSettings({ ...settings, accountType })
      return { success: true, mode: 'copilot' }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  // Auth: Check the saved token
  ipcMain.handle('auth:check-saved', async () => getDesktopAuthStatus())

  ipcMain.handle(
    'auth:configure-provider',
    async (_event, input: ProviderAuthInput) => {
      try {
        return await saveAndRefreshConfig(() =>
          configureProviderWithAuthStatus(input),
        )
      } catch (err) {
        return { success: false, mode: 'none', error: (err as Error).message }
      }
    },
  )

  ipcMain.handle(
    'auth:get-models-dev-providers',
    async () => await loadModelsDevProviderOptions(),
  )

  ipcMain.handle(
    'auth:get-codex-accounts',
    async () => await getDesktopCodexAccounts(),
  )

  ipcMain.handle(
    'auth:switch-codex-account',
    async (_event, accountId: string) => {
      try {
        return await saveAndRefreshConfig(() =>
          selectCodexAccountForDesktop(accountId),
        )
      } catch (err) {
        return { success: false, mode: 'none', error: (err as Error).message }
      }
    },
  )

  ipcMain.handle(
    'auth:remove-codex-account',
    async (_event, accountId: string) => {
      try {
        return await saveAndRefreshConfig(() =>
          removeCodexAccountForDesktop(accountId),
        )
      } catch (err) {
        return { success: false, mode: 'none', error: (err as Error).message }
      }
    },
  )

  const codexLogin = createOAuthLoginFlow<CodexLoginInput, string>({
    login: (input, callbacks) =>
      saveAndRefreshConfig(() =>
        loginCodexForDesktop({
          ...input,
          ...callbacks,
          onAuthUrl: callbacks.onAuth,
        }),
      ),
    onAuth: (url) => {
      if (!mainWindow.isDestroyed())
        mainWindow.webContents.send('auth:codex-url', url)
    },
    onSaving: () => {
      if (!mainWindow.isDestroyed())
        mainWindow.webContents.send('auth:codex-saving')
    },
    inProgressError: () => tMain('auth.codexLoginInProgress'),
    formatError: (error) =>
      error instanceof CodexOAuthError ?
        tMain(
          error.reason === 'callback_timeout' ?
            'auth.codexAuthTimeout'
          : 'auth.codexCallbackUnavailable',
        )
      : Promise.resolve(error instanceof Error ? error.message : String(error)),
  })
  ipcMain.handle('auth:cancel-codex-login', () => codexLogin.cancel())
  ipcMain.handle(
    'auth:start-codex-login',
    (_event, input: CodexLoginInput = {}) => codexLogin.start(input),
  )

  ipcMain.handle('auth:get-xai-accounts', () => getXaiAccounts())
  for (const [channel, operation] of [
    ['auth:switch-xai-account', selectXaiAccount],
    ['auth:remove-xai-account', removeXaiAccount],
  ] as const) {
    ipcMain.handle(
      channel,
      async (_event, accountId: string): Promise<AuthResult> => {
        try {
          return await saveAndRefreshConfig(() =>
            updateDesktopAccount(() => operation(accountId)),
          )
        } catch (error) {
          return {
            success: false,
            mode: 'none',
            error: error instanceof Error ? error.message : String(error),
          }
        }
      },
    )
  }

  const xaiLogin = createOAuthLoginFlow<XaiLoginInput, XaiAuthInfo>({
    login: (input, callbacks) =>
      saveAndRefreshConfig(() =>
        loginXaiForDesktop({ ...input, ...callbacks }),
      ),
    onAuth: (info) => {
      if (!mainWindow.isDestroyed())
        mainWindow.webContents.send('auth:xai-code', info)
    },
    onSaving: () => {
      if (!mainWindow.isDestroyed())
        mainWindow.webContents.send('auth:xai-saving')
    },
    inProgressError: () => tMain('auth.xaiLoginInProgress'),
    formatError: (error) =>
      error instanceof XaiOAuthError ?
        tMain(
          error.reason === 'authorization_expired' ?
            'auth.xaiAuthExpired'
          : 'auth.xaiAuthDenied',
        )
      : Promise.resolve(error instanceof Error ? error.message : String(error)),
  })
  ipcMain.handle('auth:start-xai-login', (_event, input: XaiLoginInput = {}) =>
    xaiLogin.start(input),
  )
  ipcMain.handle('auth:cancel-xai-login', () => xaiLogin.cancel())
  mainWindow.once('closed', () => {
    codexLogin.cancel()
    xaiLogin.cancel()
  })

  // Auth: Log out
  ipcMain.handle('auth:logout', async () => {
    await saveAndRefreshConfig(() => clearToken())
  })

  // Server: Start
  ipcMain.handle(
    'server:start',
    async (_event, port: number, authMode?: DesktopAuthMode, host?: string) => {
      // CLI changes must be visible when the user starts or restarts the server.
      invalidateConfigCache()
      const token = await readToken()
      const providerMode = shouldStartInProviderMode(authMode)
      const enabledProviders = getEnabledDesktopProviders()
      const tokenForStart = providerMode ? null : token

      if (!tokenForStart && enabledProviders.length === 0) {
        return {
          running: false,
          error: await tMain('server.authRequired'),
        }
      }

      const settings = await readSettings()
      const effectiveHost = resolveEffectiveServerHost(host, settings.host)
      if (!isValidServerHost(effectiveHost)) {
        return {
          running: false,
          error: await tMain('server.invalidHost'),
        }
      }

      const serverOptions = {
        runtime: settings.serverRuntime,
        verbose: settings.verbose,
        showToken: settings.showToken,
        host: effectiveHost,
        proxy: options.getEffectiveProxySettings?.(settings) ?? settings.proxy,
      }

      try {
        const status = await startServer(port, serverOptions)
        if (status.running) {
          setActiveAdminApiKey((await readServerKeysConfig()).adminApiKey)
          // Persist only after a successful start so failed attempts never
          // clobber the last known good configuration.
          await writeSettings({
            ...settings,
            lastPort: port,
            ...(host === undefined ? {} : { host: effectiveHost }),
          })
        }
        return status
      } catch (err) {
        if (
          err instanceof Error
          && err.message.startsWith('Invalid server host')
        ) {
          return {
            running: false,
            error: await tMain('server.invalidHost'),
          }
        }
        throw err
      }
    },
  )

  // Server: Stop
  ipcMain.handle('server:stop', async () => {
    await stopServer()
    setActiveAdminApiKey(undefined)
  })

  ipcMain.handle('server:get-status', () => ({
    running: isRunning(),
    port: getPort(),
    host: getHost(),
  }))

  // Settings
  ipcMain.handle('settings:get', async () => readSettings())
  ipcMain.handle('settings:get-bun-runtime', () => detectBunRuntime())
  ipcMain.handle('settings:save', async (_event, settings: DesktopSettings) => {
    if (!isValidServerHost(settings?.host ?? '')) {
      throw new Error(await tMain('server.invalidHost'))
    }
    await saveAndRefreshConfig(async () => {
      const prev = await readSettings()
      await runSettingsTransaction(
        () => options.onBeforeSettingsSave?.(settings, prev),
        () => writeSettings(settings),
        () => options.onBeforeSettingsSave?.(prev, settings),
      )
      if (options.onSettingsChange) {
        await options.onSettingsChange(settings, prev)
      }
      if (isRunning() && shouldRestartServerForSettings(prev, settings)) {
        const status = await startServer(getPort(), {
          runtime: settings.serverRuntime,
          host: settings.host,
          verbose: settings.verbose,
          showToken: settings.showToken,
          proxy:
            options.getEffectiveProxySettings?.(settings) ?? settings.proxy,
        })
        if (!status.running) {
          throw new Error(status.error ?? (await tMain('server.restartFailed')))
        }
        setActiveAdminApiKey((await readServerKeysConfig()).adminApiKey)
      }
    })
  })
  ipcMain.handle('config:get-model-mappings', async () =>
    fetchModelMappingsConfig(),
  )
  ipcMain.handle('config:get-document', () =>
    configEditorReply(() => appConfigEditor.read(), 'readFailed'),
  )
  ipcMain.handle('config:save-document', (_event, input: unknown) =>
    configEditorReply(() => appConfigEditor.save(input), 'saveFailed'),
  )
  ipcMain.handle('config:apply-document', (_event, revision: unknown) =>
    configEditorReply(() => appConfigEditor.apply(revision), 'applyFailed'),
  )
  ipcMain.handle('config:get-provider-management', () => {
    invalidateConfigCache()
    return getProviderManagementConfig()
  })
  ipcMain.handle('config:save-provider-management', (_event, input: unknown) =>
    saveAndRefreshConfig(() => saveProviderManagementConfig(input)),
  )
  ipcMain.handle('config:get-provider-model-options', () =>
    loadProviderModelOptions(),
  )
  ipcMain.handle(
    'config:save-model-mappings',
    async (_event, modelMappings: Record<string, string>) => {
      await saveAndRefreshConfig(() => saveModelMappingsViaApi(modelMappings))
    },
  )

  ipcMain.handle('auth:get-server-keys', () => readServerKeysConfig())
  ipcMain.handle(
    'auth:save-server-keys',
    async (_event, keys: ServerKeysConfigUpdate) => {
      await saveAndRefreshConfig(() => writeServerKeysConfig(keys))
      return await readServerKeysConfig()
    },
  )

  // Shell: Open the system browser
  ipcMain.handle('shell:open-url', async (_event, url: string) => {
    await shell.openExternal(url)
  })

  // Server: Proxy HTTP requests through the main process to bypass file:// origin CORS in the renderer
  ipcMain.handle(
    'server:fetch-subscription-usage',
    async (_event, provider: SubscriptionProvider) => {
      if (
        provider !== 'codex'
        && provider !== 'xai'
        && provider !== 'github-copilot'
        && provider !== 'opencode-go'
      ) {
        throw new Error('Unsupported subscription provider')
      }
      const headers = await getServerRequestHeaders()
      const response = await fetch(`${getServerBaseUrl()}/usage/${provider}`, {
        headers,
        // Allow for a credential refresh before the bounded upstream query.
        signal: AbortSignal.timeout(60_000),
      })
      if (response.status === 404) return null
      if (!response.ok) throw new Error('Failed to fetch subscription usage')
      return (await response.json()) as SubscriptionUsage
    },
  )

  ipcMain.handle('server:fetch-usage', async () => {
    const baseUrl = getServerBaseUrl()
    try {
      const headers = await getServerRequestHeaders()
      const res = await fetch(`${baseUrl}/usage`, {
        headers,
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) return null
      return (await res.json()) as unknown
    } catch {
      return null
    }
  })

  ipcMain.handle('server:fetch-models', async () => {
    const baseUrl = getServerBaseUrl()
    try {
      const headers = await getServerRequestHeaders()
      const res = await fetch(`${baseUrl}/models`, {
        headers,
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) return null
      return (await res.json()) as unknown
    } catch {
      return null
    }
  })

  const TOKEN_USAGE_PERIODS = new Set([
    'today',
    'this_week',
    'last_7_days',
    'this_month',
    'last_30_days',
    'lifetime',
  ])

  ipcMain.handle('server:fetch-token-usage', async (_event, period: string) => {
    const baseUrl = getServerBaseUrl()
    const normalizedPeriod = TOKEN_USAGE_PERIODS.has(period) ? period : 'today'
    try {
      const headers = await getServerRequestHeaders()
      const res = await fetch(
        `${baseUrl}/token-usage?period=${normalizedPeriod}`,
        {
          headers,
          signal: AbortSignal.timeout(5000),
        },
      )
      if (!res.ok) return null
      return (await res.json()) as unknown
    } catch {
      return null
    }
  })

  ipcMain.handle(
    'server:fetch-token-usage-daily',
    async (_event, period: string) => {
      const baseUrl = getServerBaseUrl()
      const normalizedPeriod =
        TOKEN_USAGE_PERIODS.has(period) ? period : 'today'
      try {
        const headers = await getServerRequestHeaders()
        const res = await fetch(
          `${baseUrl}/token-usage/daily?period=${normalizedPeriod}`,
          {
            headers,
            signal: AbortSignal.timeout(5000),
          },
        )
        if (!res.ok) return null
        return (await res.json()) as unknown
      } catch {
        return null
      }
    },
  )

  ipcMain.handle(
    'server:fetch-token-usage-events',
    async (_event, period: string, page: number, pageSize: number) => {
      const baseUrl = getServerBaseUrl()
      const normalizedPeriod =
        TOKEN_USAGE_PERIODS.has(period) ? period : 'today'
      const normalizedPage =
        Number.isFinite(page) && page > 0 ? Math.floor(page) : 1
      const normalizedPageSize =
        Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : 20
      const params = new URLSearchParams({
        page: String(normalizedPage),
        page_size: String(normalizedPageSize),
        period: normalizedPeriod,
      })
      try {
        const headers = await getServerRequestHeaders()
        const res = await fetch(
          `${baseUrl}/token-usage/events?${params.toString()}`,
          {
            headers,
            signal: AbortSignal.timeout(5000),
          },
        )
        if (!res.ok) return null
        return (await res.json()) as unknown
      } catch {
        return null
      }
    },
  )

  ipcMain.handle(
    'server:fetch-token-usage-sessions',
    async (_event, period: string, page: number, pageSize: number) => {
      const baseUrl = getServerBaseUrl()
      const normalizedPeriod =
        TOKEN_USAGE_PERIODS.has(period) ? period : 'today'
      const normalizedPage =
        Number.isFinite(page) && page > 0 ? Math.floor(page) : 1
      const normalizedPageSize =
        Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : 5
      const params = new URLSearchParams({
        page: String(normalizedPage),
        page_size: String(normalizedPageSize),
        period: normalizedPeriod,
      })
      try {
        const headers = await getServerRequestHeaders()
        const res = await fetch(
          `${baseUrl}/token-usage/sessions?${params.toString()}`,
          {
            headers,
            signal: AbortSignal.timeout(5000),
          },
        )
        if (!res.ok) return null
        return (await res.json()) as unknown
      } catch {
        return null
      }
    },
  )

  ipcMain.handle('server:get-auth-info', async () => getServerAuthInfo())

  // Server: Return the in-memory log buffer
  ipcMain.handle('server:get-logs', () => getLogs())

  // Window controls (used by the custom title bar menu)
  ipcMain.on('window:reload', () => mainWindow.reload())
  ipcMain.on('window:minimize', () => mainWindow.minimize())
  ipcMain.on('window:maximize-toggle', () => {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow.maximize()
    }
  })
  ipcMain.on('window:close', () => mainWindow.close())
  ipcMain.on('window:quit', () => {
    void options.onQuit?.()
  })
  ipcMain.on('window:zoom-in', () => {
    const level = mainWindow.webContents.getZoomLevel()
    mainWindow.webContents.setZoomLevel(level + 0.5)
  })
  ipcMain.on('window:zoom-out', () => {
    const level = mainWindow.webContents.getZoomLevel()
    mainWindow.webContents.setZoomLevel(level - 0.5)
  })
  ipcMain.on('window:zoom-reset', () => mainWindow.webContents.setZoomLevel(0))

  ipcMain.handle('window:is-maximized', () => mainWindow.isMaximized())
}
