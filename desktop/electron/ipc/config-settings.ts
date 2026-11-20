import { ipcMain } from 'electron'

import { invalidateConfigCache } from '../../../src/lib/config/config-store'
import { saveProviderManagementConfig } from '../../../src/lib/config/provider-management'
import { detectBunRuntime } from '../bun-runtime'
import { configEditorReply } from '../config-editor'
import { tMain } from '../i18n'
import { getDesktopProviderManagementConfig } from '../provider-management'
import { loadProviderModelOptions } from '../provider-model-options'
import { readServerKeysConfig } from '../server-auth-config'
import { getPort, isRunning, startServer } from '../server-manager'
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
