import type { BrowserWindow } from 'electron'

import type { createAppConfigEditor } from '../config-editor'
import type { createConfigRefresher } from '../config-refresh'
import { readServerKeysConfig } from '../server-auth-config'
import { getServerBaseUrl, isRunning } from '../server-manager'
import type {
  DesktopProxySettings,
  DesktopSettings,
  ModelMappingsConfig,
  ServerAuthInfo,
} from '../../src/types/ipc'

interface ConfigApiErrorResponse {
  error?: {
    message?: string
  }
}

export type ServerAuthScope = 'default' | 'admin'

export type MainWindowSource = BrowserWindow | (() => BrowserWindow | null)

export interface IpcHandlersOptions {
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
  onWindowClosed?: (listener: () => void) => void
}

export interface IpcHandlerContext {
  getMainWindow: () => BrowserWindow | null
  onMainWindowClosed: (listener: () => void) => void
  options: IpcHandlersOptions
  saveAndRefreshConfig: ReturnType<
    typeof createConfigRefresher
  >['saveAndRefresh']
  setActiveAdminApiKey: ReturnType<
    typeof createConfigRefresher
  >['setActiveAdminApiKey']
  saveCredentialsAndRefresh: (save: () => Promise<void>) => Promise<void>
  appConfigEditor: ReturnType<typeof createAppConfigEditor>
}

export async function getServerAuthInfo(
  scope: ServerAuthScope = 'default',
): Promise<ServerAuthInfo> {
  try {
    const { adminApiKey, apiKeys } = await readServerKeysConfig()
    const apiKey = scope === 'admin' ? adminApiKey : apiKeys[0]

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

export async function getServerRequestHeaders(
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

export function getConfigApiBaseUrl(): string {
  if (!isRunning()) {
    throw new Error(
      'Server is not running. Start the service before editing advanced config.',
    )
  }

  return `${getServerBaseUrl()}/admin/config/model-mappings`
}

export async function readConfigApiError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as ConfigApiErrorResponse
    return payload.error?.message ?? response.statusText
  } catch {
    return response.statusText
  }
}

export async function fetchModelMappingsConfig(): Promise<ModelMappingsConfig> {
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

export async function saveModelMappingsViaApi(
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
