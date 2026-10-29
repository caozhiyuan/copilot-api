import { describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'

import {
  createUpdateManager,
  type DesktopUpdater,
} from '../electron/update-manager'
import type { AppUpdateStatus } from '../src/types/ipc'

function setup(
  options: {
    enabled?: boolean
    nativeUpdates?: boolean
    packageUpdates?: boolean
    installPackage?: (file: string, version: string) => Promise<void>
  } = {},
) {
  const updater = Object.assign(new EventEmitter(), {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowPrerelease: true,
    allowDowngrade: true,
    checkForUpdates: mock<DesktopUpdater['checkForUpdates']>(() =>
      Promise.resolve(null),
    ),
    downloadUpdate: mock<DesktopUpdater['downloadUpdate']>(() =>
      Promise.resolve([]),
    ),
    quitAndInstall: mock<DesktopUpdater['quitAndInstall']>(() => {}),
  })
  const checkRelease = mock(() =>
    Promise.resolve<{ version: string; releaseUrl: string } | null>(null),
  )
  const beforeInstall = mock(() => Promise.resolve())
  const onStatus = mock((_status: AppUpdateStatus) => {})
  const manager = createUpdateManager(updater as unknown as DesktopUpdater, {
    currentVersion: '2.6.29',
    enabled: options.enabled ?? true,
    nativeUpdates: options.nativeUpdates ?? true,
    checkRelease,
    beforeInstall,
    onStatus,
    packageUpdates: options.packageUpdates,
    installPackage: options.installPackage,
  })
  return { manager, updater, checkRelease, beforeInstall, onStatus }
}

describe('desktop updates', () => {
  test('downloads macOS packages even when installation must be manual', async () => {
    const { updater, manager, beforeInstall } = setup({ packageUpdates: true })
    updater.emit('update-available', { version: '2.7.44' })
    updater.downloadUpdate.mockImplementation(async () => {
      updater.emit('update-downloaded', {
        version: '2.7.44',
        downloadedFile: '/Downloads/update.dmg',
      })
      return ['/cache/update.dmg']
    })
    expect(await manager.download()).toMatchObject({
      phase: 'downloaded',
      packageReady: true,
      manualInstall: true,
    })
    expect(manager.getDownloadedFile()).toBe('/Downloads/update.dmg')
    await manager.install()
    expect(beforeInstall).not.toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  test('uses the custom macOS installer without invoking Squirrel or stopping the server before preparation', async () => {
    const installer = mock(async (_file: string, _version: string) => {})
    const { manager, updater, beforeInstall } = setup({
      packageUpdates: true,
      installPackage: installer,
    })
    updater.emit('update-downloaded', {
      version: '2.7.44',
      downloadedFile: '/Downloads/update.dmg',
    })
    await manager.install()
    expect(installer).toHaveBeenCalledWith('/Downloads/update.dmg', '2.7.44')
    expect(beforeInstall).not.toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  test('retains the DMG and offers manual installation after a custom installer error', async () => {
    const { manager, updater } = setup({
      packageUpdates: true,
      installPackage: async () => {
        throw new Error('location not writable')
      },
    })
    updater.emit('update-downloaded', {
      version: '2.7.44',
      downloadedFile: '/Downloads/update.dmg',
    })
    expect(await manager.install()).toMatchObject({
      phase: 'downloaded',
      manualInstall: true,
      packageReady: true,
      error: 'location not writable',
    })
    expect(manager.getDownloadedFile()).toBe('/Downloads/update.dmg')
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  test('never invokes a custom installer without a downloaded package', async () => {
    const installer = mock(async () => {})
    const { manager, updater } = setup({
      packageUpdates: true,
      installPackage: installer,
    })
    updater.emit('update-downloaded', { version: '2.7.44' })
    expect((await manager.install()).manualInstall).toBe(true)
    expect(installer).not.toHaveBeenCalled()
  })
  test('disables prereleases, downgrades and installation on normal quit', () => {
    const { updater, manager } = setup()
    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)
    expect(updater.allowPrerelease).toBe(false)
    expect(updater.allowDowngrade).toBe(false)
    const snapshot = manager.getStatus()
    snapshot.phase = 'error'
    expect(manager.getStatus().phase).toBe('idle')
  })

  test('never fetches or installs updates in development', async () => {
    const { manager, updater, checkRelease } = setup({ enabled: false })
    expect((await manager.check()).phase).toBe('disabled')
    await manager.download()
    await manager.install()
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    expect(checkRelease).not.toHaveBeenCalled()
  })

  test('reports the current version when no update is available', async () => {
    const { manager, updater } = setup()
    updater.checkForUpdates.mockImplementation(() => {
      updater.emit('update-not-available', { version: '2.6.29' })
      return Promise.resolve(null)
    })
    expect(await manager.check()).toMatchObject({
      phase: 'not-available',
      currentVersion: '2.6.29',
    })
  })

  test('handles a disabled native updater returning null', async () => {
    expect((await setup().manager.check()).phase).toBe('not-available')
  })

  test('automatically downloads an update and reports progress without installing', async () => {
    const { manager, updater, onStatus } = setup()
    const downloaded = Promise.withResolvers<string[]>()
    updater.checkForUpdates.mockImplementation(() => {
      updater.emit('update-available', { version: '2.6.30' })
      return Promise.resolve(null)
    })
    updater.downloadUpdate.mockImplementation(() => downloaded.promise)
    expect((await manager.check()).phase).toBe('downloading')
    updater.emit('download-progress', { percent: 42.5 })
    expect(manager.getStatus().percent).toBe(42.5)
    updater.emit('download-progress', { percent: 101 })
    expect(manager.getStatus().percent).toBe(100)
    updater.emit('download-progress', { percent: -1 })
    expect(manager.getStatus().percent).toBe(0)
    const duplicateDownload = manager.download()
    await manager.check()
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1)
    updater.emit('update-downloaded', { version: '2.6.30' })
    downloaded.resolve(['installer.exe'])
    await duplicateDownload
    expect(manager.getStatus()).toMatchObject({
      phase: 'downloaded',
      percent: 100,
      version: '2.6.30',
    })
    expect(onStatus).toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    await manager.check()
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  test('coalesces concurrent checks', async () => {
    const { manager, updater } = setup()
    const check = Promise.withResolvers<null>()
    updater.checkForUpdates.mockImplementation(() => check.promise)
    const first = manager.check()
    const second = manager.check()
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
    check.resolve(null)
    expect(await first).toEqual(await second)
  })

  test('offers legacy installer-only releases without attempting an unchecked download', async () => {
    const { manager, updater, checkRelease } = setup()
    const error = Object.assign(new Error('latest.yml missing'), {
      code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
    })
    updater.checkForUpdates.mockImplementation(() => {
      updater.emit('error', error)
      return Promise.reject(error)
    })
    checkRelease.mockResolvedValue({
      version: '2.6.30',
      releaseUrl:
        'https://github.com/caozhiyuan/copilot-api/releases/tag/v2.6.30',
    })
    expect(await manager.check()).toMatchObject({
      phase: 'available',
      manualInstall: true,
      version: '2.6.30',
    })
    await manager.download()
    await manager.install()
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  test('uses manual release checks for unsigned macOS and unpacked Linux', async () => {
    const { manager, updater, checkRelease } = setup({ nativeUpdates: false })
    checkRelease.mockResolvedValue({
      version: '2.6.30',
      releaseUrl:
        'https://github.com/caozhiyuan/copilot-api/releases/tag/v2.6.30',
    })
    expect((await manager.check()).manualInstall).toBe(true)
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    expect(checkRelease).toHaveBeenCalledTimes(1)
    checkRelease.mockResolvedValue(null)
    expect(await manager.check()).toMatchObject({
      phase: 'not-available',
      version: undefined,
    })
  })

  test('reports native network errors and clears them on retry', async () => {
    const { manager, updater, checkRelease } = setup()
    updater.checkForUpdates.mockRejectedValueOnce(
      new Error('network unavailable'),
    )
    expect(await manager.check()).toMatchObject({
      phase: 'error',
      error: 'network unavailable',
    })
    expect(checkRelease).not.toHaveBeenCalled()
    expect(await manager.check()).toMatchObject({
      phase: 'not-available',
      error: undefined,
    })
  })

  test('reports release-check errors', async () => {
    const { manager, checkRelease } = setup({ nativeUpdates: false })
    checkRelease.mockRejectedValueOnce('offline')
    expect(await manager.check()).toMatchObject({
      phase: 'error',
      error: 'offline',
    })
  })

  test('never installs a download that fails checksum validation', async () => {
    const { manager, updater } = setup()
    updater.emit('update-available', { version: '2.6.30' })
    updater.downloadUpdate.mockImplementation(() => {
      updater.emit('error', new Error('sha512 checksum mismatch'))
      return Promise.reject(new Error('sha512 checksum mismatch'))
    })
    expect((await manager.download()).phase).toBe('error')
    await manager.install()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  test('waits for the API process to stop before installation and prevents double install', async () => {
    const { manager, updater, beforeInstall } = setup()
    const stopped = Promise.withResolvers<void>()
    beforeInstall.mockImplementation(() => stopped.promise)
    updater.emit('update-downloaded', { version: '2.6.30' })
    const install = manager.install()
    expect(manager.getStatus().phase).toBe('installing')
    await manager.install()
    await manager.check()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    stopped.resolve()
    await install
    expect(beforeInstall).toHaveBeenCalledTimes(1)
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })

  test('retains the downloaded update for retry if stopping the server fails', async () => {
    const { manager, updater, beforeInstall } = setup()
    updater.emit('update-downloaded', { version: '2.6.30' })
    beforeInstall.mockRejectedValueOnce(new Error('stop failed'))
    expect(await manager.install()).toMatchObject({
      phase: 'downloaded',
      error: 'stop failed',
    })
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
    await manager.install()
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  test('retains the downloaded update when the installer reports an error', async () => {
    const { manager, updater } = setup()
    updater.emit('update-downloaded', { version: '2.6.30' })
    updater.quitAndInstall.mockImplementation(() => {
      updater.emit('error', new Error('installer failed'))
    })
    expect(await manager.install()).toMatchObject({
      phase: 'downloaded',
      error: 'installer failed',
    })
  })
})
