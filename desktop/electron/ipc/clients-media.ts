import path from 'node:path'

import { app, dialog, ipcMain, nativeImage, shell } from 'electron'

import {
  clientIntegrationReply,
  createClientIntegrations,
} from '../client-integrations'
import { compressVideoImage } from '../compress-video-image'
import {
  createMediaStudioClient,
  mediaFileExtension,
  saveMediaFile,
  validateMediaUrl,
} from '../media-studio'
import { readServerKeysConfig } from '../server-auth-config'
import {
  getHost,
  getPort,
  getServerBaseUrl,
  isRunning,
} from '../server-manager'
import { readSettings } from '../settings-store'
import { buildServerBaseUrl } from '../../src/lib/server-url'
import type {
  ImageCreationInput,
  SaveMediaInput,
  VideoCreationInput,
} from '../../src/types/media'

import { getServerRequestHeaders, type IpcHandlerContext } from './shared'

export function registerClientsAndMediaIpcHandlers({
  mainWindow,
}: IpcHandlerContext): void {
  let clientIntegrations:
    ReturnType<typeof createClientIntegrations> | undefined
  const clients = () =>
    (clientIntegrations ??= createClientIntegrations({
      dataDir: path.join(app.getPath('userData'), 'client-integrations'),
      resourceDir:
        app.isPackaged ?
          path.join(process.resourcesPath, 'client-plugins')
        : path.resolve(app.getAppPath(), '..'),
      getGateway: async () => {
        const settings = await readSettings()
        const keys = await readServerKeysConfig()
        return {
          baseUrl: buildServerBaseUrl(
            isRunning() ? getHost() : settings.host,
            isRunning() ? getPort() : settings.lastPort,
          ),
          apiKeys: keys.apiKeys,
        }
      },
    }))

  ipcMain.handle('clients:get-state', (_event, agent: unknown) =>
    clientIntegrationReply(() => clients().getState(agent)),
  )
  ipcMain.handle('clients:get-models', (_event, client: unknown) =>
    clientIntegrationReply(() => clients().getModels(client)),
  )
  ipcMain.handle('clients:setup', (_event, input: unknown) =>
    clientIntegrationReply(() => clients().setup(input)),
  )
  ipcMain.handle(
    'clients:restore',
    (_event, client: unknown, revision: unknown) =>
      clientIntegrationReply(() => clients().restore(client, revision)),
  )
  ipcMain.handle('clients:open-config', (_event, client: unknown) =>
    clientIntegrationReply(async () => {
      const error = await shell.openPath(clients().openPath(client))
      if (error) throw new Error('operationFailed')
    }),
  )

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
}
