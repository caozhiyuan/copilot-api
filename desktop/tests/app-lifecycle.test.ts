import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

import {
  createBeforeQuitController,
  resolveLiveWindow,
} from '../electron/app-lifecycle'

describe('createBeforeQuitController', () => {
  test('prevents default until stopServer completes, deduplicates events, and re-invokes quit', async () => {
    let resolveStop!: () => void
    let stopCalls = 0
    let quitCalls = 0
    const controller = createBeforeQuitController({
      stopServer: () => {
        stopCalls += 1
        return new Promise<void>((resolve) => {
          resolveStop = resolve
        })
      },
      quit: () => {
        quitCalls += 1
      },
    })

    let preventedFirst = 0
    let preventedSecond = 0
    controller.handleBeforeQuit({
      preventDefault: () => {
        preventedFirst += 1
      },
    })
    controller.handleBeforeQuit({
      preventDefault: () => {
        preventedSecond += 1
      },
    })

    expect(preventedFirst).toBe(1)
    expect(preventedSecond).toBe(1)
    expect(controller.isQuitting()).toBe(true)
    expect(stopCalls).toBe(1)
    expect(quitCalls).toBe(0)

    resolveStop()
    await Promise.resolve()
    await Promise.resolve()

    expect(quitCalls).toBe(1)

    let preventedFinal = 0
    controller.handleBeforeQuit({
      preventDefault: () => {
        preventedFinal += 1
      },
    })
    expect(preventedFinal).toBe(0)
    expect(stopCalls).toBe(1)
  })

  test('still quits and reports errors if stopServer rejects', async () => {
    const errors: Array<unknown> = []
    let quitCalls = 0
    const controller = createBeforeQuitController({
      stopServer: () => Promise.reject(new Error('stop failed')),
      quit: () => {
        quitCalls += 1
      },
      onError: (error) => errors.push(error),
    })

    let prevented = 0
    controller.handleBeforeQuit({
      preventDefault: () => {
        prevented += 1
      },
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(prevented).toBe(1)
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe('stop failed')
    expect(quitCalls).toBe(1)
  })

  test('skips preventDefault after explicit stop and re-arms on resetForRetry', () => {
    let stopCalls = 0
    const controller = createBeforeQuitController({
      stopServer: () => {
        stopCalls += 1
        return Promise.resolve()
      },
      quit: () => {},
    })

    controller.markQuitting()
    controller.markServerStopped()

    let preventedBeforeReset = 0
    controller.handleBeforeQuit({
      preventDefault: () => {
        preventedBeforeReset += 1
      },
    })
    expect(preventedBeforeReset).toBe(0)
    expect(stopCalls).toBe(0)

    controller.resetForRetry()
    expect(controller.isQuitting()).toBe(false)

    let preventedAfterReset = 0
    controller.handleBeforeQuit({
      preventDefault: () => {
        preventedAfterReset += 1
      },
    })
    expect(preventedAfterReset).toBe(1)
    expect(stopCalls).toBe(1)
  })
})

describe('resolveLiveWindow', () => {
  test('returns null for missing or destroyed windows and returns live windows', () => {
    expect(resolveLiveWindow(() => null)).toBeNull()
    expect(resolveLiveWindow(() => undefined)).toBeNull()

    const destroyed = { isDestroyed: () => true }
    expect(resolveLiveWindow(() => destroyed)).toBeNull()

    const live = { isDestroyed: () => false }
    expect(resolveLiveWindow(() => live)).toBe(live)
  })
})

describe('desktop IPC live main window rebinding', () => {
  test('routes window controls and close hooks to a recreated BrowserWindow', () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        '--eval',
        `
        import assert from 'node:assert/strict'
        import { mock } from 'bun:test'

        const listeners = new Map()
        const handlers = new Map()
        await mock.module('electron', () => ({
          ipcMain: {
            on: (channel, fn) => listeners.set(channel, fn),
            handle: (channel, fn) => handlers.set(channel, fn),
          },
          shell: { openExternal: () => Promise.resolve() },
        }))

        const { registerWindowAndShellIpcHandlers } = await import('./electron/ipc/window-shell')
        const { resolveLiveWindow } = await import('./electron/app-lifecycle')

        let currentWindow = {
          reloads: 0,
          zoomLevel: 0,
          maximized: false,
          destroyed: false,
          isDestroyed() { return this.destroyed },
          reload() { this.reloads += 1 },
          minimize() {},
          maximize() { this.maximized = true },
          unmaximize() { this.maximized = false },
          isMaximized() { return this.maximized },
          close() {},
          webContents: {
            getZoomLevel() { return currentWindow.zoomLevel },
            setZoomLevel(level) { currentWindow.zoomLevel = level },
          },
        }
        const firstWindow = currentWindow

        registerWindowAndShellIpcHandlers({
          getMainWindow: () => resolveLiveWindow(() => currentWindow),
          onMainWindowClosed: () => {},
          options: {},
        })

        firstWindow.destroyed = true
        listeners.get('window:reload')()
        assert.equal(firstWindow.reloads, 0)
        assert.equal(await handlers.get('window:is-maximized')(), false)

        const recreatedWindow = {
          reloads: 0,
          zoomLevel: 1,
          maximized: true,
          destroyed: false,
          isDestroyed() { return this.destroyed },
          reload() { this.reloads += 1 },
          minimize() {},
          maximize() { this.maximized = true },
          unmaximize() { this.maximized = false },
          isMaximized() { return this.maximized },
          close() {},
          webContents: {
            getZoomLevel() { return recreatedWindow.zoomLevel },
            setZoomLevel(level) { recreatedWindow.zoomLevel = level },
          },
        }
        currentWindow = recreatedWindow

        listeners.get('window:reload')()
        listeners.get('window:zoom-in')()
        assert.equal(firstWindow.reloads, 0)
        assert.equal(recreatedWindow.reloads, 1)
        assert.equal(recreatedWindow.zoomLevel, 1.5)
        assert.equal(await handlers.get('window:is-maximized')(), true)
      `,
      ],
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      timeout: 10_000,
    })

    expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0)
  })
})
