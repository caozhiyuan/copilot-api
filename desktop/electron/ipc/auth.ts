import { ipcMain } from 'electron'

import { CodexOAuthError } from '../../../src/lib/auth/oauth/codex'
import {
  XaiOAuthError,
  type XaiAuthInfo,
} from '../../../src/lib/auth/oauth/xai'
import {
  getXaiAccounts,
  removeXaiAccount,
  selectXaiAccount,
} from '../../../src/lib/auth/xai-token'
import { loadModelsDevProviderOptions } from '../../../src/lib/catalog/models-dev-cache'
import {
  removeConfiguredApiKey,
  upsertConfiguredApiKey,
} from '../../../src/lib/config/config-store'
import {
  clearToken,
  getCopilotAccountType,
  getDeviceCode,
  getGitHubUser,
  pollAccessToken,
  saveToken,
} from '../auth'
import {
  createDeviceFlowStarter,
  createDeviceFlowTokenHandler,
} from '../device-flow'
import { tMain } from '../i18n'
import { createOAuthLoginFlow } from '../oauth-login'
import {
  configureProviderWithAuthStatus,
  getDesktopAuthStatus,
  getDesktopCodexAccounts,
  loginCodexForDesktop,
  loginXaiForDesktop,
  removeCodexAccountForDesktop,
  selectCodexAccountForDesktop,
  updateDesktopAccount,
} from '../provider-auth'
import {
  parseApiKeyQuotaUsage,
  readManagedApiKeys,
  readServerKeysConfig,
  writeServerKeysConfig,
} from '../server-auth-config'
import { getServerBaseUrl, isRunning } from '../server-manager'
import { readSettings, writeSettings } from '../settings-store'
import type {
  AuthResult,
  CodexLoginInput,
  GatewayApiKeyConfig,
  ProviderAuthInput,
  ServerKeysConfigUpdate,
  XaiLoginInput,
} from '../../src/types/ipc'

import { getServerRequestHeaders, type IpcHandlerContext } from './shared'

export function registerAuthIpcHandlers({
  mainWindow,
  saveAndRefreshConfig,
  saveCredentialsAndRefresh,
}: IpcHandlerContext): void {
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

  ipcMain.handle('auth:get-managed-api-keys', () => readManagedApiKeys())
  ipcMain.handle(
    'auth:save-managed-api-key',
    async (_event, key: GatewayApiKeyConfig) => {
      await saveAndRefreshConfig(() => upsertConfiguredApiKey(key))
      return readManagedApiKeys()
    },
  )
  ipcMain.handle('auth:remove-managed-api-key', async (_event, id: string) => {
    await saveAndRefreshConfig(() => removeConfiguredApiKey(id))
    return readManagedApiKeys()
  })
  ipcMain.handle('auth:get-api-key-quota-usage', async () => {
    if (!isRunning()) return null
    const response = await fetch(getServerBaseUrl() + '/admin/api-keys/usage', {
      headers: await getServerRequestHeaders('admin'),
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) throw new Error('Failed to load API key quotas')
    return parseApiKeyQuotaUsage(await response.json())
  })
  ipcMain.handle('auth:get-server-keys', () => readServerKeysConfig())
  ipcMain.handle(
    'auth:save-server-keys',
    async (_event, keys: ServerKeysConfigUpdate) => {
      await saveAndRefreshConfig(() => writeServerKeysConfig(keys))
      return await readServerKeysConfig()
    },
  )
}
