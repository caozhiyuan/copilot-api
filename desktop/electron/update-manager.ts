import type { AppUpdater } from 'electron-updater'

import type { AppUpdateStatus } from '../src/types/ipc'
import { RELEASES_URL, type ReleaseUpdate } from './release-update'

export type DesktopUpdater = Pick<
  AppUpdater,
  | 'autoDownload'
  | 'autoInstallOnAppQuit'
  | 'allowPrerelease'
  | 'allowDowngrade'
  | 'on'
  | 'checkForUpdates'
  | 'downloadUpdate'
  | 'quitAndInstall'
>

interface UpdateManagerOptions {
  currentVersion: string
  enabled: boolean
  nativeUpdates: boolean
  checkRelease: () => Promise<ReleaseUpdate | null>
  beforeInstall: () => Promise<void>
  onStatus: (status: AppUpdateStatus) => void
  packageUpdates?: boolean
  installPackage?: (file: string, version: string) => Promise<void>
}

export function createUpdateManager(
  updater: DesktopUpdater,
  options: UpdateManagerOptions,
) {
  let status: AppUpdateStatus = {
    phase: options.enabled ? 'idle' : 'disabled',
    currentVersion: options.currentVersion,
    manualInstall: !options.nativeUpdates,
    releaseUrl: RELEASES_URL,
  }
  let checkPromise: Promise<AppUpdateStatus> | null = null
  let downloadPromise: Promise<AppUpdateStatus> | null = null
  let downloadedFile: string | undefined

  const getStatus = () => ({ ...status })
  const publish = (changes: Partial<AppUpdateStatus>) => {
    status = { ...status, ...changes }
    options.onStatus(getStatus())
  }
  const fail = (error: unknown) => {
    publish({
      phase: status.phase === 'installing' ? 'downloaded' : 'error',
      error: error instanceof Error ? error.message : String(error),
    })
  }

  // Downloads are started by the manager, so a second check cannot race a
  // pending download. Installation always requires the explicit UI action.
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  updater.allowPrerelease = false
  updater.allowDowngrade = false
  updater.on('update-available', (info) => {
    publish({
      phase: 'available',
      version: info.version,
      manualInstall: false,
      releaseUrl: `${RELEASES_URL}/tag/v${encodeURIComponent(info.version)}`,
    })
  })
  updater.on('update-not-available', () => publish({ phase: 'not-available' }))
  updater.on('download-progress', (progress) => {
    publish({
      phase: 'downloading',
      percent: Math.min(100, Math.max(0, progress.percent)),
    })
  })
  updater.on('update-downloaded', (info) => {
    downloadedFile = info.downloadedFile
    publish({
      phase: 'downloaded',
      version: info.version,
      percent: 100,
      packageReady: options.packageUpdates === true,
      manualInstall: options.packageUpdates === true && !options.installPackage,
    })
  })
  updater.on('error', (error) => {
    // checkForUpdates rejects after emitting 'error'; its catch handles
    // missing metadata by checking legacy installer-only releases.
    if (status.phase !== 'checking') fail(error)
  })

  async function download(): Promise<AppUpdateStatus> {
    if (downloadPromise) return downloadPromise
    if (status.phase !== 'available' || status.manualInstall) return getStatus()
    publish({ phase: 'downloading', percent: 0, error: undefined })
    downloadPromise = (async () => {
      try {
        await updater.downloadUpdate()
      } catch (error) {
        fail(error)
      }
      return getStatus()
    })()
    try {
      return await downloadPromise
    } finally {
      downloadPromise = null
    }
  }

  async function check(): Promise<AppUpdateStatus> {
    if (checkPromise) return checkPromise
    if (
      !options.enabled
      || downloadPromise
      || status.phase === 'downloaded'
      || status.phase === 'installing'
    )
      return getStatus()

    publish({
      phase: 'checking',
      version: undefined,
      percent: undefined,
      error: undefined,
    })
    checkPromise = (async () => {
      try {
        let manualCheck = !options.nativeUpdates
        if (!manualCheck) {
          try {
            await updater.checkForUpdates()
          } catch (error) {
            if (
              error instanceof Error
              && 'code' in error
              && error.code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'
            )
              manualCheck = true
            else throw error
          }
        }
        if (manualCheck) {
          const release = await options.checkRelease()
          publish({
            phase: release ? 'available' : 'not-available',
            manualInstall: true,
            version: release?.version,
            releaseUrl: release?.releaseUrl ?? RELEASES_URL,
          })
        } else if (status.phase === 'available') {
          void download()
        } else if (status.phase === 'checking') {
          publish({ phase: 'not-available' })
        }
      } catch (error) {
        fail(error)
      }
      return getStatus()
    })()
    try {
      return await checkPromise
    } finally {
      checkPromise = null
    }
  }

  async function install(): Promise<AppUpdateStatus> {
    if (status.phase !== 'downloaded' || status.manualInstall)
      return getStatus()
    publish({ phase: 'installing', error: undefined })
    try {
      if (options.installPackage) {
        if (!downloadedFile || !status.version)
          throw new Error('No downloaded update package')
        await options.installPackage(downloadedFile, status.version)
        return getStatus()
      }
      // Finish stopping the API child process and enable window closing
      // before quitAndInstall closes windows (before-quit fires too late).
      await options.beforeInstall()
      updater.quitAndInstall(false, true)
    } catch (error) {
      fail(error)
      if (options.packageUpdates) publish({ manualInstall: true })
    }
    return getStatus()
  }

  return {
    getStatus,
    check,
    download,
    install,
    getDownloadedFile: () => downloadedFile,
  }
}
