import { ipcMain } from 'electron'

import { invalidateConfigCache } from '../../../src/lib/config/config-store'
import { saveProviderManagementConfig } from '../../../src/lib/config/provider-management'
import { detectBunRuntime } from '../bun-runtime'
import { configEditorReply } from '../config-editor'
import { tMain } from '../i18n'
import { getDesktopProviderManagementConfig } from '../provider-management'
import { loadProviderModelOptions } from '../provider-model-options'
import { readServerKeysConfig } from '../server-auth-config'
import { getHost, getPort, isRunning, startServer } from '../server-manager'
import { shouldRestartServerForSettings } from '../settings-runtime'
import { readSettings, writeSettings } from '../settings-store'
import { runSettingsTransaction } from '../settings-transaction'
import { isValidServerHost } from '../../src/lib/server-url'
import type { DesktopSettings } from '../../src/types/ipc'

import {
  fetchModelMappingsConfig,
  saveModelMappingsViaApi,
  type IpcHandlerContext,
} from './shared'

export function registerConfigAndSettingsIpcHandlers({
  appConfigEditor,
  options,
  saveAndRefreshConfig,
  setActiveAdminApiKey,
}: IpcHandlerContext): void {
  // Settings
  ipcMain.handle('settings:get', async () => readSettings())
  ipcMain.handle('settings:get-bun-runtime', () => detectBunRuntime())
  ipcMain.handle('settings:save', async (_event, settings: DesktopSettings) => {
    if (!isValidServerHost(settings?.host ?? '')) {
      throw new Error(await tMain('server.invalidHost'))
    }
    await saveAndRefreshConfig(async () => {
      const prev = await readSettings()
      let previousListener: { port: number; host: string } | undefined
      let replacementStarted = false

      const restartGateway = async (
        port: number,
        next: DesktopSettings,
        host = next.host,
      ) => {
        const status = await startServer(port, {
          runtime: next.serverRuntime,
          host,
          verbose: next.verbose,
          showToken: next.showToken,
          proxy: options.getEffectiveProxySettings?.(next) ?? next.proxy,
        })
        if (!status.running) {
          throw new Error(status.error ?? (await tMain('server.restartFailed')))
        }
      }

      await runSettingsTransaction(
        async () => {
          await options.onBeforeSettingsSave?.(settings, prev)
          if (isRunning() && shouldRestartServerForSettings(prev, settings)) {
            const port = getPort()
            previousListener = { port, host: getHost() }
            await restartGateway(port, settings)
            replacementStarted = true
          }
        },
        () => writeSettings(settings),
        async () => {
          try {
            await options.onBeforeSettingsSave?.(prev, settings)
          } finally {
            if (previousListener && (replacementStarted || !isRunning())) {
              await restartGateway(
                previousListener.port,
                prev,
                previousListener.host,
              )
              setActiveAdminApiKey((await readServerKeysConfig()).adminApiKey)
            }
          }
        },
      )
      if (replacementStarted) {
        setActiveAdminApiKey((await readServerKeysConfig()).adminApiKey)
      }
      await options.onSettingsChange?.(settings, prev)
    })
  })

  // Config
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
    return getDesktopProviderManagementConfig()
  })
  ipcMain.handle('config:save-provider-management', (_event, input: unknown) =>
    saveAndRefreshConfig(() =>
      getDesktopProviderManagementConfig(saveProviderManagementConfig(input)),
    ),
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
}
