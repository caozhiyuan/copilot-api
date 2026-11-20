import { ipcMain } from 'electron'

import { invalidateConfigCache } from '../../../src/lib/config/config-store'
import { readToken } from '../auth'
import { tMain } from '../i18n'
import {
  getEnabledDesktopProviders,
  shouldStartInProviderMode,
} from '../provider-auth'
import { readServerKeysConfig } from '../server-auth-config'
import {
  clearLogs,
  getHost,
  getLogs,
  getPort,
  getServerBaseUrl,
  isRunning,
  startServer,
  stopServer,
} from '../server-manager'
import { readSettings, writeSettings } from '../settings-store'
import {
  isValidServerHost,
  resolveEffectiveServerHost,
} from '../../src/lib/server-url'
import type {
  DesktopAuthMode,
  SubscriptionProvider,
  SubscriptionUsage,
} from '../../src/types/ipc'

import {
  getServerAuthInfo,
  getServerRequestHeaders,
  type IpcHandlerContext,
} from './shared'

const TOKEN_USAGE_PERIODS = new Set([
  'today',
  'this_week',
  'last_7_days',
  'this_month',
  'last_30_days',
  'lifetime',
])

function normalizePeriod(period: string): string {
  return TOKEN_USAGE_PERIODS.has(period) ? period : 'today'
}

async function fetchAdminTokenUsageJson(url: string): Promise<unknown> {
  try {
    const headers = await getServerRequestHeaders('admin')
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    return (await res.json()) as unknown
  } catch {
    return null
  }
}

export function registerServerAndUsageIpcHandlers({
  options,
  setActiveAdminApiKey,
}: IpcHandlerContext): void {
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
      const headers = await getServerRequestHeaders('admin')
      const response = await fetch(
        `${getServerBaseUrl()}/admin/usage/${provider}`,
        {
          headers,
          // Allow for a credential refresh before the bounded upstream query.
          signal: AbortSignal.timeout(60_000),
        },
      )
      if (response.status === 404) return null
      if (!response.ok) throw new Error('Failed to fetch subscription usage')
      return (await response.json()) as SubscriptionUsage
    },
  )

  ipcMain.handle('server:fetch-usage', async () =>
    fetchAdminTokenUsageJson(`${getServerBaseUrl()}/admin/usage`),
  )

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

  ipcMain.handle(
    'server:fetch-token-usage',
    async (_event, period: string, apiKeyId?: string) => {
      const normalizedPeriod = normalizePeriod(period)
      const query = `period=${normalizedPeriod}${apiKeyId ? '&api_key_id=' + encodeURIComponent(apiKeyId) : ''}`
      return fetchAdminTokenUsageJson(
        `${getServerBaseUrl()}/admin/token-usage?${query}`,
      )
    },
  )

  ipcMain.handle(
    'server:fetch-token-usage-daily',
    async (_event, period: string, apiKeyId?: string) => {
      const normalizedPeriod = normalizePeriod(period)
      const query = `period=${normalizedPeriod}${apiKeyId ? '&api_key_id=' + encodeURIComponent(apiKeyId) : ''}`
      return fetchAdminTokenUsageJson(
        `${getServerBaseUrl()}/admin/token-usage/daily?${query}`,
      )
    },
  )

  ipcMain.handle(
    'server:fetch-token-usage-events',
    async (
      _event,
      period: string,
      page: number,
      pageSize: number,
      apiKeyId?: string,
    ) => {
      const normalizedPage =
        Number.isFinite(page) && page > 0 ? Math.floor(page) : 1
      const normalizedPageSize =
        Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : 20
      const params = new URLSearchParams({
        page: String(normalizedPage),
        page_size: String(normalizedPageSize),
        period: normalizePeriod(period),
      })
      if (apiKeyId) params.set('api_key_id', apiKeyId)
      return fetchAdminTokenUsageJson(
        `${getServerBaseUrl()}/admin/token-usage/events?${params.toString()}`,
      )
    },
  )

  ipcMain.handle(
    'server:fetch-token-usage-sessions',
    async (
      _event,
      period: string,
      page: number,
      pageSize: number,
      apiKeyId?: string,
    ) => {
      const normalizedPage =
        Number.isFinite(page) && page > 0 ? Math.floor(page) : 1
      const normalizedPageSize =
        Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : 5
      const params = new URLSearchParams({
        page: String(normalizedPage),
        page_size: String(normalizedPageSize),
        period: normalizePeriod(period),
      })
      if (apiKeyId) params.set('api_key_id', apiKeyId)
      return fetchAdminTokenUsageJson(
        `${getServerBaseUrl()}/admin/token-usage/sessions?${params.toString()}`,
      )
    },
  )

  ipcMain.handle('server:get-auth-info', async () => getServerAuthInfo())

  // Server: Return the in-memory log buffer
  ipcMain.handle('server:get-logs', () => getLogs())
  ipcMain.handle('server:clear-logs', () => clearLogs())
}
