import { AppUpdater } from 'electron-updater'
import type { AppAdapter } from 'electron-updater/out/AppAdapter'
import type { DownloadUpdateOptions } from 'electron-updater/out/AppUpdater'
import type { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  exportUpdatePackage,
  hasDmgBaseline,
  saveDmgBaseline,
  verifyUpdateFile,
} from './update-files'

// AppUpdater's download extension points are shared with NSIS. Do not use
// MacUpdater: its ZIP hand-off initializes Squirrel.Mac's signed installer.
export class MacDmgUpdater extends AppUpdater {
  private downloadedPackage: { file: string; sha512: string } | null = null
  // Present at runtime in electron-updater 6.x but omitted from its declarations.
  // Keep this compatibility declaration contained in this adapter.
  declare readonly httpExecutor: ElectronHttpExecutor | null

  constructor(
    private readonly downloadsDirectory: string,
    app?: AppAdapter,
  ) {
    super(undefined, app)
  }

  quitAndInstall(): never {
    throw new Error('Use the desktop macOS package installer')
  }

  async verifyPackage(file: string): Promise<void> {
    if (this.downloadedPackage?.file !== file)
      throw new Error('No verified macOS update package')
    await verifyUpdateFile(file, this.downloadedPackage.sha512)
  }

  protected async doDownloadUpdate(options: DownloadUpdateOptions) {
    const { provider, info } = options.updateInfoAndProvider
    const filename = `Copilot.API-${info.version}-${process.arch}.dmg`
    const fileInfo = provider
      .resolveFiles(info)
      .find(
        (file) =>
          path.basename(decodeURIComponent(file.url.pathname)) === filename,
      )
    if (!fileInfo)
      throw new Error(`No macOS update package for ${process.arch}`)
    const executor = this.httpExecutor
    if (!executor) throw new Error('Update HTTP executor is unavailable')

    return this.executeDownload({
      fileExtension: 'dmg',
      fileInfo,
      downloadUpdateOptions: options,
      task: async (destination, downloadOptions) => {
        const helper = this.downloadedUpdateHelper
        if (!helper) throw new Error('Update cache is unavailable')
        const usableBaseline =
          !options.disableDifferentialDownload
          && (await hasDmgBaseline(helper.cacheDir))
        const needsFullDownload =
          !usableBaseline
          || (await this.differentialDownloadInstaller(
            fileInfo,
            options,
            destination,
            provider,
            'current.dmg',
          ))
        if (needsFullDownload)
          await executor.download(fileInfo.url, destination, downloadOptions)

        // A first/full download also needs the new blockmap so that the next
        // update can reuse this DMG without downloading an old installer first.
        const blockmap = path.join(
          helper.cacheDirForPendingUpdate,
          'current.blockmap',
        )
        try {
          await readFile(blockmap)
        } catch {
          try {
            const [, url] = await provider.getBlockMapFiles(
              fileInfo.url,
              info.version,
              info.version,
              null,
            )
            const data = await executor.downloadToBuffer(url, {
              headers: options.requestHeaders,
              cancellationToken: options.cancellationToken,
            })
            if (data) await writeFile(blockmap, data)
          } catch (error) {
            this._logger.warn(
              `Cannot cache macOS update blockmap: ${String(error)}`,
            )
          }
        }
      },
      done: async (event) => {
        const helper = this.downloadedUpdateHelper
        if (!helper) throw new Error('Update cache is unavailable')
        const blockmap = path.join(
          helper.cacheDirForPendingUpdate,
          'current.blockmap',
        )
        try {
          await saveDmgBaseline(
            helper.cacheDir,
            event.downloadedFile,
            blockmap,
            info.version,
            fileInfo.info.sha512,
          )
        } catch (error) {
          // Prevent executeDownload from promoting a mapping without its DMG.
          await rm(blockmap, { force: true })
          this._logger.warn(
            `Cannot cache macOS update baseline: ${String(error)}`,
          )
        }
        const downloadedFile = await exportUpdatePackage(
          event.downloadedFile,
          this.downloadsDirectory,
          filename,
          fileInfo.info.sha512,
        )
        this.downloadedPackage = {
          file: downloadedFile,
          sha512: fileInfo.info.sha512,
        }
        this.dispatchUpdateDownloaded({ ...event, downloadedFile })
      },
    })
  }
}
