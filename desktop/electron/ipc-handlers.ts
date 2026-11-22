import { invalidateConfigCache } from '../../src/lib/config/config-store'
import { resolveLiveWindow } from './app-lifecycle'
import { createAppConfigEditor } from './config-editor'
import { createConfigRefresher } from './config-refresh'
import { registerAuthIpcHandlers } from './ipc/auth'
import { registerClientsAndMediaIpcHandlers } from './ipc/clients-media'
import { registerConfigAndSettingsIpcHandlers } from './ipc/config-settings'
import { registerServerAndUsageIpcHandlers } from './ipc/server-usage'
import {
  readConfigApiError,
  type IpcHandlerContext,
  type IpcHandlersOptions,
  type MainWindowSource,
} from './ipc/shared'
import { registerWindowAndShellIpcHandlers } from './ipc/window-shell'
import { readServerKeysConfig } from './server-auth-config'
import { getServerBaseUrl, isRunning } from './server-manager'

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
  mainWindow: MainWindowSource,
  options: IpcHandlersOptions = {},
): void {
  const readWindow =
    typeof mainWindow === 'function' ? mainWindow : () => mainWindow
  const getMainWindow = () => resolveLiveWindow(readWindow)
  const onMainWindowClosed = (listener: () => void) => {
    if (options.onWindowClosed) {
      options.onWindowClosed(listener)
      return
    }
    readWindow()?.once?.('closed', listener)
  }

  const ctx: IpcHandlerContext = {
    getMainWindow,
    onMainWindowClosed,
    options,
    saveAndRefreshConfig,
    setActiveAdminApiKey,
    saveCredentialsAndRefresh,
    appConfigEditor,
  }

  registerClientsAndMediaIpcHandlers(ctx)
  registerAuthIpcHandlers(ctx)
  registerServerAndUsageIpcHandlers(ctx)
  registerConfigAndSettingsIpcHandlers(ctx)
  registerWindowAndShellIpcHandlers(ctx)
}
