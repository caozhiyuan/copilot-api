import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AppAdapter } from 'electron-updater/out/AppAdapter'
import type {
  DownloadExecutorTask,
  DownloadUpdateOptions,
} from 'electron-updater/out/AppUpdater'
import { DownloadedUpdateHelper } from 'electron-updater/out/DownloadedUpdateHelper'

import { MacDmgUpdater } from '../electron/mac-dmg-updater'
import { hasDmgBaseline, saveDmgBaseline } from '../electron/update-files'

let directory: string
const bytes = Buffer.from('a complete DMG')
const sha512 = createHash('sha512').update(bytes).digest('base64')
const filename = `Copilot.API-2.7.44-${process.arch}.dmg`
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'mac-dmg-test-'))
})
afterEach(async () => rm(directory, { recursive: true, force: true }))

function setup() {
  const cache = path.join(directory, 'cache')
  const pending = path.join(cache, 'pending')
  const adapter: AppAdapter = {
    version: '2.7.43',
    name: 'test',
    isPackaged: true,
    appUpdateConfigPath: path.join(directory, 'config.yml'),
    userDataPath: directory,
    baseCachePath: cache,
    whenReady: () => Promise.resolve(),
    quit: () => {},
    relaunch: () => {},
    onQuit: () => {},
  }
  const download = mock(async (_url: URL, destination: string) => {
    await writeFile(destination, bytes)
  })
  const downloadToBuffer = mock(async () => Buffer.from('blockmap'))
  const differential = mock(
    async (_file: unknown, _options: unknown, destination: string) => {
      await writeFile(destination, bytes)
      await writeFile(path.join(pending, 'current.blockmap'), 'blockmap')
      return false
    },
  )
  class TestUpdater extends MacDmgUpdater {
    loseHelperInTask = false
    loseHelperInDone = false
    constructor() {
      super(path.join(directory, 'Downloads'), adapter)
      this.downloadedUpdateHelper = new DownloadedUpdateHelper(cache)
      Object.defineProperty(this, 'httpExecutor', {
        configurable: true,
        value: {
          download,
          downloadToBuffer,
        },
      })
      this.logger = { info: () => {}, warn: mock(() => {}), error: () => {} }
    }
    protected override async executeDownload(task: DownloadExecutorTask) {
      await mkdir(pending, { recursive: true })
      const destination = path.join(pending, filename)
      if (this.loseHelperInTask) this.downloadedUpdateHelper = null
      await task.task(
        destination,
        { cancellationToken: task.downloadUpdateOptions.cancellationToken },
        null,
        () => Promise.resolve(),
      )
      if (this.loseHelperInDone) this.downloadedUpdateHelper = null
      await task.done?.({
        ...task.downloadUpdateOptions.updateInfoAndProvider.info,
        downloadedFile: destination,
      })
      return { updateFile: destination }
    }
    protected override differentialDownloadInstaller(
      ...args: Parameters<MacDmgUpdater['differentialDownloadInstaller']>
    ) {
      return differential(args[0], args[1], args[2])
    }
    run(options: DownloadUpdateOptions) {
      return this.doDownloadUpdate(options)
    }
  }
  const updater = new TestUpdater()
  const files = [
    {
      url: new URL(`https://example.com/${filename}`),
      info: { url: filename, sha512, size: bytes.length },
    },
  ]
  const provider = {
    resolveFiles: () => files,
    getBlockMapFiles: mock(async () => [
      new URL('https://example.com/old.blockmap'),
      new URL('https://example.com/new.blockmap'),
    ]),
  }
  const options: DownloadUpdateOptions = {
    updateInfoAndProvider: {
      info: {
        version: '2.7.44',
        path: filename,
        sha512,
        files: files.map((file) => file.info),
        releaseDate: '',
      },
      provider:
        provider as unknown as DownloadUpdateOptions['updateInfoAndProvider']['provider'],
    },
    requestHeaders: {},
    cancellationToken: {} as DownloadUpdateOptions['cancellationToken'],
  }
  return {
    updater,
    options,
    files,
    provider,
    download,
    downloadToBuffer,
    differential,
    cache,
    pending,
  }
}

describe('macOS DMG download adapter', () => {
  test('full first download seeds a baseline and exports a verified installer', async () => {
    const { updater, options, download, differential, cache } = setup()
    let exported = ''
    updater.on('update-downloaded', (event) => {
      exported = event.downloadedFile
    })
    await updater.run(options)
    expect(download).toHaveBeenCalledTimes(1)
    expect(differential).not.toHaveBeenCalled()
    expect(await hasDmgBaseline(cache)).toBe(true)
    expect(exported).toBe(path.join(directory, 'Downloads', filename))
    await updater.verifyPackage(exported)
    await writeFile(exported, 'modified after download')
    await expect(updater.verifyPackage(exported)).rejects.toThrow('checksum')
    await expect(updater.verifyPackage('/another/file')).rejects.toThrow(
      'verified',
    )
    expect(() => updater.quitAndInstall()).toThrow('desktop macOS')
  })

  test('uses the actual cached installer even if its version differs from the running app', async () => {
    const { updater, options, differential, download, cache, pending } = setup()
    await mkdir(pending, { recursive: true })
    await writeFile(path.join(directory, 'base.dmg'), bytes)
    await writeFile(path.join(directory, 'base.blockmap'), 'baseline mapping')
    await saveDmgBaseline(
      cache,
      path.join(directory, 'base.dmg'),
      path.join(directory, 'base.blockmap'),
      '2.7.42',
      sha512,
    )
    await updater.run(options)
    expect(differential).toHaveBeenCalledTimes(1)
    expect(download).not.toHaveBeenCalled()
    expect(await hasDmgBaseline(cache)).toBe(true)
    expect(await readFile(path.join(cache, 'current.blockmap'), 'utf8')).toBe(
      'blockmap',
    )
  })

  test('falls back to a full download and respects disabled differential downloads', async () => {
    const { updater, options, differential, download } = setup()
    await updater.run(options)
    differential.mockResolvedValueOnce(true)
    await updater.run(options)
    expect(download).toHaveBeenCalledTimes(2)
    await updater.run({ ...options, disableDifferentialDownload: true })
    expect(download).toHaveBeenCalledTimes(3)
    expect(differential).toHaveBeenCalledTimes(1)
  })

  test('still exports a full package when its blockmap is unavailable', async () => {
    const { updater, options, downloadToBuffer, cache } = setup()
    downloadToBuffer.mockRejectedValueOnce(new Error('404'))
    await updater.run(options)
    expect(await hasDmgBaseline(cache)).toBe(false)
    await updater.verifyPackage(path.join(directory, 'Downloads', filename))
  })

  test('never publishes a corrupted package', async () => {
    const { updater, options, download } = setup()
    download.mockImplementationOnce(async (_url, destination) => {
      await writeFile(destination, 'corrupted')
    })
    const event = mock(() => {})
    updater.on('update-downloaded', event)
    await expect(updater.run(options)).rejects.toThrow('checksum')
    expect(event).not.toHaveBeenCalled()
  })

  test('rejects unsupported assets, unavailable executors and missing cache state', async () => {
    const { updater, options, files } = setup()
    files[0].url = new URL('https://example.com/other-arch.dmg')
    await expect(updater.run(options)).rejects.toThrow('No macOS update')
    files[0].url = new URL(`https://example.com/${filename}`)
    Object.defineProperty(updater, 'httpExecutor', { value: null })
    await expect(updater.run(options)).rejects.toThrow('executor')
    const first = setup()
    first.updater.loseHelperInTask = true
    await expect(first.updater.run(first.options)).rejects.toThrow('cache')
    const second = setup()
    second.updater.loseHelperInDone = true
    await expect(second.updater.run(second.options)).rejects.toThrow('cache')
  })
})
